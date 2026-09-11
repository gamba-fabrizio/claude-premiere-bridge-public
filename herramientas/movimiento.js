#!/usr/bin/env node
/* Movimiento de cámara ROTO: la receta que estaba validada y sin construir.
 *
 * `MOVIMIENTO_ROTO.md` la dejó escrita el 2026-08-20 con su validación —8 de 10 fuera de
 * muestra, contra un techo humano de 83%— y la decisión explícita de NO construirla hasta que
 * el volumen lo justificara. Se construye ahora porque se necesita para elegir planos, y el
 * encabezado de aquel archivo dice literalmente que estaba para "armarla en una hora sin
 * repetir el camino". Esto es ese camino, sin repetirlo.
 *
 * ## Qué contesta, y qué NO
 *
 * Contesta **si hay un golpe o un tirón no intencional**, y DÓNDE está. No contesta si el foco
 * está, si el plano "funciona", ni si el paneo termina en un cuadro lindo: eso se mira. Y sobre
 * todo, un puntaje alto **NO significa descartar**: significa que ese plano NECESITA
 * ESTABILIZADOR, que es parte del flujo del usuario. La lista sirve para no buscar a mano
 * cuáles estabilizar.
 *
 * ## La fórmula, tal cual quedó validada
 *
 *     d[k]     = media |cuadro[k+1] − cuadro[k]|     sobre el clip COMPLETO, gris, 320px
 *     base[k]  = mediana de d en ±12 cuadros          línea de base LOCAL, ~1s
 *     score[k] = (d[k] − base[k]) / sqrt(max(base[k], 0.05))
 *     puntaje  = max(score) sobre el 15%–85% del clip
 *     umbral   ≈ 0,45
 *
 * Cada pieza está medida y ninguna es un parámetro que se movió hasta que diera bien:
 *
 * - **Clip completo y MÁXIMO**, no tres ventanas promediadas. El agua corre todo el tiempo y
 *   aparece en las tres ventanas; el golpe pasa una vez y el promedio lo borra. La primera
 *   versión estaba sesgada exactamente al revés de lo que importa.
 * - **Exceso sobre la base, no cociente.** `d/base` castiga a los clips que ya se mueven mucho.
 *   Con el exceso amortiguado por `sqrt(base)`, Spearman contra el juicio humano sube de
 *   **+0,550 a +0,811**.
 * - **Sólo el 15%–85%.** Sale del criterio del usuario —"un golpe en el BORDE es recortable,
 *   uno en el MEDIO arruina el plano"—, no de ajustar un número.
 *
 * ## Y el umbral NO separa: es un RANKING
 *
 * Hay solapamiento medido en la frontera —un falso positivo dio 0,508 y un roto real 0,526—
 * así que usarlo como sí/no va a fallar siempre. Se informa el puntaje y el orden, y el umbral
 * sólo como referencia. Un verbo que contestara "roto: sí/no" estaría mintiendo con la
 * precisión que no tiene.
 *
 * ## La base separa perfecto otra cosa, y eso sí es sin peros
 *
 * La mediana de `d` distingue el material con movimiento PROPIO en el cuadro del material
 * quieto, en 25 clips y sin un error: agua 5,33 y 2,76 · drone 3,13 · handheld quieto
 * 0,45–0,63. Se informa como `base`, y sirve para saber por qué un clip puntúa como puntúa.
 *
 * Uso:
 *   node movimiento.js <carpeta> [--proxies <dir>] [--salida <json>] [--etiquetas <json>]
 *
 *   --proxies    carpeta con proxies; se usan si existen (mismo material, decodifica más
 *                rápido). Se emparejan por prefijo Y se exige que la DURACIÓN coincida, por
 *                lo mismo que en `proxies.js`: un nombre deducido es una hipótesis.
 *   --etiquetas  VEREDICTOS_MOVIMIENTO.json. Si viene, al final se contrasta el ranking contra
 *                las etiquetas humanas. Un filtro nuevo se prueba contra los positivos
 *                conocidos antes que contra los negativos imaginados.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const CARPETA = args[0] && !args[0].startsWith("--") ? args[0] : null;
if (!CARPETA) { console.error("Uso: node movimiento.js <carpeta> [--proxies <dir>] [--salida <json>] [--etiquetas <json>]"); process.exit(1); }
const PROXIES = opt("proxies", null);
const SALIDA = opt("salida", path.join(CARPETA, "movimiento.json"));
const ETIQUETAS = opt("etiquetas", null);

const VIDEO = /\.(mp4|mov|mxf|m4v|avi)$/i;
const UMBRAL = 0.45;          // referencia, NO un separador: hay solapamiento medido
const VENTANA = 12;           // ±12 cuadros ≈ 1s a 25fps, la base LOCAL
const DESDE = 0.15, HASTA = 0.85;   // los bordes se ignoran: un golpe ahí es recortable

function duracion(f) {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "csv=p=0", f], { encoding: "utf8" }).trim()) || null;
  } catch (e) { return null; }
}

/* Todos los archivos de video, RECURSIVO: el material está catalogado en subcarpetas por
 * espacio, y una herramienta que sólo lee un nivel obliga a correrla nueve veces. */
