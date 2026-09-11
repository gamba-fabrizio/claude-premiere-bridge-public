#!/usr/bin/env node
/* Coteja el EXPORT contra el corte: ¿cada plano muestra el pedazo de material que el JSON pide?
 *
 * Es la verificación que faltaba en la punta de la cadena. `revisar_medios.js` mira el material
 * antes, `revisar` mira la secuencia, `plancha_corte.js` deja ver el export — pero nada
 * comprobaba que el plano N del archivo entregado sea de verdad el pedazo que la propuesta pide.
 * En un corte de 88 planos armado por script, un `entrada` equivocado es invisible: el plano
 * mide lo que tiene que medir, se ve bien, y muestra otro momento del mismo material.
 *
 * Y lo hace desde AFUERA de Premiere: compara el archivo entregado contra el material en disco.
 * Dos fuentes independientes, que es la única clase de confirmación que vale en este repo.
 *
 *     node cotejar_export.js --video <export.mp4> --corte <corte.json> [--limite 20] [--todos]
 *
 * ## Se juzga por RANGO, no por umbral. Y eso salió de medir.
 *
 * El cuadro del export se compara contra el material en el instante pedido y contra SEÑUELOS
 * —otros instantes del mismo medio—. El pedido tiene que dar el mínimo. No hay ninguna constante
 * que haya que acertar.
 *
 * Es a propósito, porque un umbral acá no transfiere. Medido sobre 6 planos de músicos de un videoclip:
 *
 *     par correcto            0,76 a 10,33
 *     señuelo, mismo medio   13,13 a 21,05
 *     señuelo, otro medio    26,11 a 30,41
 *
 * El rango del par correcto se solapa con nada, pero **su valor absoluto varía 13 veces** entre
 * planos: 0,76 en un plano de percusión y 10,33 en un cantante con Lumetri. Un umbral global
 * calibrado con el primero rechazaría al segundo. El rango, en cambio, acertó 6 de 6, y el par
 * correcto siempre dio **menos de la mitad** que el señuelo más parecido.
 *
 * El ~10 de base NO es un in-point equivocado: es la corrección de color del export. El control
 * que lo demostró fue el señuelo — sin él, un 10 no se puede interpretar.
 *
 * ## A qué distancia se pone un señuelo: medido, no elegido
 *
 * Los señuelos empezaron a ±15s y con eso **un tercio de los planos quedaba sin cotejar**, porque
 * el material es más corto que eso. Antes de acercarlos se midió a qué distancia un señuelo
 * empieza a separarse de verdad, sobre cinco planos:
 *
 *     distancia      +0,5s   +1s    +2s    +3s    +5s    +8s
 *     peor margen    x1,18  x1,19  x1,17  x1,25  x1,34  x1,55
 *
 * El pedido gana **desde +0,5s**, en 5 de 5. Se usan ±3s como los más cercanos, que es donde el
 * peor margen ya es x1,25 con aire de sobra. Y como el veredicto toma el señuelo MÁS PARECIDO,
 * agregar candidatos cercanos hace la prueba más estricta, no más laxa.
 *
 * El plano flojo es siempre el mismo —un plano estático— y eso es coherente con lo de abajo.
 *
 * Y en la corrida completa de los 88 planos de un videoclip pasaron **88 de 88**, pero los márgenes más
 * flojos dieron **x1,1**. Un x1,1 no es un veredicto: se informa como NO CONCLUYENTE, igual que
 * hace `foco.py` cuando el encuadre se mueve. Dar por bueno un margen de ruido es la misma
 * promesa de más que decir "verificado".
 *
 * ## Lo que NO puede hacer, medido: verificar al CUADRO
 *
 *     par correcto   0,76   6,62   9,91  10,33  10,23   9,86
 *     +1 cuadro      3,68   8,32  10,06  11,51  10,25   9,83
 *
 * En cuatro de seis no separa, y en uno el desfasado da MENOS. No es un defecto del metro: un
 * cantante quieto frente a un micrófono es casi el mismo cuadro 40ms después. Así que esto
 * confirma que el plano es el pedazo correcto, **no** que esté sincronizado al cuadro. Para
 * sincronía sirve `sincro.py`, que trabaja sobre el audio.
 *
 * Por eso el veredicto dice "el pedazo correcto" y no "verificado": prometer lo segundo dejaría
 * creer que la sincro está chequeada.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const flag = (n) => args.includes("--" + n);
const VIDEO = opt("video", null);
const CORTE = opt("corte", null);
const MATERIAL = opt("material", null);
const LIMITE = Number(opt("limite", 20));
const TODOS = flag("todos");
const MARGEN_FINO = 1.3;   // abajo de esto el veredicto no concluye: ver el encabezado

if (!VIDEO || !CORTE) {
  console.log("uso: node cotejar_export.js --video <export.mp4> --corte <corte.json> [--material <carpeta>] [--limite 20] [--todos]");
  process.exit(1);
}

const norm = (s) => String(s).normalize("NFC");   // macOS da NFD y Premiere NFC
const J = JSON.parse(fs.readFileSync(CORTE, "utf8"));
const crudos = J.planos || J.clips || J.fragmentos || (Array.isArray(J) ? J : []);

/* Sólo los que traen `entrada`: sin in-point no hay nada que cotejar, y decirlo importa más que
 * saltearlos en silencio — una propuesta vieja de un videoclip no traía `entrada` en 59 de 88. */
