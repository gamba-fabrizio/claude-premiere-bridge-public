#!/usr/bin/env node
/*
 * PROBADO el 2026-09-11, y la prohibicion ANTERIOR queda levantada con un aviso.
 *
 *   3 de 3 corridas ENTERAS limpias sobre una COPIA dun videoclip y la propuesta
 *   real de 88 planos: barrido de V1 con `borrar` (78 y 88 llamadas), los 88 colocados y
 *   releidos en 27 transacciones, guardado antes y despues, `revisar` sin problemas y
 *   Premiere vivo despues de las tres.
 *
 * **SOBRE UN PROYECTO REAL, GUARDA ANTES.** No es formulismo: el fallo original era
 * PROBABILISTICO —se reprodujo 1 de 3 con el codigo viejo— asi que tres corridas limpias
 * no son una garantia. Lo que sube la confianza no es ese numero sino que el mecanismo
 * quedo identificado y reproducido a pedido.
 *
 * ── QUE crasheaba, y estaba en el VERBO y no aca (2026-09-11) ──
 *
 * `colocarLote` corria TODAS sus transacciones adentro de UNA llamada al panel, donde el
 * `dormir(PAUSA)` de esta herramienta no llega: el espaciado real era CERO. Sobre 88
 * planos son 27 transacciones seguidas, y el CLAUDE.md tiene medido que en un proyecto pesado a
 * ~205 ms ya moria en la 22. Arreglado con `MS_ENTRE_TX` (400 ms) entre lotes, en el
 * verbo, con guarda en `test.js` verificada por mutacion.
 *
 * **Y OJO al bisecar: `--por-transaccion 1` es lo PEOR, no lo conservador.** Sobre estos
 * 88 planos da 177 transacciones en vez de 27. Menos acciones por transaccion es MAS
 * transacciones, o sea mas rafaga. Estaba anotado como la opcion prudente y habria
 * empeorado el caso; se descubrio calculandolo, no corriendolo.
 *
 * ── Y LO QUE MAS CAMBIO EL RESULTADO NO FUE EL CODIGO: FUE EL AMBIENTE ──
 *
 * La primera corrida entera con el arreglo YA PUESTO tambien colgo Premiere. Esa copia
 * venia de una manana entera de pruebas —88 clips colocados una docena de veces, in/out
 * limpiados sobre 60 medios, secuencias creadas y borradas, dos cuelgues previos—. Con
 * una copia FRESCA y Premiere recien abierto, las tres corridas salieron limpias.
 *
 * O sea: **un proyecto machacado da resultados que no son del codigo.** Si esta
 * herramienta falla, antes de culpar al codigo hay que preguntarse desde que estado se
 * largo.
 *
 * ── Arreglados el 2026-09-10 ──
 * · `--pista-corte 0` mandaba el audio a A1 y pisaba el tema: ahora rebota.
 * · Los planos fuera de orden borraban la pista: `tareas` se ordena por `desde`.
 * · `desactivar` dejaba sonando el audio de los suplentes: el verbo ya arrastra vinculados.
 *
 * ── PENDIENTE, encontrado probando esto ──
 * El `--limpiar` lee la pista con `clips` adentro de un `try/catch` que convierte un
 * fallo de lectura en `cs = []`, e informa "0 clip(s)" y sigue. Visto en vivo: V1 tenia
 * 88 y dijo 0. Es el contador ciego del CLAUDE.md — un fallo disfrazado de "no hay nada".
 */

