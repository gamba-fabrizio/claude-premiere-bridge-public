#!/usr/bin/env node
/* Qué le cambiaste al armado. Compara el TIMELINE contra la propuesta que lo generó.
 *
 * ## Por qué no alcanza con `desde_secuencia.js`
 *
 * Esa herramienta reescribe la propuesta con los tiempos del timeline, que es lo que hace que
 * la edición del usuario sobreviva al próximo rearmado. Pero para INFORMAR qué cambió usa
 * `dDesde`, o sea la diferencia de posición, y eso exige que la propuesta vieja traiga
 * `desde` — las de un corporativo no lo traen, porque los fragmentos se colocaron uno tras otro y la
 * posición era implícita. Ahí `dDesde` da cero siempre y **mover queda invisible**.
 *
 * El arreglo no es reconstruir las posiciones: es no necesitarlas.
 *
 *     reordenar   ->  se ve en el ORDEN de los nombres, no en sus posiciones
 *     recortar    ->  `dura` está en la propuesta, exacta
 *     in-point    ->  `entrada` está en la propuesta, exacta
 *     agregar     ->  nombre + numero de aparición que la propuesta no tiene
 *     borrar      ->  al revés
 *
 * Las dos listas son secuencias ordenadas: la propuesta es una lista, y el timeline ordenado
 * por `desde` es otra. Comparar secuencias de nombres contesta el reordenamiento sin una sola
 * posición.
 *
 * ## El emparejamiento: por IN-POINT, no por numero de aparición
 *
 * La primera versión emparejaba por nombre + numero de aparición, como `quirurgico.js`. **Es
 * circular y se probó que falla**: con un corte de prueba donde un mismo medio se usa cinco
 * veces, mover UN clip renumeró todas las apariciones de ese nombre, y la herramienta informó
 * 5 recortes donde había 1, 5 cambios de in-point donde había 1, y un clip "movido" del 6o al
 * 6o. El numero de aparición DEPENDE DEL ORDEN, y el orden es justo lo que se quiere medir.
 *
 * La identidad de una instancia la da el IN-POINT: qué pedazo del material usa. Eso no cambia
 * al reordenar. Así que adentro de cada nombre se emparejan las instancias por costo mínimo
 * `|dEntrada| * 3 + |dDura|` —el in-point pesa más porque es identidad y la duración es lo que
 * él recorta— con greedy sobre los pares ordenados por costo. Es el mismo criterio que usa
 * `desde_secuencia.js`, y por la misma razón.
 *
 * Lo que no se puede resolver: si movió un clip Y le cambió el in-point, el emparejamiento es
 * ambiguo por construcción. Ningún método distingue eso de "borró uno y agregó otro". Por eso
 * los pares de costo alto se INFORMAN como dudosos en vez de pasar callados.
 *
 * Los nombres vienen en DOS normalizaciones Unicode distintas: macOS entrega NFD y Premiere
 * devuelve NFC, así que dos "válida" que se ven iguales no son `===`. Todo pasa por `norm`.
 *
 * ## Por qué los movidos salen de una subsecuencia creciente y no de comparar índices
 *
 * Mover UN clip del final al principio corre a todos los demás una posición. Comparando índices
 * a secas, eso informa "se movieron 23 de 23", que es cierto y no sirve para nada. La
 * subsecuencia creciente más larga son los que se quedaron QUIETOS; los movidos son el resto, y
 * en ese caso da 1 de 23.
 *
 * ## Lo que NO decide esta herramienta
 *
 * Huecos y solapes. Los mide `revisar` sobre el timeline y son un dato del ESTADO, no de un
 * diff: un hueco que ya estaba no es un cambio, y uno nuevo se ve igual mirando la secuencia.
 * Mezclarlos acá daría dos fuentes para la misma pregunta.
 *
 * Uso:
 *   node comparar_corte.js --propuesta corte_video3.json --estado clips_V3.json [--fps 25]
 *   node comparar_corte.js --propuesta corte_video3.json --estado clips_V3.json --json
 */
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const tiene = (n) => args.includes("--" + n);

const PROPUESTA = opt("propuesta", null);
const ESTADO = opt("estado", null);
const FPS = Number(opt("fps", "25"));
const COMO_JSON = tiene("json");

if (!PROPUESTA || !ESTADO) {
  console.error("faltan --propuesta y --estado");
  process.exit(2);
}

