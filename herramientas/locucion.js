#!/usr/bin/env node
/* Locución con ElevenLabs, con los TIEMPOS DE CADA PALABRA, y opcionalmente puesta en Premiere.
 *
 * ## Por qué esto y no la web de ElevenLabs
 *
 * Por los tiempos. El endpoint `/with-timestamps` devuelve el instante de arranque y de fin de
 * CADA CARÁCTER, así que las palabras salen exactas y no estimadas. Eso convierte dos trabajos
 * de este repo en un dato:
 *
 *   - **Los subtítulos** dejan de necesitar Whisper. El texto ya se sabe —lo escribió el
 *     usuario— y el TTS dice cuándo se dice. Es el mismo JSON que produce `audio.js`
 *     transcribiendo, pero medido en vez de inferido.
 *   - **El corte contra el texto** —lo que hacen `armar.js` y el flujo de un cliente
 *     resolviendo cada frase a sus bordes de palabra— pasa a ser aritmética.
 *
 * ## La voz se elige UNA VEZ y se guarda AL LADO DEL MATERIAL
 *
 * En `locucion.json`, junto al guion, no en este repo: la voz es del proyecto y no le sirve a
 * otro. Sin eso cada locución sale con otro timbre y se nota entre videos del mismo cliente.
 * Es la misma regla que ya rige para el contexto de cada proyecto.
 *
 * ## Y la key NUNCA se escribe
 *
 * Sale de `$ELEVENLABS_API_KEY` y de ningún otro lado. No se guarda en el JSON, no se imprime,
 * no se pasa por argumento —que quedaría en el historial de la shell y en `ps`—.
 *
 * Uso:
 *   node locucion.js --texto <archivo.txt|"texto"> [--voz <id>] [--salida <wav>]
 *                    [--config <locucion.json>] [--modelo eleven_multilingual_v2]
 *                    [--estabilidad 0.5] [--similitud 0.75]
 *                    [--colocar --pista <n> [--segundos 0] [--proyecto <nombre>] [--secuencia <nombre>]]
 *   node locucion.js --voces            lista las voces de la cuenta y sale
 *
 *   --colocar   importa el wav y lo inserta en Premiere. Requiere el panel abierto.
 *
 * ## El VOICE CHANGER, que es lo que el TTS no puede
 *
 *   node locucion.js --desde-grabacion <mi_lectura.wav> --voz <id> [--colocar --pista <n>]
 *
 * Convierte una grabacion propia a otra voz **conservando la interpretacion**: las pausas, el
 * enfasis, el ritmo. Una locucion sintetizada suena siempre un poco muerta por buena que sea la
 * voz; esto da la actuacion del usuario con el timbre que elija.
 *
 * **NO devuelve timestamps.** El `/with-timestamps` es solo de TTS. Pero la conversion respeta
 * el largo del original —se mide y se informa—, asi que los tiempos salen de transcribir LA
 * GRABACION con el flujo que ya existe (`audio.js`) y valen para la convertida. Si el largo NO
 * coincidiera, los tiempos no se pueden transferir y la herramienta lo dice en vez de callarlo.
 *
 * Y SI descuenta del cupo de caracteres del plan, aunque se facture por duracion de audio: son
 * dos cosas distintas y aca se escribio al reves primero. Medido restando dos lecturas del
 * endpoint de suscripcion: una conversion de 4,83s costo ~345 caracteres, mas caro por segundo
 * que el TTS.
 */
const { execFileSync } = require("child_process");
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

/* curl y no fetch: el audio viene en base64 adentro de un JSON que para una locución larga pesa
 * varios MB, y `execFileSync` con maxBuffer explícito es más predecible que armar el streaming. */
