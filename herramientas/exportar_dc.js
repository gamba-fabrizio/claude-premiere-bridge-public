#!/usr/bin/env node
/* Exporta una animación de Claude Design a video SIN PÉRDIDA, cuadro por cuadro.
 *
 * ## Por qué existe
 *
 * Claude Design exporta video, pero comprimido. Teniendo el HTML se puede hacer mejor: barrer la
 * animación cuadro a cuadro, guardar cada uno como PNG y armar un ProRes. Nada de grabar la
 * pantalla — no hay compresión intermedia ni jitter de temporizado.
 *
 * ## Lo que lo hace posible, y hay que verificarlo antes de confiar
 *
 * Los `.dc.html` traen un **contrato de seek** que el propio `animations-v3.jsx` documenta:
 *
 *     data-om-exportable-video-with-duration-secs   el atributo de la RAÍZ exportable
 *     'data-om-seek-to-time-frame'                  el evento, detail {time, sync, playing}
 *
 * Y su encabezado dice, textual: *"RENDER FROM T ONLY: the exporter seeks each frame with a
 * synchronous commit... A seeked frame is a deterministic render at that time."*
 *
 * **Eso NO se da por bueno: se comprueba.** El modo `--verificar` barre a t=1, a t=6 y vuelve a
 * t=1, y compara una firma del render (transform + opacity + texto de cada elemento). Exige que
 * cambie al barrer Y que volver al mismo tiempo dé la MISMA firma. Sin las dos cosas, exportar
 * cuadro por cuadro produciría una animación que se ve distinta cada vez que se rinde, y eso no
 * se notaría hasta comparar dos exports.
 *
 * Medido en "Intro.dc.html" el 2026-08-23: cambia al barrer, y t=1 dos veces da el mismo
 * hash. Los tres artboards de un estudio pasan.
 *
 * ## Detalles que costaron o que costarían
 *
 * - **Se sirve por HTTP, no por `file://`.** El `.dc.html` carga `support.js`, el bundle del
 *   sistema de diseño y las fuentes por ruta relativa; con `file://` el navegador bloquea parte y
 *   el render sale sin tipografía, que es un fallo silencioso.
 * - **Se espera `document.fonts.ready` ANTES del primer cuadro.** Si no, los primeros salen con
 *   la fuente de fallback. Ya pasó con Poppins en otro proyecto de este repo.
 * - **Se captura el ELEMENTO raíz, no la página.** Así el PNG mide exactamente lo que declara el
 *   artboard y no depende del viewport.
 * - **`--alfa` usa `omitBackground`.** Para una placa full-frame no hace falta; para un fondo o
 *   un overlay sí, y entonces el ProRes va 4444.
 * - Chrome y puppeteer-core salen de la caché de HyperFrames y de npx: no se instala nada.
 *
 * Uso:
 *   node exportar_dc.js --html "Intro.dc.html" --dir <carpeta del zip> --salida intro.mov
 *   node exportar_dc.js --dir <carpeta> --verificar          # sólo comprueba el seek
 *   opciones: --fps 25 --alfa --escala 1 --puerto 8791 --prores 4444|422
 *             --props '{"eyebrow":"...","titleLine1":"...","titleLine2":"..."}' 
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.includes("--" + n);

const DIR = opt("dir", null);
const HTML = opt("html", null);
const SALIDA = opt("salida", null);
const FPS = Number(opt("fps", "25"));
const ESCALA = Number(opt("escala", "1"));
const PUERTO = Number(opt("puerto", "8791"));
const ALFA = flag("alfa");
/* El perfil por defecto es 4444 incluso SIN alfa, y es una decisión de calidad, no un descuido:
 * ProRes 422 submuestrea el croma horizontalmente (4:2:2) y esto es un gráfico con texto BLANCO
 * sobre ROJO SATURADO — justo donde el submuestreo se ve, como borde sucio en las letras. 4444 es
 * 4:4:4: un valor de color por píxel. Con `--prores 422` se puede pedir el más liviano. */