/* macOS entrega NFD, Premiere devuelve NFC. Se ven iguales y no son la misma cadena. */
const norm = (s) => String(s == null ? "" : s).normalize("NFC");
/* Un frame de tolerancia: la colocación cuantiza a la grilla de la secuencia, así que una
 * diferencia de menos de un frame es de la cuantización y no una edición. */
const TOL = 1 / FPS + 1e-9;
const r3 = (n) => Number(n.toFixed(3));

function leerPropuesta(ruta) {
  const j = JSON.parse(fs.readFileSync(ruta, "utf8"));
  const arr = Array.isArray(j) ? j : j.fragmentos || j.planos || j.clips;
  if (!Array.isArray(arr)) throw new Error(ruta + ": no encuentro la lista de fragmentos");
  return arr.map((x, i) => ({
    i,
    nombre: norm(x.clip || x.nombre || x.archivo),
    dura: typeof x.dura === "number" ? x.dura : undefined,
    entrada: typeof x.entrada === "number" ? x.entrada : undefined,
    anot: x,
  }));
}

function leerEstado(ruta) {
  const j = JSON.parse(fs.readFileSync(ruta, "utf8"));
  const arr = j.clips || j;
  if (!Array.isArray(arr)) throw new Error(ruta + ": no encuentro `clips`");
  return arr
    .slice()
    .sort((a, b) => a.desde - b.desde)
    .map((c, i) => ({
      i,
      nombre: norm(c.nombre),
      desde: c.desde,
      dura: r3(c.hasta - c.desde),
      entrada: typeof c.entrada === "number" ? c.entrada : undefined,
      velocidad: c.velocidad,
      pista: c.pista,
    }));
}

/* Rango de aparición sobre la lista COMPLETA. Se cuenta acá y no adentro del emparejamiento
 * porque filtrar primero corre los números: ya pasó, y mandó el SEGUNDO clip de un nombre al
 * lugar del PRIMERO. */
function conRango(lista) {
  const cuenta = new Map();
  return lista.map((x) => {
    const n = cuenta.get(x.nombre) || 0;
    cuenta.set(x.nombre, n + 1);
    return { ...x, rango: n, clave: x.nombre + "#" + n };
  });
}

const P = conRango(leerPropuesta(PROPUESTA));
const T = conRango(leerEstado(ESTADO));

/* Emparejamiento por IN-POINT adentro de cada nombre. Ver el encabezado: por numero de
 * aparición es circular y se midió que falla. El costo pondera el in-point por encima de la
 * duración porque el in-point es IDENTIDAD —qué pedazo del material se usa— y la duración es
 * justo lo que el usuario recorta. */
const COSTO_DUDOSO = 1.0; /* segundos ponderados; por encima de esto el par se informa */
function costo(p, t) {
  const dE = p.entrada !== undefined && t.entrada !== undefined ? Math.abs(t.entrada - p.entrada) : 0;
  const dD = p.dura !== undefined ? Math.abs(t.dura - p.dura) : 0;
  return dE * 3 + dD;
}

const parP = new Map(); /* clave de propuesta -> clip del timeline */
const parT = new Map(); /* clave de timeline  -> clip de la propuesta */
const dudosos = [];
{
  const porNombreP = new Map(), porNombreT = new Map();
  for (const p of P) { if (!porNombreP.has(p.nombre)) porNombreP.set(p.nombre, []); porNombreP.get(p.nombre).push(p); }
  for (const t of T) { if (!porNombreT.has(t.nombre)) porNombreT.set(t.nombre, []); porNombreT.get(t.nombre).push(t); }

  for (const [nombre, ps] of porNombreP) {
    const ts = porNombreT.get(nombre) || [];
    if (!ts.length) continue;
    /* Todos los pares ordenados por costo, y greedy: cada instancia se usa una sola vez. */
    const pares = [];
    for (const p of ps) for (const t of ts) pares.push({ p, t, c: costo(p, t) });
    pares.sort((a, b) => a.c - b.c);
    /* El costo alto sólo es AMBIGUO si hay más de una instancia de qué elegir. Con una sola de
     * cada lado el par está forzado y no hay nada que dudar: un costo alto ahí es simplemente la
     * edición que él hizo. La primera versión avisaba igual y marcaba como dudosos los dos
     * únicos clips editados de la prueba — un aviso que salta en cada edición normal es ruido,
     * y el ruido entrena a ignorar el aviso cuando importa. */
    const ambiguo = ps.length > 1 || ts.length > 1;
    for (const { p, t, c } of pares) {
      if (parP.has(p.clave) || parT.has(t.clave)) continue;
      parP.set(p.clave, t);
      parT.set(t.clave, p);
      if (ambiguo && c > COSTO_DUDOSO) dudosos.push({ clip: nombre, costo: r3(c), desde: r3(t.desde) });
    }
  }
}

