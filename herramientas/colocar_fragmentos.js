#!/usr/bin/env node
/* Coloca los fragmentos elegidos en una secuencia.
 *
 * ## OJO: la escala se INFORMA, no se aplica
 *
 * El encabezado decia "y escala cada clip para que llene el alto" y **eso es falso**: no hay una
 * sola llamada a `escala` ni a `fijar` en todo el archivo. La cuenta de abajo se calcula y se
 * imprime en una columna del informe, nada mas; escalar es un paso aparte (`escalaFija`).
 *
 * Vale contarlo porque es exactamente el error que este repo ya pago: un comentario que describe
 * la INTENCION en vez del codigo. La vez anterior fue el encabezado de `radiografia` afirmando
 * que leia los params adentro de un `lockedAccess` cuando los pedia afuera de a uno, y eso
 * habilito un crash. Aca el dano habria sido al reves — creer que ya escalo y no escalar.
 *
 * Y la cuenta esta CABLEADA A 1920x1080. En una secuencia 4K —el rough cut de un videoclip es
 * 3840x2160— daria la mitad de lo que corresponde. Si algun dia se aplica de verdad, el tamano
 * de la secuencia tiene que salir de `estado`, no de dos numeros escritos aca.
 *
 * ## La cuenta de la escala, para que sirve el informe
 *
 * El material es video de WhatsApp: 85 de 108 clips son VERTICALES y de resolucion chica
 * (478x850 el mas comun). La secuencia es 1920x1080. En Premiere un clip entra al 100% de
 * Motion en pixeles 1:1, asi que un 478x850 aparece como una estampilla en el medio del cuadro.
 *
 *     escala = min(1920/ancho, 1080/alto) x 100
 *
 * Para un vertical de 478x850 da 127% -> llena el alto, deja franjas al costado, y amplia
 * apenas 1,27x, asi que NO se ve blando. Para los 16:9 de 1024x576 da 187,5% y llena exacto.
 * El fondo de las franjas lo pone el usuario despues; el clip solo se centra y se escala.
 *
 * ## Lo que ya costo caro en este repo y aca se respeta
 *
 * - **Espaciado 1,2s entre transacciones.** Una rafaga las tira con SIGSEGV: 200 ms lo tira,
 *   1200 no. Y `guardar` va ANTES y DESPUES, no solo al final: tres veces fue lo unico que
 *   hizo que un crash costara cero.
 * - **`pistaAudio` explicito, NUNCA -1.** Con -1 el audio cae en A1 y el overwrite PISA, asi
 *   que borraria lo que hubiera ahi. Cada pista de video manda su audio a la de al lado.
 * - **Se lee lo que devuelve cada verbo.** `insertar` contesta que encontro; darlo por bueno
 *   sin mirar es el error mas caro de este repo.
 * - **Se relee TODO al final.** Verificar cada paso no verifica la tanda.
 *
 * Uso:
 *   node armar.js --corte corte_video1.json --secuencia "VIDEO 1" [--simular]
 */
const path = require("path");
const fs = require("fs");
const BR = require("path").join(__dirname, "..", "server", "bridge.js");
const { enviar } = require(BR);
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;
const CORTE = opt("corte", null);
const SEC = opt("secuencia", null);
const PISTA = Number(opt("pista", "1"));
const SIMULAR = flag("simular");
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
/*
 * COLOCAR POR LOTES: `colocarLote` mete N fragmentos en 2 transacciones en vez de 3
 * POR fragmento. Sobre 88 planos eso es ~19 transacciones contra ~264.
 *
 * El default es 10 —el TOPE medido; con 50 Premiere dejo de responder— y no 1, porque
 * el punto del cambio es la velocidad. `--sin-lote` vuelve al camino viejo entero, y
 * `--por-transaccion N` lo baja sin apagarlo: los dos existen para poder retroceder si
 * un armado real sale raro, sin editar codigo.
 *
 * NO TODOS los fragmentos pueden ir por ahi. Ver la particion mas abajo.
 */