/* Arma una secuencia desde una propuesta de montaje en JSON: el corte en una pista y los
 * SUPLENTES en las de arriba, más el tema en A1.
 *
 * Es el hermano de `colocar_sincro.js`, y la diferencia importa: ahí los clips van donde
 * la sincronía manda y no hay elección; acá van donde el montaje los pone, y cada plano
 * puede tener alternativas al lado.
 *
 * ## El corte abajo y los suplentes arriba
 *
 * Decisión del usuario, 2026-08-20. Consecuencia que hay que decir en voz alta: **los
 * suplentes TAPAN el corte**, porque en Premiere gana la pista de arriba. Para ver el corte
 * hay que apagar el ojito de las pistas de suplentes.
 *
 * Por eso, al terminar, **se DESACTIVAN las pistas de suplentes** con el verbo
 * `desactivar`: quedan a la vista en el timeline como opciones y no interfieren con la
 * reproducción. Va una llamada por pista, y cada una es UNA transacción con todos sus
 * clips adentro — sesenta transacciones en ráfaga tiran Premiere con SIGSEGV.
 *
 * Con `--dejar-activos` no se desactiva nada, y entonces hay que apagarles el ojito a las
 * pistas a mano para poder ver el corte.
 *
 * ## Y la velocidad NO se puede poner por API
 *
 * `VideoClipTrackItem` expone `getSpeed` e `isSpeedReversed`, los dos de LECTURA, y sus 9
 * acciones no incluyen ninguna de velocidad. Así que todo entra al 100% y el cambio de
 * velocidad lo hace el usuario a mano. Está reflejado, no supuesto.
 *
 * ## LA PISTA DE AUDIO VA EXPLÍCITA, y esto es lo peligroso
 *
 * El cuarto argumento de `createOverwriteItemAction` es la pista de audio, y con **-1 cae
 * en A1**. Como el overwrite PISA y no solapa, un solo plano insertado con -1 **le borra su
 * tramo al tema**. Por eso cada pista de video tiene su pista de audio propia y el verbo se
 * niega a correr si no las tiene.
 *
 * ## Espaciado 1,2s
 *
 * Una ráfaga de transacciones tira Premiere con SIGSEGV: 200 ms lo tira, 1200 no. Acá son
 * cuatro por plano y pueden ser cientos, así que se guarda antes y después y se relee todo
 * al final.
 *
 * Uso:
 *   node colocar_propuesta.js --datos <propuesta.json> --secuencia VIAJE
 *        [--pista-corte 1] [--suplentes 2] [--tema "TEMA - ..."] [--limpiar] [--simular]
 *
 *   --limpiar         barre TODAS las pistas de video. OJO: se lleva las capas de ajuste
 *                     y los subtítulos si están en pistas de arriba.
 *   --limpiar-pista N barre sólo esa. Es lo que hay que usar para rehacer el corte de una
 *                     secuencia ya terminada.
 */
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

const DATOS = opt("datos", null);
const SEC = opt("secuencia", null);
const PISTA_CORTE = Number(opt("pista-corte", "1"));
/*
 * PISO. El guard de mas abajo es de CANTIDAD —que alcancen las pistas— y no exige que la
 * de audio sea >= 2. Con `--pista-corte 0` (que es lo que uno tipea pensando en indices)
 * `pistaDeVideo` traduce el 0 a V1 EN SILENCIO, cada plano entra con `pistaAudio: 1` = A1,
 * y el overwrite le BORRA su tramo al tema — exactamente el dano que el encabezado de este
 * archivo dice que se esta evitando. Y el `insertar` contesta "quedo en V1 ...", asi que el
 * `/quedo/` de mas abajo lo cuenta como exito e imprime "✓".
 */
if (!Number.isFinite(PISTA_CORTE) || PISTA_CORTE < 1) {
  console.error("`--pista-corte` se cuenta desde 1 y vino \"" + opt("pista-corte", "1") + "\".");
  console.error("Con 0 el audio de cada plano cae en A1 y PISA el tema. No se ejecuto nada.");
  process.exit(1);
}
const MAX_SUP = Number(opt("suplentes", "2"));
const TEMA = opt("tema", null);
const FPS_SEC = Number(opt("fps-secuencia", "25"));
const SIN_LOTE = flag("sin-lote");
const POR_TX = Number(opt("por-transaccion", "10"));
const LIMPIAR = flag("limpiar");
/* `--limpiar-pista N` barre SÓLO esa pista de video. Existe porque `--limpiar` barre TODAS,
 * y en una secuencia terminada eso se lleva la capa de ajuste del color y los subtítulos
 * junto con el corte. Rehacer V1 no tiene por qué destruir V2 y V3. */
const LIMPIAR_PISTA = opt("limpiar-pista", null);
const DEJAR_ACTIVOS = flag("dejar-activos");
const SIMULAR = flag("simular");
if (!DATOS) { console.error("Falta --datos <propuesta.json>"); process.exit(1); }

const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
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
const PAUSA = 300;
const F = 1 / FPS_SEC;
const cuadro = (s) => Math.round(s / F) * F;
const g = (o) => (SEC ? Object.assign({}, o, { secuencia: SEC }) : o);
const tc = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

