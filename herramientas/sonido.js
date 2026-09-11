#!/usr/bin/env node
/* Efectos de sonido con ElevenLabs, en WAV 48k, y opcionalmente puestos en Premiere.
 *
 * La contraparte de `locucion.js` para lo que NO es voz: acentos de transición, ambientes,
 * detalles. Sale de usarlo a mano el 2026-09-02 sobre un pitch real, donde cada pedido eran
 * cinco pasos —curl, revisar que no volviera un error, envolver el PCM, medir, copiar al lado
 * del proyecto, importar, insertar— y todos se pueden hacer de una.
 *
 * ## Para qué SÍ sirve la generación, medido
 *
 * **Sonidos de diseño**: un whoosh, un riser, un impacto, un shimmer. Se piden al largo exacto
 * —`duration_seconds` de 0,5 a 30, respetado al centésimo— y eso es lo que la biblioteca no da:
 * un whoosh de 0,8s para un corte de 0,6s, sin recortar y pelearse con el ataque.
 *
 * **Ambientes**, con `--loop`, para camas que tienen que durar más que la generación.
 *
 * ## Para qué NO, también medido
 *
 * **Instrumentos identificables.** Se pidió "bandoneón" y salió un CELLO. No es un problema de
 * prompt: el modelo genera sonido, no timbres reconocibles por nombre. Lo que sí funcionó fue
 * describir la FAMILIA y el mecanismo —"reed accordion, free-reed instrument, nasal and breathy
 * timbre"— y ahí acertó. Si hace falta el instrumento de verdad, va una biblioteca.
 *
 * **Contar notas.** Pidiendo DOS notas salieron cuatro; pidiendo TRES salieron dos. La cantidad
 * no se pide: se piden variantes y se elige.
 *
 * **Foley que tenga que coincidir con una imagen.** Da algo *parecido a* una tela o un paso, y
 * cuando el sonido tiene que caer sobre un movimiento concreto eso se nota.
 *
 * Uso:
 *   node sonido.js --texto "..." [--dura 2] [--loop] [--influencia 0.6]
 *                  [--salida <wav>] [--variantes 3]
 *                  [--colocar --pista <n> [--segundos <s>] [--proyecto <n>] [--secuencia <n>]]
 *
 *   --variantes 3   genera tres con el MISMO texto y las numera. La generación no es
 *                   determinista, asi que pedir varias y elegir sale mas barato que afinar el
 *                   prompt a ciegas.
 *   --segundos      donde colocarlo. Sin esto va AL PLAYHEAD, que es el caso normal.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("Falta $ELEVENLABS_API_KEY. Ponela en tu shell:\n" +
                '  echo \'export ELEVENLABS_API_KEY="..."\' >> ~/.zshrc');
  process.exit(1);
}
const TEXTO = opt("texto", null);
if (!TEXTO) { console.error('Falta --texto "descripción del sonido"'); process.exit(1); }

const DURA = Number(opt("dura", 2));
if (!(DURA >= 0.5 && DURA <= 30)) { console.error("--dura tiene que estar entre 0.5 y 30 (la API lo exige)."); process.exit(1); }
const INFL = Number(opt("influencia", 0.6));
const VARIANTES = Math.max(1, Number(opt("variantes", 1)));
const SALIDA = path.resolve(opt("salida", path.join(process.cwd(), "sfx.wav")));

/* PCM_48000 y no el mp3 por defecto: es la tasa de las secuencias y no recomprime. La API no
 * ofrece "wav" —devuelve PCM crudo sin cabecera— asi que la cabecera se pone con ffmpeg. */