const SIN_LOTE = args.indexOf("--sin-lote") !== -1;
const POR_TX = Number(opt("por-transaccion", "10"));
/* La grilla de la SECUENCIA. Estaba hardcodeada en 25 y eso rompe la sincro en un proyecto a
 * otro frame rate: en un multicamara —secuencia y material a 50fps— cuantizar a 40ms movio el `desde` de
 * 95,74 a 95,76 y la `entrada` de 99,76 a 99,76, con lo que el desfase quedo en 4,00 cuando el
 * del clip es 4,02. Un cuadro de desincronizacion, en cinco de once clips, y NO avisa: el clip
 * mide lo mismo, no hay hueco ni solape y `revisar` no lo ve.
 * Default 25 para no cambiar nada de lo que ya andaba. */
const FPS = Number(opt("fps", "25")), F = 1 / FPS;
/* La pista de audio NO siempre puede espejar la de video. El default sigue siendo PISTA+1
 * --que es lo que hacia antes y lo que corresponde cuando cada video manda su audio al lado--
 * pero en una secuencia con menos pistas de audio que de video ese indice no existe: en el
 * curso de un curso las placas van a V4 de una secuencia con 3 pistas de audio. Es una opcion y
 * no una deduccion porque cual esta libre lo sabe quien mira el timeline, no este script.
 * Lo que sigue prohibido es -1: cae en A1 y el overwrite PISA lo que haya ahi. */
const PISTA_AUDIO = Number(opt("pistaAudio", String(Number(opt("pista", "1")) + 1)));
if (!(PISTA_AUDIO >= 1)) { console.error("--pistaAudio tiene que ser >= 1 (nunca -1: cae en A1 y pisa)"); process.exit(1); }
const BIN = opt("bin", "MATERIAL");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
if (!CORTE || !SEC) { console.error("Faltan --corte y --secuencia"); process.exit(1); }

const RAIZ = path.dirname(path.resolve(CORTE));
/* EL PROYECTO SE DEDUCE, no se pasa por flag.
 *
 * El bridge opera sobre el proyecto que tiene FOCO en Premiere, y ningún verbo dice cuál es.
 * Ya pasó: el foco cambió al proyecto de prueba y se interrogó otro creyendo que contestaba
 * sobre éste. Fueron lecturas y no hubo daño; un `--limpiar` con la misma confusión habría
 * barrido el timeline del proyecto equivocado.
 *
 * Se busca el .prproj al lado del corte y su nombre se manda como guarda en cada llamada. Una
 * guarda que hay que acordarse de pasar es una guarda que no va a estar cuando haga falta. */
function buscarProyecto(dir) {
  for (const d of [dir, path.join(dir, "Proyecto")]) {
    try {
      const f = fs.readdirSync(d).find((x) => x.toLowerCase().endsWith(".prproj"));
      if (f) return f.replace(/\.prproj$/i, "");
    } catch (e) { /* no existe: se sigue */ }
  }
  return null;
}
const PROYECTO = opt("proyecto", buscarProyecto(RAIZ));
if (!PROYECTO) {
  console.error("No encontré un .prproj al lado del corte ni en ./Proyecto. Pasá --proyecto <nombre>.");
  process.exit(1);
}
/* Toda llamada lleva la guarda. `g()` la agrega sin que haya que repetirla en cada sitio. */
const g = (o) => Object.assign({ proyecto: PROYECTO }, o);
/* La carpeta del material es OPCIONAL, y no encontrarla no es un error.
 *
 * Sirve para dos cosas: importar lo que falte y medir dimensiones para informar la escala. En un
 * REARMADO los medios ya estan en el proyecto, asi que ninguna de las dos hace falta. Antes esto
 * hacia `readdirSync` a ciegas y el proceso moria con ENOENT sobre una carpeta que no tenia por
 * que existir. */
const MATERIAL = opt("material", path.join(RAIZ, "VIDEOS"));
const HAY_MATERIAL = fs.existsSync(MATERIAL) && fs.statSync(MATERIAL).isDirectory();
const VIDEOS = MATERIAL;
const J = JSON.parse(fs.readFileSync(CORTE, "utf8"));
/* Acepta las dos formas: `fragmentos` (un corte armado a mano) y `planos` (una propuesta que
 * salio de `desde_secuencia.js`). Son el mismo dato con otro nombre, y pedir que coincidan
 * obliga a un paso de traduccion que no aporta nada. */
const frags = J.fragmentos || J.planos || [];
if (!frags.length) { console.error("El corte no tiene fragmentos."); process.exit(1); }

/* Ruta y dimensiones de cada medio. Las dimensiones se miden con ffprobe, no se asumen: en
 * este material hay doce combinaciones distintas de ancho x alto. */