const planos = crudos.map((p, i) => ({
  i, nombre: p.clip || p.nombre || "", desde: Number(p.desde) || 0,
  dura: Number(p.dura != null ? p.dura : (p.hasta || 0) - (p.desde || 0)),
  entrada: p.entrada != null ? Number(p.entrada) : null, fuente: p.fuente || null,
}));
const sinEntrada = planos.filter((p) => p.entrada == null);
let cotejables = planos.filter((p) => p.entrada != null && p.dura > 0);
if (!TODOS) cotejables = cotejables.slice(0, LIMITE);

/* La carpeta de material: se deduce de dónde está el corte si no se pasa, subiendo hasta
 * encontrar los medios. Una carpeta que hay que acordarse de pasar es una que falta cuando hace
 * falta — el mismo criterio que la guarda de `proyecto`. */
const RAIZ = MATERIAL || path.dirname(path.resolve(CORTE));
const indice = new Map();
(function rec(d, p) {
  if (p > 6) return;
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; }
  for (const x of e) {
    const q = path.join(d, x.name);
    if (x.isDirectory()) { if (!/^\.|PROXIES|Auto-Save|node_modules/i.test(x.name)) rec(q, p + 1); }
    else if (/\.(mp4|mov|mxf|m4v)$/i.test(x.name) && !/_PROXY/i.test(x.name)) {
      const k = norm(x.name); if (!indice.has(k)) indice.set(k, q);
    }
  }
})(RAIZ, 0);

const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "cotejo-"));
const E = path.join(tmp, "e.png"), S = path.join(tmp, "s.png");
const cuadro = (ruta, t, dest, rotar) => execFileSync("ffmpeg",
  ["-v", "error", ...(rotar ? [] : ["-noautorotate"]), "-ss", t.toFixed(3), "-i", ruta,
   "-frames:v", "1", "-vf", "scale=480:-2", dest, "-y"]);
const rmse = (a, b) => {
  try { execSync("compare -metric RMSE " + JSON.stringify(a) + " " + JSON.stringify(b) + " null: 2>&1", { encoding: "utf8" }); return 0; }
  catch (e) { const m = String(e.stdout || e.message).match(/\(([\d.]+)\)/); return m ? +(+m[1] * 100).toFixed(2) : NaN; }
};

const duraVideo = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "csv=p=0", VIDEO], { encoding: "utf8" }).trim());

console.log("\nexport: " + path.basename(VIDEO) + "  " + duraVideo.toFixed(2) + "s");
console.log("corte:  " + path.basename(CORTE) + "  " + planos.length + " planos, " + cotejables.length + " a cotejar");
console.log("material: " + indice.size + " medios bajo " + RAIZ);
if (sinEntrada.length) console.log("(" + sinEntrada.length + " sin `entrada`: no hay con qué cotejarlos)");
console.log("\n  #   plano                        pedido  señuelos      veredicto");

