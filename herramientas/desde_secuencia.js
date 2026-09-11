#!/usr/bin/env node
/* Convierte TU TIMELINE en la propuesta. La secuencia pasa a ser la fuente de verdad.
 *
 * ## Por qué existe
 *
 * `quirurgico.js` guarda y repone el trabajo de EFECTOS —color, rotación, escala, el ojito—
 * pero **no repone tiempos**, y eso es a propósito: un armado existe justamente para cambiar
 * el timing, así que reponer los tiempos viejos desharía el corte nuevo.
 *
 * El problema es el otro: si el usuario mueve o recorta clips y después yo rearmo desde mi
 * JSON, **su edición desaparece**. Pedido suyo el 2026-08-21: *"para que yo pueda editar y que
 * esos cambios te queden a vos en tus armados también"*.
 *
 * Así que la dirección correcta no es restaurar sus tiempos después: es que sus tiempos SEAN
 * el punto de partida. Esta herramienta lee la secuencia y reescribe la propuesta.
 *
 * ## Qué sale de dónde, que es todo el diseño
 *
 *     tiempos (desde, dura, entrada)   <-  DE LA SECUENCIA, siempre. Es lo que él editó.
 *     anotaciones (seccion, que,       <-  DE LA PROPUESTA VIEJA, emparejadas por nombre +
 *      fuente, carpeta, suplentes)         número de aparición.
 *
 * Nunca al revés. Si un tiempo de la propuesta vieja discrepa con la secuencia, gana la
 * secuencia sin preguntar: ahí está la edición.
 *
 * ## El emparejamiento y sus dos silencios
 *
 * Por nombre + número de aparición, contado sobre la lista COMPLETA. Los nombres no son únicos
 * —en V1 de este proyecto hay 16 repetidos y uno aparece seis veces— así que un `Set` contaría
 * mal. Y hay dos casos que NO se resuelven callando:
 *
 *   - **clip nuevo en la secuencia**, que la propuesta no tenía: entra igual, con las
 *     anotaciones vacías y marcado `nuevo: true`. Dejarlo afuera perdería un plano que él puso.
 *   - **plano de la propuesta que ya no está en la secuencia**: se descarta y se INFORMA. Es lo
 *     correcto —lo borró— pero tiene que verse, no desaparecer.
 *
 * ## Lo que la propuesta NO puede reproducir, y por eso se avisa
 *
 * **La velocidad.** `colocar_propuesta.js` pone todo al 100% porque la API no la escribe. Si un
 * clip corre a otra velocidad, su `dura` en el timeline no se corresponde con el material que
 * consume, y rearmar lo va a dejar distinto. Se listan aparte para ponerlos a mano.
 *
 * Uso:
 *   node desde_secuencia.js --estado estado_V1.json --propuesta vieja.json --salida nueva.json
 *                           [--secciones letra.json] [--fps 25]
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const FPS = Number(opt("fps", "25"));
const norm = (s) => String(s == null ? "" : s).normalize("NFC");

/* Los campos que esta herramienta CALCULA desde la secuencia y por lo tanto NO se copian de la
 * propuesta vieja. Todo lo demás es una anotación del usuario y se copia tal cual. Los tres
 * tiempos —desde, dura, entrada— son los críticos: si se copiaran, la propuesta vieja le ganaría
 * a la edición del timeline y la herramienta haría lo contrario de lo que promete. */
const CALCULADOS = new Set(["clip", "desde", "dura", "entrada", "velocidad", "nuevo"]);

const ESTADO = opt("estado", null);
const VIEJA = opt("propuesta", null);
const SALIDA = opt("salida", null);
const SECCIONES = opt("secciones", null);
/* Con `--anterior` se compara captura contra captura, que es la comparación EXACTA.
 *
 * Contra la propuesta vieja el diff es aproximado: en 59 de 88 planos no traía `entrada`, así
 * que un cambio de in-point no tiene con qué compararse y sale como "fijada" en vez de como
 * "cambió". Entre dos capturas del timeline no falta ningún campo, así que todo cambio se ve.
 *
 * El flujo es: capturar, editar, capturar de nuevo, y diffear las dos. */
const ANTERIOR = opt("anterior", null);
if (!ESTADO || !SALIDA) {
  console.error("Uso: node desde_secuencia.js --estado estado_V1.json --salida nueva.json [--propuesta vieja.json] [--secciones letra.json]");
  process.exit(1);
}