const cache = new Map();
function medio(nombre) {
  if (cache.has(nombre)) return cache.get(nombre);
  let ruta = null;
  if (HAY_MATERIAL) {
    /*
     * DOS NIVELES DE SUBCARPETAS, no uno.
     *
     * Con uno solo alcanzaba para material agrupado por dia. El corte REAL de un videoclip lo desmintio
     * el 2026-09-05: los planos de los musicos viven en
     * `INSTRUMENTOS/Percu (sin playback ni musica)/C0012.MP4`, o sea a dos,
     * y la herramienta rebotaba la tanda entera por 16 archivos "no encontrados" que estaban ahi.
     *
     * Rebotar era lo correcto —mejor eso que colocar 72 de 88— pero la busqueda estaba corta. Es
     * `readdir`, no `find`: dos niveles sobre una carpeta de material cuestan milisegundos, y no
     * se baja a tres porque ahi ya se empieza a pagar en un disco lento.
     */
    const cands = [path.join(VIDEOS, nombre)];
    const dirsDe = (base) => {
      try { return fs.readdirSync(base).filter((g) => {
        try { return fs.statSync(path.join(base, g)).isDirectory(); } catch (e) { return false; }
      }); } catch (e) { return []; }
    };
    for (const g of dirsDe(VIDEOS)) {
      const sub = path.join(VIDEOS, g);
      cands.push(path.join(sub, nombre));
      for (const h of dirsDe(sub)) cands.push(path.join(sub, h, nombre));
    }
    ruta = cands.find((p) => fs.existsSync(p)) || null;
  }
  let w = null, h = null;
  if (ruta) {
    try {
      const o = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", ruta], { encoding: "utf8" }).trim();
      const p = o.split(",");
      w = Number(p[0]); h = Number(p[1]);
    } catch (e) { /* queda en null y se informa */ }
  }
  const r = { ruta, w, h, escala: w && h ? Math.round(Math.min(1920 / w, 1080 / h) * 1000) / 10 : null };
  cache.set(nombre, r);
  return r;
}

/* Los tiempos van en frames enteros de la secuencia. Un valor a medio frame deja huecos de
 * medio frame, que es la firma de un corte entre frames y ya costo una tanda entera. */
const cuadro = (t) => Number((Math.round(t / F) * F).toFixed(3));

/* SI EL FRAGMENTO TRAE `desde`, MANDA EL SUYO.
 *
 * Hay dos usos y son distintos. Armar un video nuevo: los fragmentos van pegados uno tras otro
 * y la posicion la calcula el cursor. REARMAR una secuencia existente: cada clip tiene que
 * volver a DONDE ESTABA, huecos incluidos — colocarlos pegados cambiaria el corte, que es
 * justamente lo que un rearmado no debe hacer.
 *
 * Se decide por dato, no por flag: si el JSON trae `desde`, se respeta. */
let cursor = 0;
const plan = [];
const respetaPos = frags.some((f) => typeof f.desde === "number");
for (const fr of frags) {
  const m = medio(fr.clip);
  const dura = cuadro(fr.dura);
  if (dura < F) continue;
  const desde = typeof fr.desde === "number" ? cuadro(fr.desde) : cuadro(cursor);
  /* SIN `entrada` EN EL JSON, EL IN-POINT ES EL QUE TENGA EL CLIP.
   *
   * No es lo mismo que `entrada: 0`. Los medios SINTETICOS --Transparent Video, y tambien un
   * PNG fijo-- son generadores de una hora y el clip nace POR EL MEDIO: entrada 3600. Pedirles
   * entrada 0 y salida `dura` cae antes del in-point, Premiere lo ignora EN SILENCIO y el clip
   * se queda con su duracion por defecto (5s para una imagen). Ya paso con doce marcadores.
   *
   * Asi que cuando el JSON no trae `entrada` se LEE la del clip recien insertado y la salida se
   * calcula sobre esa. Y 3600 no se asume: se lee, porque no vale para cualquier medio. */
  plan.push({ ...fr, desde, dura, entrada: typeof fr.entrada === "number" ? cuadro(fr.entrada) : null, medio: m });
  cursor = Math.max(cursor, desde + dura);
}
plan.sort((a, b) => a.desde - b.desde);
console.log(respetaPos ? "posiciones DEL JSON (rearmado fiel)" : "posiciones calculadas (armado nuevo)");
const faltan = plan.filter((p) => !p.medio.ruta);
const sinDim = plan.filter((p) => p.medio.ruta && !p.medio.escala);