function api(url, cuerpo) {
  const a = ["-s", "-H", "xi-api-key: " + KEY];
  if (cuerpo) a.push("-X", "POST", "-H", "Content-Type: application/json", "-d", JSON.stringify(cuerpo));
  a.push(url);
  const txt = execFileSync("curl", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  let d; try { d = JSON.parse(txt); } catch (e) { throw new Error("respuesta no-JSON: " + txt.slice(0, 200)); }
  if (d.detail) throw new Error("la API rechazó: " + JSON.stringify(d.detail).slice(0, 200));
  return d;
}

if (flag("voces")) {
  const d = api("https://api.elevenlabs.io/v2/voices?page_size=100");
  for (const v of d.voices || []) {
    const l = v.labels || {};
    console.log(`  ${String(v.name).padEnd(38)} ${v.voice_id}  ` +
      ["gender", "age", "accent", "use_case"].map((k) => l[k]).filter(Boolean).join(" · "));
  }
  process.exit(0);
}

/* ---- de donde sale el audio: texto (TTS) o una grabacion (voice changer) ---- */
const GRAB = opt("desde-grabacion", null);
if (GRAB && !fs.existsSync(GRAB)) { console.error(`No existe la grabación: ${GRAB}`); process.exit(1); }

const T = opt("texto", null);
if (!T && !GRAB) { console.error("Falta --texto <archivo.txt|\"texto\"> o --desde-grabacion <audio>"); process.exit(1); }
const esArchivo = !GRAB && fs.existsSync(T) && fs.statSync(T).isFile();
const texto = GRAB ? null : (esArchivo ? fs.readFileSync(T, "utf8") : T).trim();
if (!GRAB && !texto) { console.error("El texto está vacío."); process.exit(1); }
const RAIZ = GRAB ? path.dirname(path.resolve(GRAB))
                  : (esArchivo ? path.dirname(path.resolve(T)) : process.cwd());

/* ---- la voz: del flag, o del config del proyecto ---- */
const CONFIG = opt("config", path.join(RAIZ, "locucion.json"));
let cfg = {};
if (fs.existsSync(CONFIG)) { try { cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { cfg = {}; } }
const VOZ = opt("voz", cfg.voz);
if (!VOZ) {
  console.error(`Falta la voz. Pasala con --voz <id>, o dejala fija en ${CONFIG}:\n` +
                '  { "voz": "<id>", "modelo": "eleven_multilingual_v2", "estabilidad": 0.5, "similitud": 0.75 }\n' +
                "Las disponibles: node locucion.js --voces");
  process.exit(1);
}
const MODELO = opt("modelo", cfg.modelo || "eleven_multilingual_v2");
const EST = Number(opt("estabilidad", cfg.estabilidad !== undefined ? cfg.estabilidad : 0.5));
const SIM = Number(opt("similitud", cfg.similitud !== undefined ? cfg.similitud : 0.75));

const SALIDA = path.resolve(opt("salida", path.join(RAIZ, "locucion.wav")));
const BASE = SALIDA.replace(/\.wav$/i, "");

const mp3 = BASE + ".mp3";
let d = null, durOriginal = null;

if (GRAB) {
  /* VOICE CHANGER. Se manda multipart y vuelve audio crudo, no JSON: por eso `curl -o` directo
   * al archivo en vez de la funcion `api()`, que parsea JSON. */
  const MODELO_STS = opt("modelo", cfg.modeloSts || "eleven_multilingual_sts_v2");
  durOriginal = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", GRAB], { encoding: "utf8" }).trim());
  console.log(`grabación ${path.basename(GRAB)} · ${durOriginal.toFixed(2)}s · voz ${VOZ} · ${MODELO_STS}`);
  execFileSync("curl", ["-s", "-X", "POST",
    `https://api.elevenlabs.io/v1/speech-to-speech/${VOZ}`,
    "-H", "xi-api-key: " + KEY,
    "-F", "audio=@" + path.resolve(GRAB),
    "-F", "model_id=" + MODELO_STS,
    "-F", "voice_settings=" + JSON.stringify({ stability: EST, similarity_boost: SIM }),
    "-o", mp3], { maxBuffer: 512 * 1024 * 1024 });
  /* Si algo falló vuelve un JSON de error con extension .mp3: se detecta mirando el archivo, no
   * confiando en que curl no haya tirado. */
  const cabeza = fs.readFileSync(mp3).slice(0, 400).toString("utf8");
  if (cabeza.trim().startsWith("{")) {
    console.error("La API rechazó: " + cabeza.slice(0, 220));
    try { fs.unlinkSync(mp3); } catch (e) {}
    process.exit(1);
  }
} else {
  console.log(`${texto.length} caracteres · voz ${VOZ} · ${MODELO} · estabilidad ${EST} similitud ${SIM}`);
  d = api(`https://api.elevenlabs.io/v1/text-to-speech/${VOZ}/with-timestamps`,
    { text: texto, model_id: MODELO, voice_settings: { stability: EST, similarity_boost: SIM } });
  if (!d.audio_base64) { console.error("La respuesta no trae audio."); process.exit(1); }
  fs.writeFileSync(mp3, Buffer.from(d.audio_base64, "base64"));
}
/* A wav porque es lo que Premiere maneja sin recomprimir y lo que espera el resto del flujo.
 *
 * Y a DOS CANALES a proposito, aunque una voz sea mono. Medido el 2026-09-02: un wav/aac MONO
 * se reproduce MUDO en el visor del usuario, y no da ningun error ni al generarlo ni al abrirlo.
 * Se perdieron cuatro entregas asi: yo medi duracion y nivel las cuatro veces, que era justo lo
 * que no fallaba. Duplicar el canal cuesta el doble de disco en un wav de voz y saca de encima un
 * modo de fallo silencioso entero.
 *
 * Lo delata `afinfo` con un "1 ch". Y OJO —corregido el 2026-09-03— NO con el "no channel layout"
 * que aparece en la linea de abajo: un estereo que suena perfecto tambien lo informa, asi que ese
 * marcador no distingue nada. El unico dato que separa los dos casos es el conteo de canales. */
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-c:a", "pcm_s16le",
                        "-ar", "48000", "-ac", "2", SALIDA]);
