#!/usr/bin/env node
/* Guarda el trabajo MANUAL de una pista y lo repone después de reconstruirla.
 *
 * ## El problema que resuelve, dicho por el usuario
 *
 * *"¿Y si hago un cambio en el montaje vos lo podés respetar en el próximo corte?"*
 * (2026-08-21). La respuesta hasta hoy era no, y la forma en que era no es lo grave:
 * `colocar_propuesta.js` barre la pista y la rehace desde un JSON, así que se lleva todo lo
 * que él hizo a mano. Y lo que se reponía después **lo reponía yo de memoria**, mirando mis
 * notas de lo que le había visto hacer.
 *
 * Ese es el peor modo de fallar de este repo aplicado a su trabajo: si me olvido uno, no hay
 * error, no hay aviso, y la corrección desaparece. Ya casi pasó — el 2026-08-21 sus tres
 * ajustes de exposición no se leyeron porque el efecto se llama `Lumetri Color` y yo buscaba
 * `Lumetri`, un `catch` vacío se comió los 45 errores, y yo informé "nada distinto del
 * default" habiendo leído cero.
 *
 * Así que el arreglo no es acordarse mejor: es **no depender de acordarse**. Se lee el estado
 * de la secuencia a un archivo ANTES de tocar nada, y se repone DESDE ESE ARCHIVO.
 *
 * ## Tres pasos, y el del medio es el suyo
 *
 *     node quirurgico.js --guardar  --pista V1 --a estado_V1.json     <- antes de reconstruir
 *     node colocar_propuesta.js ...                                   <- la reconstrucción
 *     node quirurgico.js --reponer  --de estado_V1.json [--aplicar]   <- después
 *
 * `--reponer` sin `--aplicar` **no escribe nada**: informa qué repondría, sobre qué clip, y
 * qué no pudo emparejar. Ése es el default a propósito. Una reposición a ciegas sobre una
 * pista recién armada puede pintarle un Lumetri al plano equivocado, y eso es peor que
 * perder la corrección: perderla se nota, tenerla en el plano de al lado no.
 *
 * ## El emparejamiento, que es la parte difícil
 *
 * Después de reconstruir, la lista de clips ES OTRA — para eso se reconstruye. Así que no se
 * puede emparejar por índice. Se empareja por **nombre más número de aparición**: el segundo
 * `FX3_3602.MP4` de antes va con el segundo `FX3_3602.MP4` de ahora.
 *
 * Los nombres NO son únicos en Premiere y eso ya rompió `moverABin`, así que la cuenta es por
 * multiplicidad y **las ambigüedades se informan en vez de resolverse**: si antes había tres
 * apariciones y ahora hay dos, se repone en las dos que se pueden y se dice cuál quedó sin
 * casa. Con un `Set` esto contaría 3 y 2 como "1 y 1" y taparía el problema.
 *
 * La comparación de nombres pasa por `norm`: macOS da NFD y Premiere NFC, y de 35 archivos de
 * este proyecto los dos únicos con tilde fueron los dos únicos que fallaron.
 *
 * ## Lo que se puede reponer y lo que no
 *
 * Se repone: **el ojito** (`desactivar`), **los efectos agregados con sus valores**
 * (`agregarEfecto` + `fijar`) y **el Motion** (`fijar` sobre Scale/Position/Rotation).
 *
 * NO se repone la **velocidad**: la API no la escribe. `VideoClipTrackItem` expone `getSpeed`
 * e `isSpeedReversed`, los dos de lectura, y ninguna de sus acciones la toca. Está reflejado,
 * no supuesto. Los clips con velocidad distinta de 1 se LISTAN al final para ponerlos a mano.
 *
 * Tampoco se reponen los **keyframes**: un param animado se informa con su cantidad y se deja
 * para el usuario. Reponer una animación con `keyframe` exige el playhead en cada punto, y
 * `fijar` la aplastaría a un valor fijo sin decirlo.
 *
 * ## Espaciado 1,2 s y guardado antes y después
 *
 * Una ráfaga de transacciones tira Premiere con SIGSEGV; medido, 200 ms lo tira y 1200 no. Y
 * lo que salvó el trabajo la vez que se cayó fue el autosave, no el bridge, así que `guardar`
 * va antes y después de la tanda y no sólo al final.
 */
const path = require("path");
const fs = require("fs");
const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
/*
 * 300 + los ~205ms del piso del transporte = ~505ms de espaciado REAL, que es lo
 * unico que importa: lo que tira Premiere es la separacion entre transacciones,
 * no este numero suelto.
 *
 * Medido el 2026-09-05 en un proyecto pesado (216 clips, 1284 medios, 68 secuencias):
 * a ~205ms falla 2 de 2 —una vez EXC_BAD_ACCESS en 0x18, otra colgado a 0% de
 * CPU sin dump— y a ~355 y ~505 aguanta 150 transacciones. El borde esta entre
 * 205 y 355; 505 deja 2,4x de margen. Antes esto era 1200, que con el MS_POLL
 * viejo de 700 daba ~1442ms: casi 3x mas lento por nada.
 *
 * NO se baja sin mirar `MS_POLL` en plugin/index.js. `test.js` exige que la SUMA
 * de los dos sea >= 500ms, porque bajar uno sin subir el otro es el error que ya
 * casi se comete: en el proyecto de PRUEBA los ~205ms aguantaban 200.
 */
const PAUSA = Number(opt("pausa", "300"));
/* EL PROYECTO SE DEDUCE del archivo de estado, y va como guarda en cada llamada.
 *
 * El bridge opera sobre el proyecto que tiene FOCO en Premiere y ningún verbo dice cuál es.
 * Este verbo ESCRIBE —repone efectos y Motion— así que reponer contra el proyecto equivocado
 * le pinta un Lumetri a un clip que no tiene nada que ver. Ya pasó la confusión de foco el
 * 2026-08-22, esa vez sólo con lecturas.
 *
 * Se deduce y no se pide por flag: una guarda que hay que acordarse de pasar no está cuando
 * hace falta. Con `--proyecto` se puede forzar. */