const PERFIL = opt("prores", "4444");
const VERIFICAR = flag("verificar");
const CSS = opt("css", null);
/* LOS TEXTOS NO VIENEN EN EL EXPORT, y hay que inyectarlos.
 *
 * El `.dc.html` declara sus props con `"default": ""` y el componente cae al fallback con
 * `p.brandLine ?? 'Branca 2026'`. Pero `??` solo dispara con null o undefined: **una cadena vacia
 * NO es null**, asi que el fallback nunca corre y el titulo sale VACIO. Lo que se tipeo en el
 * panel de Claude Design vive en el canvas, no en el HTML exportado.
 *
 * Y esto lo agarro MIRAR el video. Los tres chequeos numericos —seek, determinismo, tamano del
 * PNG— pasaron todos con el titulo ausente.
 *
 * Se inyectan reescribiendo los `default` del `data-props` en el HTML ANTES de servirlo. De paso
 * eso es lo que hace util a la plantilla: un artboard, N videos, los textos por parametro. */
const PROPS = opt("props", null) ? JSON.parse(opt("props")) : null;

if (!DIR) { console.error("falta --dir (la carpeta del zip de Claude Design)"); process.exit(2); }

/* puppeteer-core y Chrome de las cachés que ya están en la máquina */
function hallarPuppeteer() {
  const base = path.join(process.env.HOME, ".npm/_npx");
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, "node_modules/puppeteer-core");
    if (fs.existsSync(path.join(p, "package.json"))) return p;
  }
  return null;
}
function hallarChrome() {
  const raiz = path.join(process.env.HOME, ".cache/hyperframes/chrome");
  const hits = [];
  const rec = (d, prof) => {
    if (prof > 4 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p, prof + 1);
      else if (e.name === "chrome-headless-shell" || e.name === "Google Chrome for Testing") hits.push(p);
    }
  };
  rec(raiz, 0);
  /* la versión más nueva primero: los nombres traen la versión */
  hits.sort().reverse();
  return hits[0] || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

/* servidor estático mínimo. Sirve la carpeta tal cual, con los tipos que hacen falta. */
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".jsx": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
function servir(dir, puerto) {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const p = path.join(dir, rel);
      if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
      const tipo = TIPOS[path.extname(p).toLowerCase()] || "application/octet-stream";
      if (PROPS && p.endsWith(".dc.html")) {
        r.writeHead(200, { "Content-Type": tipo });
        return r.end(inyectar(fs.readFileSync(p, "utf8"), PROPS));
      }
      r.writeHead(200, { "Content-Type": tipo });
      fs.createReadStream(p).pipe(r);
    });
    s.listen(puerto, "127.0.0.1", () => res(s));
  });
}

/* Reescribe los `default` del `data-props`. El atributo viene con entidades HTML escapadas, asi
 * que hay que desescapar, parsear, tocar y volver a escapar — reemplazar a lo bruto con una regex
 * sobre el HTML rompe el JSON en cuanto un texto trae comillas o acentos. */
function inyectar(html, props) {
  const m = html.match(/data-props="([^"]*)"/);
  if (!m) { console.error("  OJO: no encontre data-props, los textos van a salir vacios"); return html; }
  const des = (x) => x.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let j;
  try { j = JSON.parse(des(m[1])); } catch (e) { console.error("  OJO: data-props no parsea: " + e.message); return html; }
  const puestos = [], desconocidos = [];
  for (const [k, v] of Object.entries(props)) {
    if (j[k] === undefined) { desconocidos.push(k); continue; }
    j[k].default = v;
    puestos.push(k);
  }
  if (desconocidos.length) {
    console.error("  props que el artboard NO declara: " + desconocidos.join(", "));
    console.error("  las que declara: " + Object.keys(j).filter((k) => k !== "$preview").join(", "));
  }
  console.log("  props inyectadas: " + (puestos.length ? puestos.join(", ") : "ninguna"));
  return html.replace(/data-props="[^"]*"/, 'data-props="' + esc(JSON.stringify(j)) + '"');
}