function recorrer(dir, hasta = 4, nivel = 0) {
  let out = [];
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith(".")) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory() && nivel < hasta) out = out.concat(recorrer(p, hasta, nivel + 1));
    else if (st.isFile() && VIDEO.test(n)) out.push(p);
  }
  return out;
}

/* La serie de diferencias entre cuadros consecutivos, a fps NATIVOS.
 * `tblend=difference` + `signalstats` da exactamente `media |cuadro[k+1] − cuadro[k]|` sin
 * tener que extraer los cuadros a disco. `metadata=print:file=-` y no el log, porque `-v error`
 * se come la salida de metadata y eso da una serie vacía que parece un clip quieto. */
function serieDeDiferencias(f) {
  const txt = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf",
    "scale=320:-1,format=gray,tblend=all_mode=difference,signalstats," +
    "metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const d = [];
  for (const l of txt.split("\n")) {
    const m = l.indexOf("YAVG=");
    if (m !== -1) d.push(Number(l.slice(m + 5)));
  }
  return d;
}

const mediana = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function analizar(d, fps) {
  const n = d.length;
  if (n < 2 * VENTANA + 3) return null;      // muy corto para tener base local
  const score = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - VENTANA), b = Math.min(n, k + VENTANA + 1);
    const base = mediana(d.slice(a, b));
    score[k] = (d[k] - base) / Math.sqrt(Math.max(base, 0.05));
  }
  const i0 = Math.floor(n * DESDE), i1 = Math.ceil(n * HASTA);
  let puntaje = -Infinity, donde = -1;
  for (let k = i0; k < i1; k++) if (score[k] > puntaje) { puntaje = score[k]; donde = k; }
  return { puntaje, picoEn: donde / fps, base: mediana(d), score, n };
}

const fuentes = recorrer(CARPETA).sort();
if (!fuentes.length) { console.error(`No hay video en ${CARPETA}`); process.exit(1); }

/* Los proxies se emparejan por prefijo Y duración, igual que en proxies.js: 26 de los de
 * un institucional traen un `_1` de más, y por prefijo solo se engancharían al clip vecino. */
let candidatos = [];
if (PROXIES && fs.existsSync(PROXIES)) {
  candidatos = fs.readdirSync(PROXIES).filter((n) => VIDEO.test(n)).map((n) => path.join(PROXIES, n));
}
function proxyDe(f, durOrig) {
  const base = path.basename(f, path.extname(f));
  const buenos = candidatos.filter((c) => {
    const b = path.basename(c);
    if (!b.startsWith(base)) return false;
    const sig = b.charAt(base.length);
    if (sig !== "_" && sig !== ".") return false;
    const d = duracion(c);
    return d !== null && durOrig !== null && Math.abs(d - durOrig) < 0.2;
  });
  return buenos.length === 1 ? buenos[0] : null;   // ambiguo o ninguno: se usa el original
}