const borrados = P.filter((p) => !parP.has(p.clave));
const agregados = T.filter((t) => !parT.has(t.clave));

/* Recortes y cambios de in-point: exactos, porque los dos campos están en la propuesta. */
const recortados = [];
const inPointCambiado = [];
const sinDato = [];
for (const t of T) {
  const p = parT.get(t.clave);
  if (!p) continue;
  if (p.dura === undefined) sinDato.push({ clave: t.clave, campo: "dura" });
  else if (Math.abs(t.dura - p.dura) > TOL) {
    recortados.push({
      clip: t.nombre, rango: t.rango,
      antes: r3(p.dura), ahora: t.dura, delta: r3(t.dura - p.dura), desde: r3(t.desde),
    });
  }
  if (t.entrada === undefined || p.entrada === undefined) {
    if (p.entrada === undefined) sinDato.push({ clave: t.clave, campo: "entrada" });
  } else if (Math.abs(t.entrada - p.entrada) > TOL) {
    inPointCambiado.push({
      clip: t.nombre, rango: t.rango,
      antes: r3(p.entrada), ahora: r3(t.entrada), delta: r3(t.entrada - p.entrada), desde: r3(t.desde),
    });
  }
}

/* EL REORDENAMIENTO, que es lo que no se puede leer de las posiciones.
 * Se comparan las dos secuencias de claves quitando lo agregado y lo borrado: lo que queda
 * tiene los mismos elementos de los dos lados, así que cualquier diferencia de orden es una
 * movida. */
const comunP = P.filter((p) => parP.has(p.clave));
const comunT = T.filter((t) => parT.has(t.clave));
/* La posición vieja de un clip del timeline es la de SU PAR en la propuesta, no la de una clave
 * homónima. Es la corrección: la clave por aparición se renumeraba al reordenar. */
const posEnP = new Map(comunP.map((p, i) => [p.clave, i]));
const ordenViejo = comunT.map((t) => posEnP.get(parT.get(t.clave).clave));
const reordenado = ordenViejo.some((v, i) => v !== i);

/* Los que se quedaron quietos son la subsecuencia creciente más larga. Ver el encabezado:
 * sin esto, mover un clip informa que se movieron todos. */
function quietos(seq) {
  const n = seq.length;
  if (!n) return new Set();
  const cola = [], padre = new Array(n).fill(-1), idx = [];
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = cola.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[idx[m]] < seq[i]) lo = m + 1; else hi = m; }
    idx[lo] = i;
    padre[i] = lo > 0 ? idx[lo - 1] : -1;
    if (lo === cola.length) cola.push(seq[i]); else cola[lo] = seq[i];
  }
  const res = new Set();
  let k = idx[cola.length - 1];
  while (k !== -1) { res.add(k); k = padre[k]; }
  return res;
}
const seQuedaron = quietos(ordenViejo);
const movidos = comunT
  .map((t, i) => ({ t, i }))
  .filter((x) => !seQuedaron.has(x.i))
  /* La subsecuencia creciente más larga NO es única, así que puede excluir un elemento que en
   * realidad está en su lugar. Sin este filtro se informaba un clip movido "del 6o al 6o". */
  .filter((x) => ordenViejo[x.i] !== x.i)
  .map((x) => ({
    clip: x.t.nombre, rango: x.t.rango,
    eraNro: ordenViejo[x.i] + 1, ahoraNro: x.i + 1, desde: r3(x.t.desde),
  }));

const conVelocidad = T.filter((t) => t.velocidad != null && t.velocidad !== 1)
  .map((t) => ({ clip: t.nombre, rango: t.rango, velocidad: t.velocidad, desde: r3(t.desde) }));