/*
 * Empareja dos listas de clips del mismo nombre. NO por orden de aparición.
 *
 * Por orden fallaba en la mitad del timeline: de 89 clips, **45 tienen el nombre repetido** —uno
 * aparece seis veces— así que borrar o reordenar una instancia corre la cuenta y empareja mal.
 * Medido: informó "FX3_3624 se movió de 67 a 255,64" cuando lo que había pasado era que se
 * borró otra aparición. Una mudanza de tres minutos que nunca ocurrió, con toda la cara de un
 * hallazgo.
 *
 * La identidad estable de una instancia es su **in-point**: dice qué cuadros del material es, y
 * eso NO cambia cuando el clip se mueve en el timeline. Así que se empareja por menor distancia
 * de `entrada`, con la posición como desempate y con mucho menos peso.
 *
 * Greedy sobre los pares ordenados por costo: alcanza y es predecible. Un asignador óptimo
 * sería más prolijo y acá no cambia el resultado, porque los in-points de un mismo medio están
 * lejos entre sí.
 */
function emparejar(viejos, nuevos) {
  const pares = [];
  for (let i = 0; i < viejos.length; i++) {
    for (let j = 0; j < nuevos.length; j++) {
      const ea = viejos[i].entrada, eb = nuevos[j].entrada;
      const dEnt = typeof ea === "number" && typeof eb === "number" ? Math.abs(ea - eb) : 999;
      const da = viejos[i].desde, db = nuevos[j].desde;
      const dPos = typeof da === "number" && typeof db === "number" ? Math.abs(da - db) : 999;
      /* La entrada pesa 10 veces más que la posición: mover un clip es normal, cambiarle los
       * cuadros de origen es otra cosa. */
      pares.push({ i, j, costo: dEnt * 10 + dPos });
    }
  }
  pares.sort((x, y) => x.costo - y.costo);
  const usadoV = new Set(), usadoN = new Set(), mapa = new Map();
  for (const p of pares) {
    if (usadoV.has(p.i) || usadoN.has(p.j)) continue;
    usadoV.add(p.i); usadoN.add(p.j);
    mapa.set(nuevos[p.j], viejos[p.i]);
  }
  const sobranV = viejos.filter((_, i) => !usadoV.has(i));
  const sinPar = nuevos.filter((_, j) => !usadoN.has(j));
  return { mapa, sobranV, sinPar };
}

const S = JSON.parse(fs.readFileSync(ESTADO, "utf8"));
const clips = (S.clips || []).slice().sort((a, b) => a.desde - b.desde);
if (!clips.length) { console.error("El estado no tiene clips."); process.exit(1); }
if (S.total != null && clips.length !== S.total) {
  console.error(`OJO: el estado tiene ${clips.length} clip(s) y la pista tenía ${S.total}: está INCOMPLETO.`);
  console.error("Los números de aparición van a estar corridos. Volvé a capturarlo entero.");
  process.exit(1);
}

const P = VIEJA && fs.existsSync(VIEJA) ? JSON.parse(fs.readFileSync(VIEJA, "utf8")) : { planos: [] };
/* La lista se busca bajo VARIOS nombres, y también como array pelado. Leía sólo `P.planos`, que
 * es como la escribe esta misma herramienta, y las propuestas de un corporativo la traen bajo
 * `fragmentos`: `viejos` quedaba VACÍO y los 65 planos de los tres videos salieron marcados
 * `nuevo` con las anotaciones perdidas. No falló ruidosamente — escribió tres archivos válidos
 * y vacíos de contenido. */
const viejos = P.planos || P.fragmentos || P.clips || (Array.isArray(P) ? P : []);

/* Y si el archivo EXISTE pero no se le pudo sacar ni un plano, eso es un fallo, no "todo es
 * nuevo". Se pidió emparejar contra una propuesta: no encontrarla es no poder hacer el trabajo.
 * Sin esta guarda el modo de fallo es escribir una salida plausible y vacía. */
if (VIEJA && fs.existsSync(VIEJA) && !viejos.length) {
  console.error(`\n${VIEJA} existe pero no le encuentro ni un plano.`);
  console.error(`Claves de nivel superior: ${Array.isArray(P) ? "(array vacío)" : Object.keys(P).join(", ") || "(ninguna)"}`);
  console.error(`Se buscan: planos, fragmentos, clips, o un array pelado.`);
  console.error(`Seguir escribiría una propuesta con TODO marcado \`nuevo\` y sin una sola anotación.\n`);
  process.exit(1);
}

/* Índice de la propuesta vieja por nombre, en orden: la aparición k del nombre N va con la
 * aparición k de ese mismo nombre en la secuencia. */