fs.unlinkSync(mp3);

/* VERIFICACIÓN DE AFUERA: que la API conteste 200 no dice que el archivo esté completo, y un wav
 * truncado se coloca igual y el problema aparece recién reproduciendo. */
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "csv=p=0", SALIDA], { encoding: "utf8" }).trim());
if (!dur || dur < 0.1) { console.error(`El wav quedó en ${dur}s: NO se sigue.`); process.exit(1); }

/* ---- los tiempos ---- */
if (GRAB) {
  /* El voice changer NO devuelve timestamps. Lo que sí se puede afirmar —o negar— es si el largo
   * se respetó, porque de eso depende que los tiempos de la GRABACION valgan para la convertida. */
  const delta = Math.abs(dur - durOriginal);
  console.log(`  ${SALIDA}  ${dur.toFixed(2)}s  (el original mide ${durOriginal.toFixed(2)}s, delta ${delta.toFixed(3)}s)`);
  if (delta < 0.15) {
    console.log(`  el largo se respetó: los tiempos de transcribir LA GRABACIÓN valen para ésta.`);
  } else {
    console.log(`  OJO: el largo CAMBIÓ ${delta.toFixed(2)}s. Los tiempos del original NO se pueden ` +
                `transferir; hay que transcribir la convertida.`);
  }
} else {
const al = d.alignment || d.normalized_alignment || {};
const ch = al.characters || [], st = al.character_start_times_seconds || [], en = al.character_end_times_seconds || [];
const palabras = [];
let cur = null;
for (let i = 0; i < ch.length; i++) {
  const c = ch[i];
  if (/\s/.test(c)) { if (cur) { palabras.push(cur); cur = null; } continue; }
  if (!cur) cur = { texto: "", desde: st[i], hasta: en[i] };
  cur.texto += c;
  cur.hasta = en[i];
}
if (cur) palabras.push(cur);
/* Una palabra termina en el fin de su último carácter; el `eos` marca cierre de frase, que es lo
 * que consume el armador de guion para resolver un beat a bordes de frase. */
for (const p of palabras) {
  p.desde = Number(p.desde.toFixed(3));
  p.hasta = Number(p.hasta.toFixed(3));
  p.dura = Number((p.hasta - p.desde).toFixed(3));
  p.eos = /[.!?…]$/.test(p.texto);
}
const json = BASE + ".palabras.json";
fs.writeFileSync(json, JSON.stringify({
  archivo: path.basename(SALIDA), dura: Number(dur.toFixed(3)), voz: VOZ, modelo: MODELO,
  texto: texto, palabras: palabras
}, null, 1));

console.log(`  ${SALIDA}  ${dur.toFixed(2)}s`);
console.log(`  ${json}  ${palabras.length} palabras, ${palabras.filter((p) => p.eos).length} frases`);
}