console.log(`${J.video} -> secuencia "${SEC}"`);
console.log(`${plan.length} fragmentos · ${(cursor / 60).toFixed(1)} min\n`);
console.log("bloque".padEnd(24) + "desde".padStart(7) + "dura".padStart(6) + "    entrada".padEnd(11) +
            " escala   clip");
let bloque = null;
for (const p of plan) {
  if (p.bloque && p.bloque !== bloque) { bloque = p.bloque; console.log("  " + bloque); }
  console.log("".padEnd(24) + String(p.desde).padStart(7) + String(p.dura).padStart(6) +
    String(p.entrada === null ? "la del clip" : p.entrada).padStart(11) + "  " +
    (p.medio.escala ? (p.medio.escala + "%").padStart(6) : "   ?  ") + "  " +
    `${p.medio.w}x${p.medio.h}`.padEnd(9) + " " + p.clip.slice(-26));
}
if (faltan.length) {
  console.log(`\nNO SE ENCONTRO EL ARCHIVO de ${faltan.length}:`);
  for (const p of faltan) console.log("   " + p.clip);
}
if (sinDim.length) {
  console.log(`\nSIN DIMENSIONES LEGIBLES (${sinDim.length}), no se puede escalar:`);
  for (const p of sinDim) console.log("   " + p.clip);
}
if (SIMULAR) { console.log("\n--simular: no se toco nada."); process.exit(faltan.length ? 1 : 0); }
if (faltan.length && HAY_MATERIAL) { console.error("\nNO SE APLICA: faltan archivos."); process.exit(1); }
if (!HAY_MATERIAL) {
  console.log(`\nSin carpeta de material (${MATERIAL}): no importo nada y no puedo informar escalas.`);
  console.log("Para un REARMADO esta bien — los medios ya estan en el proyecto. Si falta alguno,");
  console.log("`insertar` lo va a decir y el clip no se coloca.");
}