const porNombre = new Map();
for (const v of viejos) {
  const k = norm(v.clip);
  if (!porNombre.has(k)) porNombre.set(k, []);
  porNombre.get(k).push(v);
}
/* Las anotaciones también se emparejan por in-point y no por orden, por la misma razón. Los
 * planos de la propuesta que no traen `entrada` caen al desempate por posición, que es lo mejor
 * que hay con ese dato. */
const anotacionDe = new Map();
{
  const porNombreN = new Map();
  for (const c of clips) {
    const k = norm(c.nombre);
    if (!porNombreN.has(k)) porNombreN.set(k, []);
    porNombreN.get(k).push(c);
  }
  for (const [k, nuevosK] of porNombreN) {
    const r = emparejar(porNombre.get(k) || [], nuevosK);
    for (const [n, v] of r.mapa) anotacionDe.set(n, v);
  }
}
const usados = new Map();

/* Las secciones sirven para dos cosas: etiquetar un plano nuevo, y avisar si un plano quedó
 * en otra sección de la que decía —que es información de montaje, no un error. */
let secciones = null;
if (SECCIONES && fs.existsSync(SECCIONES)) {
  try { secciones = JSON.parse(fs.readFileSync(SECCIONES, "utf8")).secciones || null; } catch (e) { secciones = null; }
}
const seccionDe = (t) => {
  if (!secciones) return null;
  const s = secciones.find((x) => t >= x.desde && t < x.hasta);
  return s ? s.nombre : null;
};

const F = 1 / FPS;
const cuadro = (t) => Number((Math.round(t / F) * F).toFixed(3));

const planos = [], nuevos = [], movidos = [], conVelocidad = [], fueraDeGrilla = [];
const fijadas = [], cambiaronDeSeccion = [];
for (const c of clips) {
  const k = norm(c.nombre);
  const v = anotacionDe.get(c) || null;

  const desde = cuadro(c.desde);
  const dura = cuadro(c.hasta - c.desde);
  const entrada = typeof c.entrada === "number" ? cuadro(c.entrada) : undefined;
  /* La grilla se comprueba, no se asume: un valor a medio frame es la firma de un corte entre
   * frames, y rearmar desde ahí propaga el hueco. Se informa en vez de redondear callado. */
  for (const [nom, val] of [["desde", c.desde], ["hasta", c.hasta], ["entrada", c.entrada]]) {
    if (typeof val === "number" && Math.abs(val / F - Math.round(val / F)) > 1e-6) {
      fueraDeGrilla.push(`${c.nombre} ${nom}=${val}`);
    }
  }

  const pl = { clip: c.nombre, desde: desde, dura: dura };
  if (entrada !== undefined) pl.entrada = entrada;
  if (v) {
    /* Las anotaciones se copian TAL CUAL, y por EXCLUSIÓN. Antes era una lista BLANCA
     * —seccion, que, fuente, carpeta, archivo, suplentes, entradaMin— y eso funcionaba sólo en
     * el proyecto donde se escribió. Las propuestas de un corporativo anotan `bloque`, `grupo`,
     * `texto` y `porQue`, y las cuatro se caían EN SILENCIO: justo el contenido que hace
     * revisable el esqueleto. Una lista blanca de anotaciones es una guarda contra el caso
     * imaginado — el error que este repo paga más seguido.
     *
     * La exclusión tiene que ser HERMÉTICA. Si `desde`, `dura` o `entrada` se colaran, los
     * tiempos de la propuesta vieja le ganarían a la secuencia, que es exactamente lo contrario
     * de para lo que existe esta herramienta. Por eso la lista es una constante de módulo y
     * `test.js` exige que los tres estén ahí. */
    for (const campo of Object.keys(v)) {
      if (!CALCULADOS.has(campo)) pl[campo] = v[campo];
    }
    /* Y si se movió, se anota cuánto: es lo que hace visible su edición en el diff. */
    const dDesde = Number((desde - (v.desde ?? desde)).toFixed(3));
    const dDura = Number((dura - (v.dura ?? dura)).toFixed(3));
    /* La entrada sólo se puede COMPARAR si la propuesta vieja la tenía. En 59 de 88 planos no
     * la tenía —la inventaba el colocador— y ahí un delta de cero no significa "no cambió",
     * significa "no hay con qué comparar". Se informa aparte en vez de dar cero: un cambio de
     * in-point que pasa invisible es una desincronización que aparece después. */
    const dEnt = entrada !== undefined && v.entrada !== undefined ? Number((entrada - v.entrada).toFixed(3)) : 0;
    if (dDesde || dDura || dEnt) movidos.push({ clip: c.nombre, dDesde, dDura, dEnt, desde });
    else if (entrada !== undefined && v.entrada === undefined) {
      fijadas.push({ clip: c.nombre, desde: desde, entrada: entrada });
    }
    /* La SECCIÓN no se sobreescribe. Es una anotación suya y acá se copia tal cual; que el
     * plano haya quedado en otro tramo de la letra es información de montaje, no un error que
     * corresponda corregir en silencio. Antes esto reescribía 17 de 88. */
    const secAhora = seccionDe(desde);
    if (secAhora && v.seccion && secAhora !== v.seccion) {
      cambiaronDeSeccion.push({ clip: c.nombre, desde: desde, decia: v.seccion, ahora: secAhora });
    }
  } else {
    pl.nuevo = true;
    pl.seccion = seccionDe(desde) || "(sin sección)";
    pl.que = "AGREGADO A MANO en el timeline; sin anotación";
    nuevos.push({ clip: c.nombre, desde: desde, dura: dura });
  }
  if (c.velocidad !== null && c.velocidad !== undefined && c.velocidad !== 1) {
    pl.velocidad = c.velocidad;
    conVelocidad.push({ clip: c.nombre, desde: desde, velocidad: c.velocidad });
  }
  planos.push(pl);
}