const filas = [];
for (const p of cotejables) {
  const src = indice.get(norm(p.nombre));
  if (!src) { console.log("  " + String(p.i + 1).padStart(3) + "  " + p.nombre.slice(0, 26).padEnd(28) + "  — no encontré el medio"); continue; }
  const medio = p.dura / 2;
  if (p.desde + medio >= duraVideo) { console.log("  " + String(p.i + 1).padStart(3) + "  " + p.nombre.slice(0, 26).padEnd(28) + "  — fuera del video"); continue; }
  let duraSrc = 0;
  try { duraSrc = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { encoding: "utf8" }).trim()); } catch (e) {}

  cuadro(VIDEO, p.desde + medio, E, true);   // el export: como lo ve un reproductor
  const t0 = p.entrada + medio;
  cuadro(src, t0, S, false); const pedido = rmse(E, S);

  /* Los señuelos: otros instantes del MISMO medio. Tienen que ser lo bastante lejos para ser
   * otro contenido y caer adentro del archivo. Se prueban varios y gana el más parecido, que es
   * el caso difícil: si el pedido igual le gana, el veredicto es sólido. */
  const cands = [t0 + 40, t0 - 40, t0 + 15, t0 - 15, t0 + 90, t0 - 90,
                 t0 + 8, t0 - 8, t0 + 3, t0 - 3]
    .filter((t) => t >= 0 && t < duraSrc - 0.5);
  let mejorSenuelo = Infinity;
  for (const t of cands) { cuadro(src, t, S, false); const v = rmse(E, S); if (v < mejorSenuelo) mejorSenuelo = v; }

  const ok = cands.length && pedido < mejorSenuelo;
  const margen = mejorSenuelo / (pedido || 0.01);
  /* Un margen apenas arriba de 1 no es un veredicto. Medido en la corrida completa de los 88
   * planos de un videoclip: pasaron 88 de 88, pero los más flojos dieron x1,1 — y son los planos
   * estáticos, que es exactamente donde el metro ya se sabe que no distingue. Informarlos como
   * "correcto" a secas sería la misma promesa de más que decir "verificado". */
  const razon = !cands.length ? "  material corto: sin señuelo posible"
    : !ok ? "  <- SOSPECHOSO: un señuelo se parece más"
    : margen < MARGEN_FINO ? "  x" + margen.toFixed(2) + " — margen fino, plano estático: NO concluyente"
    : "  el pedazo correcto (x" + margen.toFixed(1) + ")";
  console.log("  " + String(p.i + 1).padStart(3) + "  " + p.nombre.replace(/\.MP4$/i, "").slice(0, 26).padEnd(28) +
              String(pedido).padStart(7) + String(mejorSenuelo === Infinity ? "-" : mejorSenuelo).padStart(9) + razon);
  filas.push({ i: p.i, nombre: p.nombre, fuente: p.fuente, pedido, senuelo: mejorSenuelo, ok, margen, sinSenuelo: !cands.length });
}
fs.rmSync(tmp, { recursive: true, force: true });

const juzgados = filas.filter((f) => !f.sinSenuelo);
const malos = juzgados.filter((f) => !f.ok);
console.log("\n" + juzgados.filter((f) => f.ok).length + " de " + juzgados.length + " muestran el pedazo que pide el corte" +
            (filas.length - juzgados.length ? "  (" + (filas.length - juzgados.length) + " sin señuelo posible)" : ""));
const finos = juzgados.filter((f) => f.ok && f.margen < MARGEN_FINO);
if (finos.length) console.log(finos.length + " con margen fino (< x" + MARGEN_FINO + "): " +
  finos.map((f) => "#" + (f.i + 1)).join(" ") + " — planos estáticos, no concluyen. Mirálos en la plancha.");
if (malos.length) {
  console.log("SOSPECHOSOS: " + malos.map((f) => "#" + (f.i + 1) + " " + f.nombre.slice(0, 20)).join(", "));
  console.log("Mirá esos planos en la plancha antes de concluir: el metro no distingue ±1 cuadro.");
}
console.log("\nEsto confirma el PEDAZO, no la sincronía: ±1 cuadro no se separa (medido). Para");
console.log("sincronía, `sincro.py` sobre el audio.");
process.exit(malos.length ? 1 : 0);