(async () => {
  const est = await enviar("estado", g({}));
  if (String(est.resumen).indexOf(SEC) === -1) {
    console.error(`\nLa secuencia activa no es "${SEC}": ${String(est.resumen).split("·")[0]}`);
    console.error("Activala en Premiere (o con el verbo `secuencias`) y volve a correr.");
    process.exit(1);
  }
  console.log("\nguardado antes: " + String((await enviar("guardar")).resumen).split("·")[0]);

  /* Con --limpiar se barre la pista de video ANTES de armar. Se borra de atras para adelante:
   * de adelante para atras los indices se corren y se saltea uno cada vez. Y `borrar` arrastra
   * el audio vinculado, que es lo que se quiere — sin eso queda audio huerfano en A1. */
  /* SIN `--limpiar`, ARMAR SOBRE UNA PISTA CON CONTENIDO NO PISA: ENCIMA.
   *
   * Costo una tanda entera el 2026-08-22. Se corrio sin el flag sobre V1 con 95 clips y quedaron
   * **183**: 95 + 88. La razon esta dos comentarios mas abajo y es facil de pasar por alto —
   * cada clip se inserta en el LIMBO, donde el overwrite no pisa nada real, y despues se MUEVE a
   * su lugar con `createMoveAction`, que **SOLAPA, no pisa**. Asi que el armado nuevo queda
   * encimado sobre el viejo en la misma pista.
   *
   * El informe final lo agarro —"relectura de V1: 183 clips" y 20 duraciones que no coincidian—
   * pero recien al terminar, despues de ~360 transacciones. Por eso ahora se chequea ANTES: si
   * la pista tiene contenido y no vino `--limpiar`, no se toca nada y se dice por que.
   *
   * No se limpia solo a proposito: barrer una pista es destructivo y tiene que pedirse. */
  {
    const cs = (await enviar("clips", g({ pista: "V" + PISTA }))).clips || [];
    if (cs.length && !flag("limpiar")) {
      console.error(`\nV${PISTA} tiene ${cs.length} clip(s) y no vino --limpiar.`);
      console.error("Armar asi NO los reemplaza: los clips se mueven a su lugar con");
      console.error("createMoveAction, que SOLAPA en vez de pisar, y quedarian los dos armados");
      console.error(`encimados (ya paso: 95 + 88 = 183 clips en una pista).`);
      console.error("\n  para reemplazar el contenido:  agregá --limpiar");
      console.error("  para armar en una pista libre:  --pista <n> de una vacia\n");
      process.exit(1);
    }
  }

  if (flag("limpiar")) {
    let cs = (await enviar("clips", g({ pista: "V" + PISTA }))).clips || [];
    console.log(`  limpiando V${PISTA}: ${cs.length} clip(s)`);
    let saco = 0;
    for (let i = cs.length - 1; i >= 0; i--) {
      await dormir(PAUSA);
      try { await enviar("borrar", g({ pista: "V" + PISTA, indice: i, dejarHueco: true }), 300000); saco++; }
      catch (e) { console.log(`   ✗ no se pudo borrar [${i}]: ${String(e.message || e).slice(0, 60)}`); }
    }
    /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
     * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
     * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
     * recien insertado, con solo los ~203ms del transporte en el medio. */
    const quedan = ((await enviar("clips", g({ pista: "V" + PISTA }))).clips || []).length;
    console.log(`  saque ${saco}, quedan ${quedan}`);
    if (quedan) { console.error("  NO SE VACIO: aborto para no armar encima."); process.exit(1); }
  }

  /* Importar SOLO lo que se usa. Se saltea lo que ya esta: `importFiles` NO deduplica y crea
   * otro ProjectItem por cada llamada, sin romper nada visible. */
  /* `importar` toma RUTAS ABSOLUTAS en `archivos`, y nada mas. Pasarle nombres pelados con una
   * `carpeta` aparte no falla: el verbo ignora lo que no conoce, `importFiles` acepta la lista
   * invalida y no importa nada. Ya paso — "no esta en el proyecto ninguno de los 2 pedidos". */
  const rutas = HAY_MATERIAL ? [...new Set(plan.map((p) => p.medio.ruta).filter(Boolean))] : [];

  /* GUARDA DE COLISION DE NOMBRES, y es la mas cara que pago esta herramienta.
   *
   * `importar` decide "ya esta" por NOMBRE y no por ruta, asi que un archivo homonimo que vive en
   * OTRA carpeta se saltea en silencio — informa "ya estaban"— y despues `insertar`, que tambien
   * busca por nombre, agarra el medio VIEJO. La herramienta informa exito porque verifica posicion
   * y duracion, NUNCA que medio quedo.
   *
   * Medido el 2026-08-27: los subtitulos de dos temas se llamaban los dos `sub_NNN.png`. De 42
   * clips, 38 quedaron mostrando el texto del OTRO tema y los 4 ultimos —que no tenian homonimo—
   * salieron bien. Esa asimetria fue la unica pista, y aparecio mirando un cuadro: ni `revisar`, ni
   * la relectura de la pista, ni el "42 de 42" dijeron nada.
   *
   * Por eso se compara la RUTA, que `medios` si devuelve. Se pide con `buscar` —el parametro se
   * llama asi, `filtro` se descarta en silencio— sobre el prefijo comun de los nombres. */
  if (rutas.length) {
    const base = (r) => String(r).split("/").pop();
    const nombres = rutas.map(base);
    let pref = nombres[0];
    for (const n of nombres) { while (pref && !n.startsWith(pref)) pref = pref.slice(0, -1); }
    /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `medios` no transacciona
     * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
     * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
     * recien insertado, con solo los ~203ms del transporte en el medio. */
    const r = await enviar("medios", g({ buscar: pref || nombres[0] }), 300000);
    /*
     * NORMALIZAR UNICODE ANTES DE COMPARAR, en el nombre Y en la ruta.
     *
     * macOS y Premiere entregan los acentos en normalizaciones distintas —"ú" como un punto de
     * codigo (NFC) o como "u" mas tilde combinante (NFD)— asi que dos rutas que se ven IDENTICAS
     * dan `false` con `!==`. Medido el 2026-09-05 con el corte real de un videoclip, cuyo material vive
     * bajo una ruta con un acento en el nombre:
     *
     *     de Premiere   2f 4d 75 cc81 …    "Mu" + tilde combinante
     *     del disco     2f 4d c3ba   …     "M"  + u con tilde
     *
     * Sin normalizar, la guarda de colision aborta la tanda entera declarando un choque que NO
     * existe: dice "quiero X, ya esta X" con las dos lineas iguales en pantalla. Y es el peor
     * resultado posible para una guarda — rechazar lo correcto — sobre CUALQUIER proyecto con un
     * acento en la ruta, que en castellano es la mitad.
     *
     * El arreglo ya existia en el repo (`norm`/`igualN` en `buscarMedio`, `insertar`, `ubicarClip`
     * e `importar`) y a esta comparacion no se le habia aplicado: una regla implementada en un
     * lugar no se aplica sola al de al lado.
     */
    const norm = (x) => String(x == null ? "" : x).normalize("NFC");
    const yaEsta = {};
    for (const m of r.medios || []) if (m && m.nombre) yaEsta[norm(m.nombre)] = norm(m.ruta);
    const choque = rutas.filter((ru) => yaEsta[norm(base(ru))] && yaEsta[norm(base(ru))] !== norm(ru));
    if (choque.length) {
      console.error(`\n  ${choque.length} archivo(s) chocan de NOMBRE con medios que ya estan en el ` +
                    `proyecto y vienen de OTRA carpeta.`);
      for (const ru of choque.slice(0, 5)) {
        console.error(`    ${base(ru)}`);
        console.error(`      quiero : ${ru}`);
        console.error(`      ya esta: ${yaEsta[norm(base(ru))]}`);
      }
      console.error("\n  importar los saltearia por nombre e insertar agarraria el VIEJO, con la\n" +
                    "  herramienta informando exito. Renombra los tuyos con un prefijo propio.");
      process.exit(1);
    }
    if (r.total && r.total > (r.medios || []).length) {
      console.log(`  OJO: el chequeo de colision vio ${(r.medios || []).length} de ${r.total} medios, ` +
                  `asi que es PARCIAL.`);
    }
  }

  for (let k = 0; k < rutas.length; k += 12) {
    const lote = rutas.slice(k, k + 12);
    await dormir(PAUSA);
    const r = await enviar("importar", g({ archivos: lote, bin: BIN }), 600000);
    console.log(`  importar ${k + 1}-${k + lote.length} de ${rutas.length}: ` + String(r.resumen).slice(0, 100));
  }

  /* CADA FRAGMENTO EN TRES PASOS, Y EN UNA ZONA VACIA PRIMERO.
   *
   * `insertar` usa `createOverwriteItemAction`, que PISA y no solapa. Y recortar la entrada
   * MUEVE el clip (`createSetInPointAction` lo corre). Asi que si insertara el fragmento N
   * directamente en su lugar final, al recortarlo se movería encima del N-1 y lo borraría.
   *
   * Por eso: se inserta en un limbo lejos del final, se recorta ahi donde no hay nada que
   * pisar, y despues se mueve a su posicion. Tres transacciones por fragmento, espaciadas.
   *
   * Y `salida` es un punto DE FUENTE, no una duracion: es entrada + cuanto se quiere. Pedir
   * `salida: dura` cae antes del in-point, Premiere lo ignora EN SILENCIO y el clip queda con
   * su largo original. Ya paso, y doce marcadores quedaron mal por eso. */
  const LIMBO = Math.max(600, cursor + 120);   // despues del final REAL, no de la suma de duraciones
  const puestos = [], fallados = [];

  /*
   * LA PARTICION, y no es una optimizacion: es el unico reparto correcto.
   *
   * `colocarLote` pone los in/out en el ProjectItem ANTES del overwrite, asi que necesita
   * saber el punto de fuente de antemano. Cuando el fragmento NO trae `entrada`, el camino
   * viejo lo AVERIGUA leyendo el in-point del clip recien insertado — y eso no es lo mismo
   * que `entrada: 0`: un PNG o un Transparent Video entran con in-point ~3600, y asumir cero
   * ya dejo doce placas de partitura con su duracion por defecto. Sin clip insertado no hay
   * de donde leerlo, asi que esos fragmentos siguen por el camino de tres pasos.
   *
   * En la practica casi todos traen `entrada`: `desde_secuencia.js` la lleva siempre desde
   * que se arreglo el round-trip.
   */
  const porLote = SIN_LOTE ? [] : plan.filter((p) => p.entrada !== null && p.entrada !== undefined);
  const porPaso = plan.filter((p) => porLote.indexOf(p) === -1);
  console.log(`\ncolocando: ${porLote.length} por LOTE (de hasta ${POR_TX}) · ` +
              `${porPaso.length} por el camino de tres pasos` +
              (SIN_LOTE ? "  [--sin-lote: el lote esta APAGADO]" : "") +
              (porPaso.length && !SIN_LOTE ? "  (los de tres pasos son los que no traen `entrada`)" : ""));

  if (porLote.length) {
    await dormir(PAUSA);
    const frags = porLote.map((p) => ({
      medio: p.clip, en: p.desde,
      desde: p.entrada, hasta: Number((p.entrada + p.dura).toFixed(3))
    }));
    try {
      const rl = await enviar("colocarLote", g({ pista: PISTA, pistaAudio: PISTA_AUDIO,
                                                 fragmentos: frags, porTransaccion: POR_TX }), 900000);
      console.log("  " + String(rl.resumen).replace(/ · /g, "\n  · "));
      /* EL VEREDICTO ES EL DEL VERBO, que ya releyo la pista: `colocados` sale de comparar
       * cada fragmento contra el estado, no de que la transaccion no haya tirado. */
      const malPorNombre = {};
      for (const m of (rl.mal || [])) malPorNombre[m] = true;
      if (rl.colocados === porLote.length) puestos.push(...porLote);
      else {
        /* No se sabe CUALES fallaron sin cruzar, asi que la relectura final —que ya existe y
         * mira los tres— es la que manda. Aca solo se registra el faltante. */
        puestos.push(...porLote);
        fallados.push({ p: { clip: "(lote)", desde: 0 },
                        por: `colocarLote: ${rl.colocados} de ${porLote.length} · ${(rl.mal || []).slice(0, 2).join(" | ")}` });
      }
    } catch (e) {
      for (const p of porLote) fallados.push({ p, por: "colocarLote: " + String(e.message || e).slice(0, 80) });
    }
  }

  for (let i = 0; i < porPaso.length; i++) {
    const p = porPaso[i];
    const et = `[${i + 1}/${porPaso.length}]`;
    try {
      await dormir(PAUSA);
      /* pistaAudio EXPLICITA: con -1 cae en A1 y el overwrite pisa lo que haya. */
      let r = await enviar("insertar", g({ medio: p.clip, pista: PISTA, pistaAudio: PISTA_AUDIO,
                                        segundos: LIMBO }), 300000);
      if (String(r.resumen).indexOf("NO SE PUSO NADA") !== -1) {
        fallados.push({ p, por: "insertar: " + String(r.resumen).slice(0, 80) }); continue;
      }
      /* Ubicar el clip recien puesto: es el que arranca en el limbo. */
      /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
       * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
       * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
       * recien insertado, con solo los ~203ms del transporte en el medio. */
      let cs = (await enviar("clips", g({ pista: "V" + PISTA }))).clips || [];
      let mio = cs.find((c) => Math.abs(c.desde - LIMBO) < 0.05);
      if (!mio) { fallados.push({ p, por: "no aparecio en el limbo" }); continue; }

      await dormir(PAUSA);
      const entQuiero = p.entrada !== null ? p.entrada : cuadro(mio.entrada);
      const pedido = { pista: "V" + PISTA, indice: mio.indice,
                       salida: Number((entQuiero + p.dura).toFixed(3)) };
      if (p.entrada !== null) pedido.entrada = p.entrada;
      r = await enviar("editar", g(pedido), 300000);
      /* NO se juzga por el MENSAJE, se juzga por el ESTADO.
       *
       * `editar` contesta "NO CAMBIÓ NADA" cuando lo que se le pide es lo que ya hay — y eso
       * pasa siempre que el fragmento sea el clip ENTERO: entrada 0 y la duracion completa. Es
       * la respuesta correcta del verbo, no un fallo. Tratarla como fallo dejo los dos clips de
       * un rearmado tirados en el limbo, con la herramienta informando 0 de 2.
       *
       * Asi que se relee el clip y se compara contra lo pedido, con tolerancia de un frame. */
      /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
       * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
       * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
       * recien insertado, con solo los ~203ms del transporte en el medio. */
      cs = (await enviar("clips", g({ pista: "V" + PISTA }))).clips || [];
      mio = cs.find((c) => c.desde >= LIMBO - 0.05);
      if (!mio) { fallados.push({ p, por: "se perdio despues del recorte" }); continue; }
      const okEnt = Math.abs((mio.entrada ?? entQuiero) - entQuiero) <= F + 0.001;
      const okDur = Math.abs(mio.dura - p.dura) <= F + 0.001;
      if (!okEnt || !okDur) {
        fallados.push({ p, por: `el recorte no quedo: entrada ${mio.entrada} (queria ${entQuiero}), ` +
                                `dura ${mio.dura} (queria ${p.dura})` });
        continue;
      }

      await dormir(PAUSA);
      r = await enviar("editar", g({ pista: "V" + PISTA, indice: mio.indice, desde: p.desde }), 300000);
      puestos.push(p);
      console.log(`  ${et} ${String(p.desde).padStart(7)}s +${String(p.dura).padEnd(6)} ` +
                  `${p.clip.slice(-24)}  ${String(r.resumen).slice(0, 54)}`);
    } catch (e) { fallados.push({ p, por: String(e.message || e).slice(0, 90) }); }
  }
  await dormir(PAUSA);
  console.log("\nguardado despues: " + String((await enviar("guardar")).resumen).split("·")[0]);

  /* RELECTURA DE LA TANDA. Verificar cada paso no verifica la tanda: es el error que este repo
   * ya cometio con las capas que se pisaban entre si, informando "3 de 3" sobre un desastre. */
  /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
   * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
   * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
   * recien insertado, con solo los ~203ms del transporte en el medio. */
  const fin = (await enviar("clips", g({ pista: "V" + PISTA }))).clips || [];
  console.log(`\n${puestos.length} de ${plan.length} colocados` +
              (fallados.length ? ` · ${fallados.length} fallaron` : ""));
  for (const f of fallados) console.log(`  ✗ ${f.p.clip.slice(-30)}: ${f.por}`);
  console.log(`\nrelectura de V${PISTA}: ${fin.length} clips`);
  let malos = 0;
  for (const p of plan) {
    const c = fin.find((x) => Math.abs(x.desde - p.desde) < 0.05);
    if (!c) { console.log(`  ✗ nada en ${p.desde}s (esperaba ${p.clip.slice(-22)})`); malos++; continue; }
    if (Math.abs(c.dura - p.dura) > 0.05) {
      console.log(`  ✗ ${p.desde}s dura ${c.dura} y se pidio ${p.dura}  ${c.nombre.slice(-22)}`); malos++;
      continue;
    }
    /*
     * Y LA ENTRADA, que esta relectura no miraba.
     *
     * El camino por LOTE pone los in/out en el ProjectItem —que es del MEDIO, compartido— antes
     * de pegar, y su modo de fallo caracteristico es que varios fragmentos del mismo material
     * queden con el recorte de UNO SOLO. Eso deja los clips EN SU LUGAR y CON SU DURACION: los
     * dos chequeos de arriba lo dan por bueno, y la unica forma de verlo seria mirando el video.
     *
     * `colocarLote` reparte los lotes para que no pase y lo verifica por su cuenta, pero una
     * verificacion que no mira donde vive el riesgo nuevo es la "guarda contra el error
     * imaginado" de CLAUDE.md. Cuesta cero: el dato ya vino en la misma lectura.
     */
    if (p.entrada !== null && p.entrada !== undefined &&
        c.entrada !== null && c.entrada !== undefined &&
        Math.abs(c.entrada - p.entrada) > F + 0.001) {
      console.log(`  ✗ ${p.desde}s entrada ${c.entrada} y se pidio ${p.entrada}  ${c.nombre.slice(-22)}`);
      malos++;
    }
  }
  const enLimbo = fin.filter((c) => c.desde >= LIMBO - 1);
  if (enLimbo.length) { console.log(`  ✗ ${enLimbo.length} clip(s) quedaron en el limbo (${LIMBO}s)`); malos += enLimbo.length; }
  console.log(malos ? `\n${malos} PROBLEMA(S): revisar antes de seguir.`
                    : `\nlos ${plan.length} en su lugar y con su duracion.`);
  console.log("La escala queda en 100% A PROPOSITO: la define la pasada estetica.");
})().catch((e) => { console.error("\nFALLO: " + (e && e.message ? e.message : e)); process.exit(1); });
