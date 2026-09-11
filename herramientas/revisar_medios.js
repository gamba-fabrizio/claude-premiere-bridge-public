#!/usr/bin/env node
/* Revisa el MATERIAL antes de armar: qué defectos trae que Premiere obedece en silencio.
 *
 * `revisar` mira la secuencia ya armada. Esto mira el material ANTES, que es donde estos
 * defectos son baratos: una vez que hay 88 planos colocados, arreglarlos es tocar 88 clips.
 *
 * Sólo lee, y NO usa el bridge: es ffprobe puro, así que corre sin Premiere abierto y sin
 * riesgo de ninguno de los cinco modos de crash.
 *
 *     node revisar_medios.js [carpeta ...] [--fps 25] [--deriva] [--json salida.json]
 *
 * ## Los cuatro chequeos, y por qué cada uno está acá
 *
 * Los cuatro salieron de MEDIR los dos proyectos reales (140 medios de un videoclip, 122 de un corporativo)
 * el 2026-08-23. No hay ninguno puesto por si acaso.
 *
 * **1. El flag de rotación.** 5 en un videoclip, 12 en un corporativo. Premiere lo obedece igual que ffmpeg,
 * así que un 3840x2160 con `rotation=-90` entra al timeline acostado y a escala 100 deja franjas
 * al costado con el contenido ocupando el 56% del ancho. En un videoclip costó un export entero: se
 * detectó MIRANDO el archivo terminado, no antes.
 *
 * **2. VFR — y el riesgo que se MIDIÓ Y NO EXISTE.** La sospecha era razonable: si Premiere
 * conformara asumiendo cadencia constante, cada hueco de la grilla correría el material y el
 * error se acumularía. Los números daban miedo — sobre los 35 VFR de un corporativo la deriva máxima va
 * de 0,02s a 6,20s, y para los in-points reales del corte la peor predicción era 3,12s.
 *
 *     **No pasa. Premiere respeta los PTS**, medido el 2026-08-23 en VIDEO 3 de un corporativo: se puso
 *     el playhead a 2,00s de un clip con `entrada` 100,84 sobre un medio que declara 30fps y
 *     promedia 28,33, y el cuadro que devolvió Premiere coincide con el de ffmpeg en 102,840s
 *     —el modelo PTS— y no con el de 101,951s, que es donde caería un conform de cadencia fija.
 *     RMSE 13,95 contra 29,69, y confirmado mirando los tres cuadros lado a lado.
 *
 * Así que el VFR se informa **sin alarma**: un in-point calculado con ffmpeg cae donde tiene que
 * caer. Sigue valiendo saber cuáles son, porque cualquier cuenta hecha por CONTEO DE CUADROS en
 * vez de por tiempo sí se corre — pero eso es un defecto de la herramienta que la haga, no del
 * material.
 *
 * **3. `r_frame_rate` basura.** Cinco archivos de un corporativo declaran 90000 o 120 fps donde hay 30.
 * Importa más de lo que parece: cualquier cuenta hecha con el rate DECLARADO en vez del promedio
 * da 91 segundos de error en el peor caso. Es el número que casi todo el mundo lee primero.
 *
 * **4. Resoluciones mezcladas.** un videoclip tiene una sola (3840x2160); un corporativo tiene TRECE, de
 * 478x850 a 1920x1080. Dos planos pegados con esa diferencia se ven distintos por más que el
 * encuadre coincida, y además rompe la comparación de `foco.py`: la resolución sola le mueve el
 * score 8,6% o más, que es arriba de su propia guarda de ruido.
 *
 * ## Lo que se midió y NO está acá
 *
 * **Barras horneadas (letterbox/pillarbox).** Se corrió `cropdetect` sobre 28 medios de los dos
 * proyectos y salieron CERO: todos llenan su cuadro. El chequeo no se construyó — cuesta un
 * decode por archivo para contestar algo que en este material no pasa. Si algún día entra
 * material de otra fuente, la línea es `cropdetect=24:2:0` sobre 3s desde el segundo 5 (desde 0
 * agarra el negro del arranque y da un falso positivo gigante).
 *
 * ## El fps distinto al de la secuencia NO es un defecto
 *
 * Se informa aparte y sin alarma, porque es lo NORMAL: 121 de los 140 medios de un videoclip no van a
 * 25fps y el proyecto está bien. Meterlo con los otros tres sería gritar en 121 archivos sanos y
 * enseñar a ignorar la salida.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const flag = (n) => args.includes("--" + n);
const FPS = Number(opt("fps", 25));
const SALIDA = opt("json", null);
const CON_DERIVA = flag("deriva");
const raices = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["fps", "json"].includes(args[i - 1].slice(2))));
const RAICES = raices.length ? raices : [process.cwd()];

/* macOS entrega NFD y Premiere devuelve NFC: se ven iguales y no son la misma cadena. Ya duplicó
 * medios y rompió `insertar` con los dos únicos archivos con tilde de 35. */