function buscarProyecto(dir) {
  for (const d of [dir, path.join(dir, "Proyecto"), path.dirname(dir)]) {
    try {
      const f = fs.readdirSync(d).find((x) => x.toLowerCase().endsWith(".prproj"));
      if (f) return f.replace(/\.prproj$/i, "");
    } catch (e) { /* no existe: se sigue */ }
  }
  return null;
}
let PROYECTO = opt("proyecto", null);
const g = (o) => (PROYECTO ? Object.assign({ proyecto: PROYECTO }, o) : (o || {}));
const LOTE = Number(opt("lote", "12"));

/* Unicode: macOS NFD, Premiere NFC. Sin esto un nombre con tilde no empareja. */
const norm = (s) => String(s == null ? "" : s).normalize("NFC");

function uso(m) {
  if (m) console.error("\n" + m + "\n");
  console.error(`Uso:
  node quirurgico.js --guardar --pista V1 [--a estado.json]
  node quirurgico.js --reponer --de estado.json [--pista V1] [--aplicar]

  --guardar   lee la pista con \`radiografia\` y escribe el estado a un archivo.
  --reponer   repone desde ese archivo. SIN --aplicar sólo informa qué haría.
  --aplicar   escribe de verdad. Espaciado ${PAUSA} ms, con guardado antes y después.`);
  process.exit(1);
}

/*
 * Los efectos de UN clip con sus valores, usando sólo verbos con años de uso.
 *
 * `efectos` da los NOMBRES de los params (una llamada) y `param` da cada VALOR (una llamada
 * cada uno). Es lento —~13 llamadas por clip con Lumetri— y es a propósito: la versión rápida
 * era `radiografia` con `conParams`, que tiró Premiere tres veces con el mismo stack.
 *
 * OJO CON LOS NOMBRES REPETIDOS: `param` resuelve por nombre y agarra el PRIMERO. En Lumetri
 * "Saturation" aparece cuatro veces —una por grupo anidado— y el primero es el de Basic
 * Correction, que es el que se mueve. Los otros grupos NO se leen, y se informa: es un límite
 * conocido, no algo que ya funcione.
 */
const LUMETRI = ["Temperature", "Tint", "Exposure", "Contrast", "Highlights", "Shadows",
                 "Whites", "Blacks", "Saturation", "Vibrance", "Faded Film", "Sharpen"];

async function efectosDeUnClip(pista, indice, nombresEfectos) {
  const salida = [];
  for (const nomEf of nombresEfectos) {
    let nombres = LUMETRI;
    if (nomEf.indexOf("Lumetri") === -1) {
      await dormir(PAUSA);
      try {
        const r = await enviar("efectos", g({ pista: pista, indice: indice }), 300000);
        const mio = (r.efectos || []).find((x) => x.nombre === nomEf);
        // sin duplicados: pedir dos veces el mismo nombre devuelve el mismo param
        nombres = mio ? mio.params.filter((x, i, a) => x && a.indexOf(x) === i) : [];
      } catch (e) { salida.push({ nombre: nomEf, params: [], error: String(e.message || e).slice(0, 70) }); continue; }
    }
    const leidos = [];
    for (const nom of nombres) {
      await dormir(PAUSA);
      try {
        const r = await enviar("param", g({ pista: pista, indice: indice, efecto: nomEf, param: nom }), 300000);
        if (typeof r.valor === "number") leidos.push({ nombre: nom, valor: r.valor, keyframes: r.keyframes || 0 });
      } catch (e) { /* el param no existe en este efecto: la lista es genérica, es normal */ }
    }
    salida.push({ nombre: nomEf, params: leidos, porNombre: true, gruposNoLeidos: nomEf.indexOf("Lumetri") !== -1 });
  }
  return salida;
}

