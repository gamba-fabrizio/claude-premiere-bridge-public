#!/usr/bin/env node
/* Musica con ElevenLabs, en WAV 48k, opcionalmente puesta en Premiere.
 *
 * El tercer hermano de `locucion.js` (voz) y `sonido.js` (efectos). Endpoint distinto
 * —`/v1/music`, no `sound-generation`— y por eso tool aparte: el de efectos tiene un tope
 * duro de 30s, y una cama musical para un video son 60 a 120.
 *
 * ## Para que SI sirve, medido
 *
 * **El largo EXACTO.** Se piden 90.000 ms y salen 90 segundos. Eso es lo que la musica de
 * banco no da: no hay que recortar, ni disimular un loop, ni estirar el ultimo plano para
 * que la cola cierre. Medido el 2026-09-02: pedidos 12.000 ms, salieron 12,016s.
 *
 * **La ESTRUCTURA por tramos**, con `--plan`. El endpoint acepta `composition_plan` en vez
 * de `prompt` —exactamente uno de los dos— y ahi se le pide un tramo por bloque del video
 * con su largo y su clima. Es la diferencia entre "musica linda de 90s" y "musica que cambia
 * donde cambia el video".
 *
 * La forma del plan se MIDIO pidiendosela a la API (`--pedir-plan`), no se dedujo: es
 * snake_case, `positive_global_styles` / `negative_global_styles` / `sections[]`, y cada
 * seccion lleva `section_name`, `positive_local_styles`, `negative_local_styles`,
 * `duration_ms` y `lines` (vacio si es instrumental).
 *
 * ## Para que NO
 *
 * **Un tempo exacto no se pide, se PIDE Y SE MIDE.** El BPM va en los estilos y el modelo lo
 * respeta aproximadamente. Si los cortes tienen que caer en el compas, se mide el resultado
 * con `--tramos` y si no dio, se genera otra variante. No hay parametro de tempo.
 *
 * **Contar compases o pedir un golpe en un instante.** Es lo mismo que ya esta medido en
 * `sonido.js` con las notas: la cantidad no se pide.
 *
 * ## Y lo que NO es tecnico
 *
 * **Los derechos**, investigados en sus terminos el 2026-09-03 y NO deducidos:
 *
 *   plan self-serve (Starter incluido)   todo uso comercial ONLINE y OFFLINE
 *   EXCLUIDO                             film · TV · radio · Studio Games -> Enterprise
 *   persiste                             lo generado con plan pago sirve INDEFINIDAMENTE
 *   sectores prohibidos                  armas, tabaco, farma, adulto, religioso, politico
 *
 * O sea que redes, YouTube, la web del cliente y una pantalla en un salon estan cubiertos, y una
 * tanda de TV o radio NO. Para un video de cliente la pregunta previa es DONDE VA A SALIR. La
 * tabla completa no se puede leer por HTTP —se renderiza en el cliente— y esto no es asesoramiento
 * legal: para un entregable, preguntarle a soporte por escrito.
 *
 * Uso:
 *   node musica.js --texto "..." --dura 90 [--salida <wav>] [--variantes 3]
 *   node musica.js --pedir-plan "..." --dura 90 --salida plan.json     (escribe el borrador)
 *   node musica.js --plan plan.json [--salida <wav>] [--variantes 3] [--tramos]
 *                  [--colocar --pista <n> [--segundos <s>] [--proyecto <n>] [--secuencia <n>]]
 *
 *   --tramos    mide donde caen los saltos de energia y los compara contra los limites del
 *               plan. Es la unica forma de saber si el composition_plan sirvio de algo:
 *               que la API conteste 200 no dice que la musica cambie donde se le pidio.
 *   --medir <wav> --plan p.json    mide un wav YA generado contra los tramos del plan y sale.
 *               Informa el ARCO (media por tramo), el SALTO en cada limite, el AZAR en el mismo
 *               archivo y DONDE MUERE la musica. Elegir variante es releer, no regenerar.
 *   --cupo      informa el consumo de Music antes y despues, EN MINUTOS. Dos cosas medidas y
 *               las dos costaron: `character_count` de /subscription NO incluye la musica, asi
 *               que la fuente es el desglose por producto; y el tope de Starter NO son los 90.000
 *               caracteres del plan sino ~30 MINUTOS de musica al mes. Nueve variantes de 97s
 *               son 14,3 minutos, o sea la mitad del mes: decir que probar es gratis fue mirar
 *               el medidor equivocado.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

/* La key sale SOLO del entorno, y viaja en el HEADER del request. `sonido.js` la pasa como
 * argumento de curl y ahi queda visible en `ps` mientras dura el pedido; con fetch no hay argv. */
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("Falta $ELEVENLABS_API_KEY. Ponela en tu shell:\n" +
                '  echo \'export ELEVENLABS_API_KEY="..."\' >> ~/.zshrc');
  process.exit(1);
}
const H = { "xi-api-key": KEY, "Content-Type": "application/json" };