const informe = {
  propuesta: PROPUESTA, estado: ESTADO,
  cuenta: { propuesta: P.length, timeline: T.length },
  largo: { timeline: T.length ? r3(T[T.length - 1].desde + T[T.length - 1].dura) : 0 },
  reordenado, movidos, recortados, inPointCambiado,
  agregados: agregados.map((a) => ({ clip: a.nombre, rango: a.rango, desde: r3(a.desde), dura: a.dura })),
  borrados: borrados.map((b) => ({ clip: b.nombre, rango: b.rango, eraNro: b.i + 1 })),
  conVelocidad, dudosos, sinDato,
};

if (COMO_JSON) { console.log(JSON.stringify(informe, null, 2)); process.exit(0); }

const f = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);
const vez = (r) => (r ? " (" + (r + 1) + "a vez)" : "");
console.log("");
console.log(PROPUESTA + "  ->  " + ESTADO);
console.log("  " + P.length + " en la propuesta - " + T.length + " en el timeline - " +
  informe.largo.timeline.toFixed(2) + "s (" + (informe.largo.timeline / 60).toFixed(2) + " min)");
console.log("");

const nada = !movidos.length && !recortados.length && !inPointCambiado.length &&
  !agregados.length && !borrados.length;
if (nada) console.log("  sin cambios: el timeline coincide con la propuesta");

if (borrados.length) {
  console.log("  BORRADOS (" + borrados.length + ") - los saco de la propuesta");
  for (const b of informe.borrados) console.log("    era el " + b.eraNro + "o  " + b.clip + vez(b.rango));
  console.log("");
}
if (agregados.length) {
  console.log("  AGREGADOS A MANO (" + agregados.length + ") - entran sin anotacion");
  for (const a of informe.agregados) {
    console.log("    " + a.desde.toFixed(2) + "s  dura " + a.dura.toFixed(2) + "s  " + a.clip + vez(a.rango));
  }
  console.log("");
}
if (movidos.length) {
  console.log("  MOVIDOS (" + movidos.length + " de " + comunT.length + ") - por ORDEN, no por posicion");
  for (const m of movidos) {
    console.log("    " + m.eraNro + "o -> " + m.ahoraNro + "o  @" + m.desde.toFixed(2) + "s  " + m.clip + vez(m.rango));
  }
  console.log("");
} else if (reordenado) {
  console.log("  el orden cambio pero no pude aislar cuales: revisalo a mano");
  console.log("");
}
if (recortados.length) {
  console.log("  RECORTADOS (" + recortados.length + ") - exacto, `dura` esta en la propuesta");
  for (const r of recortados) {
    console.log("    " + r.antes.toFixed(2) + "s -> " + r.ahora.toFixed(2) + "s  " + f(r.delta) +
      "s  @" + r.desde.toFixed(2) + "s  " + r.clip);
  }
  console.log("");
}
if (inPointCambiado.length) {
  console.log("  IN-POINT CAMBIADO (" + inPointCambiado.length + ") - exacto, `entrada` esta en la propuesta");
  for (const e of inPointCambiado) {
    console.log("    " + e.antes.toFixed(2) + " -> " + e.ahora.toFixed(2) + "  " + f(e.delta) +
      "s  @" + e.desde.toFixed(2) + "s  " + e.clip);
  }
  console.log("");
}
if (conVelocidad.length) {
  console.log("  CON VELOCIDAD DISTINTA DE 1 (" + conVelocidad.length +
    ") - la API no la escribe: un rearmado los deja al 100%");
  for (const v of conVelocidad) {
    console.log("    " + v.velocidad + "x  @" + v.desde.toFixed(2) + "s  " + v.clip);
  }
  console.log("");
}
if (dudosos.length) {
  console.log("  EMPAREJAMIENTO DUDOSO (" + dudosos.length + ") - mismo medio usado varias veces y el");
  console.log("  in-point se movio mucho, asi que no puedo asegurar cual instancia es cual. Miralos:");
  for (const d of dudosos) console.log("    costo " + d.costo.toFixed(2) + "  @" + d.desde.toFixed(2) + "s  " + d.clip);
  console.log("");
}
if (sinDato.length) {
  const campos = [...new Set(sinDato.map((s) => s.campo))];
  console.log("  SIN COMPARAR: " + sinDato.length + " caso(s) donde la propuesta no trae " + campos.join(" ni ") + ".");
  console.log("  Ahi un delta de cero NO significa \"no cambio\", significa que no hay con que comparar.");
  console.log("");
}
