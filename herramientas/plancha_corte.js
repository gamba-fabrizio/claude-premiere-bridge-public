#!/usr/bin/env node
/* Plancha de contacto del EXPORT, un cuadro por plano, etiquetada con el corte.
 *
 * Existe porque en este repo mirar es lo que encuentra los defectos que las guardas numéricas no:
 * el flag de rotación de un videoclip apareció mirando el archivo exportado, y los dos peores defectos de
 * `exportar_dc.js` —cero texto y una barra de reproducción horneada— los encontró una plancha
 * después de que cinco chequeos numéricos dieran verde.
 *
 * El problema era el COSTO de mirar. `premiere_frame` da un cuadro por llamada, o sea 88 llamadas
 * para 88 planos, cada una un viaje al bridge. Pero el export es un archivo suelto y muestrearlo
 * es gratis. Así que la regla que sale de acá es: **verificar el EXPORT, no el timeline.** Y
 * además el export es lo que ve el cliente, que es la pregunta que importa.
 *
 *     node plancha_corte.js --video <export.mp4> --corte <corte.json> [--destino dir] [--por 12]
 *
 * ## Tres decisiones que no son obvias
 *
 * **1. Se muestrea el MEDIO del plano, no el corte.** Un cuadro en el punto de corte es ambiguo:
 * puede ser el último del plano que termina o el primero del que empieza, y con eso la plancha no
 * sirve para decir "el plano 34 salió acostado". El medio es inequívoco.
 *
 * **2. NO se usa `-noautorotate`, al revés que `planchas.js`.** Ahí se lee material de cámara con
 * el flag MAL puesto y hay que ignorarlo. Acá se lee el resultado entregado y hay que hacer lo
 * mismo que hace un reproductor: si el export salió acostado, la plancha tiene que mostrarlo
 * acostado. Poner `-noautorotate` acá esconde justamente el defecto que se vino a buscar.
 *
 * **3. Se comprueba que el corte y el video sean el MISMO corte.** Si el JSON es de otra versión,
 * los tiempos caen en otros planos y la plancha sale plausible y equivocada — el "contador ciego"
 * de este repo, que informa éxito mirando el lugar errado. Se compara la duración del video contra
 * el final del último plano y se ABORTA si no coinciden, en vez de recortar en silencio.
 *
 * La etiqueta la pone `montage`, no `drawtext`: ffmpeg puede estar compilado sin libfreetype y
 * falla callado. Y la fuente va explícita, o `-label` contesta "unable to read font".
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const VIDEO = opt("video", null);
const CORTE = opt("corte", null);
const DEST = opt("destino", process.cwd());
const POR = Number(opt("por", 12));
const TOLERANCIA = Number(opt("tolerancia", 2));   // segundos de diferencia admitidos
const FUENTE = "/System/Library/Fonts/Supplemental/Arial.ttf";

if (!VIDEO || !CORTE) {
  console.log("uso: node plancha_corte.js --video <export.mp4> --corte <corte.json> [--destino dir] [--por 12]");
  process.exit(1);
}
for (const f of [VIDEO, CORTE]) {
  if (!fs.existsSync(f)) { console.log("no existe: " + f); process.exit(1); }
}

/* Los planos: se aceptan las dos formas que escriben las herramientas de este repo —`planos` con
 * `clip` (las propuestas) y `clips` con `nombre` (las capturas de secuencia)— porque si no hay que
 * acordarse de cuál genera cuál, y eso se olvida. */
const J = JSON.parse(fs.readFileSync(CORTE, "utf8"));
const crudos = J.planos || J.clips || J.fragmentos || (Array.isArray(J) ? J : []);
if (!crudos.length) {
  console.log("el corte no trae planos. Claves: " + Object.keys(J).join(", "));
  process.exit(1);
}
const planos = crudos.map((p, i) => ({
  i, nombre: p.clip || p.nombre || ("plano " + (i + 1)),
  desde: Number(p.desde) || 0,
  dura: Number(p.dura != null ? p.dura : (p.hasta != null ? p.hasta - (p.desde || 0) : 0)),
  fuente: p.fuente || null,
})).filter((p) => p.dura > 0);

const finCorte = Math.max(...planos.map((p) => p.desde + p.dura));

const duraVideo = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "csv=p=0", VIDEO], { encoding: "utf8" }).trim());

console.log("\nvideo:  " + path.basename(VIDEO) + "   " + duraVideo.toFixed(2) + "s");
console.log("corte:  " + path.basename(CORTE) + "   " + planos.length + " planos, terminan en " + finCorte.toFixed(2) + "s");

/* La guarda que importa. Sin esto la plancha sale igual, con los cuadros equivocados, y no hay
 * nada en la imagen que lo delate: son planos del mismo material. */
const dif = Math.abs(duraVideo - finCorte);
if (dif > TOLERANCIA) {
  console.log("\nABORTA: el corte y el video difieren en " + dif.toFixed(2) + "s (tolerancia " + TOLERANCIA + "s).");
  console.log("Probablemente el JSON no es de esta versión del export. Si lo es —por ejemplo porque");
  console.log("el export lleva placas de inicio o cola que el corte no tiene— pasá --tolerancia.");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "plancha-"));
const cuadros = [];
for (const p of planos) {
  const t = p.desde + p.dura / 2;              // el MEDIO del plano, no el corte
  if (t >= duraVideo) { console.log("  (fuera del video, salteado) " + p.nombre); continue; }
  const out = path.join(tmp, "c" + String(p.i).padStart(3, "0") + ".jpg");
  execFileSync("ffmpeg", ["-v", "error", "-ss", t.toFixed(3), "-i", VIDEO,
    "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "3", out, "-y"]);
  const mmss = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  cuadros.push({
    f: out,
    etiqueta: "#" + (p.i + 1) + "  " + p.nombre.replace(/\.(MP4|mp4|mov|MOV)$/, "").slice(0, 22) +
              "\\n" + mmss(p.desde) + "  " + p.dura.toFixed(1) + "s" + (p.fuente ? "  " + p.fuente : ""),
  });
}

const hojas = [];
for (let k = 0; k < cuadros.length; k += POR) {
  const lote = cuadros.slice(k, k + POR);
  const n = Math.floor(k / POR) + 1;
  const salida = path.join(DEST, path.basename(VIDEO).replace(/\.[^.]+$/, "") + " - plancha " + n + ".jpg");
  const a = [];
  for (const x of lote) a.push("-label", x.etiqueta, x.f);
  a.push("-font", FUENTE, "-pointsize", "13", "-tile", "4x", "-geometry", "320x180+6+6",
         "-background", "#111", "-fill", "#eee", salida);
  execFileSync("montage", a);
  hojas.push(salida);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + cuadros.length + " cuadros en " + hojas.length + " hoja(s):");
for (const h of hojas) console.log("   " + h);
console.log("\nMIRALAS. Es el paso que encontró el flag de rotación y la barra de reproducción,");
console.log("los dos después de que los chequeos numéricos dieran verde.");