/* ---------- guardar ---------- */
async function guardar() {
  const pista = opt("pista", null);
  if (!pista) uso("Falta --pista.");
  const destino = opt("a", "estado_" + pista + ".json");
  if (!PROYECTO) PROYECTO = buscarProyecto(path.dirname(path.resolve(destino)));
  const est = await enviar("estado", g({}));
  console.log("secuencia: " + String(est.resumen).split("·")[0].trim());

  /* Por tandas con `siguiente`: una sola llamada que toca 90 clips es un punto de falla del
   * que no se vuelve, y esta lectura abre la cadena de componentes de cada uno. */
  const clips = [];
  let desde = 0, total = null, vueltas = 0;
  for (;;) {
    if (vueltas++) await dormir(PAUSA);
    const r = await enviar("radiografia", g({ pista: pista, desdeIndice: desde, limite: LOTE }), 300000);
    (r.clips || []).forEach((c) => clips.push(c));
    total = r.total;
    console.log("  leídos " + clips.length + " de " + total +
      (r.conTrabajo ? "  (" + r.conTrabajo + " con trabajo manual en esta tanda)" : ""));
    if (r.siguiente == null) break;
    desde = r.siguiente;
  }
  if (total != null && clips.length !== total) {
    console.log("OJO: se leyeron " + clips.length + " y la pista tiene " + total + ". El estado está INCOMPLETO.");
  }

  /* SEGUNDA PASADA: el Motion, por los caminos que NO crashean.
   *
   * `radiografia` ya no lee params —lo hizo dos veces y las dos tiró Premiere resolviendo una
   * promesa con un objeto de param sacado de un lock cerrado— así que deja los 88 clips con el
   * Motion "sin verificar". Eso no se puede dejar así: cuatro de los seis clips con trabajo de
   * este proyecto son SÓLO una rotación, y no detectarla es decir "se puede rehacer" sobre un
   * clip que sí tiene trabajo.
   *
   * Se usan dos caminos distintos, cada uno el probado para lo suyo:
   *
   *   - escala y posición  ->  `leerEscalas`, que hace UNA llamada por pista y está medido
   *                            (seis vueltas, 180 lecturas, sin caerse)
   *   - rotación           ->  el verbo `param`, DE A UNO y espaciado. Es el mismo camino que
   *                            usa `fijar` desde siempre. 88 llamadas en dos minutos no es una
   *                            ráfaga; 560 en un barrido sí lo era.
   *
   * Se puede saltear con `--sin-motion`, y entonces los clips quedan marcados como no
   * verificados en vez de como limpios. */
  /* Las pistas de AUDIO no tienen Motion, y las dos pasadas de video fallarían con ruido:
   * `leerEscalas` rechaza una pista de audio de entrada, y pedirle "Rotation" a un clip de
   * audio devuelve "sin efecto" ochenta y ocho veces. Se saltea diciéndolo, en vez de correr
   * y tragarse los errores — que es lo que hacía antes de mirar. */
  const esAudio = /^A/i.test(String(pista));
  if (esAudio) {
    console.log("\n" + pista + " es audio: se saltean escala, posición y rotación (no tiene Motion).");
    for (const c of clips) { delete c.motionSinLeer; c.intacto = c.tocado.length === 0; }
  }
  if (!esAudio && !flag("sin-motion")) {
    console.log("\nsegunda pasada: escala y posición con `leerEscalas`, rotación de a una...");
    const porIndice = new Map(clips.map((c) => [c.indice, c]));
    try {
      let d = 0;
      for (;;) {
        await dormir(PAUSA);
        const r = await enviar("leerEscalas", g({ pista: pista, desdeIndice: d, limite: 12 }), 300000);
        for (const f of (r.clips || [])) {
          const c = porIndice.get(f.i);
          if (!c) continue;
          c.escala = f.base; c.escalaFin = f.fin; c.x = f.x; c.y = f.y; c.escalaKf = f.keyframes;
          /* A `motion`, no sólo a `tocado`. Mismo agujero que tenía la rotación: `tocado` es
           * para el informe y `motion` es lo que lee la reposición. Y acá era PEOR de detectar,
           * porque la guarda de cobertura mira por CLIP: un clip con escala 50 y además un
           * Lumetri quedaba "cubierto" por el Lumetri, y la escala se perdía en silencio sin
           * que saltara ningún aviso. Encontrado en el proyecto de prueba, el 2026-08-21. */
          c.motion = (c.motion || []).filter((x) => x.nombre !== "Scale" && x.nombre !== "Position");
          if (f.base !== null) c.motion.push({ nombre: "Scale", valor: f.base, keyframes: f.keyframes || 0 });
          if (f.x !== null) c.motion.push({ nombre: "Position", valor: [f.x, f.y], keyframes: 0 });
          if (f.base !== null && f.base !== 100) c.tocado.push("escala " + f.base);
          if (f.keyframes > 0) c.tocado.push("escala ANIMADA (" + f.keyframes + " kf)");
          if (f.x !== null && (f.x !== 0.5 || f.y !== 0.5)) c.tocado.push("posición " + f.x + "," + f.y);
        }
        if (r.siguiente == null) break;
        d = r.siguiente;
      }
    } catch (e) { console.log("  OJO: leerEscalas falló: " + (e.message || e)); }

    /* LA ROTACION VA DE A UNA, y esto es una REVERSION deliberada.
     *
     * Estaba batcheada con `leerParam`, 25 clips por llamada, porque el usuario marco —con
     * razon— que 136 llamadas era un desperdicio. Pero el historial dice otra cosa:
     *
     *     88 llamadas `param` de a una      ->  corrio limpio
     *     leerParam batcheado 25/llamada    ->  CRASH (dos veces)
     *
     * Y la bisección lo confirmo: `--sin-motion`, que hace 52 lecturas todas de a una, corrio
     * completo y Premiere sobrevivio 75s despues. Lo que salteaba eran 285 lecturas en llamadas
     * de 50 y de 25.
     *
     * Asi que la eficiencia se pagaba con estabilidad y no era un buen negocio. Son ~95 llamadas
     * y dos minutos; a cambio, es el patron que nunca crasheo. */
    let n = 0;
    try {
      for (const c of clips) {
        await dormir(PAUSA);
        n++;
        try {
          const r = await enviar("param", g({ pista: pista, indice: c.indice,
                                              efecto: "Motion", param: "Rotation" }), 300000);
          const f = { indice: c.indice, valor: r.valor, keyframes: r.keyframes || 0 };
          if (n % 25 === 0) console.log(`  rotación: ${n} de ${clips.length}`);
          /* Va a `motion`, no sólo a `tocado`. `tocado` es para el informe; `motion` es lo que
           * lee la reposición. Tenerlo sólo en `tocado` hacía que tres rotaciones quedaran
           * fuera del plan Y fuera de "ya estaban": no se restauraban y no se avisaba. */
          if (f.valor !== null) {
            c.motion = (c.motion || []).filter((x) => x.nombre !== "Rotation");
            c.motion.push({ nombre: "Rotation", i: 4, valor: f.valor, keyframes: f.keyframes || 0 });
          }
          if (f.valor !== 0 && f.valor !== null) c.tocado.push("Rotation " + f.valor);
          if (f.keyframes > 0) c.tocado.push("Rotation ANIMADA (" + f.keyframes + " kf)");
        } catch (e) { c.tocado.push("Rotation NO SE PUDO LEER: " + String(e.message || e).slice(0, 60)); }
      }
    } catch (e) { console.log("  OJO: la pasada de rotación falló: " + (e.message || e)); }
    console.log("  rotación leída en " + n + " clip(s), de a una");
    /* Ahora sí se puede decidir: el Motion está verificado. */
    for (const c of clips) { delete c.motionSinLeer; c.intacto = c.tocado.length === 0; }
  }

  /* TERCERA PASADA: los valores de los efectos agregados, con `param` y de a uno.
   *
   * `radiografia` los deja como `valoresSinLeer: true` a propósito. Acá se piden por el camino
   * probado — una llamada por param, espaciada— y SÓLO en los clips que tienen algo agregado.
   * En el proyecto real son 3 clips: 36 llamadas, no 560.
   *
   * OJO CON LOS NOMBRES REPETIDOS: `param` resuelve por nombre y agarra el PRIMERO. En Lumetri
   * "Saturation" aparece cuatro veces (una por grupo anidado) y el primero es el de Basic
   * Correction, que es justo el que se mueve. Para los demás grupos haría falta pedir por
   * índice, y `param` todavía no lo acepta: queda anotado como límite conocido, no como algo
   * que ya funciona. */
  /* TERCERA PASADA: los efectos agregados, con `efectos` + `param` de a uno.
   *
   * Antes esto usaba `radiografia` con `conParams` sobre un clip —40 lecturas en una llamada,
   * que parecía seguro por estar debajo de las 176 medidas como buenas—. **Crasheó igual.** Ese
   * fue el tercer crash con el mismo stack, y con eso el modelo del umbral se cayó: no es
   * cuántas lecturas entran en una llamada.
   *
   * Así que acá no hay más teoría, hay una regla: los valores se leen con los verbos que ya
   * tenían años de uso sin este crash. Son ~13 llamadas por clip con Lumetri en vez de 1, y son
   * POCOS clips —3 de 88 en el proyecto real— porque el triage dice dónde mirar. */
  const pendientes = clips.filter((c) => (c.efectos || []).some((e) => e.valoresSinLeer));
  if (pendientes.length && !flag("sin-valores")) {
    console.log("\ntercera pasada: efectos con sus valores, un clip por llamada (" + pendientes.length + ")...");
    for (const c of pendientes) {
      await dormir(PAUSA);
      try {
        const nombresEf = (c.efectos || []).filter((e) => e.valoresSinLeer).map((e) => e.nombre);
        c.efectos = await efectosDeUnClip(pista, c.indice, nombresEf);
        c.tocado = c.tocado.filter((t) => t.indexOf("valores SIN LEER") === -1);
        for (const ef of c.efectos) {
          const movidos = (ef.params || []).filter((q) => q.valor !== 0 &&
            !(q.nombre === "Saturation" && q.valor === 100));
          c.tocado.push("efecto " + ef.nombre + ": " + (movidos.length
            ? movidos.map((q) => q.nombre + "=" + q.valor).join(", ")
            : "todo en su default") + (ef.gruposNoLeidos ? " (sólo Basic Correction)" : ""));
          console.log("  " + c.nombre.slice(0, 22).padEnd(23) + ef.nombre + ": " +
            (ef.params || []).length + " valores · " +
            (movidos.length ? movidos.map((q) => q.nombre + "=" + q.valor).join(" ") : "nada movido"));
        }
      } catch (e) { c.tocado.push("no se pudo releer el efecto: " + String(e.message || e).slice(0, 60)); }
    }
  }

  const conTrabajo = clips.filter((c) => c.intacto !== true);
  const salida = {
    secuencia: String(est.resumen).split("·")[0].trim(),
    pista: pista, cuando: new Date().toISOString(),
    total: total, clips: clips
  };
  fs.writeFileSync(destino, JSON.stringify(salida, null, 1));
  console.log("\n" + clips.length + " clip(s) guardados en " + destino);
  console.log(conTrabajo.length + " con trabajo manual que una reconstrucción destruiría:\n");
  for (const c of conTrabajo) {
    console.log("  " + c.pista + "[" + c.indice + "] " + String(c.nombre).slice(0, 30).padEnd(31) +
      c.tocado.join("; ").slice(0, 110));
  }
  if (!conTrabajo.length) console.log("  (ninguno: la pista se puede rehacer sin perder nada)");
}