const norm = (s) => String(s).normalize("NFC");

function juntarMedios(raiz) {
  const idx = new Map();
  const rec = (d, p) => {
    if (p > 6) return;
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; }
    for (const x of e) {
      const q = path.join(d, x.name);
      if (x.isDirectory()) {
        if (!/^\.|PROXIES|Auto-Save|node_modules|Adobe Premiere Pro (Audio|Video) Previews/i.test(x.name)) rec(q, p + 1);
      } else if (/\.(mp4|mov|mxf|m4v|avi|mts)$/i.test(x.name) && !/_PROXY/i.test(x.name)) {
        const k = norm(x.name);
        if (!idx.has(k)) idx.set(k, q);   // por NOMBRE: el mismo archivo puede estar en dos lados
      }
    }
  };
  rec(raiz, 0);
  return idx;
}

function sondear(ruta) {
  const s = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name,pix_fmt:stream_side_data=rotation:stream_tags=rotate",
    "-of", "default=nw=1", ruta], { encoding: "utf8" });
  const g = (k) => { const m = s.match(new RegExp("^" + k + "=(.+)$", "m")); return m ? m[1].trim() : null; };
  const fr = (x) => { if (!x || x === "0/0" || x === "N/A") return null; const [a, b] = x.split("/").map(Number); return b ? a / b : null; };
  return {
    w: +g("width"), h: +g("height"), codec: g("codec_name"), pix: g("pix_fmt"),
    r: fr(g("r_frame_rate")), avg: fr(g("avg_frame_rate")),
    rot: Number(g("rotation") || g("rotate") || 0), nb: +(g("nb_frames") || 0),
  };
}

/* La deriva de verdad: se piden los PTS de todos los cuadros y se compara cada uno contra dónde
 * lo pondría una cadencia constante. Es lo único que da la MAGNITUD; sin esto sólo se sabe que
 * `r != avg`, que no dice si el problema es de 0,02s o de 4s. Cuesta demultiplexar el archivo
 * entero, así que va detrás de `--deriva`. */
function deriva(ruta, avg) {
  const s = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "frame=best_effort_timestamp_time", "-of", "csv=p=0", ruta], { encoding: "utf8", maxBuffer: 4e8 });
  const t = s.trim().split("\n").map(Number).filter((x) => !isNaN(x));
  if (t.length < 10 || !avg) return null;
  let max = 0;
  for (let k = 0; k < t.length; k++) {
    const d = Math.abs(t[k] - t[0] - k / avg);
    if (d > max) max = d;
  }
  return { cuadros: t.length, span: +(t[t.length - 1] - t[0]).toFixed(3), max: +max.toFixed(3) };
}

const filas = [];
const fallos = [];
for (const raiz of RAICES) {
  for (const [nombre, ruta] of juntarMedios(raiz)) {
    try {
      const d = sondear(ruta);
      if (!d.w || !d.h) { fallos.push([nombre, "sin stream de video"]); continue; }
      filas.push({ nombre, ruta, ...d });
    } catch (e) { fallos.push([nombre, String(e.message).split("\n")[0].slice(0, 70)]); }
  }
}

if (!filas.length) {
  console.log("No encontré medios en: " + RAICES.join(", "));
  process.exit(1);
}

console.log("\n" + filas.length + " medios distintos · secuencia a " + FPS + "fps · " + RAICES.map((r) => path.basename(r)).join(", "));

/* ── 1. rotación ── */
const rotados = filas.filter((f) => f.rot % 360 !== 0);
if (rotados.length) {
  console.log("\n■ FLAG DE ROTACIÓN — " + rotados.length + " medio(s). Premiere lo obedece: entran acostados.");
  for (const f of rotados) {
    const [vw, vh] = Math.abs(f.rot % 180) === 90 ? [f.h, f.w] : [f.w, f.h];
    const ocupa = (Math.min(vw, vh) / Math.max(vw, vh) * 100).toFixed(0);
    console.log("   rot " + String(f.rot).padStart(4) + "°  " + String(f.w + "x" + f.h).padStart(10) +
                " → se presenta " + String(vw + "x" + vh).padStart(10) + "  (contenido ~" + ocupa + "% del ancho)  " + f.nombre.slice(0, 40));
  }
  console.log("   arreglo: fijar · efecto Motion · param Rotation · indiceParam 4 · valor " + (rotados[0].rot > 0 ? "-90" : "-90") +
              "\n   el SIGNO sale de MIRAR el cuadro, no de deducirlo del flag. Y va con `fijar`, no con `keyframe`.");
}