(async () => {
  const p = JSON.parse(fs.readFileSync(DATOS, "utf8"));
  const planos = p.planos || [];
  if (!planos.length) { console.error("La propuesta no tiene planos."); process.exit(1); }

  /* Duraciones reales del material, para no pedir un out-point que no existe. */
  const durs = {};
  const { execFileSync } = require("child_process");
  const carpetas = [...new Set(planos.map((x) => x.carpeta).filter(Boolean))];
  const buscar = (n) => {
    for (const c of carpetas) { const f = path.join(c, n); if (fs.existsSync(f)) return f; }
    return null;
  };
  const durDe = (n) => {
    if (durs[n] !== undefined) return durs[n];
    const f = buscar(n);
    if (!f) return (durs[n] = null);
    try {
      durs[n] = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries",
        "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim());
    } catch (e) { durs[n] = null; }
    return durs[n];
  };

  /* IN-POINTS. La propuesta dice qué plano y cuánto, no desde dónde. Se reparte:
   * - la primera vez que se usa un clip, se entra al 25% para saltear el arranque, que
   *   suele tener la cámara asentándose;
   * - si el mismo clip se usa otra vez, se corre a otro tramo, así no se repite el mismo
   *   pedazo dos veces;
   * - `entradaMin` respeta lo que la propuesta exija (3591 entra recién a los 20s, que es
   *   donde el patrón del velero sale de cuadro). */
  const usos = {};
  const asignar = (nombre, dura, entradaMin) => {
    const d = durDe(nombre);
    const n = (usos[nombre] = (usos[nombre] || 0) + 1);
    const piso = entradaMin || 0;
    if (!d) return cuadro(piso);
    const util = Math.max(0, d - dura - piso);
    if (util <= 0) return cuadro(piso);
    /* 25%, 55%, 80%… del tramo utilizable, según el número de uso. */
    const fr = [0.25, 0.55, 0.80, 0.05, 0.40, 0.65][(n - 1) % 6];
    return cuadro(piso + util * fr);
  };

  const tareas = [];
  for (const pl of planos) {
    const desde = cuadro(pl.desde), dura = cuadro(pl.dura);
    /* SI LA PROPUESTA TRAE `entrada`, MANDA ELLA. No es un detalle: en material
     * SINCRONIZADO el in-point no se elige, lo determina el offset —para mostrar el
     * segundo T del tema hay que entrar en T menos el offset—. Dejar que `asignar()`
     * lo invente pone la secuencia entera fuera de sincro, y cada plano por un valor
     * distinto, así que no se arregla corriendo nada: hay que rehacerla.
     * `asignar()` queda para el material donde el in-point SÍ es una elección libre,
     * que es el caso de los inserts del viaje. */
    const ent = typeof pl.entrada === "number"
      ? cuadro(pl.entrada)
      : asignar(pl.clip, dura, pl.entradaMin);
    tareas.push({ v: PISTA_CORTE, clip: pl.clip, desde, dura, ent, que: pl.que, rol: "corte" });
    (pl.suplentes || []).slice(0, MAX_SUP).forEach((s, i) => {
      const e = asignar(s, dura, null);
      tareas.push({ v: PISTA_CORTE + 1 + i, clip: s, desde, dura, ent: e,
                    que: "suplente de " + pl.clip.replace(/\.[^.]+$/, ""), rol: "suplente" });
    });
  }
  /*
   * ORDENADAS POR `desde`, y no es cosmetico.
   *
   * `insertar` mete el clip con la duracion COMPLETA del material —minutos— y recien
   * despues se recorta con `editar salida`. Como el overwrite PISA, un plano que llega
   * fuera de orden cubre desde su posicion hasta +duracion_del_material y BORRA todo lo
   * que ya estaba mas adelante en esa pista, con su audio. `tareas` se armaba en el orden
   * en que venian los planos, sin ordenar ni verificar que `desde` fuera creciente: una
   * propuesta agrupada por seccion, con una seccion fuera de lugar, destruia la pista.
   *
   * Ordenadas de menor a mayor cada insert cae siempre sobre espacio que todavia no se
   * uso, y el recorte inmediato de cada plano deja limpio antes del siguiente.
   */
  const desordenadas = tareas.some((t, i) => i > 0 && t.desde < tareas[i - 1].desde);
  if (desordenadas) {
    console.log("  (los planos NO venian en orden cronologico: se ordenan por `desde` antes de colocar)");
  }
  tareas.sort((x, y) => (x.desde - y.desde) || (x.v - y.v));
  const maxV = Math.max(...tareas.map((t) => t.v));

  const est = await enviar("estado");
  console.log("activa: " + est.resumen);
  if (SEC && est.resumen.indexOf(SEC) === -1) {
    console.error("\nLa activa no es \"" + SEC + "\". Activala en Premiere.");
    process.exit(1);
  }
  const hayV = Number((/(\d+) pistas de video/.exec(est.resumen) || [])[1] || 0);
  const hayA = Number((/y (\d+) de audio/.exec(est.resumen) || [])[1] || 0);
  const cortes = tareas.filter((t) => t.rol === "corte").length;
  console.log("\n" + cortes + " plano(s) de corte en V" + PISTA_CORTE + " · " +
    (tareas.length - cortes) + " suplente(s) hasta V" + maxV +
    " · " + tareas.length * 4 + " operaciones ≈ " +
    Math.round(tareas.length * 4 * PAUSA / 60000) + " min");
  /* Cada pista de video necesita SU pista de audio: con -1 el audio cae en A1 y el
   * overwrite le borra el tramo al tema. */
  const necA = maxV + 1;
  console.log("necesita V" + maxV + " y A" + necA + " · hay V" + hayV + " y A" + hayA);
  if (maxV > hayV || necA > hayA) {
    console.error("\nFaltan pistas. La API NO puede crearlas: agregalas a mano");
    console.error("(click derecho en un encabezado de pista → Add Tracks).");
    process.exit(1);
  }

  if (SIMULAR) {
    let sec = null;
    for (const t of tareas.filter((x) => x.rol === "corte")) {
      const pl = planos.find((y) => cuadro(y.desde) === t.desde && y.clip === t.clip);
      if (pl && pl.seccion !== sec) { sec = pl.seccion; console.log("\n— " + sec + " —"); }
      const sup = tareas.filter((x) => x.rol === "suplente" && x.desde === t.desde);
      console.log("  " + tc(t.desde) + "  V" + t.v + " " + t.clip.replace(/\.[^.]+$/, "") +
        "  in " + t.ent.toFixed(2) + " dura " + t.dura.toFixed(2) + "s   " + t.que +
        (sup.length ? "   [sup: " + sup.map((s) => s.clip.replace(/\.[^.]+$/, "") + "→V" + s.v).join(", ") + "]" : ""));
    }
    console.log("\n(simulación: no se tocó nada)");
    return;
  }

  console.log("\nguardado antes: " + String((await enviar("guardar")).resumen).split("·")[0] + "\n");

  /* Limpiar UNA pista: sólo esa, y sin tocar audio — el audio de los clips vive en la
   * pista espejo y se va con el overwrite de los nuevos. */
  if (LIMPIAR_PISTA) {
    const v = Number(LIMPIAR_PISTA);
    let cs = [];
    try { cs = (await enviar("clips", { pista: "V" + v })).clips || []; } catch (e) { cs = []; }
    console.log("limpiando SÓLO V" + v + ": " + cs.length + " clip(s)");
    let saco = 0;
    for (let i = cs.length - 1; i >= 0; i--) {
      await dormir(PAUSA);
      try { await enviar("borrar", g({ pista: "V" + v, indice: i, dejarHueco: true }), 300000); saco++; }
      catch (e) { console.log("  ✗ V" + v + "[" + i + "]: " + String(e.message).slice(0, 80)); }
    }
    const quedan = ((await enviar("clips", { pista: "V" + v })).clips || []).length;
    console.log("  " + saco + " borrado(s), quedan " + quedan + "\n");
    if (quedan) { console.error("V" + v + " no quedó vacía, no sigo."); process.exit(1); }
  }

  if (LIMPIAR) {
    let saco = 0;
    for (let v = 1; v <= hayV; v++) {
      let cs = [];
      try { cs = (await enviar("clips", { pista: "V" + v })).clips || []; } catch (e) { cs = []; }
      for (let i = cs.length - 1; i >= 0; i--) {
        await dormir(PAUSA);
        try { await enviar("borrar", g({ pista: "V" + v, indice: i, dejarHueco: true })); saco++; }
        catch (e) { /* se informa al final por el conteo */ }
      }
      if (cs.length) console.log("  V" + v + ": " + cs.length + " fuera");
      await dormir(PAUSA);
    }
    /* Audio de A2 en adelante: A1 NO se toca, ahí va el tema. */
    for (let aa = 2; aa <= hayA; aa++) {
      let cs = [];
      try { cs = (await enviar("clips", { pista: "A" + aa })).clips || []; } catch (e) { cs = []; }
      for (let i = cs.length - 1; i >= 0; i--) {
        await dormir(PAUSA);
        try { await enviar("borrar", g({ pista: "A" + aa, indice: i, dejarHueco: true })); saco++; }
        catch (e) { }
      }
      if (cs.length) console.log("  A" + aa + ": " + cs.length + " fuera");
      await dormir(PAUSA);
    }
    console.log("  " + saco + " borrado(s)\n");
  }

  /* El tema primero, en A1 y solo. Si ya está, no se repite. */
  if (TEMA) {
    let ya = [];
    try { ya = (await enviar("clips", { pista: "A1" })).clips || []; } catch (e) { }
    if (ya.length) {
      console.log("A1 ya tiene " + ya.length + " clip(s) (" + ya[0].nombre.slice(0, 30) + "), no se toca\n");
    } else {
      await dormir(PAUSA);
      const r = await enviar("insertar", g({ medio: TEMA, pistaAudio: 1, segundos: 0 }));
      console.log("tema → A1: " + String(r.resumen).slice(0, 110) + "\n");
      await dormir(PAUSA);
    }
  }

  const puestos = [];

  /*
   * POR LOTES, que es lo que saca a esta herramienta de la prohibicion.
   *
   * El camino viejo hace CINCO llamadas por plano —insertar, clips y tres `editar`— y cada
   * `editar` recorre el timeline DOS veces: `ubicarClip` (un getName por item de todas las
   * pistas) y `buscarVinculados` (un getStartTime por item). Sobre 88 planos son 352
   * operaciones y ~139.000 llamadas. CLAUDE.md tiene medido que veinte mil en rafaga
   * crashearon Premiere con el proyecto real abierto.
   *
   * `colocarLote` no las necesita: pone los in/out en el ProjectItem ANTES del overwrite,
   * asi que el clip entra YA RECORTADO y en su lugar. Las `tareas` mapean directo —
   * medio←clip, desde←ent, hasta←ent+dura, en←desde— y el verbo reparte los lotes solo para
   * no meter dos fragmentos del mismo medio en la misma transaccion, que es su unico modo
   * de fallo conocido: el in/out vive en el MEDIO, que es compartido.
   *
   * `--sin-lote` vuelve al camino viejo entero, para poder retroceder sin editar codigo.
   */
  if (!SIN_LOTE) {
    const porPista = {};
    for (const t of tareas) (porPista["V" + t.v] = porPista["V" + t.v] || []).push(t);
    for (const et of Object.keys(porPista)) {
      const ts = porPista[et];
      const frags = ts.map((t) => ({ medio: t.clip, desde: t.ent, hasta: t.ent + t.dura, en: t.desde }));
      try {
        const rl = await enviar("colocarLote", g({ pista: et, pistaAudio: Number(et.slice(1)) + 1,
          fragmentos: frags, porTransaccion: POR_TX }), 900000);
        console.log("  " + String(rl.resumen).slice(0, 165));
        /* Se cuenta lo que el verbo RELEYO, no lo que se pidio. Si no entraron todos no se
           adivina cuales: se informa y la verificacion final de abajo los nombra. */
        if (rl.colocados === frags.length) puestos.push.apply(puestos, ts);
        else console.log("  ✗ " + et + ": " + rl.colocados + " de " + frags.length +
                         " — la verificacion final dice cuales");
      } catch (e) {
        console.log("  ✗ " + et + ": " + String(e.message || e).slice(0, 140));
      }
      await dormir(PAUSA);
    }
  }

  let i = 0;
  for (const t of (SIN_LOTE ? tareas : [])) {
    i++;
    const etq = String(i).padStart(3) + "/" + tareas.length + " " +
      t.clip.replace(/\.[^.]+$/, "") + " → V" + t.v + " @" + tc(t.desde);
    try {
      const r1 = await enviar("insertar", g({ medio: t.clip, pista: t.v,
        pistaAudio: t.v + 1, segundos: t.desde }), 300000);
      if (!/quedó/.test(String(r1.resumen))) throw new Error(String(r1.resumen).slice(0, 120));
      /* Índice del clip recién puesto: es el que arranca en `desde`. */
      const cs = (await enviar("clips", { pista: "V" + t.v })).clips || [];
      let ix = cs.findIndex((c) => Math.abs(c.desde - t.desde) < 0.03);
      if (ix === -1) ix = cs.length - 1;
      if (t.ent > 0) {
        await dormir(PAUSA);
        await enviar("editar", g({ pista: "V" + t.v, indice: ix, entrada: t.ent }), 300000);
      }
      await dormir(PAUSA);
      await enviar("editar", g({ pista: "V" + t.v, indice: ix, salida: t.ent + t.dura }), 300000);
      await dormir(PAUSA);
      await enviar("editar", g({ pista: "V" + t.v, indice: ix, desde: t.desde }), 300000);
      puestos.push(t);
      if (i % 10 === 0 || i === tareas.length) console.log("  ✓ " + etq);
    } catch (e) {
      console.log("  ✗ " + etq + "  " + String(e.message || e).slice(0, 110));
    }
    await dormir(PAUSA);
  }

  console.log("\n" + puestos.length + " de " + tareas.length + " colocado(s)");

  /* Los suplentes se desactivan: si quedan activos TAPAN el corte y la secuencia no se
   * puede ver. Una llamada por pista, cada una una sola transacción. */
  if (!DEJAR_ACTIVOS && maxV > PISTA_CORTE) {
    console.log("");
    for (let v = PISTA_CORTE + 1; v <= maxV; v++) {
      await dormir(PAUSA);
      try {
        const r = await enviar("desactivar", g({ pista: "V" + v }), 300000);
        console.log("  " + String(r.resumen).slice(0, 150));
      } catch (e) {
        console.log("  ✗ V" + v + " sin desactivar: " + String(e.message).slice(0, 100) +
          "\n    (¿falta el Reload en UDT? El verbo `desactivar` es nuevo.)");
      }
    }
  }
  await dormir(PAUSA);
  console.log("guardado después: " + String((await enviar("guardar")).resumen).split("·")[0]);

  /* VERIFICACIÓN DE AFUERA. Que cada insert no haya tirado no prueba nada: el overwrite
   * PISA, así que un plano mal ubicado se come al anterior y los dos "salieron bien". */
  console.log("\nverificando:");
  let mal = 0;
  for (let v = PISTA_CORTE; v <= maxV; v++) {
    /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
     * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
     * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
     * recien insertado, con solo los ~203ms del transporte en el medio. */
    const cs = (await enviar("clips", { pista: "V" + v })).clips || [];
    const esp = tareas.filter((t) => t.v === v);
    let ok = 0;
    for (const t of esp) {
      const c = cs.find((x) => Math.abs(x.desde - t.desde) < 0.05 &&
        x.nombre.replace(/\.[^.]+$/, "") === t.clip.replace(/\.[^.]+$/, ""));
      if (c && Math.abs(c.dura - t.dura) < 0.09) ok++;
      else mal++;
    }
    console.log("  V" + v + ": " + cs.length + " clip(s) · " + ok + " de " + esp.length + " como se pidió");
  }
  /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
   * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
   * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
   * recien insertado, con solo los ~203ms del transporte en el medio. */
  const a1 = (await enviar("clips", { pista: "A1" })).clips || [];
  console.log("  A1: " + a1.length + " clip(s)" + (a1.length ? " — " + a1[0].nombre.slice(0, 28) +
    " " + a1[0].dura.toFixed(1) + "s" : " ← OJO, el tema no está"));
  /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `revisar` no transacciona
   * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
   * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
   * recien insertado, con solo los ~203ms del transporte en el medio. */
  console.log("\n" + (await enviar("revisar")).resumen);
  if (mal) { console.log("\nOJO: " + mal + " plano(s) NO quedaron como se pidió."); process.exit(1); }
  console.log("\ntodo verificado.");
})();
