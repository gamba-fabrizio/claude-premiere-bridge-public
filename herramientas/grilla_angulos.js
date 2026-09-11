#!/usr/bin/env node
/* Para cada instante del tema, TODOS los ángulos disponibles en ese mismo frame.
 *
 * ## Por qué esto y no un catálogo por clip
 *
 * En material multicámara sincronizado no hay nada que averiguar sobre el contenido: ya
 * se sabe que ese plano es el cantante, o el baterista. La pregunta al montar es otra y
 * es TEMPORAL: *qué está pasando en cada ángulo en el instante en que quiero cortar*.
 * Si mira a cámara, si está cantando esa línea, si le tapa la cara la guitarra.
 *
 * Un etiquetado por clip no contesta eso, y ningún modelo de visión tampoco: lo contesta
 * la SINCRO. Como los planos están alineados con el tema, un segundo de la canción cae en
 * un cuadro conocido de cada clip, así que se pueden poner los N ángulos lado a lado en
 * el mismo instante. Es lo que mira un editor para elegir un corte.
 *
 * Idea del usuario, 2026-08-20: "para los planos de los músicos no necesitas saber QUE
 * hay, eso ya esta; a lo sumo tendras que decidir QUE sucede en el momento en el que
 * queres usar ese clip".
 *
 * ## La cuenta
 *
 * Un tramo colocado en la posición `pos` con in-point `ent` tiene un offset implícito
 * `pos - ent`, y entonces el instante `T` del tema cae en el material en:
 *
 *     tiempoFuente = T - (pos - ent)
 *
 * Sólo vale si el tramo CUBRE ese instante: `pos <= T <= pos + duración`. Un tramo que no
 * lo cubre no se saltea en silencio, se informa — que un ángulo no exista en un momento
 * es justamente un dato para montar.
 *
 * Los valores salen de `sincro_tramos.json` cuadriculados con la MISMA cuenta que
 * `colocar_sincro.js`, no de leer la secuencia. Es a propósito: así corre sin Premiere
 * abierto y se puede dejar de noche.
 *
 * ## La ROTACIÓN del archivo se IGNORA por default, y está medido
 *
 * Cinco de los trece clips de los cantantes traen `rotation=-90` en la metadata y el
 * contenido es HORIZONTAL: la cámara se empezó a grabar torcida y el flag quedó mal.
 * ffmpeg obedece el flag, así que las planchas salían con la gente acostada y no servían
 * para nada.
 *
 * Comparado lado a lado sobre FX3_3555 en el mismo instante: con autorotate sale 420x746
 * —vertical, el cantante de costado—, con `-noautorotate` sale 420x236 y el cuadro está
 * nivelado. Verificado mirando, no deducido del flag.
 *
 * Por eso el default es IGNORAR la rotación, y los archivos con flag distinto de cero se
 * INFORMAN en vez de corregirse callado. Con `--rotacion respetar` se obedece el flag,
 * para material donde sí esté bien puesto.
 *
 * ## Y el material puede estar en LOG
 *
 * Si el original es plano y verdoso, las planchas salen igual de planas y NO se puede
 * juzgar color ahí. Con `--lut <archivo.cube>` se aplica al extraer, sólo para mirar.
 * No toca el proyecto.
 *
 * Uso:
 *   node grilla_angulos.js --datos <sincro_tramos.json> --secciones <letra.json>
 *        --destino <dir> [--por-seccion 1] [--fps-secuencia 25] [--ancho 380]
 *        [--lut mirada.cube] [--momentos 12.5,74,151] [--rotacion ignorar|respetar]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

const DATOS = opt("datos", null);
const SECCIONES = opt("secciones", null);
const DESTINO = opt("destino", null);
const POR_SECCION = Number(opt("por-seccion", "1"));
const FPS_SEC = Number(opt("fps-secuencia", "25"));
const ANCHO = Number(opt("ancho", "380"));
const LUT = opt("lut", null);
const MOMENTOS = opt("momentos", null);
const ROTACION = opt("rotacion", "ignorar");
if (!DATOS || !DESTINO) {
  console.error("Faltan --datos <sincro_tramos.json> y --destino <dir>");
  process.exit(1);
}
const FUENTE = "/System/Library/Fonts/Supplemental/Arial.ttf";

const redondear = (s, fps) => Math.round(s * fps) / fps;
/* La misma cuenta que colocar_sincro.js: si las dos no coinciden, la grilla muestra un
 * frame distinto del que está en el timeline y no sirve para decidir nada. */