function generar(destino) {
  const crudo = destino + ".pcm";
  execFileSync("curl", ["-sS", "-X", "POST",
    "https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_48000",
    "-H", "xi-api-key: " + KEY, "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ text: TEXTO, duration_seconds: DURA,
                           prompt_influence: INFL, loop: flag("loop") }),
    "-o", crudo], { maxBuffer: 512 * 1024 * 1024 });

  /* Un error vuelve como JSON con la extensión del audio. Se detecta INTENTANDO PARSEARLO, no
   * buscando un `{` en los primeros bytes: el PCM crudo tiene ese byte adentro del audio y ese
   * chequeo dio un falso positivo la primera vez que se uso. */
  const cabeza = fs.readFileSync(crudo).slice(0, 2048).toString("utf8");
  try {
    const j = JSON.parse(cabeza);
    if (j && (j.detail || j.message)) {
      fs.unlinkSync(crudo);
      throw new Error("la API rechazó: " + JSON.stringify(j.detail || j.message).slice(0, 200));
    }
  } catch (e) { if (e.message.startsWith("la API rechazó")) throw e; /* no era JSON: es audio */ }

  /* Los dos canales van a proposito: un wav MONO se reproduce MUDO en el visor del usuario, sin
   * error de ninguna de las dos partes. Medido el 2026-09-02; ver la nota en `locucion.js`. */
  execFileSync("ffmpeg", ["-v", "error", "-f", "s16le", "-ar", "48000", "-ac", "2",
                          "-i", crudo, "-ac", "2", destino, "-y"]);
  fs.unlinkSync(crudo);

  /* VERIFICACIÓN DE AFUERA. Que curl no tire no dice que el archivo esté completo, y un wav
   * truncado se coloca igual: el problema aparece recién reproduciendo. */
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", destino], { encoding: "utf8" }).trim());
  if (!dur || Math.abs(dur - DURA) > 0.35) {
    throw new Error(`el wav quedó en ${dur}s y se pidieron ${DURA}s`);
  }
  /* El nivel se informa SIEMPRE, y el clipping se distingue de un pico suelto por el flat
   * factor: un clip real aplana corridas de muestras. Medido el 2026-09-02, un whoosh volvió
   * con pico 0,0 dB y flat factor 21,5 —clippeado de verdad— y otros con pico alto y flat 0. */
  /* Va con spawnSync y no con execFileSync porque ffmpeg escribe las estadisticas por
   * STDERR, y el valor de retorno de execFileSync es stdout: daba null y el .match explotaba. */
  const st = spawnSync("ffmpeg", ["-hide_banner", "-i", destino, "-af",
    "astats=metadata=1,volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const num = (re) => { const m = st.match(re); return m ? Number(m[1]) : null; };
  return { dur: dur,
           media: num(/mean_volume:\s*(-?[\d.]+) dB/),
           pico: num(/max_volume:\s*(-?[\d.]+) dB/),
           flat: num(/Flat factor:\s*([\d.]+)/) };
}

const base = SALIDA.replace(/\.wav$/i, "");
const hechos = [];
console.log(`"${TEXTO.slice(0, 70)}${TEXTO.length > 70 ? "…" : ""}"`);
console.log(`${DURA}s · influencia ${INFL}${flag("loop") ? " · loop" : ""} · ${VARIANTES} variante(s)\n`);
for (let i = 1; i <= VARIANTES; i++) {
  const d = VARIANTES === 1 ? SALIDA : `${base}_${i}.wav`;
  try {
    const m = generar(d);
    hechos.push(d);
    /* El clipping exige flat alto Y PICO CERCA DE 0. Medido el 2026-09-03: un ambiente que
     * salió MUDO —media -70,1 dB, pico -54,6— informó "CLIPPEADO (flat 5,1)", porque un
     * archivo casi silencioso es plano por definición. El flat factor solo no distingue
     * "aplastado contra el techo" de "no hay nada".
     *
     * Y la guarda que de verdad hacía falta es la otra: que la generación SALGA MUDA. Pasó
     * pidiendo "very quiet, no cars, no voices, barely audible" — el modelo tomó los
     * negativos al pie de la letra y generó silencio. La API contesta 200, el wav mide el
     * largo pedido, y no suena nada. Sin este aviso se coloca y se descubre reproduciendo. */
    const CLIP = m.flat !== null && m.flat > 5 && m.pico !== null && m.pico > -1;
    const MUDO = m.media !== null && m.media < -55;
    const aviso = MUDO
      ? `  ← SALIÓ CASI MUDO (media ${m.media} dB): describí lo que SÍ hay, no lo que falta`
      : CLIP ? "  ← CLIPPEADO (flat " + m.flat.toFixed(1) + ")" : "";
    console.log(`  ${path.basename(d)}  ${m.dur.toFixed(2)}s  media ${m.media} dB  pico ${m.pico} dB${aviso}`);
  } catch (e) { console.log(`  variante ${i}: ${String(e.message).slice(0, 160)}`); }
}
if (!hechos.length) process.exit(1);

if (!flag("colocar")) {
  console.log(`\nNo se colocó nada. Corré con --colocar --pista <n> para ponerlo en Premiere.`);
  process.exit(0);
}
if (hechos.length > 1) {
  console.log(`\n${hechos.length} variantes: elegí una y volvé a correr con --variantes 1 y --colocar.`);
  process.exit(0);
}
const PISTA = Number(opt("pista", 0));
if (!PISTA) { console.error("Con --colocar hace falta --pista <n> (la pista de AUDIO)."); process.exit(1); }

(async () => {
  const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  let PROY = opt("proyecto", null);
  const SEC = opt("secuencia", null);
  if (!PROY) {
    const e = await enviar("estado", {}, 120000);
    PROY = e.info && e.info.proyectoNombre;
    if (!PROY) { console.error("No se pudo leer qué proyecto tiene foco. Pasá --proyecto."); process.exit(1); }
    console.log(`\nproyecto (leído del foco): ${PROY}`);
  }
  const g = (o) => Object.assign({ proyecto: PROY }, SEC ? { secuencia: SEC } : {}, o);

  /* Sin --segundos va AL PLAYHEAD, que es el caso normal: uno está parado en el corte que
   * quiere decorar. Se LEE en vez de asumir 0. */
  let SEG = opt("segundos", null);
  if (SEG === null) {
    const p = await enviar("playhead", g({}), 60000);
    SEG = p.segundos;
    console.log(`  al playhead: ${SEG}s`);
  }
  SEG = Number(SEG);

  /* EL ARCHIVO NO SE IMPORTA DESDE DONDE ESTÉ: se copia al lado del proyecto primero.
   * Un medio que vive en una carpeta temporal deja el proyecto apuntando a algo que se limpia
   * solo, y Premiere lo marca offline recién al abrirlo la próxima vez. */
  const e2 = await enviar("estado", g({}), 120000);
  const rutaProy = (e2.info && e2.info.proyecto) || "";
  const destino = path.join(path.dirname(rutaProy), "SFX generados");
  let archivo = hechos[0];
  if (rutaProy && !archivo.startsWith(destino)) {
    fs.mkdirSync(destino, { recursive: true });
    const nuevo = path.join(destino, "SFX_" + path.basename(archivo));
    fs.copyFileSync(archivo, nuevo);
    archivo = nuevo;
    console.log(`  copiado a ${destino}`);
  }
  await dormir(1400);

  await enviar("guardar", g({}), 120000); await dormir(1400);
  let r = await enviar("importar", g({ archivos: [archivo], bin: "SFX generados" }), 180000);
  console.log("  importar: " + String(r.resumen).slice(0, 150)); await dormir(1500);
  r = await enviar("insertar", g({ medio: path.basename(archivo), pistaAudio: PISTA, segundos: SEG }), 180000);
  console.log("  insertar: " + String(r.resumen).slice(0, 190)); await dormir(1600);

  /* EL VEREDICTO SALE DE RELEER LA PISTA. Y ojo: pedir una pista de audio que no existe la
   * CREA —medido— asi que el mensaje "fuera de rango" no significa que no haya entrado. */
  const c = await enviar("clips", g({}), 180000);
  const lista = (c.datos && c.datos.clips) || c.clips || c.datos || [];
  const nom = path.basename(archivo);
  const puesto = (Array.isArray(lista) ? lista : []).filter(
    (x) => x.pista === "A" + PISTA && String(x.nombre || "").indexOf(nom) !== -1);
  if (!puesto.length) {
    console.log(`  ✗ NO quedó en A${PISTA}. El wav está en ${archivo}; se coloca a mano.`);
    process.exit(1);
  }
  const p = puesto.sort((a, b) => Math.abs(a.desde - SEG) - Math.abs(b.desde - SEG))[0];
  const bien = Math.abs(p.desde - SEG) < 0.05;
  console.log(`  ${bien ? "✓" : "✗"} A${PISTA}[${p.indice}] desde ${p.desde}s dura ${p.dura}s (se pidió ${SEG}s)`);
  await dormir(1400);
  await enviar("guardar", g({}), 120000);
  console.log("  guardado");
  if (!bien) process.exit(1);
})().catch((e) => { console.log("ERROR: " + String(e.message).slice(0, 250)); process.exit(1); });