/* La voz se deja anotada si no estaba: la próxima locución del proyecto sale igual sin pensarlo. */
if (!fs.existsSync(CONFIG)) {
  fs.writeFileSync(CONFIG, JSON.stringify({ voz: VOZ, modelo: MODELO, estabilidad: EST, similitud: SIM }, null, 1));
  console.log(`  voz anotada en ${CONFIG} para las próximas`);
}

/* ---- colocar en Premiere ---- */
if (!flag("colocar")) {
  console.log(`\nNo se colocó nada. Corré con --colocar --pista <n> para ponerlo en Premiere.`);
  process.exit(0);
}
const PISTA = Number(opt("pista", 0));
if (!PISTA) { console.error("Con --colocar hace falta --pista <n> (la pista de AUDIO)."); process.exit(1); }
const SEG = Number(opt("segundos", 0));

(async () => {
  const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  /* La guarda `proyecto` se manda SIEMPRE. Si no viene por flag se lee del foco: una guarda que
   * hay que acordarse de pasar es una guarda que no está cuando hace falta. */
  let PROY = opt("proyecto", null);
  const SEC = opt("secuencia", null);
  if (!PROY) {
    const e = await enviar("estado", {}, 120000);
    PROY = e.info && e.info.proyectoNombre;
    if (!PROY) { console.error("No se pudo leer qué proyecto tiene foco. Pasá --proyecto."); process.exit(1); }
    console.log(`\nproyecto (leído del foco): ${PROY}`);
  }
  const g = (o) => Object.assign({ proyecto: PROY }, SEC ? { secuencia: SEC } : {}, o);

  let r = await enviar("guardar", g({}), 120000);
  console.log("  guardar: ok"); await dormir(1400);
  r = await enviar("importar", g({ archivos: [SALIDA] }), 180000);
  console.log("  importar: " + String(r.resumen).slice(0, 160)); await dormir(1500);
  r = await enviar("insertar", g({ medio: path.basename(SALIDA), pistaAudio: PISTA, segundos: SEG }), 180000);
  console.log("  insertar: " + String(r.resumen).slice(0, 200)); await dormir(1600);

  /* EL VEREDICTO SALE DEL ESTADO, no del mensaje: se relee la pista y se exige que el clip esté
   * donde se pidió y que mida lo que mide el wav. `insertar` ya informa bien, pero contar con eso
   * es juzgar por el mensaje. */
  const c = await enviar("clips", g({}), 120000);
  const lista = (c.datos && c.datos.clips) || c.clips || c.datos || [];
  const nom = path.basename(SALIDA);
  const puesto = (Array.isArray(lista) ? lista : []).filter(
    (x) => x.pista === "A" + PISTA && String(x.nombre || "").indexOf(nom) !== -1);
  if (!puesto.length) {
    console.log(`  ✗ NO quedó en A${PISTA}. El wav está en disco; se coloca a mano.`);
    process.exit(1);
  }
  const p = puesto.sort((a, b) => Math.abs(a.desde - SEG) - Math.abs(b.desde - SEG))[0];
  const bien = Math.abs(p.desde - SEG) < 0.05 && Math.abs(p.dura - dur) < 0.1;
  console.log(`  ${bien ? "✓" : "✗"} A${PISTA}[${p.indice}] desde ${p.desde}s dura ${p.dura}s ` +
              `(se pidió ${SEG}s y el wav mide ${dur.toFixed(2)}s)`);
  await dormir(1400);
  await enviar("guardar", g({}), 120000);
  console.log("  guardado");
  if (!bien) process.exit(1);
})().catch((e) => { console.log("ERROR: " + String(e.message).slice(0, 250)); process.exit(1); });
