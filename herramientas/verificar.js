/* Verificación DE AFUERA del EDL: recorta cada rango y lo vuelve a transcribir.
 *
 * Si el in o el out están mal, el texto sale distinto — corto por adelante,
 * con una palabra colgada al final, o con el "Los leo." del asistente. Comparar
 * el resultado del script contra sí mismo no probaría nada: leer y elegir usan
 * los mismos tiempos de Whisper, que es exactamente lo que ya mintió dos veces.
 *
 * Los rangos se leen del JSON que escribe armar_cn.js, no se tipean: tipeando un
 * out a mano me salió 1.1s largo y el error parecía del script.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const D = process.env.PROYECTO_DIR || process.cwd();
const T = path.join(D, "verif");

/* El prefijo del nombre sale de los propios archivos, no escrito a mano: la
 * jornada anterior era `CerroNegro_19-12-25_` y ésta `CerroNegro_18-11-25_`.
 * Fijarlo hace que el script explote en el proyecto siguiente. */
const PREFIJO = (() => {
  for (const f of fs.readdirSync(D)) {
    const m = f.match(/^(.*_)[0-9]+\.audio\.json$/);
    if (m) return m[1];
  }
  throw new Error(`No hay ningun .audio.json en ${D}.`);
})();
const MODELO = path.join(os.homedir(), "Library/Application Support/whisper-cpp/models/ggml-large-v3-turbo.bin");

fs.mkdirSync(T, { recursive: true });
const videos = JSON.parse(fs.readFileSync(path.join(D, "VIDEOS.json"), "utf8"));

const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
const palabras = (t) => norm(t).split(" ").filter(Boolean);

/** Coincidencia de palabras: cuántas del esperado aparecen, y cuántas sobran. */
function comparar(esperado, obtenido) {
  const E = palabras(esperado), O = palabras(obtenido);
  const setO = new Set(O), setE = new Set(E);
  const faltan = E.filter((w) => !setO.has(w));
  const sobran = O.filter((w) => !setE.has(w));
  return { faltan, sobran, cobertura: E.length ? (E.length - faltan.length) / E.length : 0 };
}

let ok = 0, dudosos = [];
for (const v of videos) {
  console.log(`\n══ ${v.titulo}`);
  for (const b of v.beats) {
    const wav = path.join(T, `v_${b.clip}_${b.desde.toFixed(2)}.wav`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", b.desde.toFixed(3), "-t", (b.hasta - b.desde).toFixed(3),
      "-i", path.join(path.dirname(JSON.parse(fs.readFileSync(path.join(D, `${PREFIJO}${b.clip}.audio.json`), "utf8")).archivo), b.archivo),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const salida = execFileSync("whisper-cli", ["-m", MODELO, "-l", "es", "-nt", "--no-prints", "-f", wav],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().replace(/\s+/g, " ").trim();
    const c = comparar(b.texto, salida);
    const bien = c.cobertura >= 0.9 && c.sobran.length <= 2;
    if (bien) ok++; else dudosos.push({ ...b, salida, ...c });
    console.log(`  ${bien ? "✓" : "✗"} _${b.clip} ${b.desde.toFixed(2)}–${b.hasta.toFixed(2)}  cobertura ${(c.cobertura * 100).toFixed(0)}%${c.sobran.length ? `, sobran ${c.sobran.length}: ${c.sobran.join(" ")}` : ""}${c.faltan.length ? `, faltan: ${c.faltan.join(" ")}` : ""}`);
  }
}

console.log(`\n${ok} de ${ok + dudosos.length} beats verificados desde afuera.`);
if (dudosos.length) {
  console.log(`\n${dudosos.length} para revisar:`);
  for (const d of dudosos) {
    console.log(`\n  _${d.clip} ${d.desde.toFixed(2)}–${d.hasta.toFixed(2)}`);
    console.log(`     esperado: ${d.texto}`);
    console.log(`     salió:    ${d.salida}`);
  }
}