console.log(`${fuentes.length} clip(s) en ${CARPETA}${PROXIES ? ` · proxies: ${candidatos.length}` : ""}\n`);
const salida = [];
const t0 = Date.now();
for (let i = 0; i < fuentes.length; i++) {
  const f = fuentes[i];
  const nombre = path.basename(f, path.extname(f));
  const dur = duracion(f);
  const px = proxyDe(f, dur);
  const leer = px || f;
  let fps = 25;
  try {
    const r = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v",
      "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", leer], { encoding: "utf8" }).trim();
    const [a, b] = r.split("/").map(Number);
    if (a && b) fps = a / b;
  } catch (e) { /* queda 25: se informa igual y el pico en segundos sale con ese fps */ }

  let d, err = null;
  try { d = serieDeDiferencias(leer); } catch (e) { err = String(e.message || e).slice(0, 160); }
  const a = (!err && d) ? analizar(d, fps) : null;
  if (!a) {
    salida.push({ nombre, ruta: f, dur, fps, puntaje: null, razon: err || "clip demasiado corto para una base local" });
    console.log(`  ? ${nombre} — ${err || "muy corto"}`);
  } else {
    salida.push({
      nombre, ruta: f, proxy: px || null, dur, fps,
      puntaje: Number(a.puntaje.toFixed(3)),
      picoEn: Number(a.picoEn.toFixed(2)),
      base: Number(a.base.toFixed(3)),
      /* La serie se guarda a 4 por segundo: alcanza para encontrar un TRAMO limpio adentro
       * del clip y no infla el JSON a decenas de MB. El puntaje sale de la serie COMPLETA. */
      scoreCada: 0.25,
      serie: (() => {
        const paso = Math.max(1, Math.round(fps / 4)), s = [];
        for (let k = 0; k < a.n; k += paso) {
          let mx = -Infinity;
          for (let j = k; j < Math.min(a.n, k + paso); j++) if (a.score[j] > mx) mx = a.score[j];
          s.push(Number(mx.toFixed(2)));
        }
        return s;
      })()
    });
    console.log(`  ${a.puntaje >= UMBRAL ? "!" : "="} ${nombre.padEnd(14)} puntaje ${a.puntaje.toFixed(3).padStart(7)}  pico en ${a.picoEn.toFixed(1).padStart(5)}s  base ${a.base.toFixed(2).padStart(5)}`);
  }
}
fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 1));
console.log(`\n${salida.length} analizado(s) en ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min · ${SALIDA}`);

const conPuntaje = salida.filter((x) => x.puntaje !== null).sort((a, b) => b.puntaje - a.puntaje);
console.log(`\nlos 12 primeros del ranking (los mas sospechosos de tener un golpe):`);
for (const x of conPuntaje.slice(0, 12)) console.log(`  ${x.nombre.padEnd(14)} ${x.puntaje.toFixed(3).padStart(7)}  en ${x.picoEn.toFixed(1)}s`);

/* ---- Contraste contra las etiquetas humanas ----
 * Un filtro nuevo se prueba contra los POSITIVOS CONOCIDOS antes que contra los negativos
 * imaginados. Y acá hay una sutileza que hay que respetar: las etiquetas son del TRAMO que el
 * usuario miró, no del clip, y un mismo clip cambió de etiqueta con la ventana corrida 1s. Por
 * eso se compara en BINARIO (ok contra no-ok) y se informa el techo, que es 83%. */
if (ETIQUETAS && fs.existsSync(ETIQUETAS)) {
  const et = JSON.parse(fs.readFileSync(ETIQUETAS, "utf8"));
  const porClip = new Map();
  for (const t of et.tandas || []) for (const c of t.clips || []) {
    if (!porClip.has(c.clip)) porClip.set(c.clip, []);
    porClip.get(c.clip).push(c.veredicto);
  }
  const filas = [];
  for (const [clip, vs] of porClip) {
    const x = salida.find((s) => s.nombre === clip);
    if (!x || x.puntaje === null) continue;
    const noOk = vs.some((v) => v === "roto");     // binario: si alguna vez lo llamo roto
    filas.push({ clip, puntaje: x.puntaje, humano: vs.join("/"), noOk });
  }
  filas.sort((a, b) => b.puntaje - a.puntaje);
  const aciertos = filas.filter((f) => (f.puntaje >= UMBRAL) === f.noOk).length;
  console.log(`\ncontra las ${filas.length} etiquetas humanas (binario ok / no-ok, umbral ${UMBRAL}):`);
  for (const f of filas) {
    const pred = f.puntaje >= UMBRAL ? "no-ok" : "ok";
    const bien = (f.puntaje >= UMBRAL) === f.noOk;
    console.log(`  ${bien ? " " : "X"} ${f.clip.padEnd(14)} ${f.puntaje.toFixed(3).padStart(7)}  predice ${pred.padEnd(6)} humano ${f.humano}`);
  }
  console.log(`  ${aciertos} de ${filas.length} (${Math.round(100 * aciertos / filas.length)}%) · el TECHO humano medido es 83%`);
}