/* Diff exacto contra la captura anterior, si la hay. */
const cambios = [];
if (ANTERIOR && fs.existsSync(ANTERIOR)) {
  const A = JSON.parse(fs.readFileSync(ANTERIOR, "utf8"));
  const antes = (A.clips || []).slice().sort((a, b) => a.desde - b.desde);
  const idx = new Map(), idxN = new Map();
  for (const c of antes) {
    const k = norm(c.nombre);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(c);
  }
  for (const c of clips) {
    const k = norm(c.nombre);
    if (!idxN.has(k)) idxN.set(k, []);
    idxN.get(k).push(c);
  }
  /* Emparejado por in-point, no por orden: ver `emparejar`. */
  const conQuien = new Map(), huerfanosV = [];
  for (const [k, nuevosK] of idxN) {
    const r = emparejar(idx.get(k) || [], nuevosK);
    for (const [n, v] of r.mapa) conQuien.set(n, v);
    for (const v of r.sobranV) huerfanosV.push(v);
  }
  for (const [k, viejosK] of idx) { if (!idxN.has(k)) for (const v of viejosK) huerfanosV.push(v); }
  for (const c of clips) {
    const a = conQuien.get(c);
    if (!a) { cambios.push({ clip: c.nombre, desde: c.desde, qué: "AGREGADO" }); continue; }
    const d = [];
    if (Math.abs(a.desde - c.desde) > 0.001) d.push(`posición ${a.desde} → ${c.desde}`);
    const dua = a.hasta - a.desde, duc = c.hasta - c.desde;
    if (Math.abs(dua - duc) > 0.001) d.push(`duración ${dua.toFixed(2)} → ${duc.toFixed(2)}`);
    if (typeof a.entrada === "number" && typeof c.entrada === "number" && Math.abs(a.entrada - c.entrada) > 0.001) {
      d.push(`entrada ${a.entrada} → ${c.entrada}`);
    }
    if (a.velocidad !== c.velocidad) d.push(`velocidad ${a.velocidad} → ${c.velocidad}`);
    if (d.length) cambios.push({ clip: c.nombre, desde: c.desde, qué: d.join(" · ") });
  }
  for (const v of huerfanosV) cambios.push({ clip: v.nombre, desde: v.desde, qué: "BORRADO" });
}

/* Los que ya no están. Se descartan —los borró— pero tienen que verse. */
const usadas = new Set(anotacionDe.values());
const sobran = viejos.filter((v) => !usadas.has(v));

const salida = { secuencia: S.secuencia || P.secuencia || null, pista: S.pista || null,
                 desdeSecuencia: true, capturado: S.cuando || null, planos: planos };
if (P.velocidad !== undefined) salida.velocidad = P.velocidad;
fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 1));

/* ---------- informe ---------- */
const tc = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
console.log(`${planos.length} plano(s) escritos en ${SALIDA}`);
console.log(`  de la secuencia: tiempos · de la propuesta vieja: anotaciones\n`);

