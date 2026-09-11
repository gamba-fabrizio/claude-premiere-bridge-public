#!/usr/bin/env node
/* La contraparte de `audio.js` para material SIN voz.
 *
 * En b-roll no hay transcripción de la que agarrarse: la selección es visual. Lo
 * que este script aporta son las dos cosas que se pueden sacar de la máquina sin
 * mirar 45 minutos de material:
 *
 *   1. CUADROS, para saber QUÉ muestra cada clip — tres por clip (20%, 50%, 80%),
 *      que además revelan si el plano se abre, cierra o panea.
 *   2. MOVIMIENTO, para saber CÓMO se mueve, que en un cuadro fijo no se ve. Se
 *      mide la diferencia media entre cuadros consecutivos a 2fps sobre una
 *      miniatura en gris: barato y suficiente para distinguir un plano quieto de
 *      un travelling, y para encontrar el TRAMO estable adentro de una toma.
 *
 * Lo que NO da, y hay que decirlo cada vez: si el movimiento es suave o tiembla,
 * si el foco está, si el paneo termina en un cuadro que sirve. Eso se audita
 * mirando. Esto es una preselección, no un corte.
 *
 * Usa los PROXIES cuando existen: mismo material, códec liviano, decodifica
 * mucho más rápido que HEVC 4K. Cae al original si falta el proxy.
 *
 * Uso: node broll.js <carpeta> [--destino <dir>] [--proxies <dir>]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const carpeta = args[0];
if (!carpeta) { console.error("Falta la carpeta de material."); process.exit(1); }
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const destino = opt("destino", process.cwd());
const dirProxies = opt("proxies", null);

const VIDEO = /\.(mp4|mov|mxf|avi|mts)$/i;

/** Todos los clips, recorriendo subcarpetas, con la carpeta que los cataloga. */
function clipsDe(raiz) {
  const out = [];
  const rec = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      if (f.startsWith(".")) continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (p !== dirProxies) rec(p); }
      else if (VIDEO.test(f)) out.push({ ruta: p, nombre: path.basename(f, path.extname(f)), grupo: path.basename(d) });
    }
  };
  rec(raiz);
  return out;
}

/** El proxy del clip, si existe. Los proxies suelen llamarse `<nombre>_Proxy.mov`. */
function proxyDe(nombre) {
  if (!dirProxies || !fs.existsSync(dirProxies)) return null;
  for (const f of fs.readdirSync(dirProxies)) {
    if (f.startsWith(".")) continue;
    const base = path.basename(f, path.extname(f)).replace(/_proxy$/i, "");
    if (base === nombre) return path.join(dirProxies, f);
  }
  return null;
}