/* La firma de un render: lo que hay que comparar para saber si el seek es determinista. */
const FIRMA = `(() => {
  const ex = document.querySelector('[data-om-exportable-video-with-duration-secs]');
  const els = ex.querySelectorAll('*');
  let s = '';
  for (const e of els) { const c = getComputedStyle(e); s += c.transform + '|' + c.opacity + '|' + (e.textContent||'').slice(0,12) + ';'; }
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
})()`;

const SEEK = (t) => `(() => {
  const ex = document.querySelector('[data-om-exportable-video-with-duration-secs]');
  ex.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', { detail: { time: ${t}, sync: true, playing: false }, bubbles: true }));
  return true;
})()`;

(async () => {
  const pupDir = hallarPuppeteer();
  if (!pupDir) { console.error("no encontré puppeteer-core en ~/.npm/_npx"); process.exit(1); }
  const puppeteer = require(pupDir);
  const chrome = hallarChrome();
  console.log("chrome:     " + chrome.replace(process.env.HOME, "~"));
  console.log("puppeteer:  " + pupDir.replace(process.env.HOME, "~"));

  const srv = await servir(path.resolve(DIR), PUERTO);
  const nav = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ["--no-sandbox", "--force-device-scale-factor=" + ESCALA, "--font-render-hinting=none"] });

  const htmls = HTML ? [HTML] : fs.readdirSync(DIR).filter((f) => f.endsWith(".dc.html"));
  const informe = [];

  for (const h of htmls) {
    const pag = await nav.newPage();
    await pag.setViewport({ width: 1920, height: 1080, deviceScaleFactor: ESCALA });
    await pag.goto(`http://127.0.0.1:${PUERTO}/${encodeURIComponent(h)}`, { waitUntil: "networkidle0", timeout: 60000 });
    await pag.waitForSelector("[data-om-exportable-video-with-duration-secs]", { timeout: 30000 });
    /* las fuentes ANTES del primer cuadro, o los primeros salen con el fallback */
    await pag.evaluate("document.fonts.ready");

    /* EL TRANSFORM DE ENCAJE, que hay que sacar o se captura RESAMPLEADO.
     * El SVG mide 1920x1080 intrinsecos (sus atributos width/height) y el runtime de Claude
     * Design le aplica un `transform: matrix(s,0,0,s,0,0)` para que entre en el viewport. Con el
     * viewport en 1920x1080 la escala salio 0,959 y el elemento se pintaba 1842x1036: capturar
     * asi y despues escalar a 1920 en Premiere ablanda todo, que es justo lo que este export
     * viene a evitar.
     * La regla va con `!important` en una hoja de autor, que le gana al estilo INLINE que pone el
     * runtime — si no, se lo vuelve a aplicar en cada render. */
    /* EL CHROME DEL HOST, que se cuela en la captura.
     * `element.screenshot()` recorta la captura de PAGINA al rectangulo del elemento, asi que
     * todo lo que se solape entra igual — aunque no sea hijo del SVG. El runtime pinta sus
     * controles de reproduccion en un `[data-omelette-chrome]` dentro de `.sc-host`, abajo al
     * centro, y los tres exports salieron con una barra de progreso con un punto encima.
     * Se ocultan ANTES de capturar, y despues se COMPRUEBA que no quede nada solapado. */
    await pag.addStyleTag({ content:
      "svg[data-om-exportable-video-with-duration-secs]{transform:none!important;" +
      "transform-origin:0 0!important;position:absolute!important;left:0!important;top:0!important}" +
      "html,body{margin:0!important;padding:0!important;overflow:hidden!important}" +
      "[data-omelette-chrome],[data-om-chrome],.sc-host>div:not(:has(svg[data-om-exportable-video-with-duration-secs]))" +
      "{display:none!important;visibility:hidden!important}" +
      /* CSS del usuario, AL FINAL para que pueda pisar lo de arriba. Existe para separar capas de
       * un mismo artboard sin tocar el HTML: sacarle el logo al fondo es `img[src*="assets/logo/"]
       * {display:none}`, y el logo solo es esconder todo lo demas y exportar con --alfa. Es la
       * unica forma de partir una pieza de Claude Design en capas sin volver a disenarla. */
      (CSS || "") });
    if (CSS) console.log("  css inyectado: " + CSS.slice(0, 90) + (CSS.length > 90 ? "…" : ""));

    /* La guarda: nada visible de AFUERA del SVG puede solaparse con su rectangulo. Sin esto el
     * chrome del host se hornea en el video y no lo agarra ningun chequeo numerico. */
    const intrusos = await pag.evaluate(`(() => {
      const ex = document.querySelector('[data-om-exportable-video-with-duration-secs]');
      const R = ex.getBoundingClientRect();
      const dentro = new Set(ex.querySelectorAll('*'));
      const out = [];
      for (const e of document.querySelectorAll('body *')) {
        if (dentro.has(e) || e === ex || e.contains(ex)) continue;
        const q = e.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        const c = getComputedStyle(e);
        if (c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) === 0) continue;
        if (q.right < R.left || q.left > R.right || q.bottom < R.top || q.top > R.bottom) continue;
        out.push(e.tagName + (e.getAttribute('data-omelette-chrome') !== null ? '[data-omelette-chrome]' : '')
                 + ' ' + Math.round(q.width) + 'x' + Math.round(q.height));
      }
      return out;
    })()`);
    if (intrusos.length) {
      console.error("   OJO: " + intrusos.length + " elemento(s) de afuera se solapan con el cuadro y se van a hornear:");
      for (const i of intrusos.slice(0, 6)) console.error("      " + i);
    } else {
      console.log("   nada del host se solapa con el cuadro ✓");
    }

    const meta = await pag.evaluate(`(() => {
      const ex = document.querySelector('[data-om-exportable-video-with-duration-secs]');
      const r = ex.getBoundingClientRect();
      return { dur: Number(ex.getAttribute('data-om-exportable-video-with-duration-secs')),
               w: Math.round(r.width), h: Math.round(r.height),
               intrinseco: { w: Number(ex.getAttribute('width')) || ex.clientWidth,
                             h: Number(ex.getAttribute('height')) || ex.clientHeight },
               escala: Number((r.width / (Number(ex.getAttribute('width')) || ex.clientWidth)).toFixed(4)),
               escenas: window.OM_SCENES ? JSON.parse(window.OM_SCENES).map(s => s.name + ':' + s.dur) : null };
    })()`);
    /* el viewport se agranda al tamano intrinseco: si el elemento no entra, Chrome recorta */
    await pag.setViewport({ width: meta.intrinseco.w, height: meta.intrinseco.h, deviceScaleFactor: ESCALA });

    /* Si se pidieron props, se exige que el texto este EN EL RENDER. Sin esto el export sale con
     * el titulo vacio y los otros chequeos no lo notan — ya paso. */
    if (PROPS) {
      await pag.evaluate(SEEK(Math.min(3.0, meta.dur / 2)));
      const visto = await pag.evaluate(`(() => {
        const ex = document.querySelector('[data-om-exportable-video-with-duration-secs]');
        return ex.innerText || ex.textContent || '';
      })()`);
      const faltan = Object.entries(PROPS).filter(([, v]) => v && !visto.includes(String(v).slice(0, 12)));
      if (faltan.length) {
        console.error("   los textos NO aparecen en el render: " + faltan.map(([k]) => k).join(", "));
        console.error("   texto que si se ve: " + JSON.stringify(visto.replace(/\s+/g, " ").trim()).slice(0, 160));
      } else {
        console.log("   textos en el render: " + Object.keys(PROPS).length + " de " + Object.keys(PROPS).length + " ✓");
      }
    }

    /* --- la verificación: cambia al barrer Y es determinista --- */
    await pag.evaluate(SEEK(1.0)); const f1a = await pag.evaluate(FIRMA);
    await pag.evaluate(SEEK(Math.min(6.0, meta.dur - 0.1))); const f6 = await pag.evaluate(FIRMA);
    await pag.evaluate(SEEK(1.0)); const f1b = await pag.evaluate(FIRMA);
    const cambia = f1a !== f6, determinista = f1a === f1b;

    console.log(`\n── ${h}`);
    console.log(`   intrinseco ${meta.intrinseco.w}x${meta.intrinseco.h} · pintado ${meta.w}x${meta.h} (escala ${meta.escala})` +
      (Math.abs(meta.escala - 1) < 0.001 ? "  1:1 ✓" : "  <- OJO: el transform de encaje no se neutralizo"));
    console.log(`   ${meta.dur}s · ${Math.round(meta.dur * FPS)} cuadros a ${FPS}fps`);
    if (meta.escenas) console.log(`   escenas: ${meta.escenas.join(" · ")}`);
    console.log(`   seek: ${cambia ? "cambia ✓" : "NO CAMBIA ✗"} · ${determinista ? "determinista ✓" : "NO DETERMINISTA ✗"}`);
    informe.push({ html: h, ...meta, cambia, determinista });

    if (VERIFICAR || !SALIDA) { await pag.close(); continue; }
    if (!cambia || !determinista) { console.error("   no exporto: el seek no cumple el contrato"); await pag.close(); continue; }

    /* --- los cuadros --- */
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "dcexp-"));
    const n = Math.round(meta.dur * FPS);
    const el = await pag.$("[data-om-exportable-video-with-duration-secs]");
    for (let k = 0; k < n; k++) {
      await pag.evaluate(SEEK(k / FPS));
      await el.screenshot({ path: path.join(tmp, String(k).padStart(5, "0") + ".png"),
        omitBackground: ALFA, optimizeForSpeed: true });
      if (k === 0) {
        /* el veredicto sale de MEDIR el archivo, no de confiar en el viewport */
        const dim = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=width,height", "-of", "csv=p=0",
          path.join(tmp, "00000.png")], { encoding: "utf8" }).trim();
        const [pw, ph] = dim.split(",").map(Number);
        if (pw !== meta.intrinseco.w * ESCALA || ph !== meta.intrinseco.h * ESCALA) {
          console.error(`\n   el PNG salio ${pw}x${ph} y el intrinseco es ${meta.intrinseco.w}x${meta.intrinseco.h}: aborto`);
          fs.rmSync(tmp, { recursive: true, force: true }); await pag.close(); break;
        }
        console.log(`   PNG ${pw}x${ph} ✓`);
      }
      if (k % 25 === 0) process.stdout.write(`\r   cuadro ${k + 1}/${n}   `);
    }
    process.stdout.write(`\r   ${n} cuadros exportados   \n`);

    const salida = htmls.length === 1 ? SALIDA
      : path.join(path.dirname(SALIDA), h.replace(/\.dc\.html$/, "") + path.extname(SALIDA));
    /* ProRes 4444 si hay alfa, 422 HQ si no. -c:v prores_ks es el encoder con perfiles. */
    const perfiles = { "422": ["3", "yuv422p10le"], "4444": ["4444", ALFA ? "yuva444p10le" : "yuv444p10le"] };
    const [prof, pix] = perfiles[PERFIL] || perfiles["4444"];
    execFileSync("ffmpeg", ["-v", "error", "-framerate", String(FPS), "-i", path.join(tmp, "%05d.png"),
      "-c:v", "prores_ks", "-profile:v", prof, "-pix_fmt", pix, "-vendor", "apl0",
      "-r", String(FPS), salida, "-y"]);
    fs.rmSync(tmp, { recursive: true, force: true });

    const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "csv=p=0", salida], { encoding: "utf8" }).trim();
    const info = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,profile,pix_fmt,width,height,nb_frames", "-of", "csv=p=0", salida], { encoding: "utf8" }).trim();
    console.log(`   ${path.basename(salida)}  ${(fs.statSync(salida).size / 1048576).toFixed(1)} MB  ${dur}s  ${info}`);
    await pag.close();
  }

  await nav.close();
  srv.close();
  if (VERIFICAR) console.log("\n" + informe.filter((x) => x.cambia && x.determinista).length + " de " + informe.length + " cumplen el contrato de seek");
})();