const TEXTO = opt("texto", null);
const PEDIR = opt("pedir-plan", null);
const PLANF = opt("plan", null);
const VARIANTES = Math.max(1, Number(opt("variantes", 1)));

/* Exactamente uno de los tres modos. Un pedido ambiguo no se resuelve eligiendo. */
const modos = [TEXTO && "--texto", PEDIR && "--pedir-plan", PLANF && "--plan"].filter(Boolean);
if (modos.length !== 1 && !flag("medir")) {
  console.error("Va exactamente UNO de --texto, --pedir-plan o --plan. Se recibio: " +
                (modos.join(", ") || "ninguno"));
  process.exit(1);
}

/* ---------- el plan: leerlo o pedirlo, y validar los largos ---------- */

async function pedirPlan(prompt, ms) {
  const r = await fetch("https://api.elevenlabs.io/v1/music/plan", {
    method: "POST", headers: H,
    body: JSON.stringify({ prompt: prompt, music_length_ms: ms }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`la API rechazo el plan (HTTP ${r.status}): ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

function validarPlan(plan) {
  if (!plan || !Array.isArray(plan.sections) || !plan.sections.length) {
    throw new Error("el plan no tiene `sections`. Forma esperada: " +
                    "{positive_global_styles, negative_global_styles, sections:[{section_name, " +
                    "positive_local_styles, negative_local_styles, duration_ms, lines}]}");
  }
  const malas = plan.sections.filter((s) => !(Number(s.duration_ms) > 0));
  if (malas.length) throw new Error(`${malas.length} seccion(es) sin \`duration_ms\` valido`);
  return plan.sections.reduce((a, s) => a + Number(s.duration_ms), 0);
}

/* ---------- generar ---------- */

async function generar(destino, cuerpo, msPedidos) {
  const r = await fetch("https://api.elevenlabs.io/v1/music?output_format=pcm_48000", {
    method: "POST", headers: H, body: JSON.stringify(cuerpo),
  });
  const buf = Buffer.from(await r.arrayBuffer());

  /* Un error vuelve con la extension del audio. Se detecta INTENTANDO PARSEAR, no buscando un
   * `{` en los primeros bytes: el PCM crudo tiene ese byte adentro del audio y ese chequeo dio
   * un falso positivo la primera vez que se uso en `sonido.js`. */
  try {
    const j = JSON.parse(buf.slice(0, 4096).toString("utf8"));
    if (j && (j.detail || j.message)) {
      throw new Error("la API rechazo: " + JSON.stringify(j.detail || j.message).slice(0, 300));
    }
  } catch (e) { if (String(e.message).startsWith("la API rechazo")) throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${buf.slice(0, 300).toString("utf8")}`);

  const crudo = destino + ".pcm";
  fs.writeFileSync(crudo, buf);

  /* `-ar 48000 -ac 2` EXPLICITOS. Un wav mono se reproduce MUDO del lado del editor —sin error
   * de ninguna de las dos partes, medido el 2026-09-02— y una tasa heredada de un filtro tambien. */
  execFileSync("ffmpeg", ["-v", "error", "-f", "s16le", "-ar", "48000", "-ac", "2",
                          "-i", crudo, "-ar", "48000", "-ac", "2", destino, "-y"]);
  fs.unlinkSync(crudo);

  /* VERIFICACION DE AFUERA: que la API conteste 200 no dice que el archivo este completo, y un
   * wav truncado se coloca igual. Se miden las TRES cosas que fallaron alguna vez: largo, tasa
   * y canales. Medir solo el largo es lo que dejo pasar el mono cuatro entregas seguidas. */
  const pr = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", destino], { encoding: "utf8" }).trim().split("\n");
  const tasa = Number(pr[0]), can = Number(pr[1]), dur = Number(pr[2]);
  const pedido = msPedidos / 1000;
  if (!dur || Math.abs(dur - pedido) > 1.0) {
    throw new Error(`el wav quedo en ${dur}s y se pidieron ${pedido}s`);
  }
  if (tasa !== 48000) throw new Error(`el wav quedo a ${tasa} Hz, no a 48000`);
  if (can !== 2) throw new Error(`el wav quedo con ${can} canal(es): mono se reproduce MUDO`);

  const st = spawnSync("ffmpeg", ["-hide_banner", "-i", destino, "-af",
    "astats=metadata=1,volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const num = (re) => { const m = st.match(re); return m ? Number(m[1]) : null; };
  return { dur, tasa, can, media: num(/mean_volume:\s*(-?[\d.]+) dB/),
           pico: num(/max_volume:\s*(-?[\d.]+) dB/), flat: num(/Flat factor:\s*([\d.]+)/) };
}

/* ---------- donde caen los saltos de energia ---------- */

/* La pregunta que el composition_plan tiene que contestar no es "salio linda" sino "cambia
 * donde le pedi". Se mide con la envolvente de RMS, que es lo que ya esta probado en este repo
 * —`silencedetect` dio un falso negativo completo sobre veinte pausas reales—.
 *
 * OJO, y esto se pago: la PRIMERA version rankeaba la derivada por ventana y contestaba
 * "0 de 3 limites" sobre una musica que SI seguia el arco pedido. Sus tres saltos mas grandes
 * eran la musica ARRANCANDO desde silencio digital y la COLA muriendose —artefactos de
 * silencio, no cambios de seccion— asi que los limites reales nunca entraban al ranking.
 * Es el "medi el piso del instrumento" de CLAUDE.md.
 *
 * Ahora se miden tres cosas distintas y ninguna es un booleano:
 *   1. el ARCO: la media por tramo, que es donde se ve si la forma pedida entro
 *   2. el SALTO en cada limite, como diferencia de medias en +-4s
 *   3. el AZAR: el mismo salto en 400 limites al azar DEL MISMO ARCHIVO, para saber si el
 *      numero del punto 2 significa algo. Sin ese control un salto de 3 dB no dice nada.
 *   4. donde MUERE la musica, que es el defecto que ninguna otra medicion ve: el modelo deja
 *      mudos los ultimos ~4s de lo que se le pide y el wav igual mide el largo exacto. */
function medir(wav, tramos) {
  const VENT = 0.25, SR = 8000;
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", wav, "-ac", "1", "-ar", String(SR),
    "-f", "s16le", "-"], { maxBuffer: 512 * 1024 * 1024 });
  const b = raw.stdout;
  const porVent = Math.round(SR * VENT), m = Math.floor(b.length / 2 / porVent);
  const e = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let k = 0; k < porVent; k++) { const v = b.readInt16LE((i * porVent + k) * 2) / 32768; s += v * v; }
    e[i] = Math.sqrt(s / porVent);
  }
  const dur = m * VENT;
  const dB = (x) => 20 * Math.log10(Math.max(x, 1e-7));
  const rango = (a, c) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, Math.ceil(a / VENT)); i < Math.min(m, Math.floor(c / VENT)); i++) { s += e[i] * e[i]; n++; }
    return n < 4 ? null : dB(Math.sqrt(s / n));
  };
  /* Hasta donde esta VIVA: 25 dB por debajo de la mediana de lo que suena. El umbral es
   * relativo al material y no absoluto, porque el nivel de salida varia entre variantes. */
  const activos = [];
  for (let i = 0; i < m; i++) if (dB(e[i]) > dB(Math.max.apply(null, Array.from(e))) - 40) activos.push(dB(e[i]));
  activos.sort((x, y) => x - y);
  const umb = activos[Math.floor(activos.length / 2)] - 25;
  let ini = 0, fin = m - 1;
  while (ini < m && dB(e[ini]) <= umb) ini++;
  while (fin > 0 && dB(e[fin]) <= umb) fin--;

  const arco = tramos.map((t) => ({ nombre: t.nombre, desde: t.desde, hasta: t.hasta,
                                    media: rango(t.desde, Math.min(t.hasta, dur)) }));
  const salto = (L) => { const a = rango(L - 4, L), c = rango(L, L + 4); return (a === null || c === null) ? null : c - a; };
  const nulo = [];
  let sem = 12345;
  const rnd = () => { sem = (sem * 1103515245 + 12345) & 0x7fffffff; return sem / 0x7fffffff; };
  for (let i = 0; i < 400; i++) { const v = salto(6 + rnd() * (dur - 12)); if (v !== null) nulo.push(Math.abs(v)); }
  nulo.sort((x, y) => x - y);
  const pct = (v) => { let c = 0; for (const n of nulo) if (n < Math.abs(v)) c++; return 100 * c / nulo.length; };

  const limites = tramos.slice(0, -1).map((t) => t.hasta);
  return { dur, viva: [ini * VENT, (fin + 1) * VENT], arco,
           limites: limites.map((L) => { const v = salto(L); return { L, salto: v, pct: v === null ? null : pct(v) }; }),
           nuloMed: nulo[Math.floor(nulo.length / 2)], nuloP90: nulo[Math.floor(nulo.length * 0.9)] };
}

/* ---------- el cupo, del desglose por producto ---------- */

async function cupoMusic() {
  const fin = Date.now(), ini = fin - 35 * 24 * 3600 * 1000;
  const u = `https://api.elevenlabs.io/v1/usage/character-stats?start_unix=${ini}&end_unix=${fin}` +
            `&breakdown_type=product_type`;
  const r = await fetch(u, { headers: { "xi-api-key": KEY } });
  if (!r.ok) return null;
  const j = await r.json();
  const b = j.usage || {};
  const suma = (k) => (b[k] || []).reduce((a, x) => a + Number(x || 0), 0);
  const clave = Object.keys(b).find((k) => /music/i.test(k));
  return clave ? { clave, chars: suma(clave) } : { clave: null, chars: null, crudo: Object.keys(b) };
}

/* ---------- main ---------- */

(async () => {
  /* modo --medir: no genera nada, mide un wav que ya existe contra los tramos de un plan.
   * Elegir entre variantes es releer los archivos, no volver a pedirlos. */
  if (flag("medir")) {
    const w = path.resolve(opt("medir", ""));
    if (!fs.existsSync(w)) { console.error(`no existe ${w}`); process.exit(1); }
    if (!PLANF) { console.error("--medir necesita --plan <json> para saber los tramos."); process.exit(1); }
    const plan = JSON.parse(fs.readFileSync(path.resolve(PLANF), "utf8"));
    validarPlan(plan);
    let acc = 0; const tr = [];
    plan.sections.forEach((s2) => {
      const a = acc / 1000; acc += Number(s2.duration_ms);
      tr.push({ nombre: s2.section_name, desde: a, hasta: acc / 1000 });
    });
    const z = medir(w, tr);
    const largoVideo = tr.length > 1 ? tr[tr.length - 2].hasta : z.dur;
    console.log(`${path.basename(w)}  ${z.dur.toFixed(2)}s`);
    console.log(`  viva ${z.viva[0].toFixed(2)}s → ${z.viva[1].toFixed(2)}s   cola muda ${(z.dur - z.viva[1]).toFixed(2)}s   ` +
      (z.viva[1] >= largoVideo ? `✓ llega a los ${largoVideo}s (+${(z.viva[1] - largoVideo).toFixed(2)}s)`
                               : `✗ SE MUERE ${(largoVideo - z.viva[1]).toFixed(2)}s ANTES de los ${largoVideo}s`));
    let prev = null;
    z.arco.forEach((a) => {
      if (a.media === null) return;
      const dd = prev === null ? "" : `  (${(a.media - prev >= 0 ? "+" : "")}${(a.media - prev).toFixed(1)} dB)`;
      console.log(`  ${a.nombre.padEnd(20)} ${a.desde.toFixed(1)}-${a.hasta.toFixed(1)}s  ${a.media.toFixed(1)} dB${dd}`);
      prev = a.media;
    });
    console.log(`  saltos: ` + z.limites.filter((x) => x.salto !== null).map(
      (x) => `${x.L}s ${(x.salto >= 0 ? "+" : "")}${x.salto.toFixed(1)}dB p${x.pct.toFixed(0)}`).join(" · "));
    console.log(`  azar en el MISMO archivo: mediana ${z.nuloMed.toFixed(1)} dB, p90 ${z.nuloP90.toFixed(1)} dB`);
    return;
  }

  /* modo --pedir-plan: escribe el borrador y sale. La API redacta un plan decente y despues se
   * le editan los largos a mano, que es mas rapido que escribirlo de cero. */
  if (PEDIR) {
    const ms = Math.round(Number(opt("dura", 60)) * 1000);
    const plan = await pedirPlan(PEDIR, ms);
    const dest = path.resolve(opt("salida", path.join(process.cwd(), "plan.json")));
    fs.writeFileSync(dest, JSON.stringify(plan, null, 2));
    const tot = validarPlan(plan);
    console.log(`plan escrito en ${dest}`);
    console.log(`${plan.sections.length} tramos, ${(tot / 1000).toFixed(1)}s en total:`);
    plan.sections.forEach((s, i) => console.log(
      `  ${i} ${s.section_name}  ${(s.duration_ms / 1000).toFixed(1)}s  ` +
      `${(s.positive_local_styles || []).slice(0, 3).join(", ")}`));
    console.log("\nEditale los `duration_ms` a los tramos de TU corte y corré con --plan.");
    return;
  }

  let cuerpo, msPedidos, limites = [], tramos = [];
  if (PLANF) {
    const plan = JSON.parse(fs.readFileSync(path.resolve(PLANF), "utf8"));
    msPedidos = validarPlan(plan);
    cuerpo = { composition_plan: plan };
    let acc = 0;
    plan.sections.forEach((s) => {
      const a = acc / 1000; acc += Number(s.duration_ms);
      tramos.push({ nombre: s.section_name, desde: a, hasta: acc / 1000 });
    });
    limites = tramos.slice(0, -1).map((t) => t.hasta);
    console.log(`plan: ${plan.sections.length} tramos, ${(msPedidos / 1000).toFixed(2)}s`);
    plan.sections.forEach((s, i) => console.log(
      `  ${i} ${s.section_name.padEnd(22)} ${(s.duration_ms / 1000).toFixed(2)}s`));
    console.log(`  limites internos: ${limites.map((x) => x.toFixed(2) + "s").join(" · ")}`);
  } else {
    msPedidos = Math.round(Number(opt("dura", 60)) * 1000);
    cuerpo = { prompt: TEXTO, music_length_ms: msPedidos };
    console.log(`"${TEXTO.slice(0, 90)}${TEXTO.length > 90 ? "…" : ""}"  ${msPedidos / 1000}s`);
  }
  console.log(`${VARIANTES} variante(s)\n`);

  const antes = flag("cupo") ? await cupoMusic() : null;

  const SALIDA = path.resolve(opt("salida", path.join(process.cwd(), "musica.wav")));
  const base = SALIDA.replace(/\.wav$/i, "");
  const hechos = [];
  for (let i = 1; i <= VARIANTES; i++) {
    const d = VARIANTES === 1 ? SALIDA : `${base}_${i}.wav`;
    try {
      const m = await generar(d, cuerpo, msPedidos);
      hechos.push(d);
      const aviso = (m.flat !== null && m.flat > 5) ? `  ← CLIPPEADO (flat ${m.flat.toFixed(1)})` : "";
      console.log(`  ${path.basename(d)}  ${m.dur.toFixed(2)}s  ${m.tasa}Hz ${m.can}ch  ` +
                  `media ${m.media} dB  pico ${m.pico} dB${aviso}`);
      if (flag("tramos") && tramos.length) {
        const z = medir(d, tramos);
        const colaMuda = z.dur - z.viva[1];
        const largoVideo = tramos.length > 1 ? tramos[tramos.length - 2].hasta : z.dur;
        console.log(`     viva ${z.viva[0].toFixed(2)}s → ${z.viva[1].toFixed(2)}s de ${z.dur.toFixed(2)}s` +
          `   cola muda ${colaMuda.toFixed(2)}s   ` +
          (z.viva[1] >= largoVideo ? `✓ llega a los ${largoVideo}s (+${(z.viva[1] - largoVideo).toFixed(2)}s)`
                                   : `✗ SE MUERE ${(largoVideo - z.viva[1]).toFixed(2)}s ANTES de los ${largoVideo}s`));
        let prev = null;
        z.arco.forEach((a) => {
          if (a.media === null) return;
          const dd = prev === null ? "" : `  (${(a.media - prev >= 0 ? "+" : "")}${(a.media - prev).toFixed(1)} dB)`;
          console.log(`     ${a.nombre.padEnd(20)} ${a.desde.toFixed(1)}-${a.hasta.toFixed(1)}s  ${a.media.toFixed(1)} dB${dd}`);
          prev = a.media;
        });
        console.log(`     saltos: ` + z.limites.filter((x) => x.salto !== null).map(
          (x) => `${x.L}s ${(x.salto >= 0 ? "+" : "")}${x.salto.toFixed(1)}dB p${x.pct.toFixed(0)}`).join(" · "));
        console.log(`     azar en el MISMO archivo: mediana ${z.nuloMed.toFixed(1)} dB, p90 ${z.nuloP90.toFixed(1)} dB.` +
          ` Un limite con p<90 NO tiene un evento distinguible del azar: el plan le dio la CURVA` +
          ` pero no una transicion contra la que cortar.`);
      }
    } catch (e) { console.log(`  variante ${i}: ${String(e.message).slice(0, 220)}`); }
  }
  if (!hechos.length) process.exit(1);

  if (antes) {
    const desp = await cupoMusic();
    if (antes.chars !== null && desp && desp.chars !== null) {
      /* 33,4 caracteres por segundo de musica, medido el 2026-09-03 sobre 859s generados. Se
       * informan los MINUTOS porque el tope de Starter esta en minutos, no en caracteres. */
      const CAR_POR_SEG = 33.4;
      const min = (c) => (c / CAR_POR_SEG / 60).toFixed(1);
      console.log(`\ncupo Music: ${antes.chars} → ${desp.chars} caracteres ` +
                  `(+${desp.chars - antes.chars} por ${VARIANTES} variante(s))`);
      console.log(`  en minutos: ${min(antes.chars)} → ${min(desp.chars)} de ~30 que trae Starter ` +
                  `al mes. OJO: el tope de la musica esta en MINUTOS, no en los 90.000 caracteres ` +
                  `del plan, y \`character_count\` de /subscription no la cuenta.`);
    } else {
      console.log(`\ncupo: el desglose no trajo una clave de Music. Claves: ` +
                  `${(desp && desp.crudo || []).join(", ")}`);
    }
  }

  if (!flag("colocar")) {
    console.log(`\nNo se coloco nada. Corré con --colocar --pista <n> para ponerla en Premiere.`);
    return;
  }
  if (hechos.length > 1) {
    console.log(`\n${hechos.length} variantes: elegí una y volvé a correr con --variantes 1 y --colocar.`);
    return;
  }
  const PISTA = Number(opt("pista", 0));
  if (!PISTA) { console.error("Con --colocar hace falta --pista <n> (la pista de AUDIO)."); process.exit(1); }

  const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  let PROY = opt("proyecto", null);
  const SEC = opt("secuencia", null);
  /* La guarda `proyecto` se manda SIEMPRE: si no viene por flag se LEE del foco. Una guarda que
   * hay que acordarse de pasar es una guarda que no esta cuando hace falta. */
  if (!PROY) {
    const e = await enviar("estado", {}, 120000);
    PROY = e.info && e.info.proyectoNombre;
    if (!PROY) { console.error("No se pudo leer que proyecto tiene foco. Pasá --proyecto."); process.exit(1); }
    console.log(`\nproyecto (leido del foco): ${PROY}`);
  }
  const g = (o) => Object.assign({ proyecto: PROY }, SEC ? { secuencia: SEC } : {}, o);

  /* Una cama musical arranca en 0, no en el playhead: es el caso opuesto al de un efecto. */
  const SEG = Number(opt("segundos", 0));

  /* NO se importa desde donde este: se copia al lado del proyecto. Un medio en una carpeta
   * temporal deja el proyecto apuntando a algo que se limpia solo. */
  const e2 = await enviar("estado", g({}), 120000);
  const rutaProy = (e2.info && e2.info.proyecto) || "";
  const carpeta = path.join(path.dirname(rutaProy), "Musica generada");
  let archivo = hechos[0];
  if (rutaProy && !archivo.startsWith(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
    const nuevo = path.join(carpeta, path.basename(archivo));
    fs.copyFileSync(archivo, nuevo);
    archivo = nuevo;
    console.log(`  copiado a ${carpeta}`);
  }
  await dormir(1400);

  await enviar("guardar", g({}), 120000); await dormir(1400);
  let r = await enviar("importar", g({ archivos: [archivo], bin: "Musica generada" }), 180000);
  console.log("  importar: " + String(r.resumen).slice(0, 150)); await dormir(1500);
  r = await enviar("insertar", g({ medio: path.basename(archivo), pistaAudio: PISTA, segundos: SEG }), 180000);
  console.log("  insertar: " + String(r.resumen).slice(0, 190)); await dormir(1600);

  /* EL VEREDICTO SALE DE RELEER LA PISTA, no del mensaje de `insertar`. Y pedir una pista de
   * audio que no existe la CREA, asi que "fuera de rango" no significa que no haya entrado. */
  const c = await enviar("clips", g({}), 180000);
  const lista = (c.datos && c.datos.clips) || c.clips || c.datos || [];
  const nom = path.basename(archivo);
  const puesto = (Array.isArray(lista) ? lista : []).filter(
    (x) => x.pista === "A" + PISTA && String(x.nombre || "").indexOf(nom) !== -1);
  if (!puesto.length) {
    console.log(`  ✗ NO quedo en A${PISTA}. El wav esta en ${archivo}; se coloca a mano.`);
    process.exit(1);
  }
  const p = puesto.sort((a, b) => Math.abs(a.desde - SEG) - Math.abs(b.desde - SEG))[0];
  const bien = Math.abs(p.desde - SEG) < 0.05;
  console.log(`  ${bien ? "✓" : "✗"} A${PISTA}[${p.indice}] desde ${p.desde}s dura ${p.dura}s (se pidio ${SEG}s)`);
  await dormir(1400);
  await enviar("guardar", g({}), 120000);
  console.log("  guardado");
  if (!bien) process.exit(1);
})().catch((e) => { console.log("ERROR: " + String(e.message).slice(0, 300)); process.exit(1); });