const duracion = (p) => Number(execFileSync("ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p]).toString().trim());

/**
 * Movimiento por segundo. Devuelve la serie y de dónde a dónde está más quieto.
 *
 * `metadata=print` escribe por stderr y con `-v error` se pierde — costó una
 * vuelta descubrirlo, porque el comando "anda" y devuelve la lista vacía.
 */
function movimiento(p, dur) {
  let salida = "";
  try {
    salida = execFileSync("bash", ["-c",
      `ffmpeg -i ${JSON.stringify(p)} -vf "fps=2,scale=64:36,format=gray,` +
      `tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" ` +
      `-f null - 2>/dev/null`], { maxBuffer: 1e8 }).toString();
  } catch (e) { return null; }
  const v = [...salida.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1])).slice(1);
  if (!v.length) return null;
  const medio = v.reduce((a, b) => a + b, 0) / v.length;
  /* EL TRAMO USABLE NO ES EL MÁS QUIETO. Esto empezó buscando el mínimo de
   * movimiento y elegía sistemáticamente lo peor: en una toma con movimiento, la
   * parte más quieta es la RAMPA —el operador todavía acomodando— y eso es
   * justo lo que no sirve. Confirmado por el editor sobre 24 planos: de los 12
   * que marcó mal, cinco arrancaban en el 0% del clip y siete tenían un cociente
   * de 0,40 contra la mediana; sus 12 buenos promediaban 0,75.
   *
   * La regla que sale de eso, y que reproduce 10 de sus 12 elecciones dentro de
   * 2 segundos:
   *   · NUNCA desde el inicio — piso absoluto de 1,5s, no un porcentaje: la
   *     cámara tarda lo mismo en acomodarse en un clip de 9s que en uno de 90;
   *   · tampoco el último 10%, que es la rampa de salida;
   *   · movimiento cercano a 0,72 × la mediana del clip — establecido pero no en
   *     su pico— y lo más parejo posible adentro de la ventana. */
  const ventana = 6; // muestras = 3s a 2fps
  const ordenada = [...v].sort((a, b) => a - b);
  const mediana = ordenada[Math.floor(ordenada.length / 2)] || 0.1;
  const OBJETIVO = 0.72;
  const iMin = Math.max(Math.floor(v.length * 0.08), 3); // 3 muestras = 1,5s
  const iMax = Math.ceil(v.length * 0.90) - ventana;
  let mejor = null;
  for (let i = Math.min(iMin, Math.max(0, v.length - ventana)); i <= Math.max(iMin, iMax); i++) {
    const w = v.slice(i, i + ventana);
    if (w.length < ventana) break;
    const m = w.reduce((a, b) => a + b, 0) / ventana;
    let varia = 0;
    for (let k = 1; k < w.length; k++) varia += Math.abs(w[k] - w[k - 1]);
    varia /= ventana - 1;
    const puntaje = Math.abs(m / Math.max(mediana, 0.1) - OBJETIVO) + varia / Math.max(mediana, 0.1) * 0.5;
    if (!mejor || puntaje < mejor.p) mejor = { desde: Number((i / 2).toFixed(1)), mov: m, p: puntaje };
  }
  return {
    medio: Number(medio.toFixed(1)),
    pico: Number(Math.max(...v).toFixed(1)),
    quietoPct: Math.round(100 * v.filter((x) => x < 1.5).length / v.length),
    mejorTramo: mejor ? { desde: mejor.desde, dura: 3, mov: Number(mejor.mov.toFixed(1)) } : null,
    serie: v.map((x) => Number(x.toFixed(1))),
  };
}

const clips = clipsDe(carpeta);
console.log(`${clips.length} clips en ${carpeta}`);
const dirCuadros = path.join(destino, "cuadros");
fs.mkdirSync(dirCuadros, { recursive: true });

const salida = [];
let n = 0;
for (const c of clips) {
  n++;
  const fuente = proxyDe(c.nombre) || c.ruta;
  let dur = 0;
  try { dur = duracion(fuente); } catch (e) { console.log(`  ${c.nombre}: ffprobe falló`); continue; }
  const cuadros = [];
  for (const pc of [20, 50, 80]) {
    const o = path.join(dirCuadros, `${c.nombre}_${pc}.jpg`);
    try {
      // `-noautorotate` va ANTES de `-i`: es opcion de demuxer y puesta despues no hace nada y
      // no avisa. Sin esto los clips con el flag de rotacion mal puesto —5 en un videoclip, 12 en
      // un corporativo— salen ACOSTADOS en la plancha, y la plancha existe para poder mirarlos.
      execFileSync("ffmpeg", ["-v", "error", "-y", "-noautorotate", "-ss", String((dur * pc / 100).toFixed(2)),
        "-i", fuente, "-vframes", "1", "-vf", "scale=320:-2", o], { stdio: ["ignore", "ignore", "pipe"] });
      cuadros.push(o);
    } catch (e) { console.log(`  ${c.nombre} @${pc}%: ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
  }
  salida.push({ ...c, fuente, dur: Number(dur.toFixed(2)), cuadros, mov: movimiento(fuente, dur) });
  if (n % 20 === 0) console.log(`  ${n}/${clips.length}`);
}

fs.writeFileSync(path.join(destino, "broll.json"), JSON.stringify(salida, null, 1));
const porGrupo = {};
for (const c of salida) (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(c);
console.log(`\nlisto: ${salida.length} clips`);
for (const g of Object.keys(porGrupo).sort()) {
  const cs = porGrupo[g], movs = cs.map((c) => c.mov && c.mov.medio).filter((x) => x != null);
  console.log(`  ${g.padEnd(16)}${String(cs.length).padStart(3)} clips  ` +
    `${(cs.reduce((a, c) => a + c.dur, 0) / 60).toFixed(1).padStart(5)} min  ` +
    `movimiento ${movs.length ? (movs.reduce((a, b) => a + b, 0) / movs.length).toFixed(1) : "?"}`);
}