function cuadricular(offset, desde, hasta, durClip) {
  const F = 1 / FPS_SEC;
  const k = Math.round(offset / F);
  let ent = Math.round(desde / F);
  let pos = ent + k;
  if (pos < 0) { const n = -pos; pos += n; ent += n; }
  let sal = Math.round(hasta / F);
  if (durClip) sal = Math.min(sal, Math.floor(durClip / F));
  if (sal <= ent) sal = ent + 1;
  return { pos: redondear(pos * F, FPS_SEC), ent: redondear(ent * F, FPS_SEC),
           sal: redondear(sal * F, FPS_SEC) };
}

const d = JSON.parse(fs.readFileSync(DATOS, "utf8"));
const tramos = [];
for (const c of d.clips.slice().sort((a, b) => a.nombre.localeCompare(b.nombre))) {
  (c.segmentos || []).forEach((s, i) => {
    const q = cuadricular(s.offset, s.desde, s.hasta, c.dur);
    tramos.push({
      etq: c.nombre.replace(/\.[^.]+$/, "") + ((c.segmentos || []).length > 1 ? "[" + (i + 1) + "]" : ""),
      archivo: c.archivo, pos: q.pos, ent: q.ent, dura: q.sal - q.ent,
      offset: q.pos - q.ent,
    });
  });
}

/* Qué instantes. Por defecto uno por sección, corrido hacia adentro: el borde exacto de
 * una sección suele caer en el último frame de la anterior. */
let momentos = [];
if (MOMENTOS) {
  momentos = MOMENTOS.split(",").map((x) => ({ t: Number(x), nombre: "t" + x }));
} else {
  if (!SECCIONES) { console.error("Sin --momentos hace falta --secciones <letra.json>"); process.exit(1); }
  const L = JSON.parse(fs.readFileSync(SECCIONES, "utf8"));
  for (const s of L.secciones) {
    const dur = s.hasta - s.desde;
    for (let k = 1; k <= POR_SECCION; k++) {
      momentos.push({
        t: redondear(s.desde + dur * (k / (POR_SECCION + 1)), FPS_SEC),
        nombre: s.nombre, estrofa: s.estrofa || null,
      });
    }
  }
}

fs.rmSync(DESTINO, { recursive: true, force: true });
fs.mkdirSync(DESTINO, { recursive: true });
const tmp = path.join(DESTINO, ".cuadros");
fs.mkdirSync(tmp, { recursive: true });

const tc = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
console.log(tramos.length + " ángulo(s) · " + momentos.length + " momento(s)" +
            (LUT ? " · LUT de mirada: " + path.basename(LUT) : "") + "\n");