/* ── 2. r_frame_rate basura ── */
const basura = filas.filter((f) => f.r && f.avg && (f.r / f.avg > 1.5 || f.r > 1000));
if (basura.length) {
  console.log("\n■ r_frame_rate NO CREÍBLE — " + basura.length + " medio(s). Usar el PROMEDIO, no el declarado.");
  for (const f of basura) console.log("   declara " + String(f.r.toFixed(3)).padStart(10) + "  promedia " + String(f.avg.toFixed(3)).padStart(8) + "   " + f.nombre.slice(0, 44));
  console.log("   una cuenta hecha con el declarado da hasta 91s de error (medido en un corporativo).");
}

/* ── 3. VFR ── */
const vfr = filas.filter((f) => f.r && f.avg && Math.abs(f.r - f.avg) / f.avg > 0.01);
if (vfr.length) {
  console.log("\n□ VFR — " + vfr.length + " medio(s) con cadencia variable. NO es un defecto: está");
  console.log("  medido que Premiere respeta los PTS, así que un in-point calculado con ffmpeg cae bien.");
  if (CON_DERIVA) {
    const conD = [];
    for (const f of vfr) { const d = deriva(f.ruta, f.avg); if (d) conD.push({ ...f, d }); }
    conD.sort((a, b) => b.d.max - a.d.max);
    for (const f of conD) {
      const grave = f.d.max > 0.5 ? "  <- el que más derivaría" : "";
      console.log("   deriva máx " + String(f.d.max.toFixed(2) + "s").padStart(8) + "  en " + String(f.d.span.toFixed(0) + "s").padStart(5) +
                  " de material   " + f.nombre.slice(0, 38) + grave);
    }
    const graves = conD.filter((f) => f.d.max > 0.5);
    console.log("\n   " + graves.length + " pasarían el medio segundo SI el conform fuera de cadencia fija.");
    console.log("   No lo es: Premiere respeta los PTS, medido. Esto sirve para dimensionar el error");
    console.log("   de una herramienta que cuente CUADROS en vez de leer tiempos, no de Premiere.");
  } else {
    for (const f of vfr) console.log("   declara " + String(f.r.toFixed(3)).padStart(9) + "  promedia " + String(f.avg.toFixed(3)).padStart(8) + "   " + f.nombre.slice(0, 44));
    console.log("   con --deriva se mide cuántos SEGUNDOS puede correrse cada uno (demultiplexa todo, tarda).");
  }
}

/* ── 4. resoluciones ── */
const porResol = new Map();
for (const f of filas) { const k = f.w + "x" + f.h; porResol.set(k, (porResol.get(k) || 0) + 1); }
const resols = [...porResol.entries()].sort((a, b) => b[1] - a[1]);
if (resols.length > 1) {
  console.log("\n■ RESOLUCIONES MEZCLADAS — " + resols.length + " distintas.");
  console.log("   " + resols.map(([k, v]) => k + " x" + v).join(" · "));
  console.log("   dos planos pegados con esa diferencia se ven distintos aunque el encuadre coincida,");
  console.log("   y `foco.py` no puede comparar entre resoluciones: la resolución sola le mueve el score 8,6%.");
} else {
  console.log("\n□ resolución única: " + resols[0][0] + " — nada que mirar.");
}

/* ── informativo, sin alarma ── */
const otroFps = filas.filter((f) => f.avg && Math.abs(f.avg - FPS) > 0.01);
console.log("\n□ fps distinto al de la secuencia: " + otroFps.length + " de " + filas.length + " — es NORMAL, Premiere los conforma. No es un defecto.");
const diez = filas.filter((f) => /10le|10be|12le|p010|422p10/.test(f.pix || ""));
if (diez.length) console.log("□ 10 bits o más: " + diez.length + " — afecta la fluidez del timeline, no la corrección. Ahí sirven los proxies.");
if (fallos.length) {
  console.log("\n□ no se pudieron leer " + fallos.length + ":");
  for (const [n, e] of fallos.slice(0, 8)) console.log("   " + n.slice(0, 40) + " — " + e);
}

// el VFR NO entra: está medido que Premiere lo maneja bien, así que contarlo como defecto
// haría "revisar lo marcado" sobre 35 archivos sanos, que es justo lo que este archivo evita.
const nada = !rotados.length && !basura.length && resols.length === 1;
console.log("\n" + (nada ? "Sin defectos silenciosos." : "Revisar lo marcado con ■ antes de armar."));

if (SALIDA) {
  fs.writeFileSync(SALIDA, JSON.stringify({
    fps: FPS, raices: RAICES, total: filas.length,
    rotados: rotados.map((f) => ({ n: f.nombre, rot: f.rot, w: f.w, h: f.h })),
    rateNoCreible: basura.map((f) => ({ n: f.nombre, declarado: f.r, promedio: f.avg })),
    vfr: vfr.map((f) => ({ n: f.nombre, declarado: f.r, promedio: f.avg })),
    resoluciones: resols, fallos,
  }, null, 1));
  console.log("→ " + SALIDA);
}