console.log(`emparejados con anotación: ${planos.length - nuevos.length} de ${planos.length}`);
if (movidos.length) {
  console.log(`\nEDITADOS POR VOS — ${movidos.length}, y así quedan de acá en adelante:`);
  for (const m of movidos.slice(0, 40)) {
    const p = [];
    if (m.dDesde) p.push(`posición ${m.dDesde > 0 ? "+" : ""}${m.dDesde}s`);
    if (m.dDura) p.push(`duración ${m.dDura > 0 ? "+" : ""}${m.dDura}s`);
    if (m.dEnt) p.push(`entrada ${m.dEnt > 0 ? "+" : ""}${m.dEnt}s`);
    console.log(`  ${tc(m.desde).padStart(6)}  ${String(m.clip).slice(0, 30).padEnd(31)} ${p.join(" · ")}`);
  }
  if (movidos.length > 40) console.log(`  ... y ${movidos.length - 40} más`);
} else {
  console.log("\nno moviste ningún clip respecto de la propuesta vieja.");
}
if (ANTERIOR) {
  console.log(`\nDIFF EXACTO contra ${path.basename(ANTERIOR)} — ${cambios.length} cambio(s):`);
  if (!cambios.length) console.log("  la secuencia está igual que en esa captura.");
  for (const x of cambios.slice(0, 40)) {
    console.log(`  ${tc(x.desde).padStart(6)}  ${String(x.clip).slice(0, 28).padEnd(29)} ${x.qué}`);
  }
  if (cambios.length > 40) console.log(`  ... y ${cambios.length - 40} más`);
}
if (fijadas.length) {
  console.log(`\nENTRADA AHORA FIJADA — ${fijadas.length}. La propuesta vieja no la especificaba, así que el`);
  console.log(`colocador la inventaba; ahora lleva la del timeline y el rearmado es reproducible:`);
  for (const x of fijadas.slice(0, 8)) console.log(`  ${tc(x.desde).padStart(6)}  ${String(x.clip).slice(0, 30).padEnd(31)} entrada ${x.entrada}s`);
  if (fijadas.length > 8) console.log(`  ... y ${fijadas.length - 8} más`);
}
if (cambiaronDeSeccion.length) {
  console.log(`\nEN OTRA SECCIÓN DE LA QUE DECÍAN — ${cambiaronDeSeccion.length}. NO se cambió la anotación:`);
  for (const x of cambiaronDeSeccion.slice(0, 8)) {
    console.log(`  ${tc(x.desde).padStart(6)}  ${String(x.clip).slice(0, 26).padEnd(27)} decía "${x.decia}" y cae en "${x.ahora}"`);
  }
  if (cambiaronDeSeccion.length > 8) console.log(`  ... y ${cambiaronDeSeccion.length - 8} más`);
}
if (nuevos.length) {
  console.log(`\nAGREGADOS A MANO — ${nuevos.length}, entran sin anotación:`);
  for (const x of nuevos) console.log(`  ${tc(x.desde).padStart(6)}  ${String(x.clip).slice(0, 34).padEnd(35)} ${x.dura}s`);
}
if (sobran.length) {
  console.log(`\nYA NO ESTÁN — ${sobran.length}, se descartan de la propuesta:`);
  for (const x of sobran.slice(0, 20)) console.log(`  ${String(x.clip).slice(0, 34).padEnd(35)} decía ${tc(x.desde || 0)} · ${x.que ? String(x.que).slice(0, 40) : ""}`);
}
if (conVelocidad.length) {
  console.log(`\nCON VELOCIDAD DISTINTA DE 1 — ${conVelocidad.length}. La API NO la escribe, así que un`);
  console.log(`rearmado los pone al 100% y hay que volver a ponerla A MANO:`);
  for (const x of conVelocidad) console.log(`  ${tc(x.desde).padStart(6)}  ${String(x.clip).slice(0, 30).padEnd(31)} ${x.velocidad}x`);
}
if (fueraDeGrilla.length) {
  console.log(`\nFUERA DE LA GRILLA DE ${FPS}fps — ${fueraDeGrilla.length} valor(es). Es la firma de un corte`);
  console.log(`entre frames; rearmar desde acá propaga el hueco:`);
  for (const x of fueraDeGrilla.slice(0, 10)) console.log(`  ${x}`);
}

/* Chequeo de la TANDA, no de cada plano: que la propuesta nueva describa un corte sano. */
let solapes = 0, ceros = 0, huecos = 0;
for (let i = 0; i < planos.length; i++) {
  if (planos[i].dura <= 0) ceros++;
  if (i) {
    const finAnt = Number((planos[i - 1].desde + planos[i - 1].dura).toFixed(3));
    const d = Number((planos[i].desde - finAnt).toFixed(3));
    if (d < -0.001) solapes++;
    else if (d > 0.001) huecos++;
  }
}
console.log(`\nla propuesta nueva: ${ceros} duración cero · ${solapes} solape(s) · ${huecos} hueco(s)`);
if (ceros || solapes) console.log("OJO: eso venía así en la secuencia. Revisalo antes de rearmar.");