/* ---------- reponer ---------- */
async function reponer() {
  const origen = opt("de", null);
  if (!origen || !fs.existsSync(origen)) uso("Falta --de <estado.json> (o no existe).");
  if (!PROYECTO) PROYECTO = buscarProyecto(path.dirname(path.resolve(origen)));
  const S = JSON.parse(fs.readFileSync(origen, "utf8"));
  const pista = opt("pista", S.pista);
  const APLICA = flag("aplicar");

  const est = await enviar("estado", g({}));
  const secAhora = String(est.resumen).split("·")[0].trim();
  if (S.secuencia && secAhora !== S.secuencia) {
    console.log("OJO: el estado se guardó en \"" + S.secuencia + "\" y la activa es \"" + secAhora + "\".");
    console.log("Se sigue igual porque el nombre puede haber cambiado, pero revisá que sea la misma.\n");
  }

  /* SE LEE EL ESTADO ACTUAL, no sólo la lista de clips.
   *
   * Sin esto la herramienta NO es idempotente: corrida sobre una pista que todavía tiene los
   * efectos, `agregarEfecto` le pone un SEGUNDO Lumetri encima del que ya estaba. Y no hay
   * verbo para sacar un efecto, así que eso se limpia a mano.
   *
   * Se va a correr más de una vez —después de cada armado, y de nuevo si algo falló a mitad—
   * así que reponer tiene que significar "poner lo que FALTA", no "volver a poner todo". Con
   * la radiografía de ahora, un clip que ya está bien se saltea y se dice. */
  const ahoraFull = [];
  {
    /* Pausa larga ANTES del primer barrido. Premiere se cayó el 2026-08-21 haciendo esta
     * lectura 1,2 s después de un `fijar`; la causa no está identificada, pero mezclar una
     * escritura con un barrido de cientos de promesas es la combinación que estaba en juego,
     * y esperar acá no cuesta nada. */
    await dormir(Math.max(PAUSA, 3000));
    let d = 0, vueltas = 0;
    for (;;) {
      if (vueltas++) await dormir(PAUSA);
      const r = await enviar("radiografia", g({ pista: pista, desdeIndice: d, limite: LOTE }), 300000);
      (r.clips || []).forEach((c) => ahoraFull.push(c));
      if (r.siguiente == null) break;
      d = r.siguiente;
    }
  }
  const ahora = ahoraFull;
  console.log(pista + ": " + ahora.length + " clip(s) ahora · " + (S.clips || []).length + " en el estado guardado");

  /* EL DETALLE SÓLO DE LOS CLIPS QUE SE VAN A TOCAR.
   *
   * El barrido de arriba no lee params —por eso no crashea— así que no sabe la rotación ni los
   * valores de los efectos. Sin eso la idempotencia se pierde: no se puede distinguir "ya está
   * puesto" de "falta ponerlo", y la herramienta reescribiría todo cada vez.
   *
   * Pero no hace falta el detalle de los 88: sólo de los que el estado guardado marca con
   * trabajo. En el proyecto real son 6, o sea ~9 llamadas. */
  {
    const nombresConTrabajo = new Set((S.clips || []).filter((c) => c.intacto !== true).map((c) => norm(c.nombre)));
    const aDetallar = ahoraFull.filter((c) => nombresConTrabajo.has(norm(c.nombre)));
    if (aDetallar.length) {
      console.log("leyendo el detalle de " + aDetallar.length + " clip(s) candidatos...");
      /* Escala y posición para TODOS de una, con `leerEscalas`: sin esto la idempotencia
       * proponía reponer una escala que ya estaba puesta. */
      const esc = new Map();
      try {
        let d = 0;
        for (;;) {
          await dormir(PAUSA);
          const r = await enviar("leerEscalas", g({ pista: pista, desdeIndice: d, limite: 12 }), 300000);
          for (const f of (r.clips || [])) esc.set(f.i, f);
          if (r.siguiente == null) break;
          d = r.siguiente;
        }
      } catch (e) { console.log("  OJO: leerEscalas falló: " + (e.message || e)); }
      for (const c of aDetallar) {
        await dormir(PAUSA);
        c.motion = [];
        try {
          const r = await enviar("param", g({ pista: pista, indice: c.indice, efecto: "Motion", param: "Rotation" }), 300000);
          c.motion.push({ nombre: "Rotation", i: 4, valor: r.valor, keyframes: r.keyframes || 0 });
        } catch (e) { /* sin Rotation legible: el plan lo va a proponer, que es el lado seguro */ }
        const f = esc.get(c.indice);
        if (f) {
          if (f.base !== null) c.motion.push({ nombre: "Scale", valor: f.base, keyframes: f.keyframes || 0 });
          if (f.x !== null) c.motion.push({ nombre: "Position", valor: [f.x, f.y], keyframes: 0 });
        }
        if ((c.efectos || []).some((e) => e.valoresSinLeer)) {
          try {
            const nombresEf = c.efectos.filter((e) => e.valoresSinLeer).map((e) => e.nombre);
            c.efectos = await efectosDeUnClip(pista, c.indice, nombresEf);
          } catch (e) { /* queda con valoresSinLeer: el plan lo va a proponer, que es el lado seguro */ }
        }
      }
    }
  }
  console.log("");

  /* Emparejar por nombre + número de aparición. Por multiplicidad y no con un Set: los
   * nombres no son únicos y contar "3 y 2" como "1 y 1" taparía justo el problema. */
  const idxAhora = new Map();
  ahora.forEach((c) => {
    const k = norm(c.nombre);
    if (!idxAhora.has(k)) idxAhora.set(k, []);
    idxAhora.get(k).push(c);
  });
  /* EL RANGO DE APARICIÓN SE CUENTA SOBRE LA PISTA COMPLETA, no sobre los clips con trabajo.
   *
   * Contarlo sobre la lista filtrada es un bug silencioso y del peor tipo. Medido con el caso
   * real: el estado tenía el SEGUNDO "FX3_3558.MP4" (índice 25) y era el único de ese nombre
   * con trabajo manual, así que como primero de la lista filtrada se emparejaba con el
   * PRIMERO de la pista nueva (índice 19). El ojito apagado le caía al plano equivocado.
   *
   * En esta pista hay 16 nombres repetidos y uno aparece SEIS veces, así que no es un borde.
   * El rango sale de recorrer `S.clips` entero —que `--guardar` escribe completo— contando
   * cuántas veces apareció ese nombre antes. */
  const rango = new Map();
  const cuentaGuardada = new Map();
  for (const c of (S.clips || [])) {
    const k = norm(c.nombre);
    const n = cuentaGuardada.get(k) || 0;
    cuentaGuardada.set(k, n + 1);
    rango.set(c, n);
  }
  /* Y si el estado quedó incompleto, los rangos NO son confiables: faltan apariciones que
   * corrían la cuenta. Se avisa fuerte en vez de reponer sobre un supuesto. */
  if (S.total != null && (S.clips || []).length !== S.total) {
    console.log("OJO: el estado tiene " + (S.clips || []).length + " clip(s) y la pista tenía " +
      S.total + ". Los números de aparición pueden estar corridos y la reposición caer en el");
    console.log("clip de al lado. Volvé a guardar el estado completo antes de aplicar.\n");
  }

  const plan = [], sinCasa = [], aMano = [], intactos = [];
  for (const v of (S.clips || [])) {
    if (v.intacto === true) continue;   // null = no se sabe, se trata como que TIENE trabajo
    const k = norm(v.nombre);
    const lista = idxAhora.get(k) || [];
    const n = rango.get(v) || 0;
    const destino = lista[n];
    if (!destino) {
      sinCasa.push({ v: v, razon: lista.length ? "era la aparición nº " + (n + 1) + " de ese nombre y ahora hay " + lista.length : "ya no está en la pista" });
      continue;
    }
    const acciones = [], yaEstaba = [];
    if (v.desactivado === true) {
      if (destino.desactivado === true) yaEstaba.push("ojito ya apagado");
      else acciones.push({ tipo: "ojito", verbo: "desactivar", params: { pista: pista, indice: destino.indice } });
    }
    const efectosAhora = (destino.efectos || []).map((e) => e.nombre);
    for (const ef of (v.efectos || [])) {
      const fijables = (ef.params || []).filter((p) => p.keyframes === 0 && typeof p.valor === "number");
      const animados = (ef.params || []).filter((p) => p.keyframes > 0);
      if (efectosAhora.indexOf(ef.nombre) !== -1) {
        /* El efecto ya está. Se comparan los VALORES y se repone sólo lo que difiera: puede
         * estar el efecto y faltarle los params, que es como queda si una tanda anterior se
         * cortó por la mitad. */
        const suyo = (destino.efectos || []).find((e) => e.nombre === ef.nombre);
        /* Por ÍNDICE si los dos lo tienen, y si no POR NOMBRE.
         *
         * Antes era `x.i === q.i` a secas, y los params leídos con `param` vienen sin índice:
         * `undefined === undefined` da true, así que Exposure se comparaba contra el PRIMER
         * param de la lista y todo salía "distinto". Es el `undefined !== undefined` del
         * catálogo dado vuelta — una comparación que no distingue lo que tiene que distinguir. */
        const distintos = fijables.filter((q) => {
          const porI = typeof q.i === "number" &&
            (suyo.params || []).find((x) => typeof x.i === "number" && x.i === q.i);
          const m = porI || (suyo.params || []).find((x) => x.nombre === q.nombre);
          return !m || m.valor !== q.valor;
        });
        if (!distintos.length) { yaEstaba.push(ef.nombre + " ya está con sus " + fijables.length + " valores"); continue; }
        acciones.push({ tipo: "params", verbo: null, params: { efecto: ef.nombre }, luego: distintos,
                        animados: animados.length, nota: ef.nombre + " ya estaba, faltaban " + distintos.length + " valor(es)" });
        continue;
      }
      acciones.push({ tipo: "efecto", verbo: "agregarEfecto", params: { pista: pista, indice: destino.indice, efecto: ef.nombre },
                      luego: fijables, animados: animados.length });
      if (ef.incompleto) acciones.push({ tipo: "AVISO", detalle: "el efecto " + ef.nombre + " se leyó INCOMPLETO: " + ef.incompleto });
    }
    for (const p of (v.motion || [])) {
      const esDef = (p.nombre === "Scale" || p.nombre === "Scale Height") ? p.valor === 100
        : p.nombre === "Rotation" ? p.valor === 0
        : Array.isArray(p.valor) && p.valor[0] === 0.5 && p.valor[1] === 0.5;
      if (esDef) continue;
      if (p.keyframes > 0) { aMano.push(v.nombre + ": " + p.nombre + " ANIMADO (" + p.keyframes + " kf) — no se repone"); continue; }
      const suyoM = (destino.motion || []).find((x) => x.nombre === p.nombre);
      const igual = suyoM && (Array.isArray(p.valor)
        ? Array.isArray(suyoM.valor) && suyoM.valor[0] === p.valor[0] && suyoM.valor[1] === p.valor[1]
        : suyoM.valor === p.valor);
      if (igual) { yaEstaba.push(p.nombre + " ya está en " + JSON.stringify(p.valor)); continue; }
      acciones.push({ tipo: "motion", verbo: "fijar", params: { pista: pista, indice: destino.indice, efecto: "Motion", param: p.nombre,
        ...(typeof p.i === "number" && p.i >= 0 ? { indiceParam: p.i } : {}),
        ...(Array.isArray(p.valor) ? { x: p.valor[0], y: p.valor[1] } : { valor: p.valor }) } });
    }
    if (v.velocidad !== null && v.velocidad !== 1) aMano.push(v.nombre + ": velocidad " + v.velocidad + " — la API no la escribe");
    if (acciones.length) plan.push({ v: v, destino: destino, acciones: acciones, yaEstaba: yaEstaba });
    else if (yaEstaba.length) intactos.push({ v: v, destino: destino, yaEstaba: yaEstaba });
  }

  /* SE MUESTRA CUÁNTO SE MOVIÓ, y se marca si se movió mucho.
   *
   * El emparejamiento por número de aparición no aguanta que la reconstrucción borre una
   * aparición ANTERIOR de ese nombre: ahí los rangos se corren y el trabajo cae en el clip
   * de al lado. La forma segura de vivir con eso no es un algoritmo más listo, es que el
   * error sea VISIBLE: un clip que no se pidió mover y aparece a 40 segundos de donde estaba
   * es un match equivocado, y se ve de un vistazo.
   *
   * El umbral es 1 s a propósito: los ajustes que él pide son de frames o de un par de
   * segundos, así que 1 s separa "lo movimos" de "es otro clip". */
  const SOSPECHA = Number(opt("umbral-mudanza", "1"));
  let sospechosos = 0;
  console.log("PLAN — " + plan.length + " clip(s) a restaurar" +
    (intactos.length ? " · " + intactos.length + " ya estaban completos" : "") + "\n");
  for (const p of plan) {
    const d = p.destino.desde - p.v.desde;
    const raro = Math.abs(d) > SOSPECHA;
    if (raro) sospechosos++;
    console.log("  " + String(p.v.nombre).slice(0, 28).padEnd(29) + " guardado en [" + p.v.indice + "]" +
      " a " + p.v.desde + "s -> ahora " + p.destino.pista + "[" + p.destino.indice + "] a " +
      p.destino.desde + "s  (" + (d >= 0 ? "+" : "") + d.toFixed(2) + "s)" +
      (raro ? "   <<< SE MOVIÓ MUCHO: ¿es el mismo plano?" : ""));
    for (const a of p.acciones) {
      if (a.tipo === "AVISO") { console.log("      !! " + a.detalle); continue; }
      if (a.tipo === "params") {
        console.log("      " + a.nota + ": " + a.luego.map((q) => q.nombre + "[" + q.i + "]=" + q.valor).join(" "));
        continue;
      }
      const extra = a.tipo === "efecto"
        ? " + " + a.luego.length + " param(s): " + a.luego.map((q) => q.nombre + "[" + q.i + "]=" + q.valor).join(" ") +
          (a.animados ? " (" + a.animados + " animado(s) NO se reponen)" : "")
        : "";
      console.log("      " + a.verbo + " " + JSON.stringify(a.params).slice(0, 96) + extra);
    }
  }
  /* GUARDA DE COBERTURA: todo clip con trabajo tiene que aparecer en UNA de las tres listas.
   *
   * Existe porque ya se cayó por acá: tres rotaciones quedaron fuera del plan y fuera de "ya
   * estaban" —el dato estaba en `tocado` pero no en `motion`— y la herramienta informó "0 a
   * restaurar" sin decir que tres clips con trabajo se le habían perdido. Un silencio así es
   * peor que un error: parece que no había nada que hacer. */
  {
    const cubiertos = new Set();
    for (const x of plan) cubiertos.add(x.v);
    for (const x of intactos) cubiertos.add(x.v);
    for (const x of sinCasa) cubiertos.add(x.v);
    /* Y además POR PIEZA: un clip puede estar "cubierto" por una acción y perder otra. Pasó con
     * la escala —un clip con escala 50 y un Lumetri quedaba cubierto por el Lumetri y la escala
     * se perdía sin aviso— así que se cuenta cada cosa que el estado marca como no-default. */
    const piezasPerdidas = [];
    for (const c of (S.clips || [])) {
      if (c.intacto === true) continue;
      const enPlan = plan.find((x) => x.v === c);
      const enIntactos = intactos.find((x) => x.v === c);
      if (!enPlan && !enIntactos) continue;          // sinCasa ya se informa aparte
      const cubre = (nom) => {
        const acts = enPlan ? enPlan.acciones : [];
        const ya = enPlan ? (enPlan.yaEstaba || []) : (enIntactos.yaEstaba || []);
        return acts.some((a) => a.params && a.params.param === nom) || ya.some((y) => y.indexOf(nom) === 0);
      };
      for (const m of (c.motion || [])) {
        const esDef = (m.nombre === "Scale") ? m.valor === 100
          : m.nombre === "Rotation" ? m.valor === 0
          : Array.isArray(m.valor) && m.valor[0] === 0.5 && m.valor[1] === 0.5;
        if (esDef || m.keyframes > 0) continue;      // los animados se listan en "a mano"
        if (!cubre(m.nombre)) piezasPerdidas.push(`[${c.indice}] ${c.nombre}: ${m.nombre}=${JSON.stringify(m.valor)}`);
      }
    }
    if (piezasPerdidas.length) {
      console.log("\nERROR DE COBERTURA POR PIEZA — " + piezasPerdidas.length + " valor(es) que el estado");
      console.log("marca como no-default y que el plan NO toca ni declara como ya puestos:");
      for (const x of piezasPerdidas) console.log("  " + x);
      console.log("Es un bug de la herramienta. NO se aplica nada.");
      return;
    }
    const perdidos = (S.clips || []).filter((c) => c.intacto !== true && !cubiertos.has(c));
    if (perdidos.length) {
      console.log("\nERROR DE COBERTURA — " + perdidos.length + " clip(s) con trabajo NO entraron en");
      console.log("ninguna lista. Su trabajo NO se repondría y sin este aviso no se notaría:");
      for (const c of perdidos) {
        console.log("  [" + c.indice + "] " + String(c.nombre).slice(0, 26).padEnd(27) +
          "tenía: " + (c.tocado || []).join("; ").slice(0, 72));
      }
      console.log("Es un bug de la herramienta, no del proyecto. NO se aplica nada.");
      return;
    }
  }
  if (intactos.length) {
    console.log("\nYA ESTABAN — " + intactos.length + ", no se toca nada:");
    for (const t of intactos) {
      console.log("  " + String(t.v.nombre).slice(0, 28).padEnd(29) + "[" + t.destino.indice + "] " +
        t.yaEstaba.join("; ").slice(0, 76));
    }
  }
  if (sinCasa.length) {
    console.log("\nSIN EMPAREJAR — " + sinCasa.length + ", su trabajo manual NO se repone:");
    for (const s of sinCasa) console.log("  " + String(s.v.nombre).slice(0, 30).padEnd(31) + s.razon + " · tenía: " + s.v.tocado.join("; ").slice(0, 70));
  }
  if (aMano.length) {
    console.log("\nA MANO — la API no puede:");
    for (const m of aMano) console.log("  " + m);
  }

  if (sospechosos) {
    console.log("\n" + sospechosos + " clip(s) aparecen a más de " + SOSPECHA + "s de donde estaban.");
    console.log("Puede ser legítimo si se pidió moverlos; si no, el emparejamiento por número de");
    console.log("aparición se corrió y el trabajo caería en el plano de al lado. MIRALOS antes de aplicar.");
  }
  if (!APLICA) {
    console.log("\nNO SE ESCRIBIÓ NADA. Revisá el plan y volvé a correr con --aplicar.");
    return;
  }
  /* Con sospechas, --aplicar NO alcanza: hace falta decirlo explícitamente. Reponer sobre un
   * emparejamiento dudoso deja el Lumetri en el plano equivocado, que no se nota. */
  if (sospechosos && !flag("igual-aplicar")) {
    console.log("\nNO SE APLICÓ: hay " + sospechosos + " emparejamiento(s) dudoso(s).");
    console.log("Revisalos y, si están bien, agregá --igual-aplicar.");
    return;
  }
  if (!plan.length) { console.log("\nNada que reponer."); return; }

  console.log("\nguardado antes: " + String((await enviar("guardar", g({}))).resumen).split("·")[0]);
  let ok = 0, mal = [];
  for (const p of plan) {
    for (const a of p.acciones) {
      if (a.tipo === "AVISO") continue;
      await dormir(PAUSA);
      try {
        /* `tipo: "params"` no tiene llamada principal: el efecto ya está y sólo faltan
         * valores. Mandar `agregarEfecto` acá pondría un segundo Lumetri encima. */
        if (a.verbo === "agregarEfecto") {
          /* `agregarEfecto` opera sobre el clip SELECCIONADO e IGNORA `pista` e `indice`: usa
           * `exigirClip(sequence)`. Llamarlo con pista+indice, como se hacía acá, le pone el
           * efecto a cualquier clip que estuviera seleccionado e informa éxito — un daño
           * silencioso del peor tipo. Encontrado en el proyecto de prueba, el 2026-08-21.
           *
           * Así que hay que SELECCIONAR primero, y después comprobar que el efecto cayó en el
           * clip que se pidió y no en otro. Que el verbo no tire no prueba nada. */
          await enviar("seleccionar", g({ pista: a.params.pista, indice: a.params.indice }), 300000);
          await dormir(PAUSA);
          const r = await enviar("agregarEfecto", g({ efecto: a.params.efecto }), 300000);
          const donde = String(r.clip || "");
          if (donde && norm(donde) !== norm(p.v.nombre)) {
            mal.push(p.v.nombre + " / agregarEfecto: el efecto cayó en \"" + donde + "\", NO en el clip pedido");
            console.log("  ✗ " + p.v.nombre.slice(0, 22).padEnd(23) + "agregarEfecto cayó en \"" + donde + "\"");
            continue;
          }
          console.log("  " + p.v.nombre.slice(0, 22).padEnd(23) + "agregarEfecto: " + String(r.resumen).slice(0, 80));
          ok++;
        } else if (a.verbo) {
          const r = await enviar(a.verbo, a.params, 300000);
          console.log("  " + p.v.nombre.slice(0, 22).padEnd(23) + a.verbo + ": " + String(r.resumen).slice(0, 90));
          ok++;
        } else {
          console.log("  " + p.v.nombre.slice(0, 22).padEnd(23) + (a.nota || "sólo params"));
        }
        /* Los params del efecto van DESPUÉS de agregarlo, y con `fijar` y no `keyframe`:
         * `keyframe` escribe en el playhead y ANIMA, y así quedó una vez una animación de
         * color que nadie pidió. */
        /* SOLO LOS PARAMS QUE DE VERDAD DIFIEREN.
         *
         * Un efecto recien agregado nace con sus defaults, y el estado guardado trae los 12
         * params leidos — de los cuales normalmente 2 estan movidos. Escribir los otros 10 es
         * poner un default sobre su propio default: diez transacciones que no cambian nada, y
         * las rafagas de transacciones son lo que tira Premiere con SIGSEGV.
         *
         * Se relee el efecto recien puesto y se filtra. Un dato menos que escribir es un riesgo
         * menos, y ademas el informe pasa a decir la verdad: "2 valores" y no "12". */
        let pendientes = a.luego || [];
        if (a.verbo === "agregarEfecto" && pendientes.length) {
          await dormir(PAUSA);
          try {
            const r2 = await enviar("efectos", g({ pista: pista, indice: p.destino.indice }), 300000);
            const mio = (r2.efectos || []).find((x) => x.nombre === a.params.efecto);
            if (mio) {
              const actual = new Map();
              for (const nom of new Set(pendientes.map((q) => q.nombre))) {
                await dormir(PAUSA);
                try {
                  const rp = await enviar("param", g({ pista: pista, indice: p.destino.indice,
                                                       efecto: a.params.efecto, param: nom }), 300000);
                  if (typeof rp.valor === "number") actual.set(nom, rp.valor);
                } catch (e) { /* si no se puede leer, se escribe: el lado seguro */ }
              }
              const antes = pendientes.length;
              pendientes = pendientes.filter((q) => !actual.has(q.nombre) || actual.get(q.nombre) !== q.valor);
              console.log(`      de ${antes} params, ${pendientes.length} estan distintos del default`);
            }
          } catch (e) { /* no se pudo comparar: se escriben todos, que es el lado seguro */ }
        }
        for (const q of pendientes) {
          await dormir(PAUSA);
          try {
            /* Por ÍNDICE además del nombre: en Lumetri "Saturation" aparece tres veces —cada
             * grupo anidado tiene el suyo— y `fijar` por nombre agarra el primero. Mandando
             * los dos, el verbo rechaza si no coinciden, que es lo que hace falta cuando la
             * cadena de efectos cambió y el índice guardado ya no apunta a lo mismo. */
            const arg = { pista: pista, indice: p.destino.indice, efecto: a.params.efecto,
                          param: q.nombre, valor: q.valor };
            /* Sólo si el índice se conoce de verdad. Los valores leídos con `param` vienen por
             * NOMBRE y no traen índice; inventar uno mandaría a `fijar` a verificar contra un
             * índice que no se midió, y ahí rechaza o —peor— acierta por casualidad. */
            if (typeof q.i === "number" && q.i >= 0) arg.indiceParam = q.i;
            const rr = await enviar("fijar", arg, 300000);
            /*
             * SE JUZGA POR `quedo`, NO POR QUE NO HAYA TIRADO.
             *
             * `fijar` ya relee el param y contesta `quedo: false` cuando el valor no
             * entró, y acá se contaba `ok++` igual. Los dos casos están medidos en
             * CLAUDE.md y ninguno tira: un param ANIMADO —la escritura va al valor
             * BASE y los keyframes la tapan— y un valor CLAMPEADO (el Wonder Glow
             * pedido en 400 que quedó en 100). Esta herramienta existe para devolver
             * el trabajo manual del editor: contar como repuesto algo que no entró es
             * exactamente el fallo que no se puede permitir.
             *
             * Y el resumen NO se trunca cuando falla: el aviso `NO QUEDÓ COMO SE
             * PIDIÓ` va al FINAL de la línea, así que el `.slice(0, 70)` se lo comía
             * — el dato estaba en la respuesta y no llegaba a la pantalla.
             */
            const entro = rr.quedo !== false;
            console.log("      " + q.nombre + " = " + q.valor + ": " +
              (entro ? String(rr.resumen).slice(0, 70) : String(rr.resumen)));
            if (entro) ok++;
            else mal.push(p.v.nombre + " / " + q.nombre + ": fijar contestó quedo:false — " + String(rr.resumen));
          } catch (e) { mal.push(p.v.nombre + " / " + q.nombre + ": " + (e.message || e)); }
        }
      } catch (e) { mal.push(p.v.nombre + " / " + a.verbo + ": " + (e.message || e)); }
    }
  }
  console.log("\nguardado después: " + String((await enviar("guardar", g({}))).resumen).split("·")[0]);
  console.log("\n" + ok + " operación(es) aplicadas · " + mal.length + " fallaron");
  for (const m of mal) console.log("  ✗ " + m);
  /* No se dice "listo": se dice que hay que releer. Verificar cada paso no verifica la tanda,
   * y ése es el error que este repo cometió en `armarSecuencia` con las capas que se pisaban. */
  console.log("\nAhora RELEER: node quirurgico.js --guardar --pista " + pista + " --a /tmp/despues.json");
  console.log("y comparar contra " + origen + ". Verificar cada paso no verifica la tanda.");
}

(async () => {
  if (flag("guardar")) await guardar();
  else if (flag("reponer")) await reponer();
  else uso("Falta --guardar o --reponer.");
})().catch((e) => { console.error("\nFALLÓ: " + (e && e.message ? e.message : String(e))); process.exit(1); });