const filas = [];
let n = 0;
momentos.forEach((m, mi) => {
  const casillas = [];
  const faltan = [];
  for (const t of tramos) {
    /* El tramo tiene que CUBRIR el instante. Que un ángulo no exista en un momento es
     * información para montar, así que se cuenta aparte en vez de saltearlo callado. */
    if (m.t < t.pos || m.t > t.pos + t.dura) { faltan.push(t.etq); continue; }
    const fuente = m.t - t.offset;
    const jpg = path.join(tmp, "m" + String(mi).padStart(2, "0") + "_" + t.etq.replace(/[^\w]/g, "") + ".jpg");
    const vf = [LUT ? "lut3d='" + LUT + "'" : null, "scale=" + ANCHO + ":-2"]
      .filter(Boolean).join(",");
    try {
      /* -ss ANTES de -i para que busque por keyframe y no decodifique desde el arranque:
       * con 4K son segundos contra minutos por cuadro.
       *
       * Y -noautorotate ANTES de -i también, que es donde aplica: es una opción de
       * DEMUXER, no de salida. Puesta después no hace nada y el cuadro sale rotado
       * igual, sin ningún error que lo avise. */
      const cmd = ["-v", "error", "-y"];
      if (ROTACION === "ignorar") cmd.push("-noautorotate");
      cmd.push("-ss", String(fuente.toFixed(3)), "-i", t.archivo, "-frames:v", "1", "-vf", vf, jpg);
      execFileSync("ffmpeg", cmd, { stdio: "pipe" });
      /* La etiqueta se TRUNCA: un nombre largo se monta sobre las de al lado y deja la
       * plancha ilegible justo donde hay que leer qué clip es. Medido con
       * "FX3_0472  TEMA CON INTRO - ACA ESTA EL SOLO DEL TEMA, ARRANCA 1m44s". */
      const corta = t.etq.length > 22 ? t.etq.slice(0, 21) + "…" : t.etq;
      casillas.push({ jpg: jpg, etq: corta + "  " + fuente.toFixed(2) + "s" });
      n++;
    } catch (e) { faltan.push(t.etq + "(falló)"); }
  }
  if (!casillas.length) { console.log("  " + m.nombre + " " + tc(m.t) + ": ningún ángulo"); return; }
  const salida = path.join(DESTINO,
    "MOMENTO_" + String(mi).padStart(2, "0") + "_" + String(m.nombre).replace(/[^\w]/g, "_") + ".jpg");
  const a = [];
  for (const c of casillas) a.push("-label", c.etq, c.jpg);
  /* Las dos dimensiones, no sólo el ancho: una casilla vertical con el alto libre
   * desalinea la grilla entera y la deja llena de huecos. Con las dos, magick encaja
   * cada cuadro adentro del rectángulo y las filas quedan parejas. */
  a.push("-font", FUENTE, "-tile", "4x",
    "-geometry", ANCHO + "x" + Math.round(ANCHO * 9 / 16) + "+4+4",
    "-background", "white", "-pointsize", "14", "-title",
    m.nombre + "   " + tc(m.t) + (m.estrofa ? "   (estrofa " + m.estrofa + ")" : ""), salida);
  execFileSync("magick", ["montage", ...a]);
  filas.push({ m: m, n: casillas.length, faltan: faltan, salida: salida });
  console.log("  " + String(m.nombre).slice(0, 30).padEnd(31) + tc(m.t).padStart(6) +
    "   " + String(casillas.length).padStart(2) + " ángulo(s)" +
    (faltan.length ? "   sin: " + faltan.join(", ") : ""));
});

fs.rmSync(tmp, { recursive: true, force: true });
const md = [];
md.push("# Grilla momento × ángulo\n");
md.push("Cada plancha muestra **todos los ángulos disponibles en el mismo instante del");
md.push("tema**. Es lo que hace falta para elegir un corte, y existe porque los planos");
md.push("están sincronizados: el mismo segundo de la canción cae en un cuadro conocido de");
md.push("cada clip.\n");
md.push("La etiqueta de cada casilla dice el clip y en qué segundo DEL MATERIAL cae, así");
md.push("el plano se puede ir a buscar directo.\n");
if (LUT) md.push("Aplicado `" + path.basename(LUT) + "` sólo para mirar; el proyecto no se tocó.\n");
md.push("| momento | tiempo | estrofa | ángulos | plancha |");
md.push("|---|---|---|---|---|");
for (const f of filas) {
  md.push("| " + f.m.nombre + " | " + tc(f.m.t) + " | " + (f.m.estrofa || "—") + " | " +
    f.n + (f.faltan.length ? " (sin " + f.faltan.length + ")" : "") + " | `" +
    path.basename(f.salida) + "` |");
}
fs.writeFileSync(path.join(DESTINO, "GRILLA.md"), md.join("\n"));
console.log("\n" + filas.length + " plancha(s) · " + n + " cuadro(s) · " + DESTINO);
