/**
 * Lo verificable sin Premiere. Corré `node test.js` antes de dar algo por hecho.
 *
 * No prueba que el bridge funcione —eso solo se sabe con Premiere abierto— sino
 * las cuentas que devuelven algo plausible cuando están mal. La colisión de
 * globales es el caso testigo: dos `const uxp` en dos <script> distintos es un
 * SyntaxError que mata el archivo entero, y el síntoma visible es un panel que
 * dibuja bien y no hace nada. Se pagó una vez; no se paga dos.
 */


const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const raiz = __dirname;
let fallos = 0;

function ok(msg, extra) {
  console.log("  ok     " + msg + (extra ? "  (" + extra + ")" : ""));
}
function mal(msg, detalle) {
  console.log("  FALLA  " + msg + (detalle ? "\n         " + detalle : ""));
  fallos++;
}
function titulo(t) { console.log("\n" + t + "\n"); }

/* ---------- sintaxis ---------- */

titulo("Sintaxis");

const archivos = [
  "server/index.js", "server/bridge.js",
  "plugin/index.js", "plugin/lib/comandos.js"
];
for (const rel of archivos) {
  try {
    execFileSync(process.execPath, ["--check", path.join(raiz, rel)], { stdio: "pipe" });
    ok(rel);
  } catch (e) {
    mal(rel, String(e.stderr || e.message).trim());
  }
}

/* ---------- globales del plugin ---------- */

titulo("El scope global del panel");

/*
 * Los <script> del panel NO son módulos: comparten un scope. Se listan las
 * declaraciones de nivel superior de cada archivo (las que no tienen sangría) y
 * se buscan repetidas.
 */
function declaracionesGlobales(rel) {
  const src = fs.readFileSync(path.join(raiz, rel), "utf8");
  const nombres = new Set();
  const re = /^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) nombres.add(m[1]);
  return nombres;
}

const deComandos = declaracionesGlobales("plugin/lib/comandos.js");
const deIndex = declaracionesGlobales("plugin/index.js");
const choques = [...deComandos].filter((n) => deIndex.has(n));

if (choques.length) {
  mal("comandos.js e index.js declaran el mismo nombre", choques.join(", ") +
      " — un segundo `const` en el mismo scope es SyntaxError y mata el archivo entero");
} else {
  ok("sin nombres repetidos entre los dos scripts",
     deComandos.size + " + " + deIndex.size + " declaraciones");
}

// El panel usa `ejecutar`, que vive en comandos.js. Si se renombra allá y no acá,
// el panel late pero no ejecuta nunca — y el latido tapa el síntoma.
const srcIndex = fs.readFileSync(path.join(raiz, "plugin/index.js"), "utf8");
if (!deComandos.has("ejecutar")) {
  mal("comandos.js no declara `ejecutar`", "index.js la llama");
} else if (srcIndex.indexOf("ejecutar(") === -1) {
  mal("index.js no llama a `ejecutar`", "el panel latiría sin ejecutar nada");
} else {
  ok("index.js llama a `ejecutar`, que comandos.js declara");
}

/*
 * Que cada verbo de VERBOS esté realmente DECLARADO.
 *
 * Si falta uno, la línea `const VERBOS = {...}` tira ReferenceError, el script
 * muere ahí y VERBOS queda en zona muerta para siempre: el panel late pero
 * cualquier comando contesta "Cannot access 'VERBOS' before initialization",
 * que no se parece en nada a la causa.
 *
 * Se paga editando con scripts: un corte de `clips` hasta `estado` se llevó las
 * once funciones que había en el medio, y nada lo detectó hasta correrlo.
 */
const srcComandosDecl = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
const declaradas = new Set(
  [...srcComandosDecl.matchAll(/^(?:async function|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
);
const mVerbos = srcComandosDecl.match(/const VERBOS\s*=\s*\{([^}]*)\}/);
if (!mVerbos) {
  mal("no se encontró el objeto VERBOS en comandos.js");
} else {
  const listados = mVerbos[1].split(",").map((x) => x.trim()).filter(Boolean);
  const sinDeclarar = listados.filter((n) => !declaradas.has(n));
  if (sinDeclarar.length) {
    mal("VERBOS nombra funciones que no existen", sinDeclarar.join(", ") +
        " — la línea de VERBOS va a tirar y ningún comando va a poder ejecutarse");
  } else {
    ok("las " + listados.length + " funciones de VERBOS están declaradas");
  }
}

/* ---------- el manifest ---------- */

titulo("El manifest");

const manifest = JSON.parse(fs.readFileSync(path.join(raiz, "plugin/manifest.json"), "utf8"));

/* id y shortname identifican al plugin para Premiere: si coinciden con los de OTRO
   plugin UXP instalado, Premiere los trata como el MISMO y uno pisa al otro. Por eso
   el `id` del manifest hay que cambiarlo por uno propio antes de instalar. */
const EXTERNOS = path.join(require("os").homedir(),
  "Library/Application Support/Adobe/UXP/Plugins/External");
let choquesId = [];
if (fs.existsSync(EXTERNOS)) {
  for (const d of fs.readdirSync(EXTERNOS)) {
    const m = path.join(EXTERNOS, d, "manifest.json");
    if (!fs.existsSync(m)) continue;
    let otro; try { otro = JSON.parse(fs.readFileSync(m, "utf8")); } catch (e) { continue; }
    if (otro.id === manifest.id && otro.version === manifest.version) continue;  // es el nuestro
    if (otro.id === manifest.id || otro.shortname === manifest.shortname) choquesId.push(d);
  }
}
if (choquesId.length) {
  mal("el manifest colisiona con otro plugin UXP instalado: " + choquesId.join(", "),
      `este: ${manifest.id} / ${manifest.shortname}`);
} else {
  ok("id y shortname no colisionan con ningun plugin UXP instalado",
     manifest.id + " / " + manifest.shortname);
}

if (manifest.main !== "index.html") mal("el manifest no apunta a index.html", manifest.main);
else ok("main apunta a index.html");

/* ---------- las rutas de intercambio ---------- */

titulo("La carpeta de intercambio");

/*
 * El servidor la resuelve desde __dirname; el panel la tiene escrita a mano
 * porque corre adentro de Premiere. Que las dos apunten al mismo lado no lo
 * garantiza nada: hay que compararlas.
 */
const { CARPETA } = require("./server/bridge.js");
const m = srcIndex.match(/RUTA_BRIDGE\s*=\s*"([^"]+)"/);

if (!m) {
  mal("no se encontró RUTA_BRIDGE en plugin/index.js");
} else if (path.resolve(m[1]) !== path.resolve(CARPETA)) {
  mal("el panel y el servidor apuntan a carpetas distintas",
      "panel:    " + m[1] + "\n         servidor: " + CARPETA);
} else {
  ok("el panel y el servidor apuntan a la misma carpeta", CARPETA);
}

if (!fs.existsSync(CARPETA)) mal("la carpeta de intercambio no existe", CARPETA);
else ok("la carpeta de intercambio existe");

/* ---------- los verbos ---------- */

titulo("Los verbos");

// Que el servidor exponga un verbo que el panel no sabe hacer da un error recién
// en Premiere. Acá se compara la lista de los dos lados.
//
// La clase de caracteres va con mayúsculas a propósito: con `[a-z]+` los seis
// verbos camelCase (`agregarEfecto`, `armarSecuencia`, `borrarSecuencia`,
// `sacarRangos`, `cerrarHuecos`, `escalaFija`) no entraban en la comparación y
// el chequeo corría sobre 23 de 29 sin decirlo.
const srcServidor = fs.readFileSync(path.join(raiz, "server/index.js"), "utf8");
const delServidor = [...srcServidor.matchAll(/enviar\(\s*"([a-zA-Z]+)"/g)].map((x) => x[1]);
const srcComandos = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
const mv = srcComandos.match(/const VERBOS\s*=\s*\{([^}]*)\}/);
const delPanel = mv ? mv[1].split(",").map((s) => s.trim()).filter(Boolean) : [];

const huerfanos = delServidor.filter((v) => delPanel.indexOf(v) === -1);
if (huerfanos.length) {
  mal("el servidor manda verbos que el panel no conoce", huerfanos.join(", ") +
      " — el panel tiene: " + delPanel.join(", "));
} else {
  ok("todos los verbos del servidor existen en el panel", delServidor.length + ": " + delServidor.join(", "));
}

/*
 * Y la dirección contraria, que es la que muerde de verdad.
 *
 * Un verbo que vive solo en `VERBOS` es INVISIBLE desde las herramientas MCP: no
 * falla, no avisa, se agarra la herramienta más parecida que sí existe y esa hace
 * otra cosa. Pasó con `fijar` —se usó `keyframe`, que escribe en el playhead, y
 * quedó una animación de color que nadie pidió— y con `renombrar`, que hizo ~90
 * renombrados por el transporte directo porque no había `premiere_renombrar`.
 *
 * No todo verbo TIENE que ser herramienta. Por eso esto no compara a secas: pide
 * que la decisión esté escrita. Si agregás un verbo, o le hacés su herramienta o
 * lo ponés acá, y en los dos casos lo decidiste. El default —no hacer nada— falla.
 */
const SIN_HERRAMIENTA_A_PROPOSITO = [
  // Piezas del flujo de edición del curso, que se manejan por tandas desde un
  // script con pausas: como herramienta suelta invitan a la ráfaga que tira
  // Premiere. Ver "Y una ráfaga de TRANSACCIONES también lo tira" en CLAUDE.md.
  "aplicarEscalas", "aplicarZooms", "leerEscalas", "aplicarAnim",
  "unirAudio", "unirVideo", "ajustarAlCuadro",
  // Operaciones sobre el proyecto entero, con las que un error cuesta caro.
  "duplicarSecuencia",
  // Lo usa `colocar_fragmentos.js` por el transporte directo, igual que los de arriba: como
  // herramienta suelta invita a colocar de a uno con la ceremonia de un lote. Y su modo de fallo
  // pide un llamador que lo entienda: el in/out vive en el MEDIO, compartido, asi que dos
  // fragmentos del mismo material NO pueden ir en el mismo lote —el verbo los reparte solo— y si
  // eso se rompiera, los N entrarian con el recorte del ULTIMO: se ve como que coloco todo.
  "colocarLote",
  // Sonda del pendiente 7: contesta si createAppendComponentAction acepta un componente de OTRO
  // clip, o sea si un efecto se puede copiar CON SUS VALORES sin leer ~460 params. Mientras la
  // respuesta no este medida, exponerla como herramienta seria ofrecer una copia que quizas
  // entrega el efecto con sus defaults y se ve casi igual: el peor tipo de fallo.
  "copiarEfecto",
  // Sonda: importar transcripciones NO SE PUEDE, y la causa está identificada —
  // `Transcript.importFromJSON` devuelve un TextSegments con el puntero interno en
  // null, probado con el JSON que Premiere mismo exportó. No es algo que nos falte
  // encontrar: es un bug de la API. El verbo queda como diagnóstico, y exponerlo
  // como herramienta sería prometer algo que no hace.
  "importarTranscripcion",
  // Sonda de diagnóstico: contesta si el VALOR de un param se puede leer sincrónicamente
  // adentro de un `lockedAccess`. Es la pregunta que decide si `radiografia` cuesta 12
  // llamadas o 136, y si la respuesta es que sí, desaparece la causa señalada de los dos
  // crashes de 2026-08-21 (referencias de param awaiteadas fuera de su lock). No es una
  // herramienta: se corre una vez, se lee el typeof y se decide el diseño.
  "sondaParam",
  // Inspección: `mirarMedio` mira cuadros de un medio del panel, `api` refleja
  // firmas. Son para diagnosticar desde el transporte directo, no para el uso
  // normal.
  "mirarMedio", "api"
];

const sinExponer = delPanel.filter((v) => delServidor.indexOf(v) === -1);
const noDeclarados = sinExponer.filter((v) => SIN_HERRAMIENTA_A_PROPOSITO.indexOf(v) === -1);
const sobran = SIN_HERRAMIENTA_A_PROPOSITO.filter((v) => delPanel.indexOf(v) === -1 || delServidor.indexOf(v) !== -1);

if (noDeclarados.length) {
  mal("hay verbos del panel sin herramienta MCP y sin declarar",
      noDeclarados.join(", ") +
      " — o le hacés su server.registerTool, o lo agregás a SIN_HERRAMIENTA_A_PROPOSITO en test.js");
} else if (sobran.length) {
  mal("SIN_HERRAMIENTA_A_PROPOSITO tiene entradas que ya no corresponden",
      sobran.join(", ") + " — o el verbo se borró, o ya tiene herramienta: sacalo de la lista");
} else {
  ok("todo verbo del panel tiene herramienta o está declarado como interno",
     delPanel.length + " verbos · " + (delPanel.length - sinExponer.length) + " expuestos · " +
     sinExponer.length + " internos a propósito");

/*
 * Y que los números del encabezado del CLAUDE.md sean los de verdad. Escritos a
 * mano envejecen: decían 33 herramientas sobre 43 verbos cuando eran 35 sobre 46,
 * y un lector los cruzó con la realidad y concluyó que había verbos huérfanos.
 */
{
  const srcClaude = fs.readFileSync(path.join(raiz, "CLAUDE.md"), "utf8");
  const m2 = srcClaude.match(/\*\*(\d+) herramientas MCP sobre (\d+) verbos/);
  if (!m2) {
    mal("el encabezado de CLAUDE.md no declara cuántas herramientas y verbos hay");
  } else if (Number(m2[1]) !== delServidor.length || Number(m2[2]) !== delPanel.length) {
    mal("los números del encabezado de CLAUDE.md no son los reales",
        `dice ${m2[1]} herramientas sobre ${m2[2]} verbos · son ${delServidor.length} sobre ${delPanel.length}`);
  } else {
    ok("los números del encabezado de CLAUDE.md coinciden con la realidad");
  }
}
}

/*
 * LA GUARDA `proyecto` TIENE QUE LLEGAR A TODAS LAS HERRAMIENTAS, Y NO ALCANZA CON DECLARARLA.
 *
 * El despachador del panel la implementa y este test ya exigía que existiera y que fuera antes
 * que la de secuencia. Las dos cosas eran verdad y la guarda no protegía nada: el 2026-08-25 se
 * midió que NINGUNA de las 45 `registerTool` declaraba `proyecto`, así que pasarla desde una
 * herramienta MCP la descartaba en silencio. `premiere_guardar` con `proyecto: "UN CORPORATIVO"`
 * guardó OTRO proyecto. Guardar es inocuo; un `borrar` con la misma confusión no lo sería.
 *
 * Es el corolario de CLAUDE.md aplicado a este mismo archivo: **una guarda contra el error
 * imaginado deja pasar el real.** El test miraba el despachador y no el camino por el que se
 * llega a él.
 *
 * Se chequean LAS DOS MITADES, porque declarar y reenviar son cosas distintas y fallan aparte:
 *   1. el `inputSchema` declara `proyecto`
 *   2. el handler lo REENVÍA — o toma `args` entero, o lo destructura Y lo mete en el `enviar`
 */
{
  const bloques = [];
  const re = /registerTool\(\s*\n\s*"(premiere_[a-z_]+)"/g;
  let m;
  const marcas = [];
  while ((m = re.exec(srcServidor)) !== null) marcas.push({ pos: m.index, nombre: m[1] });
  for (let i = 0; i < marcas.length; i++) {
    const fin = i + 1 < marcas.length ? marcas[i + 1].pos : srcServidor.length;
    bloques.push({ nombre: marcas[i].nombre, cuerpo: srcServidor.slice(marcas[i].pos, fin) });
  }

  /*
   * LAS DOS GUARDAS DEL DESPACHADOR, con el mismo criterio.
   *
   * `proyecto` se completó el 2026-08-25 y `secuencia` quedó pendiente en el
   * mismo texto —"sigue declarada en sólo 16 de 45, ahí el mismo agujero sigue
   * abierto"—. Se cerró el 2026-09-05: las 51 declaran las dos. Confundir de
   * secuencia dentro del proyecto correcto se nota antes que confundir de
   * proyecto, pero el modo de fallo es idéntico: pasarla y que se descarte da
   * falsa sensación de estar protegido, que es peor que no tenerla.
   */
  for (const guarda of ["proyecto", "secuencia"]) {
    const reGuarda = new RegExp("\\b" + guarda + "\\s*:");
    const rePalabra = new RegExp("\\b" + guarda + "\\b");
    const sinDeclarar = [], sinReenviar = [];
    for (const b of bloques) {
      const mSchema = b.cuerpo.match(/inputSchema:\s*\{([\s\S]*?)\n    \}/);
      if (!mSchema || !reGuarda.test(mSchema[1])) { sinDeclarar.push(b.nombre); continue; }

      const mh = b.cuerpo.match(/\n  async (\(\)|\(\{[^)]*\}\)|\(\w+\)) =>/);
      const forma = mh ? mh[1] : "";
      /*
       * LA FORMA `(args)` TAMBIEN SE CHEQUEA. Antes hacia `continue` diciendo "la
       * guarda viaja adentro de args", y eso es cierto SOLO si el handler pasa
       * `args` entero al `enviar`. Si elige campos —`enviar("borrar", {pista:
       * args.pista})`— la guarda se cae y no protege: es el defecto del
       * 2026-08-25 en su forma nueva, antes faltaba el schema y ahora podria
       * faltar el reenvio.
       *
       * Medido el 2026-09-05: las 38 de esta forma pasan `args` entero —10 como
       * `enviar(v, args)` y 28 como `enviar(v, args, timeout)`— asi que no habia
       * ninguna desprotegida. Lo que faltaba era lo que lo sostenga.
       */
      const mArgs = forma.match(/^\((\w+)\)$/);
      if (mArgs) {
        const v = mArgs[1];
        const llamadas = [...b.cuerpo.matchAll(/await enviar\(\s*"\w+"\s*,\s*([^,)]+)/g)].map((x) => x[1].trim());
        const entero = llamadas.some((a) => a === v || a === v + " || {}");
        if (!entero) sinReenviar.push(b.nombre + " (toma `" + v + "` y no lo pasa entero al enviar)");
        continue;
      }

      const destructura = rePalabra.test(forma);
      const mEnviar = b.cuerpo.match(/await enviar\("\w+"[\s\S]{0,200}?\)/);
      const reenvia = mEnviar ? rePalabra.test(mEnviar[0]) : false;
      if (!destructura || !reenvia) sinReenviar.push(b.nombre);
    }

    if (sinDeclarar.length) {
      mal("hay herramientas MCP que no declaran la guarda `" + guarda + "`",
          sinDeclarar.join(", ") + " — pasarla desde ahí la descarta en silencio y la guarda no protege");
    } else if (sinReenviar.length) {
      mal("hay herramientas que declaran `" + guarda + "` pero no lo REENVÍAN al panel",
          sinReenviar.join(", ") + " — falta destructurarlo o meterlo en el `enviar`; declararlo solo no hace nada");
    } else {
      ok("las " + bloques.length + " herramientas declaran la guarda `" + guarda + "` y la reenvían");
    }
  }
}

/*
 * Y que el README no anuncie herramientas que no existen.
 *
 * Es el mismo bug de arriba corrido a la documentación, y es peor: acá se lee la
 * tabla, se le cree, y se usa un nombre que Premiere nunca va a ver. El
 * 2026-08-15 el README listaba diez herramientas inexistentes —los verbos
 * internos documentados como si fueran herramientas— y se comía `guardar` y
 * `renombrar`, que sí lo eran.
 *
 * Por eso todo `premiere_loquesea` entre comillas invertidas en el README tiene
 * que estar registrado, y toda herramienta registrada tiene que estar nombrada.
 */
const srcReadme = fs.readFileSync(path.join(raiz, "README.md"), "utf8");
const enReadme = [...new Set([...srcReadme.matchAll(/`(premiere_[a-z_]+)`/g)].map((x) => x[1]))];
const registradas = [...new Set(
  [...srcServidor.matchAll(/registerTool\(\s*\n?\s*"(premiere_[a-z_]+)"/g)].map((x) => x[1])
)];

const inventadas = enReadme.filter((t) => registradas.indexOf(t) === -1);
const nombradas = registradas.filter((t) => enReadme.indexOf(t) === -1);
if (inventadas.length) {
  mal("el README nombra herramientas que no existen",
      inventadas.join(", ") + " — si son verbos internos, van sin el prefijo `premiere_`");
} else if (nombradas.length) {
  mal("hay herramientas registradas que el README no nombra", nombradas.join(", "));
} else {
  ok("el README y las herramientas registradas coinciden", registradas.length + " herramientas");
}

/*
 * `herramientas/audio.js` corre AFUERA de Premiere, así que no lo cubre ninguno
 * de los chequeos de verbos. Lo mínimo: que cargue y que exporte sus dos piezas.
 *
 * No se chequea que whisper esté instalado: es opcional y en otra máquina puede
 * no estar todavía. La herramienta ya avisa con la ruta exacta si falta.
 */
titulo("Las herramientas de afuera");

const rutaAudio = path.join(raiz, "herramientas/audio.js");
if (!fs.existsSync(rutaAudio)) {
  mal("falta `herramientas/audio.js`");
} else {
  let mod = null;
  try { mod = require(rutaAudio); } catch (e) { mod = null; mal("`herramientas/audio.js` no carga", e && e.message ? e.message : String(e)); }
  if (mod) {
    const faltan = ["palabrasDe", "mapa"].filter((f) => typeof mod[f] !== "function");
    if (faltan.length) mal("`herramientas/audio.js` no exporta " + faltan.join(", "));
    else if (!/herramientas\/audio\.js/.test(srcReadme)) mal("`herramientas/audio.js` no está documentada en el README");
    else if (!/ggml-silero/.test(srcReadme)) mal("el README no dice cómo bajar el modelo de VAD", "sin eso la herramienta no corre en otra máquina");
    else ok("`herramientas/audio.js` carga y está documentada");
  }
}

/*
 * Las otras herramientas: que estén, que parseen, que el README las nombre,
 * y —lo que importa— que NO tengan la carpeta ni el prefijo escritos a mano.
 *
 * Los cuatro tropiezos de la segunda jornada fueron exactamente eso: valores
 * heredados del primer proyecto. Ninguno falla ruidosamente —dos leyeron el
 * proyecto equivocado y contestaron con confianza— así que el chequeo tiene que
 * ser estático.
 */
for (const h of ["leer.js", "armar.js", "verificar.js", "suplentes.js", "construir.js",
                 "comparar_corte.js", "exportar_dc.js", "revisar_medios.js",
                 "plancha_corte.js", "cotejar_export.js"]) {
  const ruta = path.join(raiz, "herramientas", h);
  if (!fs.existsSync(ruta)) { mal(`falta \`herramientas/${h}\``); continue; }
  // Se miran los COMENTARIOS aparte: las notas citan los prefijos de las dos
  // jornadas justamente para explicar por qué se deducen, y buscarlos en el
  // archivo entero marcaba como error la documentación del arreglo.
  const src = fs.readFileSync(ruta, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/Desktop\/prueba de material/.test(src)) {
    mal(`\`herramientas/${h}\` tiene una carpeta de proyecto escrita a mano`,
        "un default que apunta a otro proyecto no falla: lee el equivocado y contesta con confianza");
  } else if (/CerroNegro_\d{2}-\d{2}-\d{2}_/.test(src)) {
    mal(`\`herramientas/${h}\` tiene el prefijo de una jornada escrito a mano`,
        "explota en la jornada siguiente, y recién al llegar al primer archivo");
  } else if (!new RegExp("`?" + h.replace(".", "\\.") + "`?").test(srcReadme)) {
    mal(`\`herramientas/${h}\` no está documentada en el README`);
  } else {
    ok(`\`herramientas/${h}\` sin rutas ni prefijos a mano, y documentada`);
  }
}

/*
 * Y la lista de beats NO puede vivir en el código: es criterio editorial de cada
 * jornada. `armar.js` tiene que leerla del proyecto, y tiene que haber un ejemplo.
 */
{
  const src = fs.readFileSync(path.join(raiz, "herramientas/armar.js"), "utf8");
  if (/^const VIDEOS = \[/m.test(src)) {
    mal("`herramientas/armar.js` tiene la lista de beats adentro",
        "es criterio editorial de una jornada, no herramienta: va con el material");
  } else if (!/require\(rutaBeats\)/.test(src) || !fs.existsSync(path.join(raiz, "herramientas/beats.ejemplo.js"))) {
    mal("`armar.js` no lee los beats del proyecto, o falta `beats.ejemplo.js`");
  } else {
    ok("`armar.js` lee los beats del proyecto y hay un ejemplo");
  }
}

/* ---------- las pistas ---------- */

titulo("Las pistas");

// Los verbos que trabajan sobre una pista de video tienen que resolverla con
// `pistaDeVideo`. El patrón viejo —parsear el número y llamar getVideoTrack—
// aceptaba "A1" en silencio: daba índice 0 y operaba sobre V1. No fallaba, que
// es lo peor que puede hacer.
const crudos = [...srcComandos.matchAll(/parseInt\(pista\.slice\(1\), 10\) - 1/g)].length;
if (crudos) {
  mal("hay verbos que parsean la pista a mano en vez de usar `pistaDeVideo`",
      crudos + " sitio(s) — con {pista:\"A1\"} operarían sobre V1 sin avisar");
} else {
  // Los dos resolvers valen: `pistaDeVideo` rechaza el audio, `pistaDeSecuencia`
  // lo acepta y es solo para los verbos que de verdad saben tratarlo. Lo que no
  // vale es parsear a mano, que es lo que chequea `crudos` arriba.
  const soloVideo = [...srcComandos.matchAll(/pistaDeVideo\(params\.pista, "(\w+)"\)/g)].map((x) => x[1]);
  const conAudio = [...srcComandos.matchAll(/pistaDeSecuencia\(params\.pista, "(\w+)"\)/g)].map((x) => x[1]);
  const usos = soloVideo.concat(conAudio);
  const mal2 = usos.filter((v) => delPanel.indexOf(v) === -1);
  if (mal2.length) {
    mal("un resolver de pista se llama con un nombre de verbo que no existe", mal2.join(", "));
  } else if (!usos.length) {
    mal("ningún verbo resuelve la pista con un resolver", "se perdieron los dos");
  } else {
    ok(`${usos.length} verbos resuelven la pista con un resolver`,
       "solo video: " + soloVideo.join(", ") + " · con audio: " + (conAudio.join(", ") || "ninguno"));
  }
}

/*
 * `cerrarHuecos` sobre audio NO tiene que arrastrar los vinculados: estirar un
 * clip de A1 estiraría su video y lo solaparía si V1 no tenía hueco ahí. Es una
 * línea fácil de perder en un refactor y el efecto no se ve hasta reproducir.
 */
const cuerpoCerrar = srcComandos.match(/async function cerrarHuecos[\s\S]*?\n\}/);
if (!cuerpoCerrar) {
  mal("no se encontró `cerrarHuecos` para revisarlo");
} else if (!/esAudio \? \[\] : await buscarVinculados/.test(cuerpoCerrar[0])) {
  mal("`cerrarHuecos` arrastra los vinculados también en audio",
      "estirar un clip de A1 estiraría su video y podría solaparlo en V1");
} else {
  ok("`cerrarHuecos` no arrastra vinculados en pistas de audio");
}

/*
 * `buscarVinculados` tiene que exigir que el socio sea del OTRO tipo.
 *
 * Sin eso empareja video con video —mismo medio, mismo rango— y `editar` le
 * manda al falso socio el mismo `salida` de FUENTE: si los materiales arrancan
 * en distinto lugar, quedan con duraciones distintas. Reproducido el 2026-08-16
 * en el proyecto de prueba: uno pedido en 3s dejó al otro en 20s intacto, y en
 * la variante legal uno quedó en 5s y el otro en 10s.
 *
 * Se chequea el filtro final y además que NO vuelva `getMediaType()`: se probó
 * con ese getter y salió al revés, porque los valores de Constants.MediaType no
 * son primitivos y comparados como texto dan "[object Object]".
 */
const cuerpoVinc = srcComandos.match(/async function buscarVinculados[\s\S]*?\n\}/);
if (!cuerpoVinc) {
  mal("no se encontró `buscarVinculados` para revisarlo");
} else if (/getMediaType/.test(cuerpoVinc[0])) {
  mal("`buscarVinculados` volvió a decidir el tipo con `getMediaType()`",
      "los valores de Constants.MediaType no son primitivos: comparados como texto dan \"[object Object]\"");
} else if (!/\.video !== esVideo/.test(cuerpoVinc[0])) {
  mal("`buscarVinculados` no exige que el vinculado sea del otro tipo",
      "empareja video con video y `editar` le manda un punto de fuente que no le corresponde");
} else {
  ok("`buscarVinculados` solo empareja video con audio");
}

/*
 * `editar` tiene que TRADUCIR `entrada` y `salida` a cada vinculado, no
 * copiarles el número.
 *
 * Son puntos adentro del MATERIAL, y el material de cada clip arranca donde
 * arranca. Copiar el absoluto le daba al socio una duración que no era la suya:
 * medido el 2026-08-16, un video que empieza en 5 y su audio en 8, pidiendo
 * `salida: 8`, dejaba el video en 3s y el audio en DURACIÓN CERO — y Premiere
 * acepta un clip de largo cero, así que es pérdida de datos silenciosa.
 */
const cuerpoEditar = srcComandos.match(/async function editar[\s\S]*?\n  if \(!acciones\.length\)/);
if (!cuerpoEditar) {
  mal("no se encontró `editar` para revisarlo");
} else if (/createSetOutPointAction\(aTick\(params\.salida\)\)/.test(cuerpoEditar[0]) ||
           /createSetInPointAction\(aTick\(params\.entrada\)\)/.test(cuerpoEditar[0])) {
  mal("`editar` le copia a los vinculados el punto de fuente en vez de traducirlo",
      "un vinculado que arranca en otro lugar del material queda con otra duración, o en cero");
} else if (!/suyo\.entrada \+ delta/.test(cuerpoEditar[0])) {
  mal("`editar` no traduce `entrada`/`salida` por el delta de material de cada clip");
} else {
  ok("`editar` traduce entrada y salida a cada vinculado");
}

/*
 * La reparación del audio de `soloVideo` tiene que VERIFICARSE releyendo el
 * clip, no darse por buena porque las llamadas no tiraron.
 *
 * Así estaba: dos `executeTransaction` con el booleano ignorado y un push
 * incondicional. Explica la discrepancia del M1 —informó 10 reparados de 13 y
 * A1 ganó 6 clips, cuando 3 fallos explican 3—: los que fallaban se contaban
 * como buenos.
 */
const cuerpoCortar = srcComandos.match(/async function cortar[\s\S]*?\n\}/);
if (!cuerpoCortar) {
  mal("no se encontró `cortar` para revisarlo");
} else if (!/const quedo = await tiemposDe\(a\.item\)/.test(cuerpoCortar[0])) {
  mal("`soloVideo` informa el audio reparado sin releerlo",
      "alcanza con que las llamadas no tiren para contarlo como reparado");
} else if (!/createOverwriteItemAction\(medio, juntaTick,/.test(cuerpoCortar[0])) {
  mal("`cortar` posiciona la cola con un tiempo en SEGUNDOS",
      "`junta` viene redondeada a 3 decimales y en ticks cae un pelo por encima del frame: deja 1 frame de hueco");
} else if (!/\btickCorte = r\b/.test(cuerpoCortar[0].replace(/\/\*[\s\S]*?\*\//g, ""))) {
  /*
   * El punto de corte se cuantiza al frame antes de tocar nada, y NO por la API:
   * alignToNearestFrame contesta "Illegal Parameter type" en todas sus formas.
   * Lo que anda es aritmética entera sobre ticks con getTimebase(). Sin esto, un
   * corte entre frames deja un hueco — siete veces en el M1.
   */
  mal("`cortar` no APLICA el punto de corte cuantizado",
      "falta `tickCorte = r`. Antes esto buscaba la etiqueta \"redondeo entero de ticks\", que es una\n         " +
      "cadena en el codigo: un chequeo por MENCION pasa con el bucle entero y sin la asignacion.\n         " +
      "Cortar entre frames deja un hueco: la cabeza guarda el tick exacto y la cola snapea — 7 veces en el M1");
} else {
  ok("`soloVideo` verifica el audio, y el corte se cuantiza al frame");
}

/* ---------- marcar cuantiza al frame, como `cortar` ---------- */

titulo("marcar cuantiza al frame de la secuencia e informa cuanto movio el marcador");

/*
 * En la interfaz de Premiere NO se puede poner un marcador entre frames, asi que subframe no
 * es un estado que el usuario pueda crear a mano: lo producia este verbo y nada mas.
 *
 * Descubierto el 2026-09-03 poniendo 139 marcadores en el beat de una musica a 96 BPM. El beat
 * mide 15,625 cuadros a 25fps, asi que solo 1 de cada 8 cae en cuadro justo: 121 de los 139
 * quedaron subframe. Lo vio el EDITOR, no la verificacion — y la regla ya estaba escrita en
 * CLAUDE.md, en la nota de los huecos de un frame de `cortar`. Se pago dos veces la misma.
 *
 * No es grave porque al cortar Premiere aproxima, pero entonces el marcador deja de decir donde
 * esta el corte. Y a 96 BPM el conflicto es irreducible: un beat de 15,625 cuadros no puede caer
 * en cuadro y en beat a la vez, asi que gana el cuadro, que es lo unico que el timeline sostiene.
 *
 * Tres cosas, y la tercera es la que hace que el verbo no mienta: si informa el tiempo PEDIDO en
 * vez del real, el marcador se movio y el resumen dice que no.
 */
{
  const m = srcComandos.match(/async function marcar\(params\)[\s\S]*?\n}\n/);
  if (!m) {
    mal("no se encontro el cuerpo de `marcar`", "el chequeo de cuantizacion no puede correr");
  } else {
    /*
     * SIN COMENTARIOS: estos cuerpos explican la cuantizacion en prosa, y un
     * chequeo que matchea su propia explicacion no protege nada. Ya se pago tres
     * veces en este archivo.
     */
    const cuerpo = m[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const leeTimebase = /sequence\.getTimebase\(\)/.test(cuerpo);
    /* La via es aritmetica entera sobre ticks: `alignToNearestFrame` contesta
     * "Illegal Parameter type", ya medido en `cortar`. */
    const redondea = /Math\.round\(ticks \/ tb\) \* tb/.test(cuerpo);
    const informa = /\$\{cuantizado\}/.test(cuerpo);
    const tiempoReal = /en \$\{segundosReales\}s/.test(cuerpo) &&
                       /segundos: segundosReales/.test(cuerpo);
    /*
     * Y QUE EL ALINEADO SE APLIQUE, que era el agujero: los otros cuatro miran
     * que el frame se CALCULE. Sin `tick = alineado` el marcador queda subframe,
     * `segundos` informa el tick sin cuantizar, y el resumen igual dice
     * "cuantizado al frame: se pidio X y quedo en Y" —porque `cuantizado` se
     * arma con `despuesSeg`, que existe igual—. Miente de las dos puntas y los
     * cuatro chequeos viejos pasan.
     */
    const aplica = /\btick = alineado\b/.test(cuerpo);
    if (!leeTimebase) {
      mal("`marcar` no lee el timebase de la secuencia",
        "sin los ticks por frame no hay con que cuantizar, y un marcador subframe no dice donde " +
        "esta el corte: se corre hasta medio cuadro");
    } else if (!redondea) {
      mal("`marcar` no cuantiza el tick al frame por aritmetica entera",
        "`alignToNearestFrame` contesta \"Illegal Parameter type\" en todas sus formas — ya medido " +
        "en `cortar`— asi que la unica via es Math.round(ticks/tpf)*tpf");
    } else if (!informa) {
      mal("`marcar` cuantiza en silencio",
        "mover el marcador sin decirlo es cambiar lo que se pidio sin avisar; el resumen tiene que " +
        "traer cuanto se movio, igual que `cortar`");
    } else if (!aplica) {
      mal("`marcar` calcula el frame alineado y NO lo aplica",
        "falta `tick = alineado`: el marcador queda subframe, `segundos` informa el tick sin\n         " +
        "cuantizar, y el resumen igual dice que lo cuantizo. Vuelven los 121 de 139 subframe.");
    } else if (!tiempoReal) {
      mal("`marcar` informa el tiempo PEDIDO y no el real",
        "es el peor de los tres: el marcador se movio al frame y el resumen dice que quedo donde se " +
        "pidio. Un verbo que informa la intencion en vez del estado es el modo de fallar n1 de CLAUDE.md");
    } else {
      ok("lee el timebase, cuantiza por aritmetica entera, lo informa y devuelve el tiempo REAL");
    }
  }
}

/*
 * Una capa de ajuste NO se escala: el efecto se aplica al área que la capa
 * ocupa, así que bajarla al 50% deja la corrección en un rectángulo en el medio
 * del cuadro. Probado y mirado en un frame el 2026-08-16.
 *
 * `escalaFija` escala una pista entera de una, que es justo lo que hace el flujo
 * del curso, así que tiene que saltearlas — y `clips` tiene que decir cuáles
 * son, porque si no no hay forma de distinguirlas.
 */
const cuerpoEscala = srcComandos.match(/async function escalaFija[\s\S]*?\n\}/);
if (!cuerpoEscala) {
  mal("no se encontró `escalaFija` para revisarlo");
} else if (!/esCapaDeAjuste/.test(cuerpoEscala[0])) {
  mal("`escalaFija` escala también las capas de ajuste",
      "deja la corrección en un rectángulo en el medio del cuadro y el resto sin corregir");
} else if (!/clips\.splice\(i, 1\)/.test(cuerpoEscala[0])) {
  /*
   * NOMBRARLA NO ES SALTEARLA. Antes alcanzaba con que `esCapaDeAjuste` apareciera
   * en el cuerpo, y lo que de verdad la saca de la tanda es el `splice`. Perder el
   * splice y conservar el push —el refactor accidental probable— deja `escalaFija`
   * escalando las capas al 50 Y listándolas en `salteadas`: hace el daño e informa
   * que no lo hizo. Se descubre mirando un frame.
   */
  mal("`escalaFija` detecta la capa de ajuste y NO la saca de la tanda",
      "falta `clips.splice(i, 1)`: la escala igual y encima la informa como salteada");
} else if (!/esCapaDeAjuste: await esCapaDeAjuste/.test(
    (srcComandos.match(/async function clips\([\s\S]*?\n\}/) || [""])[0])) {
  /*
   * ACOTADO AL CUERPO DE `clips`. Antes buscaba en TODO comandos.js, así que si
   * `clips` perdía el campo pero otro verbo tenía la misma línea, el chequeo pasaba
   * verde — y `esCapaDeAjuste` es el único dato con el que se distingue una capa de
   * ajuste desde MCP.
   */
  mal("`clips` no informa cuáles son capas de ajuste",
      "sin ese dato no se las puede distinguir de un clip común desde las herramientas MCP");
} else {
  ok("las capas de ajuste se informan y no se escalan");
}

/* ---------- que el servidor CARGUE ---------- */

titulo("El servidor");

/*
 * `node --check` valida sintaxis y nada más. El 2026-08-16 se agregó una
 * herramienta con `servidor.tool(...)` —la variable es `server` y el método es
 * `registerTool`— y pasó el chequeo, pasó todo este test, y se commiteó: el
 * servidor MCP no habría arrancado. La única prueba real es cargarlo.
 */
try {
  const antes = Object.keys(require.cache).length;
  require("./server/index.js");
  ok("server/index.js carga sin romperse", Object.keys(require.cache).length - antes + " módulos");
} catch (e) {
  mal("server/index.js NO carga", e && e.message ? e.message : String(e));
}

// Y que todas las herramientas se registren de la misma forma: una sola llamada
// distinta basta para que el archivo cargue a medias o no cargue.
const formas = [...srcServidor.matchAll(/^\s*(\w+)\.(registerTool|tool)\(/gm)].map((m) => m[1] + "." + m[2]);
const unicas = [...new Set(formas)];
if (unicas.length > 1) {
  mal("las herramientas se registran de formas distintas", unicas.join(" y "));
} else if (!formas.length) {
  mal("no se encontró ninguna herramienta registrada en el servidor");
} else {
  ok(`las ${formas.length} herramientas usan la misma forma`, unicas[0]);
}

/*
 * Los fps de la secuencia salen de los TICKS POR FRAME, no de un número de
 * cuadros suelto, y el valor tiene que derivarse de TICKS_POR_SEGUNDO.
 *
 * Hardcodear 10160640000 andaría sólo para 25fps y fallaría en silencio para
 * cualquier otro, que es el modo de fallar nº3: medir un caso y generalizar.
 */
const cuerpoPoner = srcComandos.match(/async function ponerAjustes[\s\S]*?\n\}/);
if (!cuerpoPoner) {
  mal("no se encontró `ponerAjustes` para revisarlo");
} else if (!/TICKS_POR_SEGUNDO\s*\/\s*fps/.test(cuerpoPoner[0])) {
  mal("`ponerAjustes` no deriva los ticks por frame de TICKS_POR_SEGUNDO / fps",
      "un valor hardcodeado anda para 25fps y falla callado para cualquier otro");
} else if (!/const ahora = await leerAjustes\(sequence\)[\s\S]*?ahora\.fps/.test(cuerpoPoner[0])) {
  mal("`ponerAjustes` no releé los fps para saber si la escritura entró",
      "esta API acepta escrituras que no aplica: que la llamada no tire no prueba nada");
} else {
  ok("`ponerAjustes` deriva los fps de los ticks y verifica releyendo");
}

/*
 * `leerAjustes` tiene que leer los fps de `.value`, que es donde están: el getter
 * devuelve CUADROS POR SEGUNDO, no ticks. Buscar `.ticks` primero —por analogía
 * con el resto de la API— daba null, y el verbo informaba "nullfps" como si el
 * getter estuviera roto. De ahí salió además el orden de las formas del setter.
 */
const cuerpoLeer = srcComandos.match(/async function leerAjustes[\s\S]*?\n\}/);
if (!cuerpoLeer) {
  mal("no se encontró `leerAjustes` para revisarlo");
} else if (!/crudoFrameRate/.test(cuerpoLeer[0]) || !/fr\.value === "number"/.test(cuerpoLeer[0])) {
  mal("`leerAjustes` no lee los fps de `.value` del getter",
      "getVideoFrameRate() devuelve {value: fps}, no ticks: buscar .ticks da null y parece que el getter falla");
} else {
  ok("`leerAjustes` lee los fps de `.value` y guarda el objeto crudo");
}

/*
 * Y el orden de las formas del setter: las que hablan en CUADROS van antes que
 * las de ticks. No es cosmético — es lo que el getter devuelve. Probando ticks
 * primero, el TickTime contestó "Invalid parameter" y las otras "Illegal
 * Parameter type", y de ahí se concluyó mal que el valor estaba equivocado.
 */
if (cuerpoPoner) {
  const iValue = cuerpoPoner[0].indexOf("objeto {value: fps}");
  const iTick = cuerpoPoner[0].indexOf("TickTime de ticks por frame");
  if (iValue === -1 || iTick === -1) {
    mal("`ponerAjustes` no enumera las formas esperadas del frame rate");
  } else if (iValue > iTick) {
    mal("`ponerAjustes` prueba los ticks antes que los cuadros",
        "el getter habla en fps: probar ticks primero fue lo que hizo concluir mal");
  } else {
    ok("`ponerAjustes` prueba primero las formas en cuadros, después las de ticks");
  }
}

/*
 * `armarSecuencia` tiene que aplicar tamaño y fps con la secuencia VACÍA.
 *
 * Si se aplicaran después de pegar los fragmentos, bajar de 50 a 25fps duplica el
 * largo del frame y los cortes que caían en un frame impar quedan ENTRE frames —
 * que es el bug de los huecos de un frame que ya se pagó en el M1.
 */
const cuerpoArmar = srcComandos.match(/async function armarSecuencia[\s\S]*?\n\}/);
if (!cuerpoArmar) {
  mal("no se encontró `armarSecuencia` para revisarlo");
} else {
  const iVaciar = cuerpoArmar[0].indexOf("vaciarSecuencia(project, nueva)");
  const iPoner = cuerpoArmar[0].indexOf("ponerAjustes(project, nueva");
  // El ancla del pegado es `createOverwriteItemAction`, NO un `for` sobre
  // fragmentos: hay dos bucles así antes —validar y resolver los medios— y
  // anclar ahí daba una falla donde el orden estaba bien.
  const iPegar = cuerpoArmar[0].indexOf("createOverwriteItemAction");
  if (iPoner === -1) {
    mal("`armarSecuencia` no aplica los ajustes pedidos", "la secuencia sale con los del material y nadie lo dice");
  } else if (!(iVaciar !== -1 && iVaciar < iPoner)) {
    mal("`armarSecuencia` ajusta antes de vaciar la secuencia");
  } else if (!(iPegar !== -1 && iPoner < iPegar)) {
    mal("`armarSecuencia` ajusta los fps DESPUÉS de pegar los fragmentos",
        "cambiar los fps con clips puestos deja cortes entre frames");
  } else {
    ok("`armarSecuencia` aplica tamaño y fps con la secuencia todavía vacía");
  }
}

/*
 * Y que los tres parámetros nuevos estén expuestos en las DOS herramientas: un
 * parámetro que sólo vive en el verbo es invisible desde MCP, que es lo que ya
 * pasó con `fijar` y con `renombrar`.
 */
for (const [tool, params] of [["premiere_resolucion", ["ancho", "alto", "fps"]], ["premiere_armar_secuencia", ["ancho", "alto", "fps"]]]) {
  const bloque = srcServidor.match(new RegExp('"' + tool + '"[\\s\\S]*?\\n\\);'));
  if (!bloque) { mal(`no se encontró la herramienta ${tool}`); continue; }
  const faltan = params.filter((p) => !new RegExp("^\\s*" + p + ":", "m").test(bloque[0]));
  if (faltan.length) mal(`${tool} no expone ${faltan.join(", ")}`, "desde MCP no se puede pedir");
  else ok(`${tool} expone ${params.join(", ")}`);
}

/*
 * `moverABin` tiene que mandar TODOS los movimientos en una sola transacción.
 *
 * Una transacción por medio es una ráfaga, y está medido que 18 a 200ms tiran
 * Premiere con SIGSEGV. Ordenar los medios de una jornada son decenas de
 * movimientos, o sea exactamente el patrón que ya costó una edición real. Se
 * chequea que el bucle sobre los pendientes esté ADENTRO del executeTransaction,
 * y no al revés.
 */
const cuerpoMover = srcComandos.match(/async function moverABin[\s\S]*?\n\}/);
if (!cuerpoMover) {
  mal("no se encontró `moverABin` para revisarlo");
} else {
  const iTx = cuerpoMover[0].indexOf("executeTransaction((a) => {\n          for (const it of restantes)");
  if (iTx === -1) {
    mal("`moverABin` no mete el bucle de movimientos adentro de una sola transacción",
        "una transacción por medio es la ráfaga que tira Premiere con SIGSEGV");
  } else if (/new Set\(\(\(await hijosDe\(carpeta\)\)/.test(cuerpoMover[0]) || /final\.has\(String\(it\.name\)\)/.test(cuerpoMover[0])) {
    mal("`moverABin` verifica con un Set de nombres",
        "Premiere deja importar el mismo archivo muchas veces: cuatro items llamados igual entran como uno y el verbo informa 4 de 4 movidos habiendo quedado uno afuera");
  } else if (!/transacciones\+\+/.test(cuerpoMover[0])) {
    mal("`moverABin` no cuenta las transacciones que corrieron",
        "hay que poder decir cuántos Cmd+Z hacen falta");
  } else {
    ok("`moverABin` manda todos los movimientos en una sola transacción");
  }
}

/*
 * Las acciones de bins se CREAN adentro de `lockedAccess`, no afuera.
 *
 * Creándolas afuera, `createBinAction` y `createMoveItemAction` contestan
 * "Requires locked access" — medido el 2026-08-17. El mensaje suena a un problema
 * de permisos del proyecto y no a lo que es: la fábrica de la acción necesita el
 * lock tomado. Se chequea que la llamada a la fábrica quede DESPUÉS de abrir el
 * executeTransaction, en las dos funciones.
 */
for (const fn of ["asegurarBin", "moverABin"]) {
  const cuerpo = srcComandos.match(new RegExp("async function " + fn + "[\\s\\S]*?\\n\\}"));
  if (!cuerpo) { mal(`no se encontró \`${fn}\` para revisarlo`); continue; }
  /*
   * SE COMPARA LA POSICION, no se buscan literales.
   *
   * La version vieja exigia el literal `if (!accion)` para detectar el caso malo, y esa
   * cadena aparece CERO veces en comandos.js: `fuera` era siempre false. Y `dentro` solo
   * pedia `const accion = ` pegado al `executeTransaction`, que sigue estando cuando la
   * fabrica se sube afuera del lock. Verificado por mutacion el 2026-09-10: subiendo la
   * llamada y dejando `const accion = accionYa;` adentro, test.js daba "ok".
   *
   * La propiedad que importa es una sola: NINGUNA invocacion de la fabrica puede quedar
   * antes de `project.lockedAccess`. En `moverABin` hay que saltear la DEFINICION de
   * `accionDe`, que es un arrow y va antes del lock a proposito.
   */
  const limpio = cuerpo[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const iLock = limpio.indexOf("project.lockedAccess");
  const nombreFab = fn === "asegurarBin" ? "fn" : "accionDe";
  const patron = new RegExp("\\b" + nombreFab + "\\(", "g");
  /* Se saltea la DEFINICION —`const accionDe = (…) =>`— y no cualquier asignacion:
     `const accion = fn()` SI es una invocacion, y el filtro ingenuo la descartaba. */
  const invocaciones = [...limpio.matchAll(patron)].filter((m) =>
    !new RegExp("const\\s+" + nombreFab + "\\s*=\\s*$")
      .test(limpio.slice(Math.max(0, m.index - 30), m.index)));
  const fuera = iLock === -1 || invocaciones.some((m) => m.index < iLock);
  const dentro = invocaciones.length > 0 && !fuera;
  if (fuera || !dentro) {
    mal(`\`${fn}\` crea la acción FUERA de lockedAccess`,
        "createBinAction y createMoveItemAction contestan \"Requires locked access\" si la fábrica se llama sin el lock");
  } else {
    ok(`\`${fn}\` crea sus acciones adentro de lockedAccess`);
  }
}

/*
 * `armarSecuencia` tiene que DEVOLVER los in/out de los medios que tocó.
 *
 * `createSetInOutPointsAction` escribe en el ProjectItem, que es de todo el
 * proyecto y no de ese corte, así que sin limpiarlos cada medio queda recortado
 * en el panel para siempre y cualquier secuencia que se cree después desde él
 * arranca en el in-point viejo. Es el daño que ya pagó `cortar`; `armarSecuencia`
 * lo tenía igual y nadie lo había mirado.
 *
 * Y va en UNA transacción: una por medio es la ráfaga que tira Premiere.
 */
if (cuerpoArmar) {
  if (!/createClearInOutPointsAction/.test(cuerpoArmar[0])) {
    mal("`armarSecuencia` no devuelve los in/out de los medios",
        "quedan recortados en el panel del proyecto para siempre");
  } else if (!/executeTransaction\(\(a\) => \{\s*\n\s*for \(const t of tocados\)/.test(cuerpoArmar[0])) {
    mal("`armarSecuencia` limpia los in/out con una transacción por medio",
        "es la ráfaga que tira Premiere con SIGSEGV");
  } else if (!/inOutLimpiados/.test(cuerpoArmar[0])) {
    mal("`armarSecuencia` no informa si pudo devolver los in/out");
  } else {
    ok("`armarSecuencia` devuelve los in/out de los medios en una transacción");
  }
}

/*
 * Las capas se releen AL FINAL, no sólo al ponerlas.
 *
 * `createOverwriteItemAction` PISA: dos capas en la misma pista y la misma
 * posición se comen entre sí, y la segunda deja a la primera truncada. Medido el
 * 2026-08-17 — dos tomas alternativas del mismo beat en V3 a 58,52s dejaron 1,64s
 * de la primera y el verbo informó "3/3 capas", porque cada una se había
 * verificado en el momento de ponerla. `revisar` tampoco lo ve: un clip truncado
 * es legal.
 */
if (cuerpoArmar) {
  /*
   * SE EXIGE EL USO, NO LA MENCION. Antes alcanzaba con que `capasRotas` apareciera
   * en el cuerpo. Conservando la deteccion y perdiendo la resta y el aviso, la
   * variable queda calculada y sin usar: el resumen vuelve a informar "3/3 capas"
   * sobre dos capas que se comieron entre si, y el chequeo sigue verde. Es el caso
   * medido el 2026-08-17 —V3 a 58,52s, 1,64s de la primera— y `revisar` no lo ve,
   * porque un clip truncado es legal: no es hueco, ni solape, ni duracion cero.
   */
  const usaRotas = /capasPuestas\.length - capasRotas\.length/.test(cuerpoArmar[0]);
  const avisaRotas = /SE PISARON/.test(cuerpoArmar[0]);
  if (!/capasRotas/.test(cuerpoArmar[0])) {
    mal("`armarSecuencia` no relee las capas después de ponerlas todas",
        "dos capas en la misma pista y posición se pisan, y cada una se verifica sola");
  } else if (!/Math\.abs\(t\.hasta - c\.hasta\) < 0\.15/.test(cuerpoArmar[0])) {
    mal("`armarSecuencia` relee las capas pero no chequea que sigan ENTERAS",
        "una capa pisada conserva su arranque y pierde el final");
  } else if (!usaRotas) {
    mal("`armarSecuencia` detecta las capas pisadas y NO las descuenta del conteo",
        "falta `capasPuestas.length - capasRotas.length`: vuelve a informar \"3/3 capas\" sobre dos\n         " +
        "capas que se comieron entre si. Detectar y no usar el resultado es peor que no detectar.");
  } else if (!avisaRotas) {
    mal("`armarSecuencia` descuenta las capas pisadas pero no dice CUALES",
        "un \"2/3\" sin nombrar cual se piso ni por que obliga a buscarlo a mano en el timeline");
  } else {
    ok("`armarSecuencia` relee las capas al final y avisa si se pisaron");
  }
}

/*
 * Y `importar` tiene que REINTENTAR la cuenta: `importFiles` vuelve antes de que
 * los medios estén en el panel, así que una sola lectura da "no entró ninguno"
 * con la importación andando bien.
 */
// El ancla lleva `(params)`: `async function importar` matchea también
// `importarTranscripcion`, y el chequeo daba una falla donde el código estaba bien.
const cuerpoImportar = srcComandos.match(/async function importar\(params\)[\s\S]*?\n\}/);
if (!cuerpoImportar) {
  mal("no se encontró `importar` para revisarlo");
} else if (!/const pedidos = \[\.\.\.new Set\(rutas\.map/.test(cuerpoImportar[0]) || !/const faltan = pedidos\.filter/.test(cuerpoImportar[0])) {
  mal("`importar` decide por el CONTEO en vez de por los archivos pedidos",
      "\"ya estaban\" se informaba como fracaso: rearmando sobre medios ya importados tiraba \"no entró ninguno\" con los dos en su bin");
} else if (/await it\.getItems\(\)/.test(cuerpoImportar[0])) {
  mal("`importar` recorre el proyecto con `getItems()` a secas en vez de `hijosDe`",
      "un bin de createBinAction no contesta getItems() sin castear a FolderItem: el verbo queda CIEGO adentro de los bins");
} else if (!/for \(let intento = 0; intento < \d+ && faltabanAntes\.some/.test(cuerpoImportar[0])) {
  mal("`importar` lee una sola vez",
      "importFiles vuelve antes de que los medios aparezcan en el panel");
} else if (!/faltan\.length === pedidos\.length/.test(cuerpoImportar[0])) {
  mal("`importar` tira error aunque algunos pedidos SÍ estén",
      "sólo es un fallo cuando no está ninguno");
} else if (!/const porImportar = rutas\.filter/.test(cuerpoImportar[0]) || !/importFiles\(porImportar/.test(cuerpoImportar[0])) {
  mal("`importar` le pide a Premiere archivos que ya están en el proyecto",
      "importFiles NO deduplica: crea otro ProjectItem del mismo archivo, y no rompe nada visible así que pasa desapercibido");
} else {
  ok("`importar` decide por archivo, reintenta, y no repide lo que ya está");
}

/*
 * La guarda `secuencia` va en el DESPACHADOR, no verbo por verbo.
 *
 * Casi todos los verbos operan sobre "la activa" y no reciben cuál: en un script
 * eso es una trampa, porque la activa puede cambiar sola si algo falla a mitad.
 * Pasó el 2026-08-17 y tres verbos le escribieron a la secuencia equivocada.
 * Ponerla en cada verbo sería olvidarla justo en el que duele, así que se chequea
 * que esté en `ejecutar` y que RECHACE en vez de cambiar la activa —cambiarla
 * movería la interfaz del usuario sin que lo pida.
 */
const cuerpoEjec = srcComandos.match(/async function ejecutar[\s\S]*?\n\}/);
if (!cuerpoEjec) {
  mal("no se encontró `ejecutar` para revisarlo");
} else if (!/p\.secuencia/.test(cuerpoEjec[0])) {
  mal("el despachador no tiene la guarda `secuencia`",
      "sin ella un script no puede exigir sobre qué secuencia opera, y la activa puede cambiar sola");
} else if (/setActiveSequence/.test(cuerpoEjec[0])) {
  mal("la guarda `secuencia` CAMBIA la secuencia activa en vez de rechazar",
      "mover la interfaz del usuario sin que lo pida es otra sorpresa, no la solución");
} else if (!/No se ejecutó nada/.test(cuerpoEjec[0])) {
  mal("la guarda `secuencia` no deja claro que no se ejecutó nada");
} else {
  ok("el despachador rechaza si la secuencia activa no es la pedida");
}

/*
 * Ninguna llamada a `createOverwriteItemAction` puede pasar -1 como cuarto
 * argumento: ES LA PISTA DE AUDIO, y con -1 el audio cae siempre en A1 y PISA lo
 * que haya, porque el overwrite no solapa sino que borra. Insertando en V3 el
 * audio se comía A1 sin decirlo, y `revisar` no lo ve —a un clip acortado no le
 * queda hueco ni solape—. Se exige el índice explícito aunque sea 0.
 */
/*
 * PARENTESIS BALANCEADOS, no regex. La version vieja usaba `[^)]*?` para los
 * argumentos, y `[^)]` NO puede atravesar el parentesis de cierre de una llamada
 * anidada: `createOverwriteItemAction(item, aTick(...), pista, -1)` le quedaba
 * INVISIBLE. Verificado por mutacion el 2026-09-10: con el -1 puesto a mano en
 * `insertar`, test.js contestaba "ok ninguna llamada manda el audio a A1 con -1"
 * y "todo ok".
 *
 * O sea que la guarda protegia el unico sitio SIN anidados —`cortar`— y dejaba
 * libres `insertar` y `armarSecuencia`, que es donde CLAUDE.md registro que los
 * quince audios de las capas se comieron 2,4s de A1 cada uno. La guarda contra el
 * error imaginado dejando pasar el real, otra vez.
 */
{
  /* Argumentos de nivel superior de cada llamada, respetando anidados. */
  function argsDe(src, fn) {
    const out = [];
    let i = 0;
    while ((i = src.indexOf(fn + "(", i)) !== -1) {
      let j = i + fn.length + 1, prof = 1, arg = "", args = [];
      while (j < src.length && prof > 0) {
        const ch = src[j];
        if (ch === "(") prof++;
        else if (ch === ")") { prof--; if (!prof) break; }
        if (prof === 1 && ch === ",") { args.push(arg.trim()); arg = ""; }
        else arg += ch;
        j++;
      }
      args.push(arg.trim());
      out.push({ args: args, en: i });
      i = j;
    }
    return out;
  }
  const llamadas = argsDe(srcComandos, "createOverwriteItemAction");
  const malas = llamadas.filter((c) => /^-\s*1$/.test(c.args[3] || ""));
  if (!llamadas.length) {
    mal("no encuentro ninguna llamada a createOverwriteItemAction",
        "el lector de argumentos no esta viendo nada: el chequeo no cubre nada.");
  } else if (malas.length) {
    mal(`${malas.length} de ${llamadas.length} llamada(s) a createOverwriteItemAction pasan -1 como pista de audio`,
        "el audio cae en A1 y pisa lo que haya; poné el índice explícito");
  } else {
    ok(`ninguna de las ${llamadas.length} llamadas manda el audio a A1 con -1`);
  }
}

/*
 * `ubicarClip` NO puede pedir el nombre de todos los items en cada llamada.
 *
 * Lo llaman `editar`, `cortar`, `borrar` y `motion`, y un armado de 138 planos hace tres
 * `editar` por plano. Pidiendo `getName()` por cada item de cada pista, eso daba ~296
 * llamadas a la API por edición y más de 120.000 por tanda — el patrón que este repo tiene
 * medido como causa de crash con el proyecto real abierto.
 *
 * Dos cosas: si vino `pista`, las demás se saltean (ninguna puede matchear), y el nombre se
 * pide sólo cuando hace falta. Verificado reintroduciendo el bug.
 */
{
  const desde = srcComandos.indexOf("async function ubicarClip");
  const cuerpo = srcComandos.slice(desde, srcComandos.indexOf("\n/** La velocidad", desde));
  const salta = /if \(etiquetaPedida && etiquetaPedida !== etiqueta\) continue;/.test(cuerpo);
  // en el bucle de BÚSQUEDA el getName tiene que estar condicionado, no suelto
  const busqueda = cuerpo.slice(0, cuerpo.indexOf("Recién acá se paga"));
  const suelto = /^\s*const nombre = String\(await items\[i\]\.getName\(\)\);\s*$/m.test(busqueda);
  if (!salta) {
    mal("`ubicarClip` no saltea las pistas que no pueden matchear",
      "con `pista` dada recorre todas y pide getName de cada item: miles de llamadas por tanda");
  } else if (suelto) {
    mal("`ubicarClip` pide getName() de todos los items del camino",
      "sólo hace falta para comparar por nombre o para el item encontrado");
  } else {
    ok("`ubicarClip` saltea pistas imposibles y no pide el nombre de todos los items");
  }
}

/*
 * Las comparaciones de NOMBRE tienen que normalizar Unicode.
 *
 * macOS entrega los nombres de archivo en NFD y Premiere en NFC: "á" es "a"+U+0301 en uno
 * y U+00E1 en el otro. Se ven iguales y `===` da false. Medido con
 * "FX3_0490 (Estribillo solo, válida).MP4": `importar` no reconoció que ya estaba y lo
 * DUPLICÓ, e `insertar` dijo "no hay ningún medio que coincida" con el medio en el panel.
 * De 35 archivos, los dos únicos con tilde fueron los dos únicos que fallaron.
 *
 * Se exige que los tres buscadores por nombre usen los helpers y no comparación cruda.
 * Verificado reintroduciendo el bug en cada uno.
 */
{
  const faltan = [];
  for (const [fn, quien] of [["buscarMedio", "buscarMedio"], ["insertar", "insertar"],
                             ["ubicarClip", "ubicarClip"]]) {
    const desde = srcComandos.indexOf("async function " + fn + "(");
    if (desde === -1) { faltan.push(quien + " (no existe)"); continue; }
    const cuerpo = srcComandos.slice(desde, srcComandos.indexOf("\nasync function ", desde + 10));
    const usaHelper = /\b(igualN|contieneN)\s*\(/.test(cuerpo);
    // comparación cruda de nombres: indexOf sobre toLowerCase, o === contra un nombre
    const cruda = /toLowerCase\(\)\.indexOf\(/.test(cuerpo) ||
                  /\bn === nombre\b/.test(cuerpo);
    if (!usaHelper || cruda) faltan.push(quien + (usaHelper ? " (mezcla cruda)" : " (sin helper)"));
  }
  if (!/const norm = /.test(srcComandos) || !/const contieneN = /.test(srcComandos)) {
    mal("no existen los helpers de normalización de nombres",
      "hacen falta `norm` y `contieneN`: sin ellos un nombre con tilde no matchea");
  } else if (faltan.length) {
    mal("hay buscadores por nombre que comparan sin normalizar: " + faltan.join(", "),
      "macOS da NFD y Premiere NFC; un archivo con tilde no se encuentra y se duplica");
  } else {
    ok("los tres buscadores por nombre normalizan Unicode antes de comparar");
  }
}

/*
 * `insertar` tiene que contar la pista de AUDIO, no sólo la de video.
 *
 * Contaba sólo video, y con el .wav del tema contestó "NO SE PUSO NADA" mientras el archivo
 * entraba en A1 —un medio sin video no pone nada en la pista de video—. Es el contador ciego
 * de `cortesDeEscena` en otro verbo: declara un fracaso que no ocurrió, y creerle habría
 * hecho insertar el tema de nuevo y duplicarlo.
 *
 * Se chequea que el cuerpo lea la pista de audio y que el "no se puso nada" dependa de las
 * dos. Verificado reintroduciendo el bug: el chequeo falla.
 */
{
  const desde = srcComandos.indexOf("async function insertar");
  const cuerpo = srcComandos.slice(desde, srcComandos.indexOf("\nasync function ", desde + 10));
  const leeAudio = /getAudioTrack\s*\(\s*pistaAudio\s*\)/.test(cuerpo);
  /*
   * Se chequea la PROPIEDAD, no la expresion. La version vieja exigia el literal
   * `!puesto.length && !puestoA.length`, y cuando el veredicto se mejoro para salir
   * del CONTEO esta guarda fallo sobre codigo correcto — una guarda que codifica una
   * implementacion en vez de una propiedad rechaza justamente las mejoras.
   */
  const defEntro = (cuerpo.match(/const entro\s*=([^;]*);/) || [, ""])[1];
  const defNada = (cuerpo.match(/const nadaEnNingunLado\s*=([^;]*);/) || [, ""])[1];
  const junto = defEntro + " " + defNada;
  const miraAudio = /audioPuesto|crecioA|puestoA/.test(junto);
  const miraVideo = /crecioV|items\.length|puesto\b/.test(junto);
  /* Y que salga del CONTEO: "hay un clip en ese segundo" contaba como recien puesto
     un clip PREEXISTENTE, y el que lo leyera seguia editando el clip del usuario. */
  const porConteo = /crecioV|crecioA/.test(junto);

  if (!leeAudio) {
    mal("`insertar` no lee la pista de audio",
      "cuenta sólo la de video, y con un medio sin video informa \"NO SE PUSO NADA\" habiendo puesto");
  } else if (!(miraAudio && miraVideo)) {
    mal("el \"no se puso nada\" de `insertar` no mira las dos pistas",
      "tiene que exigir que no haya entrado ni en video ni en audio");
  } else if (!porConteo) {
    mal("`entro` de `insertar` no sale del CONTEO",
      "mirar solo si hay un clip en ese segundo cuenta como recien puesto uno que YA estaba, "
      + "y quien lo lea sigue recortando y moviendo el clip del usuario.");
  } else {
    ok("`insertar` mira las dos pistas y su veredicto sale del conteo, no del segundo");
  }

  /*
   * Y el PISO de `pistaAudio`. La guarda vieja de "ninguna llamada manda el audio a A1
   * con -1" es una regex sobre el fuente: agarra el -1 literal que escribe un programador,
   * NO el -1 CALCULADO en runtime por `params.pistaAudio - 1` con 0. Es la guarda contra
   * el error imaginado dejando pasar el real, y el real esta medido: el 2026-09-10, con
   * `pistaAudio: 0`, el audio aparecio en A1 mientras el resumen decia "A0 fuera de rango".
   *
   * El TECHO no se exige a proposito: pedir una pista que no existe la CREA, y eso se usa.
   */
  if (!/params\.pistaAudio\s*<\s*1/.test(cuerpo) || !/throw new Error/.test(cuerpo.slice(cuerpo.search(/params\.pistaAudio\s*<\s*1/)))) {
    mal("`insertar` no tiene PISO en `pistaAudio`",
      "con 0 el indice queda en -1 y el audio cae en A1 PISANDO lo que haya, mientras el resumen "
      + "dice \"A0 fuera de rango\". En un proyecto real ahi vive el tema.");
  } else {
    ok("`pistaAudio` tiene piso: 0 o menos rebota en vez de tirar el audio en A1");
  }
}

/*
 * El bucle de sondeo de `importarTranscripcion` committea ~10 transacciones para
 * encontrar la firma, y encadenar transacciones tira Premiere con SIGSEGV: 200ms
 * lo tira, 1200ms no. Sin pausa esa sonda es el peor caso del patrón —diez en
 * menos de un segundo— sobre el proyecto real del usuario. Verificado sacando el
 * await: el chequeo falla.
 */
{
  const desde = srcComandos.indexOf("async function importarTranscripcion");
  const cuerpo = srcComandos.slice(desde, srcComandos.indexOf("\nasync function ", desde + 10));
  // El bucle se llama `aProbar` desde que existe `soloDiagnostico`: se busca el
  // `for` que recorre las formas, sin atarse al nombre de la lista.
  const loop = cuerpo.slice(/for \(const \[nombre, fn\] of \w+\)/.exec(cuerpo) ? cuerpo.search(/for \(const \[nombre, fn\] of \w+\)/) : cuerpo.length);
  const m = /await esperar\(\s*(\d+)/.exec(loop.slice(0, 500));
  if (!m) {
    mal("el bucle de importarTranscripcion no espacia las transacciones",
        "una ráfaga de ~10 transacciones tira Premiere (SIGSEGV); poné una pausa entre intentos");
  } else if (Number(m[1]) < 1200) {
    mal(`el bucle de importarTranscripcion espacia ${m[1]}ms`,
        "el mínimo medido que no crashea es 1200ms");
  } else {
    ok(`el bucle de importarTranscripcion espacia ${m[1]}ms entre transacciones`);
  }
}

/*
 * `etiquetar` no puede ESCRIBIR sin objetivo. Sin `medios`, el recorrido junta todo
 * el panel de proyecto —secuencias y capas de ajuste tienen etiqueta también— así que
 * un {color} suelto repinta el proyecto entero y borra el código de colores del
 * usuario. Verificado sacando la guarda.
 */
{
  const desde = srcComandos.indexOf("async function etiquetar");
  const cuerpo = srcComandos.slice(desde, srcComandos.indexOf("\nasync function ", desde + 10));
  if (!/params\.color !== undefined[\s\S]{0,80}!pedidos/.test(cuerpo)) {
    mal("etiquetar puede escribir sin objetivo",
        "sin `medios` etiquetaría todo el panel, secuencias incluidas");
  } else {
    ok("etiquetar exige objetivo para escribir");
  }
}

/*
 * Ningún verbo puede referenciar una variable que no declara.
 *
 * Existe porque un reemplazo de texto para `cortesDeEscena` matcheó también en
 * `renombrar` y le dejó un `marcadoresPorLugar: desglose` con `desglose` inexistente:
 * un ReferenceError en tiempo de ejecución que `node --check` NO agarra, en un verbo
 * que venía andando y que nadie iba a volver a probar. Se buscan los nombres del
 * objeto que devuelve cada verbo contra lo que ese verbo declara.
 */
{
  const nombres = [...srcComandos.matchAll(/^async function ([a-zA-Z]+)\(params\)/gm)].map((m) => m[1]);
  const sospechosos = [];
  for (const n of nombres) {
    const i = srcComandos.indexOf("async function " + n + "(params)");
    /* El corte va al PRÓXIMO `function` de cualquier tipo, no sólo `async`: cortando
     * sólo en async, el cuerpo se comía las funciones sync que vinieran después. */
    const candidatos = [srcComandos.indexOf("\nasync function ", i + 10), srcComandos.indexOf("\nfunction ", i + 10)]
      .filter((x) => x !== -1);
    const j = candidatos.length ? Math.min(...candidatos) : srcComandos.length;
    /* Y SE SACAN LOS COMENTARIOS. Sin esto la regex lee prosa: "NO los incluye:
     * probado," y "escala, posición" salieron como referencias inexistentes. */
    const cuerpo = srcComandos.slice(i, j)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Valores de shorthand en los return: `clave: valor` con valor identificador pelado.
    const LITERALES = ["true", "false", "null", "undefined"];
    /* Se lee el bloque `return {` COMPLETO, no línea por línea: la primera versión
     * pedía un par por línea y el bug real estaba en una línea con cuatro
     * --"antes: antes, despues: despues, marcadoresPorLugar: desglose, quedo: quedo"--
     * así que el chequeo pasaba en verde con el defecto puesto. */
    const ret = cuerpo.lastIndexOf("return {");
    const bloque = ret === -1 ? "" : cuerpo.slice(ret);
    const usados = new Set([...bloque.matchAll(/[a-zA-Z]+:\s*([a-z][a-zA-Z]*)\s*[,}]/g)]
      .map((m) => m[1]).filter((v) => LITERALES.indexOf(v) === -1));
    for (const v of usados) {
      const declarado = new RegExp("(const|let|var)\\s+(\\{[^}]*\\b" + v + "\\b[^}]*\\}|" + v + "\\b)").test(cuerpo)
        || new RegExp("\\b" + v + "\\s*=").test(cuerpo)
        || new RegExp("function\\s+" + v + "\\b").test(srcComandos)
        // COLUMNA CERO. Sin esto vale cualquier `const` declarado DENTRO de una función
        // anterior, y así el chequeo pasaba con el bug puesto: `desglose` existe en
        // `cortesDeEscena`, que está antes que `renombrar` en el archivo. La guarda contra
        // el error imaginado dejaba pasar el real, otra vez.
        || new RegExp("^const\\s+" + v + "\\b", "m").test(srcComandos);
      if (!declarado) sospechosos.push(n + " usa \"" + v + "\"");
    }
  }
  if (sospechosos.length) {
    mal(`${sospechosos.length} referencia(s) a variables que no existen`, sospechosos.slice(0, 6).join(" · "));
  } else {
    ok("ningún verbo referencia variables que no declara");
  }
}

/*
 * `radiografia` no puede tener un CATCH VACÍO, y tiene que exigir objetivo.
 *
 * El verbo existe por un catch vacío: buscando "Lumetri" cuando el efecto se llama
 * "Lumetri Color", 45 lecturas de param fallaron, el catch se comió los 45 errores, y yo
 * informé "nada distinto del default" habiendo leído CERO. Casi se perdieron tres
 * correcciones de exposición del usuario. Un verbo cuyo trabajo es decir qué hay no puede
 * tragarse el error que le impidió mirar.
 *
 * Y tiene que exigir `pista`: sin objetivo recorrería 30 pistas, que es justo la ráfaga de
 * lecturas que ya tiró Premiere con SIGBUS.
 *
 * Verificado haciendo fallar las dos ramas: vaciando el catch y sacando el throw.
 */
{
  const desde = srcComandos.indexOf("async function radiografia(");
  if (desde === -1) {
    mal("no existe `radiografia`", "es el verbo que lee qué trabajo manual se perdería al reconstruir");
  } else {
    const fin = srcComandos.indexOf("\nconst VERBOS", desde);
    const cuerpo = srcComandos.slice(desde, fin === -1 ? srcComandos.length : fin);
    const problemas = [];
    // Un catch que no hace NADA con el error. El de `isDisabled` es a propósito y lleva
    // comentario, así que se permite exactamente el que tiene un comentario adentro.
    const catches = cuerpo.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/g) || [];
    for (const c of catches) {
      const adentro = c.slice(c.indexOf("{") + 1, -1).trim();
      if (adentro === "" ) problemas.push("hay un catch completamente vacío");
    }
    // El error tiene que quedar registrado en la fila, no sólo no tirar.
    if (!/fila\.error\s*=/.test(cuerpo)) problemas.push("el error de lectura no se guarda en la fila");
    if (!/tocado\.push\("NO SE PUDO LEER/.test(cuerpo)) problemas.push("un clip ilegible no se marca como NO intacto");
    if (!/throw new Error\([^)]*Falta `pista`/.test(cuerpo)) problemas.push("no exige `pista`: barrería la secuencia entera");
    if (problemas.length) {
      mal("`radiografia` puede mentir: " + problemas.join(" · "),
        "un verbo que informa qué hay no puede tragarse el error que le impidió mirar");
    } else {
      ok("`radiografia` informa sus errores de lectura y exige objetivo");
    }
  }
}

/*
 * `radiografia` NO puede volver a leer params, y nadie puede pedírselo.
 *
 * La opción `conParams` existió, se acotó cuatro veces y tiró Premiere TRES, siempre con el
 * mismo stack: `AsyncScriptTaskQueue::ProcessPromise` -> `NAPIContextAdapter::CallCallback`,
 * categoría PromiseFulfillment, sobre un `IntrusivePtr<AnonObject>`. La última corrida leía
 * 120 params en 3 llamadas, cuando `leerEscalas` hace 176 en UNA y nunca se cayó — así que
 * ningún umbral lo explica y no hay una quinta mitigación que valga la pena probar.
 *
 * Se chequean las dos direcciones: que el verbo rechace el parámetro, y que las herramientas
 * de afuera no se lo manden. Verificado haciendo fallar las dos ramas.
 */
{
  const problemas = [];
  const desde = srcComandos.indexOf("async function radiografia(");
  if (desde === -1) problemas.push("no existe `radiografia`");
  else {
    const fin = srcComandos.indexOf("\nconst VERBOS", desde);
    const cuerpo = srcComandos.slice(desde, fin === -1 ? srcComandos.length : fin);
    if (!/params\.conParams !== undefined/.test(cuerpo) || !/throw new Error/.test(cuerpo)) {
      problemas.push("no rechaza `conParams` (ignorarlo en silencio es peor: el llamador cree que lo aplicó)");
    }
    if (/await\s+valorEnTiempo/.test(cuerpo)) problemas.push("volvió a leer valores de param con await");
  }
  const q = fs.readFileSync(path.join(__dirname, "herramientas", "quirurgico.js"), "utf8");
  // en el código, no en los comentarios que explican por qué no
  const lineasCodigo = q.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l));
  if (lineasCodigo.some((l) => /conParams/.test(l))) {
    problemas.push("`quirurgico.js` todavía le manda `conParams` a radiografia");
  }
  if (problemas.length) {
    mal("radiografia puede volver a leer params: " + problemas.join(" · "),
      "tres crashes con el mismo stack; los valores van por `leerEscalas`, `leerParam` o `param`");
  } else {
    ok("`radiografia` rechaza `conParams` y nadie se lo manda");
  }
}

/*
 * `agregarEfecto` opera sobre el clip SELECCIONADO, así que quien lo llame tiene que
 * seleccionar primero.
 *
 * Usa `exigirClip(sequence)` e IGNORA `pista` e `indice`. `quirurgico.js` lo llamaba con
 * pista+indice, así que le habría puesto el efecto al clip que estuviera seleccionado e
 * informado éxito — el daño silencioso del peor tipo, y en un verbo cuyo trabajo es
 * justamente no perder el trabajo del usuario. Encontrado en el proyecto de prueba.
 *
 * Se exige que `quirurgico.js` seleccione antes y que compare el clip devuelto contra el
 * pedido. Verificado haciendo fallar las dos ramas.
 */
{
  const q = fs.readFileSync(path.join(__dirname, "herramientas", "quirurgico.js"), "utf8");
  const problemas = [];
  const i = q.indexOf('a.verbo === "agregarEfecto"');
  if (i === -1) problemas.push("no trata `agregarEfecto` aparte de los otros verbos");
  else {
    const bloque = q.slice(i, i + 1800);
    if (!/enviar\("seleccionar"/.test(bloque)) problemas.push("no selecciona el clip antes");
    if (!/norm\(donde\)\s*!==\s*norm\(/.test(bloque)) problemas.push("no comprueba en qué clip cayó el efecto");
  }
  // y que el verbo del panel siga siendo el que opera sobre la selección: si algún día acepta
  // pista+indice, este chequeo sobra y hay que sacarlo a propósito, no dejarlo mintiendo.
  const ae = srcComandos.indexOf("async function agregarEfecto(");
  if (ae !== -1) {
    const cuerpo = srcComandos.slice(ae, srcComandos.indexOf("\nasync function ", ae + 10));
    if (!/exigirClip\(/.test(cuerpo)) {
      problemas.push("`agregarEfecto` ya no usa exigirClip: revisá si este chequeo sigue haciendo falta");
    }
  }
  if (problemas.length) {
    mal("quien llama a `agregarEfecto` puede pegarle al clip equivocado: " + problemas.join(" · "),
      "el verbo opera sobre la SELECCIÓN e ignora pista/indice, y no tirar no prueba nada");
  } else {
    ok("`quirurgico.js` selecciona antes de `agregarEfecto` y verifica dónde cayó");
  }
}

/*
 * Tiene que existir una guarda de PROYECTO, y tiene que ir ANTES de la de secuencia.
 *
 * El bridge opera sobre el proyecto que tiene foco, y ningún verbo dice cuál es. El 2026-08-22
 * el foco cambió al proyecto de prueba y se interrogaron `medios` y `bins` creyendo que
 * contestaban sobre otro. Fueron lecturas; un `borrar` con la misma confusión habría barrido el
 * timeline equivocado sin un solo aviso.
 *
 * El orden importa: dos proyectos pueden tener una secuencia con el mismo nombre, así que la
 * guarda de secuencia sola no alcanza. Verificado invirtiendo el orden y quitando la guarda.
 */
{
  const problemas = [];
  const iP = srcComandos.indexOf("p.proyecto === \"string\"");
  const iS = srcComandos.indexOf("p.secuencia === \"string\"");
  if (iP === -1) problemas.push("no existe la guarda de `proyecto` en el despachador");
  else if (iS !== -1 && iP > iS) problemas.push("la guarda de proyecto va DESPUÉS de la de secuencia");
  if (iP !== -1) {
    const bloque = srcComandos.slice(iP, iP + 900);
    if (!/throw new Error/.test(bloque)) problemas.push("la guarda de proyecto no rechaza");
    if (!/NO se ejecutó nada/.test(bloque)) problemas.push("no dice que no ejecutó nada");
  }
  // y que `estado` diga en qué proyecto estás: es el verbo de orientación
  const iE = srcComandos.indexOf("async function estado(");
  if (iE !== -1) {
    const cuerpo = srcComandos.slice(iE, srcComandos.indexOf("\nasync function ", iE + 10));
    if (!/proyectoNombre/.test(cuerpo)) problemas.push("`estado` no expone el nombre del proyecto");
    if (!/\[\$\{info\.proyectoNombre/.test(cuerpo)) problemas.push("`estado` no lo pone en el RESUMEN, que es lo único que se lee");
  }
  if (problemas.length) {
    mal("falta la guarda de proyecto: " + problemas.join(" · "),
      "el bridge opera sobre el proyecto con foco y nada dice cuál es");
  } else {
    ok("hay guarda de `proyecto`, va antes que la de secuencia, y `estado` dice dónde estás");
  }
}

/*
 * Ningún verbo NUEVO puede barrer una pista leyendo params sin tope.
 *
 * Leer params en volumen dentro de una sola llamada es el patrón que tiró Premiere tres veces
 * (PromiseFulfillment en NAPIContextAdapter). Los tres puntos medidos: 1 lectura por llamada
 * nunca falló, ~176 corrió seis vueltas sin caerse, ~560 se cayó dos de dos.
 *
 * Este chequeo NO exige tope en los que ya existen —`escalaFija` es del flujo del curso, anda,
 * y a la escala real hace 20 a 90 lecturas, muy por debajo de 176; tocar un verbo estable por
 * un riesgo que no se materializa es el error más caro de este repo—. Lo que hace es AVISAR si
 * aparece uno nuevo, y para eso los conocidos van declarados con su razón.
 */
{
  const CONOCIDOS = {
    // Sin tope y se deja así: 1 lectura por clip, y las pistas reales tienen 20-90 clips.
    escalaFija: "flujo del curso, 1 lectura por clip, escala real muy por debajo del umbral",
    // Con tope y `siguiente`, y nadie los llama sin límite.
    leerEscalas: "tiene limite y siguiente; quirurgico lo llama con limite 25 (50 lecturas)",
    aplicarZooms: "tiene limite y siguiente",
    // Leen de a poco, no barren la pista.
    cortar: "2 lecturas por corte, sobre un clip",
    fijar: "2 lecturas, sobre un clip",
    param: "1 lectura",
    leerParam: "1 por clip, con tope duro de 60",
    motion: "1 lectura, sobre el clip seleccionado",
    desactivar: "1 lectura",
    firmaMotion: "2 lecturas, helper de revisar",
    // 1 lectura, y sobre UN keyframe: mueve uno por llamada a proposito.
    moverKeyframe: "1 lectura, el valor del keyframe que se mueve; un keyframe por llamada",
    // 2 lecturas del MISMO param, una en cada lado, y un componente por llamada.
    copiarEfecto: "2 lecturas: el testigo en origen y en destino; un componente por llamada"
  };
  const nuevos = [];
  const re = /\nasync function (\w+)\(/g;
  let m;
  while ((m = re.exec(srcComandos))) {
    const v = m[1];
    const i = srcComandos.indexOf(`async function ${v}(`);
    const j = srcComandos.indexOf("\nasync function ", i + 10);
    const c = srcComandos.slice(i, j > 0 ? j : srcComandos.length);
    if (!/await\s+valorEnTiempo/.test(c)) continue;
    if (CONOCIDOS[v]) continue;
    nuevos.push(v);
  }
  if (nuevos.length) {
    mal("verbo(s) nuevo(s) que leen params y no están declarados: " + nuevos.join(", "),
      "leer params en volumen en una llamada tiró Premiere 3 veces; declaralo en CONOCIDOS " +
      "con su razón, o ponele `limite` y `siguiente`");
  } else {
    ok(`los ${Object.keys(CONOCIDOS).length} verbos que leen params están declarados con su cota`);
  }
}

/* ---------- las anotaciones de `desde_secuencia.js` ---------- */

titulo("desde_secuencia: las anotaciones se copian por EXCLUSIÓN");

/*
 * Copiaba las anotaciones con una lista BLANCA de siete nombres, y funcionaba sólo en el
 * proyecto donde se escribió: las propuestas de un corporativo anotan `bloque`, `grupo`, `texto` y
 * `porQue`, y las cuatro se caían en silencio. Ahora copia todo lo que no calcula ella misma.
 *
 * Y el riesgo de invertir la lógica es peor que el bug que arregla: si `desde`, `dura` o
 * `entrada` no estuvieran excluidos, los tiempos de la propuesta VIEJA le ganarían a la
 * secuencia, que es lo contrario de para lo que existe la herramienta. Eso es lo que se exige
 * acá, no la estética del bucle.
 */
{
  const src = fs.readFileSync(path.join(raiz, "herramientas/desde_secuencia.js"), "utf8");
  const m = src.match(/const CALCULADOS = new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    mal("`desde_secuencia.js` no declara `CALCULADOS`",
      "las anotaciones tienen que copiarse por exclusión; una lista blanca deja caer en " +
      "silencio las anotaciones de cualquier proyecto que use otros nombres");
  } else {
    const excluidos = m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const criticos = ["desde", "dura", "entrada"];
    const faltan = criticos.filter((c) => !excluidos.includes(c));
    if (faltan.length) {
      mal("`CALCULADOS` no excluye " + faltan.join(", "),
        "si un tiempo de la propuesta vieja se copia, le gana a la secuencia y la herramienta " +
        "deshace la edición del usuario en vez de tomarla como punto de partida");
    } else if (/for \(const campo of \[/.test(src)) {
      mal("`desde_secuencia.js` volvió a copiar anotaciones desde una lista literal",
        "tiene que ser `Object.keys(v)` filtrado por `CALCULADOS`");
    } else if (!/Object\.keys\(v\)/.test(src) || !/CALCULADOS\.has\(campo\)/.test(src)) {
      mal("`desde_secuencia.js` no copia las anotaciones por exclusión",
        "se espera `Object.keys(v)` filtrado con `CALCULADOS.has(campo)`");
    } else {
      ok("las anotaciones se copian por exclusión y los tres tiempos están excluidos",
        excluidos.length + " campos calculados");
    }
  }
}

/* ---------- desde_secuencia: la lista vieja, y el fallo vacio ---------- */

titulo("desde_secuencia: encontrar la propuesta vieja, o FALLAR");

/*
 * Leía sólo `P.planos`, que es la clave que escribe ella misma. Las propuestas de un corporativo la
 * traen bajo `fragmentos`, así que `viejos` quedó vacío y los 65 planos de los tres videos
 * salieron marcados `nuevo`, sin una sola anotación. No falló ruidosamente: escribió tres
 * archivos VÁLIDOS y vacíos de contenido, y lo único que lo agarró fue contar las anotaciones
 * en la salida.
 *
 * Dos cosas, y la segunda importa más que la primera: que busque la lista bajo varios nombres,
 * y que si el archivo existe y no le saca ni un plano, SALGA CON ERROR. Un emparejamiento con
 * cero candidatos no es "todo es nuevo", es no haber podido hacer el trabajo.
 */
{
  const src = fs.readFileSync(path.join(raiz, "herramientas/desde_secuencia.js"), "utf8");
  const lee = /P\.planos \|\| P\.fragmentos \|\| P\.clips/.test(src);
  const sale = /!viejos\.length[\s\S]{0,600}?process\.exit\(1\)/.test(src);
  if (!lee) {
    mal("`desde_secuencia.js` busca la lista vieja bajo un solo nombre",
      "las propuestas no usan todas la misma clave; con la equivocada `viejos` queda vacío y " +
      "TODO sale marcado `nuevo` sin anotaciones, en silencio");
  } else if (!sale) {
    mal("`desde_secuencia.js` no falla cuando la propuesta vieja queda vacía",
      "seguir escribe una salida plausible y sin una sola anotación; ya pasó con 65 planos");
  } else {
    ok("busca la lista vieja bajo varios nombres y sale con error si queda vacía");
  }
}

/* ---------- comparar_corte: el caso que encontro el bug ---------- */

titulo("comparar_corte encuentra las cinco ediciones, y ni una mas");

/*
 * La primera version emparejaba por nombre + numero de aparicion y, sobre un corte donde un
 * mismo medio se usa cinco veces, mover UN clip renumero todas sus apariciones: informo 5
 * recortes donde habia 1, 5 cambios de in-point donde habia 1, y un clip movido "del 6o al 6o".
 * El emparejamiento por aparicion es CIRCULAR — el numero depende del orden y el orden es lo
 * que se quiere medir.
 *
 * Esa prueba se corrio a mano y no quedaba guardada, asi que un cambio en el emparejamiento no
 * tenia nada que lo agarre. Aca se construye el caso: un nombre repetido cinco veces, y encima
 * las cinco ediciones posibles. Se exige EXACTAMENTE una de cada una — la regresion no se ve
 * como un cero, se ve como cinco.
 */
{
  const H = path.join(raiz, "herramientas/comparar_corte.js");
  if (!fs.existsSync(H)) {
    mal("falta `herramientas/comparar_corte.js`");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmpcorte-"));
    const REP = "repetido.mp4";                 // el que se usa cinco veces
    /* La propuesta: 8 planos, cinco del mismo medio con in-points DISTINTOS —que es lo que da
     * identidad a cada instancia— y tres de medios sueltos. */
    const frag = [
      { clip: REP,       entrada: 10, dura: 4 },
      { clip: "a.mp4",   entrada: 0,  dura: 5 },
      { clip: REP,       entrada: 40, dura: 6 },
      { clip: "b.mp4",   entrada: 3,  dura: 3 },
      { clip: REP,       entrada: 70, dura: 4 },
      { clip: REP,       entrada: 95, dura: 5 },
      { clip: "c.mp4",   entrada: 8,  dura: 7 },
      { clip: REP,       entrada: 120, dura: 3 },
    ];
    fs.writeFileSync(path.join(dir, "prop.json"), JSON.stringify({ fragmentos: frag }));

    /* El timeline: las CINCO ediciones, cada una una sola vez.
     *   borrar   -> se saca "b.mp4"
     *   mover    -> el ultimo REP (entrada 120) pasa al puesto 2
     *   recortar -> "c.mp4" pierde 1,40s
     *   in-point -> el REP de entrada 40 pasa a 42,60
     *   agregar  -> entra "nuevo.mp4" al final                                              */
    let t = frag.filter((x) => x.clip !== "b.mp4").map((x) => ({ ...x }));
    const mov = t.pop();                                  // el REP de entrada 120
    t.splice(1, 0, mov);
    t.find((x) => x.clip === "c.mp4").dura -= 1.4;
    t.find((x) => x.clip === REP && x.entrada === 40).entrada = 42.6;
    t.push({ clip: "nuevo.mp4", entrada: 0, dura: 2 });
    let pos = 0;
    const clips = t.map((x) => {
      const c = { nombre: x.clip, pista: "V1", desde: pos, hasta: pos + x.dura, entrada: x.entrada, velocidad: 1 };
      pos += x.dura;
      return c;
    });
    fs.writeFileSync(path.join(dir, "est.json"), JSON.stringify({ clips }));

    let inf = null, err = null;
    try {
      inf = JSON.parse(execFileSync(process.execPath,
        [H, "--propuesta", path.join(dir, "prop.json"), "--estado", path.join(dir, "est.json"), "--json"],
        { encoding: "utf8" }));
    } catch (e) { err = String(e.stderr || e.message).trim(); }

    if (!inf) {
      mal("`comparar_corte.js` no corrio sobre el caso construido", err);
    } else {
      const c = {
        borrados: inf.borrados.length, agregados: inf.agregados.length,
        movidos: inf.movidos.length, recortados: inf.recortados.length,
        inPoint: inf.inPointCambiado.length,
      };
      const esperado = { borrados: 1, agregados: 1, movidos: 1, recortados: 1, inPoint: 1 };
      const mal_ = Object.keys(esperado).filter((k) => c[k] !== esperado[k]);
      if (mal_.length) {
        mal("`comparar_corte.js` no encuentra exactamente una de cada edicion: " +
            mal_.map((k) => k + " " + c[k] + " (esperado 1)").join(", "),
          "si recortados y inPoint dan 4 o 5, volvio a emparejar por numero de aparicion: " +
          "mover un clip renumera todas las apariciones de su nombre y el #1 del timeline deja " +
          "de ser el #1 de la propuesta");
      } else {
        ok("las cinco ediciones, una de cada una, sobre un nombre usado cinco veces");
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- locucion.js: la key no se escribe, y el veredicto sale del estado ---------- */

titulo("locucion.js lee la key del entorno, verifica el wav de afuera y relee la colocacion");

/*
 * Cuatro propiedades, y las cuatro son de las que este repo ya pago en otro lado:
 *
 * 1. La key sale de `$ELEVENLABS_API_KEY` y NO se escribe en ningun archivo ni se pasa por
 *    argumento —quedaria en el historial de la shell y en `ps`—.
 * 2. El wav se mide con ffprobe antes de seguir: que la API conteste 200 no dice que el archivo
 *    este completo, y un wav truncado se coloca igual y aparece recien al reproducir.
 * 3. La colocacion manda la guarda `proyecto`, leida del foco si no viene por flag.
 * 4. Y el veredicto de la colocacion sale de RELEER la pista, no del mensaje de `insertar`.
 */
{
  const p = path.join(raiz, "herramientas/locucion.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/locucion.js`", "es la locucion con tiempos por palabra");
  } else {
    const src = fs.readFileSync(p, "utf8");
    const delEntorno = /process\.env\.ELEVENLABS_API_KEY/.test(src);
    // que no la guarde: el JSON de config no puede llevarla
    const noLaGuarda = !/JSON\.stringify\(\{[^}]*KEY/.test(src) && !/voz: VOZ[^}]*KEY/.test(src);
    const mideElWav = /ffprobe[\s\S]{0,200}format=duration[\s\S]{0,400}dur < 0\.1/.test(src);
    const guarda = /proyecto:\s*PROY/.test(src) && /proyectoNombre/.test(src);
    const releeEstado = /enviar\("clips"/.test(src) && /x\.pista === "A" \+ PISTA/.test(src);
    /* El voice changer NO devuelve timestamps, asi que los tiempos solo se pueden reusar si el
     * largo se respeto. La herramienta tiene que COMPARARLO y decirlo, no darlo por sentado:
     * medido delta 0,000s, pero eso es un caso y esto es una guarda. */
    const compараLargo = /durOriginal/.test(src) && /delta < 0\.15/.test(src) &&
                         /NO se pueden ` \+\s*`transferir/.test(src);
    if (!delEntorno || !noLaGuarda) {
      mal("`locucion.js` no toma la key SOLO del entorno",
        "una key en un archivo del proyecto se commitea sola; pasada por argumento queda en el " +
        "historial de la shell y en `ps`");
    } else if (!mideElWav) {
      mal("`locucion.js` no mide el wav de afuera antes de seguir",
        "que la API conteste 200 no dice que el archivo este completo, y un wav truncado se " +
        "coloca igual: el problema aparece recien reproduciendo");
    } else if (!guarda) {
      mal("`locucion.js` coloca sin mandar la guarda `proyecto`",
        "con el foco en otro proyecto le mete la locucion al material equivocado");
    } else if (!releeEstado) {
      mal("`locucion.js` juzga la colocacion por el mensaje y no por el estado",
        "hay que releer la pista y exigir que el clip este donde se pidio y mida lo que mide " +
        "el wav; el mensaje de `insertar` es un dato, no el veredicto");
    } else if (!compараLargo) {
      mal("`locucion.js` no comprueba que el voice changer respete el largo",
        "el voice changer no devuelve timestamps, asi que los tiempos de la grabacion solo " +
        "valen si la conversion no cambio la duracion; hay que compararlo y DECIRLO");
    } else {
      ok("key del entorno, wav medido, guarda de proyecto, colocacion releida y largo comparado");
    }
  }
}

/* ---------- sonido.js: el error viene con la extension del audio ---------- */

titulo("sonido.js detecta el error parseando, mide el wav, copia al lado del proyecto y relee");

/*
 * Cinco propiedades, y la primera es la que costo un falso positivo el mismo dia que se uso:
 *
 * 1. Un error de la API vuelve como JSON en el MISMO cuerpo donde vendria el audio, asi que hay
 *    que detectarlo INTENTANDO PARSEARLO. Buscar un `{` en los primeros bytes da falso positivo:
 *    el PCM crudo tiene ese byte adentro del audio.
 * 2. El wav se mide con ffprobe CONTRA LO PEDIDO. `duration_seconds` se respeta al centesimo, asi
 *    que una diferencia grande no es tolerancia: es un archivo truncado.
 * 3. El archivo se COPIA al lado del proyecto antes de importarlo. Un medio que vive en el
 *    scratchpad deja el proyecto apuntando a algo que se limpia solo — el mismo daño que el proxy
 *    adjuntado a una carpeta temporal, que encima no se puede soltar.
 * 4. La guarda `proyecto`, leida del foco si no viene por flag.
 * 5. Y el veredicto sale de RELEER la pista, no del mensaje de `insertar` — que ademas informa el
 *    conteo VIEJO de pistas cuando crea una.
 */
{
  const p = path.join(raiz, "herramientas/sonido.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/sonido.js`", "es la generacion de efectos de sonido");
  } else {
    const src = fs.readFileSync(p, "utf8");
    const delEntorno = /process\.env\.ELEVENLABS_API_KEY/.test(src) &&
                       !/"-d",\s*[\s\S]{0,80}KEY/.test(src);
    /* La deteccion tiene que PARSEAR, y no puede quedar mirando un caracter suelto. */
    const parsea = /JSON\.parse\(cabeza\)/.test(src) &&
                   !/cabeza\.(startsWith|indexOf)\(\s*["'`]\{/.test(src) &&
                   !/cabeza\[0\]/.test(src);
    const mideContraLoPedido = /ffprobe[\s\S]{0,220}format=duration/.test(src) &&
                               /Math\.abs\(dur - DURA\)/.test(src);
    const copiaAlLado = /copyFileSync/.test(src) &&
                        /copyFileSync[\s\S]{0,200}archivo = nuevo/.test(src) &&
                        src.indexOf("copyFileSync") < src.indexOf('enviar("importar"');
    const guarda = /proyecto:\s*PROY/.test(src) &&
                   /e\.info\s*&&\s*e\.info\.proyectoNombre/.test(src);
    const releeEstado = /enviar\("clips"/.test(src) && /x\.pista === "A" \+ PISTA/.test(src);
    if (!delEntorno) {
      mal("`sonido.js` no toma la key SOLO del entorno",
        "pasada en el cuerpo o por argumento queda en el historial de la shell y en `ps`");
    } else if (!parsea) {
      mal("`sonido.js` no detecta el error de la API parseando el cuerpo",
        "un error vuelve como JSON en el mismo lugar donde vendria el audio, y buscar un `{` en " +
        "los primeros bytes DA FALSO POSITIVO: el PCM crudo tiene ese byte adentro del audio. " +
        "Ya paso una vez");
    } else if (!mideContraLoPedido) {
      mal("`sonido.js` no compara la duracion del wav contra la pedida",
        "`duration_seconds` se respeta al centesimo, asi que una diferencia grande no es " +
        "tolerancia: es un archivo truncado, y truncado se coloca igual");
    } else if (!copiaAlLado) {
      mal("`sonido.js` importa el wav desde donde este, sin copiarlo al lado del proyecto",
        "un medio en una carpeta temporal deja el proyecto apuntando a algo que se limpia solo, " +
        "y Premiere lo marca offline recien al abrirlo la proxima vez");
    } else if (!guarda) {
      mal("`sonido.js` coloca sin mandar la guarda `proyecto` leida del foco",
        "con el foco en otro proyecto le mete el efecto al material equivocado");
    } else if (!releeEstado) {
      mal("`sonido.js` juzga la colocacion por el mensaje y no por el estado",
        "hay que releer la pista: `insertar` informa el conteo VIEJO de pistas cuando crea una, " +
        "asi que su mensaje no distingue un fracaso de una pista nueva");
    } else {
      ok("error parseado, wav medido contra lo pedido, copiado al lado del proyecto, guarda y relectura");
    }
  }
}

/* ---------- proxies.js: el perfil se ELIGE por proyecto y se INFORMA ---------- */

titulo("proxies.js ofrece prores, lo escribe en 10 bits 4:2:2, y dice que perfil uso");

/*
 * Encontrado por el editor GRADUANDO un videoclip: los proxies h264 le cambiaban el verde-magenta en
 * una mano. Y la medicion que yo habia hecho antes NO lo podia ver — compare promedios RGB y
 * percentiles de LUMA, que es justo donde una diferencia de CROMA no aparece.
 *
 * La causa, medida sobre dos clips: el material es LOG —el croma del cuadro entero se mueve
 * dentro de +-2 unidades de 128— y el proxy sale en 8 bits 4:2:0 contra el 10 bits 4:2:2 del
 * original. Sobre una senal de tres unidades el paso de cuantizacion es casi la senal, y
 * graduar la estira treinta veces.
 *
 *     perfil                |dV|    decodificar 3s   disco (132 min)
 *     h264 420 8 bits      0,433       0,14 s           10 GB
 *     ProRes 422 Proxy     0,204       0,18 s           25 GB
 *
 * ProRes gana en las dos cosas y cuesta 2,5x de disco. **Ninguno es el default correcto
 * siempre**: es una decision por proyecto —"donde importa el color, prores; para redes o
 * trabajos chicos, h264"— asi que lo que este chequeo exige no es un valor sino que la
 * eleccion EXISTA, sea explicita y quede en el log.
 */
{
  const p = path.join(raiz, "herramientas/proxies.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/proxies.js`", "es el generador de proxies");
  } else {
    const src4 = fs.readFileSync(p, "utf8");
    const hayPerfil = /opt\(\s*["'`]perfil/.test(src4) && /prores/.test(src4);
    /* Un perfil inventado NO se puede descartar en silencio: es una tanda de dos horas. */
    const rechaza = /PERFIL !== "h264"[\s\S]{0,600}process\.exit\(1\)/.test(src4);
    /* Y el ProRes tiene que pedir 10 bits 4:2:2 EXPLICITO: es lo unico que se compra. */
    const diezBits = /prores_ks[\s\S]{0,160}yuv422p10le/.test(src4);
    /* La extension sigue al codec: un .mp4 con ProRes adentro es la trampa del preset MooV
     * que ya esta anotada en CLAUDE.md, en otra herramienta. */
    const extSigue = /EXT\s*=\s*PERFIL === "prores" \? "mov" : "mp4"/.test(src4) &&
                     /_\$\{MARCA\}\.\$\{EXT\}/.test(src4);
    /* Y se INFORMA: una tanda larga con el perfil equivocado tiene que verse en el log. */
    const informa = /perfil \$\{PERFIL/.test(src4);
    if (!hayPerfil) {
      mal("`proxies.js` no ofrece el perfil ProRes",
        "sobre material LOG el h264 de 8 bits 4:2:0 duplica el error de croma, y eso se ve " +
        "recien al graduar. Lo encontro el editor, no ninguna medicion");
    } else if (!rechaza) {
      mal("`proxies.js` acepta un --perfil inventado en vez de rebotar",
        "una tanda de proxies son horas de maquina: un perfil descartado en silencio se " +
        "descubre cuando ya estan los 116 archivos hechos con el equivocado");
    } else if (!diezBits) {
      mal("`proxies.js` no pide 10 bits 4:2:2 explicito en el perfil prores",
        "es lo UNICO que se compra pagando 2,5x de disco; un ProRes de 8 bits no arregla nada");
    } else if (!extSigue) {
      mal("`proxies.js` no hace que la extension siga al codec",
        "un .mp4 con ProRes adentro es la misma trampa del preset MooV que ya esta anotada " +
        "en CLAUDE.md para `exportar`, cometida en otra herramienta");
    } else if (!informa) {
      mal("`proxies.js` no informa QUE PERFIL uso",
        "ninguno de los dos es el default correcto siempre, asi que una tanda de dos horas " +
        "con el perfil equivocado tiene que ser visible en el log");
    } else {
      ok("ofrece prores en 10 bits 4:2:2, rechaza un perfil inventado, la extension sigue al codec, y lo informa");
    }
  }
}

/* ---------- recargar.js: Premiere bloquea, UDT se ABRE y se TRAE AL FRENTE ---------- */

titulo("recargar.js abre UDT, lo trae al frente y recien ahi dispara el macro");

/*
 * Medido en frio el 2026-09-03, con Premiere y UDT cerrados y el latido de 5 horas.
 *
 * La causa de que "Load Bridge" no anduviera NO era el macro ni el tiempo de arranque de UDT:
 * era EL FOCO. Con UDT al frente en el instante del click, el panel arranco en 1 SEGUNDO.
 *
 * Y se pudo automatizar porque una afirmacion de CLAUDE.md era FALSA: decia que desde aca no se
 * puede traer UDT adelante, con tres metodos "probados". `activate` si funciona — no funciona
 * sobre UDT CERRADO, que es como se habia medido.
 *
 * Tres cosas y ninguna es opcional:
 *   1. Premiere BLOQUEA: el macro no lo abre y sin host no hay nada que cargar.
 *   2. UDT NO bloquea: se ABRE. Rechazar por UDT romperia un flujo que funciona.
 *   3. UDT se trae AL FRENTE antes del macro, que es lo que arreglo el problema real.
 */
{
  const p = path.join(raiz, "herramientas/recargar.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/recargar.js`", "es el que dispara el Load/Reload por Keyboard Maestro");
  } else {
    const src3 = fs.readFileSync(p, "utf8");
    const bloqueaPremiere = /function exigirPremiere\(\)/.test(src3) &&
                            /corriendo\(\s*["'`]Adobe Premiere Pro/.test(src3);
    const abreUDT = /function prepararUDT\(\)/.test(src3) &&
                    /!corriendo\(\s*["'`]UXP Developer[\s\S]{0,200}activate/.test(src3);
    /* LA CLAVE: activate ANTES del macro. Sin esto vuelve el bug real. */
    const iAct = src3.lastIndexOf("Adobe UXP Developer Tools\" to activate");
    const iMacro = src3.indexOf("Keyboard Maestro Engine");
    const activaAntes = iAct !== -1 && iMacro !== -1 && iAct < iMacro;
    const esperaDeclarada = /ESPERA_UDT_MS/.test(src3) && /no es detectable|acceso de asistencia/i.test(src3);
    const usos = (src3.match(/porQueNoAndubo\(\)/g) || []).length;
    if (!bloqueaPremiere) {
      mal("`recargar.js` no bloquea cuando PREMIERE no esta abierto",
        "el panel corre ADENTRO de Premiere y el macro no lo abre: sin host el macro clickea al " +
        "vacio y el informe termina culpando al panel");
    } else if (!abreUDT) {
      mal("`recargar.js` no ABRE UDT cuando falta",
        "rechazar por UDT rompe un flujo que funciona —el macro tambien lo abre— y es el modo de " +
        "fallo mas caro para una guarda. Hay que abrirlo, no exigirlo");
    } else if (!activaAntes) {
      mal("`recargar.js` no trae UDT AL FRENTE antes de disparar el macro",
        "ES LA CAUSA REAL del bug: los macros clickean por IMAGEN, y con UDT al frente el panel " +
        "arranco en 1 segundo. `activate` funciona sobre UDT ya corriendo, aunque CLAUDE.md " +
        "afirmara lo contrario");
    } else if (!esperaDeclarada) {
      mal("`recargar.js` no declara que la espera de UDT es FIJA",
        "no se puede detectar que UDT termino de inicializar: System Events no tiene acceso de " +
        "asistencia. Un numero fijo y dicho es mas honesto que un chequeo que no puede mirar");
    } else if (usos < 3) {
      mal("`recargar.js` informa el porque en un solo camino de fallo",
        "son DOS los caminos que fallan asi, el que CARGA de cero y el que RECARGA");
    } else {
      ok("Premiere bloquea, UDT se abre y se activa antes del macro, y la espera esta declarada");
    }
  }
}

/* ---------- sonido.js: un ambiente que sale MUDO, y el clipping que no era ---------- */

titulo("sonido.js avisa si la generacion salio muda, y no llama clipping a un archivo silencioso");

/*
 * Medido el 2026-09-03 generando un ambiente de calle para un video de cliente. Se pidio
 * "very quiet upscale neighbourhood, no cars, no voices, no footsteps, barely audible" y el
 * modelo tomo los negativos al pie de la letra: salio SILENCIO. Media -70,1 dB, pico -54,6.
 *
 * La API contesta 200, el wav mide el largo pedido al centesimo, y no suena nada. O sea el
 * modo de fallar n1 de CLAUDE.md: la unica forma de agarrarlo es MIRAR EL NIVEL.
 *
 * Y encima el aviso que si aparecio estaba mal: informo "CLIPPEADO (flat 5,1)", porque un
 * archivo casi silencioso es plano por definicion. El flat factor solo no distingue
 * "aplastado contra el techo" de "no hay nada", asi que el clipping tiene que exigir tambien
 * un pico cerca de 0.
 */
{
  const p = path.join(raiz, "herramientas/sonido.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/sonido.js`", "es la generacion de efectos de sonido");
  } else {
    const src2 = fs.readFileSync(p, "utf8");
    const avisaMudo = /media\s*<\s*-5\d/.test(src2) && /MUDO/.test(src2);
    const clipConPico = /flat\s*>\s*5[\s\S]{0,80}pico[\s\S]{0,40}>\s*-1/.test(src2);
    if (!avisaMudo) {
      mal("`sonido.js` no avisa cuando la generacion sale MUDA",
        "pedir un ambiente con muchos negativos —'no cars, no voices, barely audible'— hace que " +
        "el modelo genere SILENCIO. La API contesta 200 y el wav mide el largo exacto, asi que " +
        "sin mirar el nivel se coloca y se descubre reproduciendo");
    } else if (!clipConPico) {
      mal("`sonido.js` llama CLIPPEADO a un archivo por su flat factor sin mirar el pico",
        "un archivo casi silencioso es plano por definicion: dio flat 5,1 con un pico de -54,6 dB " +
        "e informo clipping. El clipping exige flat alto Y pico cerca de 0");
    } else {
      ok("avisa si sale mudo, y el clipping exige flat alto y pico cerca de 0");
    }
  }
}

/* ---------- musica.js: el plan, la cola muda, y un chequeo que medía silencio ---------- */

titulo("musica.js mide la cola, controla contra el azar y no rankea derivadas de borde");

/*
 * Cinco propiedades, y las cinco son deudas de CLAUDE.md cobradas en una herramienta nueva.
 *
 * 1. La key sale del entorno Y VIAJA EN EL HEADER. `sonido.js` la pasa como argumento de `curl`
 *    y ahi queda visible en `ps` mientras dura el pedido; con `fetch` no hay argv que mirar.
 *
 * 2. El wav se mide de afuera en las TRES cosas que fallaron alguna vez: largo, tasa y canales.
 *    Medir solo el largo es lo que dejo pasar el mono cuatro entregas seguidas.
 *
 * 3. LA COLA. El modelo deja mudos los ultimos ~4s de lo que se le pide —medido cinco veces:
 *    4,25 · 4,00 · 4,75 · 2,50 · 3,75s— y el wav igual mide el largo EXACTO. No hay error y no
 *    hay aviso: solo se descubre reproduciendo el final. Si el tool no informa donde muere la
 *    musica, no hay nada que lo agarre.
 *
 * 4. EL CONTROL DE AZAR. Un salto de 3 dB en un limite pedido no significa nada por si solo: la
 *    mediana de 400 limites al azar del mismo archivo es 0,5 a 1,5 dB. Sin ese control, "hay un
 *    salto en los 5s" se lee como que el plan funciono.
 *
 * 5. Y LO QUE NO PUEDE VOLVER: la primera version rankeaba la DERIVADA de energia por ventana e
 *    informo "0 de 3 limites" sobre una musica que si seguia el arco pedido. Sus tres saltos mas
 *    grandes eran la musica arrancando desde silencio y la cola muriendose —artefactos de borde—
 *    asi que los limites reales nunca entraban al ranking. El chequeo exige que la medicion sea
 *    por MEDIA de tramo, no por derivada.
 */
{
  const p = path.join(raiz, "herramientas/musica.js");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/musica.js`", "es la generacion de musica con composition_plan");
  } else {
    const src = fs.readFileSync(p, "utf8");
    /* La key en el header del request, y NUNCA en un argv de curl. */
    const enHeader = /process\.env\.ELEVENLABS_API_KEY/.test(src) &&
                     /"xi-api-key":\s*KEY/.test(src) &&
                     !/"-H",\s*"xi-api-key/.test(src) &&
                     !/execFileSync\("curl"/.test(src);
    const parsea = /JSON\.parse\(buf\.slice\(/.test(src) &&
                   !/buf\.slice\([\s\S]{0,60}(startsWith|indexOf)\(\s*["'`]\{/.test(src);
    /* Las tres cosas, no solo el largo. */
    const mideTres = /Math\.abs\(dur - pedido\)/.test(src) &&
                     /tasa !== 48000/.test(src) && /can !== 2/.test(src);
    /* Donde MUERE la musica: la cola muda no la ve ninguna otra medicion. */
    const informaCola = /viva/.test(src) &&
                        /SE MUERE/.test(src) &&
                        /cola muda/.test(src);
    /* El control de azar, y que la medicion sea por media de tramo y no por derivada. */
    const controlAzar = /nulo/.test(src) && /400/.test(src) && /pct/.test(src);
    const porMedia = /arco\s*=\s*tramos\.map/.test(src) &&
                     !/paso\s*=\s*env\.map/.test(src) &&
                     !/orden\s*=\s*paso/.test(src);
    /* Exactamente uno de prompt / composition_plan: la API lo exige y un pedido ambiguo no se
     * resuelve eligiendo. */
    const unModo = /modos\.length !== 1/.test(src);
    const guarda = /proyecto:\s*PROY/.test(src) &&
                   /e\.info\s*&&\s*e\.info\.proyectoNombre/.test(src);
    const releeEstado = /enviar\("clips"/.test(src) && /x\.pista === "A" \+ PISTA/.test(src);
    if (!enHeader) {
      mal("`musica.js` no manda la key en el header del request",
        "del entorno no alcanza: pasada como argumento de curl queda visible en `ps` mientras " +
        "dura el pedido, que es lo que hace `sonido.js` y convendria cambiarle");
    } else if (!parsea) {
      mal("`musica.js` no detecta el error de la API parseando el cuerpo",
        "un error vuelve como JSON donde vendria el audio, y buscar un `{` en los primeros bytes " +
        "DA FALSO POSITIVO: el PCM crudo tiene ese byte adentro del audio");
    } else if (!mideTres) {
      mal("`musica.js` no mide las tres cosas del wav: largo, tasa y canales",
        "medir solo el largo es lo que dejo pasar el mono cuatro entregas seguidas, y un " +
        "`loudnorm` sin `-ar` escribe a 192 kHz que tambien suena mudo");
    } else if (!informaCola) {
      mal("`musica.js` no informa DONDE MUERE la musica",
        "el modelo deja mudos los ultimos ~4s de lo que se le pide —medido cinco veces— y el wav " +
        "mide el largo EXACTO igual. Sin este informe, pedir 90s entrega 86s de musica y 4 de " +
        "silencio, y eso solo se descubre reproduciendo el final");
    } else if (!controlAzar) {
      mal("`musica.js` informa saltos sin control de azar",
        "la mediana de 400 limites al azar del mismo archivo es 0,5 a 1,5 dB, asi que un salto " +
        "de 3 dB en un limite pedido NO prueba que el plan haya puesto una transicion ahi");
    } else if (!porMedia) {
      mal("`musica.js` mide los tramos por derivada por ventana y no por media",
        "esa version ya existio e informo `0 de 3 limites` sobre una musica que SI seguia el " +
        "arco: sus saltos mas grandes eran la musica arrancando desde silencio y la cola " +
        "muriendose, o sea artefactos de borde, y los limites reales no entraban al ranking");
    } else if (!unModo) {
      mal("`musica.js` no exige exactamente uno de --texto / --pedir-plan / --plan",
        "la API acepta `prompt` o `composition_plan`, no los dos, y un pedido ambiguo no se " +
        "resuelve eligiendo por el tool");
    } else if (!guarda) {
      mal("`musica.js` coloca sin mandar la guarda `proyecto` leida del foco",
        "con el foco en otro proyecto le mete la cama musical al video equivocado");
    } else if (!releeEstado) {
      mal("`musica.js` juzga la colocacion por el mensaje y no por el estado",
        "hay que releer la pista: `insertar` informa el conteo VIEJO de pistas cuando crea una");
    } else {
      ok("key en el header, wav medido en tres ejes, cola informada, azar controlado y medicion por media");
    }
  }
}

/* ---------- el audio que se entrega va a DOS CANALES ---------- */

titulo("locucion.js, sonido.js y musica.js escriben ESTEREO: un wav mono se reproduce mudo");

/*
 * Medido el 2026-09-02, y costo cuatro entregas. Un wav —o un aac— MONO se reproduce MUDO en el
 * visor del usuario. No hay error de ninguna de las dos partes: el archivo esta bien, tiene voz
 * de punta a punta y transcribe el guion; simplemente no suena. `afinfo` lo delata con un
 * `afinfo` lo delata con un "1 ch" — y OJO, no con el "no channel layout" de la linea de
 * abajo, que un estereo que funciona tambien informa. Medido el 2026-09-03.
 *
 * Lo peor fue el diagnostico: se atribuyo primero a la tasa de muestreo —que TAMBIEN estaba mal,
 * ver la nota del `loudnorm` en CLAUDE.md— se arreglo eso, y el sintoma no se movio. O sea que
 * habia dos defectos encimados y el primero explicaba lo suficiente como para parecer la causa.
 *
 * Una voz es mono por naturaleza y duplicar el canal es puro disco, pero saca de encima un modo
 * de fallo que no avisa por ningun lado.
 */
{
  for (const n of ["locucion", "sonido", "musica"]) {
    const p = path.join(raiz, `herramientas/${n}.js`);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    /* No alcanza con que la cadena "-ac" aparezca: tiene que estar en la llamada que ESCRIBE el
     * wav, y con valor 2.
     *
     * Y NO alcanza con buscar `-ac 1` en todo el archivo, que fue la primera version y dio un
     * FALSO POSITIVO sobre `musica.js`: ese tool decodifica a MONO a proposito para medir la
     * envolvente de RMS, que es analisis y no un entregable. Un chequeo que matchea de mas da un
     * veredicto equivocado, no un silencio — el corolario de CLAUDE.md, cobrado otra vez.
     *
     * La distincion que sirve: una llamada a ffmpeg que termina en `"-"` escribe a STDOUT y es
     * analisis (decodificar para medir, o `-f null -` para astats). Las demas escriben un archivo,
     * y son las unicas donde `-ac` importa. */
    const llamadas = src.match(/(?:execFileSync|spawnSync)\("ffmpeg",\s*\[[\s\S]*?\]/g) || [];
    const escriben = llamadas.filter((c) => !/"-"\s*\]$/.test(c.trim()));
    const dosCanales = escriben.length > 0 && escriben.some((c) => /"-ac",\s*"2"/.test(c));
    const monoSuelto = escriben.some((c) => /"-ac",\s*"1"/.test(c));
    if (!dosCanales || monoSuelto) {
      mal(`\`${n}.js\` no escribe el wav en estereo`,
        "un wav MONO se reproduce MUDO en el visor del usuario, sin error de ninguna de las dos " +
        "partes: el archivo tiene voz y transcribe bien, y no suena. Costo cuatro entregas, y " +
        "las cuatro veces se midio duracion y nivel, que era lo que no fallaba");
    } else {
      ok(`${n}.js escribe el wav a dos canales`);
    }
  }
}

/* ---------- las claves de los OBJETOS anidados tambien rebotan ---------- */

titulo("Un `entrada` inventado adentro de un fragmento NO se descarta en silencio");

/*
 * La guarda de 2026-08-28 cerro las claves de PRIMER NIVEL. Adentro de los objetos seguia
 * abierta, y se cobro el 2026-09-02: a `armarSecuencia` se le paso
 * `fragmentos: [{desde: 0, hasta: 77, entrada: 1855}]` y el `entrada` se descarto sin avisar.
 * Los fragmentos son {desde, hasta} en segundos de la FUENTE, asi que la secuencia quedo con
 * el clip en el segundo CERO del material en vez de en el minuto 31 — y como el verbo informo
 * "1 de 1 fragmentos", se leyo como exito. Costo rearmar 14 secuencias.
 *
 * Y la tabla se DERIVA del codigo, igual que PARAMS_DE: se vuelven a extraer las claves que
 * cada verbo lee de esos objetos, y si no coinciden el test falla. Una tabla escrita a mano se
 * desactualiza y entonces la guarda rechaza llamadas CORRECTAS, que es el peor modo de fallo
 * para una guarda.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const m = src.match(/const CLAVES_DE_OBJETO = \{([\s\S]*?)\n  \};/);
  if (!m) {
    mal("no esta la guarda de claves anidadas en el despachador",
      "un parametro inventado adentro de un fragmento se descarta en silencio, y el verbo " +
      "informa exito sobre una llamada que no hizo lo que se le pidio");
  } else {
    /* que la guarda se ejecute ANTES de tocar nada */
    const iGuarda = src.indexOf("const CLAVES_DE_OBJETO");
    const iVerbo  = src.indexOf("return await fn(p);");
    const antes = iGuarda > 0 && iVerbo > iGuarda;
    /* y que las claves declaradas sean las que el verbo LEE de verdad */
    const declaradas = {};
    for (const par of m[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
      const verbo = par[1], campos = {};
      for (const c of par[2].matchAll(/(\w+):\s*\[([^\]]*)\]/g))
        campos[c[1]] = c[2].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
      declaradas[verbo] = campos;
    }
    const problemas = [];
    for (const verbo of Object.keys(declaradas)) {
      for (const campo of Object.keys(declaradas[verbo])) {
        /* las claves que el codigo lee: `const X = campo[i]` y despues `X.clave` */
        /* Se busca SOLO adentro del cuerpo del verbo. Buscar en todo el archivo daba un
         * falso positivo grande: `marcadores` tambien recorre una variable `lista`, y el
         * chequeo reportaba que `keyframe.lista` leia `guid`, `getStart` y `colorNombre`.
         * Es el corolario de este archivo otra vez — una guarda que matchea de mas produce
         * un veredicto equivocado, no un silencio. */
        const iFn = src.indexOf(`async function ${verbo}(`);
        if (iFn < 0) continue;
        let iFin = src.indexOf("\nasync function ", iFn + 10);
        if (iFin < 0) iFin = src.length;
        const cuerpo = src.slice(iFn, iFin);
        const leidas = new Set();
        const re = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${campo}\\[`, "g");
        let mm;
        while ((mm = re.exec(cuerpo))) {
          const v = mm[1], seg = cuerpo.slice(mm.index, mm.index + 2500);
          for (const k of seg.matchAll(new RegExp(`\\b${v}\\.(\\w+)`, "g"))) leidas.add(k[1]);
        }
        if (!leidas.size) continue;   // no se pudo leer: no se inventa un veredicto
        const faltan = [...leidas].filter((k) => declaradas[verbo][campo].indexOf(k) === -1);
        if (faltan.length) problemas.push(`${verbo}.${campo} LEE ${faltan.join(", ")} y no esta(n) declarada(s)`);
      }
    }
    if (!antes) {
      mal("la guarda de claves anidadas no corre antes de ejecutar el verbo",
        "una llamada mal escrita no tiene que hacer nada, ni siquiera a medias");
    } else if (problemas.length) {
      mal("la tabla de claves anidadas no coincide con lo que el codigo lee",
        problemas.join(" · ") + ". Una tabla desactualizada rechaza llamadas CORRECTAS, que es " +
        "peor que no tener guarda");
    } else {
      ok(`claves anidadas vigiladas en ${Object.keys(declaradas).length} verbo(s), y la tabla coincide con el codigo`);
    }
  }
}

/* ---------- copiarEfecto avisa que NO copia: comparte la instancia ---------- */

titulo("copiarEfecto avisa que el componente queda COMPARTIDO, no copiado");

/*
 * `createAppendComponentAction(comp)` con un componente de OTRO clip no lo copia: lo COMPARTE.
 * Medido el 2026-09-01 entre dos secuencias: se escribio Exposure 2,5 en el destino y el ORIGEN
 * paso a leer 2,5.
 *
 * El nombre del verbo dice "copiar" y eso invita a usarlo para replicar un look y despues
 * retocarlo — que es justamente lo que rompe el montaje de origen, en silencio y en otra
 * secuencia que uno no esta mirando. Mientras el verbo se llame asi, el aviso es obligatorio.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const fn = (src.match(/async function copiarEfecto[\s\S]*?\n}/) || [""])[0];
  const avisa = /NO ES UNA COPIA, ES LA MISMA INSTANCIA/.test(fn);
  if (!fn) {
    mal("no se encontró `copiarEfecto`", "es el verbo que comparte componentes entre clips");
  } else if (!avisa) {
    mal("`copiarEfecto` no avisa que el componente queda COMPARTIDO",
      "no copia: comparte la instancia, así que retocar el look en el destino cambia el " +
      "montaje de ORIGEN, en silencio y en otra secuencia. Medido: Exposure 2,5 escrito en el " +
      "destino se leyó 2,5 en el origen");
  } else {
    ok("avisa en el resumen que la instancia queda compartida entre los dos clips");
  }
}

/* ---------- la pista de un clip sale de getTrackIndex, no de recorrer buscando ---------- */

titulo("ubicarPistaDeClip pregunta getTrackIndex, y el respaldo NO elige entre gemelos");

/*
 * Un alt-drag hacia arriba deja el mismo medio, en el mismo instante, en dos pistas. El
 * recorrido por nombre + tiempo matchea las dos y devolvia la MAS BAJA. Medido en Premiere
 * 26.3.2: MM5165.MP4 en V1[37] y V12[0], las dos 62,48-63,44s; con el de V12 seleccionado el
 * bridge informaba V1.
 *
 * Dos mitades, y la segunda es la que se olvida: que use `getTrackIndex()`, Y que el respaldo
 * —que sigue ahi por si una version no expone el metodo— devuelva -1 ante dos coincidencias en
 * vez de la primera. Un indice equivocado es peor que ninguno.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const fn = (src.match(/async function ubicarPistaDeClip[\s\S]*?\n}/) || [""])[0];
  const pregunta = /clip\.getTrackIndex\(\)/.test(fn);
  // el respaldo tiene que RENDIRSE con dos, no quedarse con la primera
  const noElige = /encontrada !== -1[\s\S]{0,60}?return -1/.test(fn);
  if (!fn) {
    mal("no se encontró `ubicarPistaDeClip` en plugin/lib/comandos.js",
      "es la que decide en qué pista está el clip seleccionado");
  } else if (!pregunta) {
    mal("`ubicarPistaDeClip` no usa `getTrackIndex()`",
      "recorrer buscando por nombre + tiempo devuelve la pista MÁS BAJA cuando el clip está " +
      "duplicado en dos pistas, y eso informa una pista que no es");
  } else if (!noElige) {
    mal("el respaldo de `ubicarPistaDeClip` elige la primera coincidencia",
      "con dos gemelos tiene que devolver -1: un índice equivocado es peor que ninguno, " +
      "porque el que lo lea después actúa sobre la pista que no es");
  } else {
    ok("pregunta getTrackIndex, y el respaldo se rinde ante gemelos en vez de adivinar");
  }
}

/* ---------- proxies.js: la guarda de proyecto, el veredicto releido, y emparejar por duracion ---------- */

titulo("proxies.js manda la guarda `proyecto`, juzga por el ESTADO y empareja por DURACION");

/*
 * Adjuntar un proxy NO TIENE VUELTA: la API no expone `detachProxy`. Eso hace que las tres
 * propiedades de abajo no sean higiene sino seguridad, y las tres se pagaron el 2026-09-01
 * adjuntando los 127 de un institucional:
 *
 * 1. La guarda `proyecto` NO se mandaba. Existia en el despachador y la herramienta no la
 *    usaba: con el foco en otro proyecto habria enganchado proxies al material equivocado.
 * 2. Contaba `ok++` cuando la llamada no tiraba, sin leer el resumen —que trae el antes/despues
 *    y la ruta—. Es el modo de fallar nº1 de CLAUDE.md dentro del repo.
 * 3. Emparejaba solo por nombre y con la extension clavada. 26 de los 127 proxies traen un `_1`
 *    de mas, asi que por prefijo se habrian enganchado al clip VECINO. Decide la DURACION.
 */
{
  const p = path.join(raiz, "herramientas/proxies.js");
  const src = fs.readFileSync(p, "utf8");
  const llamada = (src.match(/enviar\(\s*"proxy"[\s\S]{0,240}?\)/) || [""])[0];

  const mandaGuarda = /proyecto:\s*PROYECTO/.test(llamada);
  // La LECTURA, no la palabra: `proyectoNombre` aparece tambien en el texto del error, asi que
  // buscarla a secas hace que el chequeo se confirme con su propia prosa. Ya paso hoy con el de
  // getProyectoYSecuencia; es el corolario de CLAUDE.md sobre guardas, cometido en una guarda.
  const leeElFoco = /e\.info\s*&&\s*e\.info\.proyectoNombre/.test(src);
  // el ok++ tiene que estar DENTRO de un if que mire el resumen, no suelto tras el enviar
  const juzgaEstado = /→ true/.test(src) && /includes\(h\.archivo\)/.test(src) &&
                      /if\s*\([^)]*→ true[\s\S]{0,120}?ok\+\+/.test(src);
  const porDuracion = /Math\.abs\(d - durOrig\) < 0\.2/.test(src);
  const rechazaAmbiguo = /ambiguos\.push/.test(src) && !/buenos\[0\][\s\S]{0,80}buenos\.length > 1/.test(src);

  if (!mandaGuarda) {
    mal("`proxies.js` adjunta SIN mandar la guarda `proyecto`",
      "con el foco en otro proyecto engancha proxies al material equivocado, y no hay " +
      "`detachProxy` para sacarlos");
  } else if (!leeElFoco) {
    mal("`proxies.js` no sabe deducir el proyecto del foco",
      "una guarda que hay que acordarse de pasar por flag es una guarda que no esta cuando hace falta");
  } else if (!juzgaEstado) {
    mal("`proxies.js` cuenta un adjuntado sin releer el estado",
      "que `enviar` no tire no prueba que el proxy haya quedado: el verbo devuelve " +
      "`tiene: false → true` y la ruta, y hay que exigir las dos");
  } else if (!porDuracion) {
    mal("`proxies.js` empareja proxies externos sin comprobar la DURACION",
      "el nombre es una hipotesis: 26 de los 127 de un institucional traen un `_1` de mas y por " +
      "prefijo se enganchan al clip vecino, sin error y sin vuelta");
  } else if (!rechazaAmbiguo) {
    mal("`proxies.js` no rechaza el emparejamiento ambiguo",
      "con dos candidatos que coinciden en duracion, elegir uno es adivinar en una operacion " +
      "irreversible");
  } else {
    ok("manda la guarda, relee el estado y decide por duracion (ambiguo = no se adjunta)");
  }
}

/* ---------- parchear_corte: apunta por tiempo, y NO escribe si algo no cierra ---------- */

titulo("parchear_corte apunta por TIEMPO y aborta sin escribir si la verificacion falla");

/*
 * Existe para no re-planificar despues de una revision: un armado sale de un plan con algo de azar,
 * asi que replanificar cambia TODOS los planos —incluidos los que el usuario no critico— y su
 * revision, que es lo mas caro del proceso, se pierde. Las notas se aplican como OPERACIONES.
 *
 * Dos cosas tienen que estar y las dos se pagaron:
 *
 * 1. Las operaciones apuntan POR TIEMPO, no por indice. Cada `partir` inserta un fragmento y corre
 *    los indices siguientes, asi que una lista escrita con indices se desalinea sola a la segunda
 *    operacion: la primera version dejo una duracion de -9,08s.
 *
 * 2. Si la verificacion encuentra algo, NO ESCRIBE. Un plan a medias que igual se guarda es peor
 *    que uno que no se guarda: se coloca en Premiere y el problema aparece mirando el video.
 */
{
  const p = path.join(raiz, "herramientas/parchear_corte.py");
  if (!fs.existsSync(p)) {
    mal("falta `herramientas/parchear_corte.py`",
      "sin el, cada correccion de un armado obliga a re-planificar y se pierde la revision");
  } else {
    const src = fs.readFileSync(p, "utf8");
    const porTiempo = /def cual\(t\)/.test(src) && /op\["en"\]/.test(src);
    const noIndice = !/op\["i"\]/.test(src);
    const abortaAntes = /if prob:[\s\S]{0,400}?sys\.exit\(1\)/.test(src) &&
                        src.search(/if prob:/) < src.search(/json\.dump/);
    const sincro = /entrada.*desde.*des\[/.test(src) || /x\["desde"\] - des\[/.test(src);
    if (!porTiempo || !noIndice) {
      mal("`parchear_corte.py` no apunta las operaciones por TIEMPO",
        "con indices, cada `partir` corre los siguientes y la lista se desalinea sola: " +
        "ya dejo una duracion de -9,08s");
    } else if (!abortaAntes) {
      mal("`parchear_corte.py` escribe el plan aunque la verificacion encuentre problemas",
        "un plan a medias que se guarda igual se coloca en Premiere, y el problema aparece " +
        "recien mirando el video");
    } else if (!sincro) {
      mal("`parchear_corte.py` no recalcula `entrada` a partir del desfase",
        "en material sincronizado el in-point NO es una eleccion: elegir otro desincroniza en " +
        "silencio, porque el clip mide lo mismo y nada avisa");
    } else {
      ok("apunta por tiempo, recalcula la sincronia y no escribe si algo no cierra");
    }
  }
}

/* ---------- estado no exige secuencia · importar mira si el proyecto crecio ---------- */

titulo("estado informa el proyecto aunque no haya secuencia activa");

/*
 * `estado` usaba `getProyectoYSecuencia`, asi que en un proyecto recien creado tiraba "Hay un
 * proyecto abierto pero ninguna secuencia activa": el verbo de ORIENTACION negandose justo cuando
 * mas falta hace saber donde se esta parado. Aparecio el 2026-08-29 probando `crearProyecto`.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const i = src.indexOf("async function estado()");
  /* Se corta en la funcion SIGUIENTE: una ventana fija de N caracteres se mete en el cuerpo de
     la de al lado —que si llama a getProyectoYSecuencia— y el chequeo falla sobre codigo bueno. */
  const sig = src.indexOf("\nasync function ", i + 10);
  const cuerpo = i === -1 ? "" : src.slice(i, sig === -1 ? i + 2200 : sig);
  if (i === -1) {
    mal("no se encontro `estado` en comandos.js", "el chequeo quedo apuntando a la nada");
  /* La LLAMADA, no la palabra: el comentario que explica por que ya no se usa la menciona, y un
     match flojo hacia fallar el chequeo sobre codigo bueno. Ya paso, en este mismo chequeo. */
  } else if (/await\s+getProyectoYSecuencia\s*\(/.test(cuerpo)) {
    mal("`estado` vuelve a exigir una secuencia activa",
      "en un proyecto sin secuencias tira en vez de informar, que es lo contrario de lo que " +
      "tiene que hacer el verbo de orientacion");
  } else if (!/SIN SECUENCIA ACTIVA/.test(cuerpo)) {
    mal("`estado` no exige secuencia pero tampoco lo INFORMA",
      "quedarse callado sobre que no hay secuencia es otra forma del mismo problema");
  } else {
    ok("informa el proyecto y avisa cuando no hay secuencia");
  }
}

titulo("importar mira si el proyecto CRECIO antes de declarar que no entro nada");

/*
 * La comprobacion buscaba el NOMBRE del archivo pedido entre los medios. Importar un `.prproj` trae
 * los medios de ADENTRO, con otros nombres, asi que ninguno coincide y el verbo informaba fracaso
 * sobre algo que funciono: el descartable paso de 1 a 33 medios y contesto "no esta ninguno de los
 * pedidos". Es el contador ciego de `cortesDeEscena` con otro sujeto.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const i = src.indexOf("async function importar(");
  const cuerpo = i === -1 ? "" : src.slice(i);
  const j = cuerpo.indexOf("faltan.length === pedidos.length");
  const rama = j === -1 ? "" : cuerpo.slice(j, j + 1800);
  if (i === -1 || j === -1) {
    mal("no se encontro la rama de `importar` que declara que no entro nada",
      "el chequeo quedo apuntando a la nada");
  } else if (!/despues\.length\s*-\s*antes\.length/.test(rama)) {
    mal("`importar` declara que no entro nada sin mirar si el proyecto CRECIO",
      "importar un .prproj trae los medios de adentro con otros nombres: el verbo informa " +
      "fracaso sobre algo que funciono. Ya paso, 1 -> 33 medios");
  } else if (!/crecio\s*>\s*0/.test(rama)) {
    mal("`importar` calcula cuanto crecio pero no ramifica con eso",
      "medir y no usarlo deja el informe equivocado igual");
  } else {
    ok("distingue por el conteo, que es el dato que no depende de los nombres");
  }
}

/* ---------- PARAMS_DE: la tabla de claves aceptadas se DERIVA del codigo ---------- */

titulo("PARAMS_DE coincide con lo que cada verbo realmente lee");

/*
 * La guarda que rechaza claves desconocidas sirve mientras la tabla este al dia. Una tabla escrita
 * a mano se desactualiza en el primer verbo nuevo, y ahi deja de proteger y empieza a ESTORBAR:
 * rechaza llamadas correctas, que es peor que el problema original.
 *
 * Por eso la tabla se vuelve a derivar aca, de los `params.X` de cada verbo, SIGUIENDO los helpers
 * a los que se les pasa `params` entero. Sin seguirlos queda corta: `borrar` lee `dejarHueco` y
 * `vinculados` en su cuerpo, pero `pista`, `indice` y `nombre` los lee `ubicarClip(sequence, params)`.
 */
function derivarParams(src) {
  const FN = {};
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    const abre = src.indexOf("{", m.index + m[0].length - 1);
    let prof = 0, fin = abre;
    for (let k = abre; k < src.length; k++) {
      if (src[k] === "{") prof++;
      else if (src[k] === "}") { prof--; if (prof === 0) { fin = k; break; } }
    }
    FN[m[1]] = { args: m[2].split(",").map((x) => x.trim()).filter(Boolean), cuerpo: src.slice(abre, fin + 1) };
  }
  const desestructurar = (set, dentro) => dentro.split(",").forEach((t) => {
    const n = t.split(":")[0].split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) set.add(n);
  });
  function claves(nombre, pos, visto) {
    visto = visto || new Set();
    const id = nombre + "#" + pos;
    if (visto.has(id)) return new Set();
    visto.add(id);
    const f = FN[nombre], out = new Set();
    if (!f || !f.args[pos]) return out;
    const alias = f.args[pos].replace(/\s*=.*$/, "").trim();
    if (alias.startsWith("{")) { desestructurar(out, alias.slice(1, -1)); return out; }
    const A = alias.replace(/[$]/g, "\\$");
    /* el lookbehind evita el falso positivo de `e.params.length` dentro de otra expresion */
    for (const m of f.cuerpo.matchAll(new RegExp("(?<![.\\w$])" + A + "\\.([A-Za-z_$][\\w$]*)", "g"))) out.add(m[1]);
    for (const m of f.cuerpo.matchAll(new RegExp("(?<![.\\w$])" + A + "\\[\\s*[\"']([^\"']+)[\"']", "g"))) out.add(m[1]);
    for (const m of f.cuerpo.matchAll(new RegExp("\\{([^{}]*)\\}\\s*=\\s*(?<![.\\w$])" + A + "\\b", "g"))) desestructurar(out, m[1]);
    for (const m of f.cuerpo.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
      const dest = m[1];
      if (!FN[dest] || dest === nombre) continue;
      const i = m[2].split(",").map((x) => x.trim()).indexOf(alias);
      if (i === -1) continue;
      for (const k of claves(dest, i, visto)) out.add(k);
    }
    return out;
  }
  const mv = /const VERBOS = \{([^}]*)\}/.exec(src);
  const verbos = mv ? mv[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
  const t = {};
  for (const v of verbos) t[v] = [...claves(v, 0)].sort();
  return t;
}

const SRC_CMD = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
const DERIVADA = derivarParams(SRC_CMD);

{
  const mt = /const PARAMS_DE = \{([\s\S]*?)\n\};/.exec(SRC_CMD);
  if (!mt) {
    mal("no existe la tabla `PARAMS_DE` en comandos.js",
      "sin ella un parametro que no existe se descarta en silencio y la llamada corre por su rama " +
      "por defecto, que casi siempre se parece al exito");
  } else {
    const escrita = {};
    for (const m of mt[1].matchAll(/\n\s*([A-Za-z_$][\w$]*):\s*\[([^\]]*)\]/g)) {
      escrita[m[1]] = m[2].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean).sort();
    }
    const dif = [];
    for (const v of Object.keys(DERIVADA)) {
      if (!escrita[v]) { dif.push(`${v}: falta en la tabla`); continue; }
      const a = DERIVADA[v].join(" "), b = escrita[v].join(" ");
      if (a !== b) dif.push(`${v}: la tabla dice [${b}] y el codigo lee [${a}]`);
    }
    for (const v of Object.keys(escrita)) if (!DERIVADA[v]) dif.push(`${v}: sobra en la tabla (no es un verbo)`);
    if (dif.length) {
      mal("`PARAMS_DE` no coincide con lo que leen los verbos",
        dif.slice(0, 4).join(" · ") + (dif.length > 4 ? ` · y ${dif.length - 4} mas` : "") +
        ". Una tabla desactualizada rechaza llamadas CORRECTAS");
    } else {
      ok(`la tabla coincide con los ${Object.keys(DERIVADA).length} verbos, derivada del codigo`);
    }
  }
}

titulo("nadie llama a un verbo con una clave que la tabla no acepta");

/*
 * El chequeo mira el CAMINO y no solo el destino: que la tabla este bien no prueba que las
 * herramientas del repo la respeten. Si una pasa una clave de mas, la guarda la va a rebotar en
 * produccion — y eso hay que verlo aca, no ahi.
 */
{
  const GLOB = new Set(["proyecto", "secuencia"]);
  const problemas = [];
  let n = 0;
  for (const dir of ["herramientas", "server"]) {
    const d = path.join(raiz, dir);
    if (!fs.existsSync(d)) continue;
    for (const nom of fs.readdirSync(d)) {
      if (!nom.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(d, nom), "utf8");
      for (const m of src.matchAll(/enviar\(\s*["'`](\w+)["'`]\s*,\s*g?\(?\s*\{([\s\S]*?)\}\s*\)?/g)) {
        const verbo = m[1];
        if (!DERIVADA[verbo]) { problemas.push(`${nom}: verbo desconocido "${verbo}"`); continue; }
        n++;
        const ok2 = new Set([...DERIVADA[verbo], ...GLOB]);
        for (const k of m[2].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/g))
          if (!ok2.has(k[1])) problemas.push(`${nom}: ${verbo} <- "${k[1]}"`);
      }
    }
  }
  const u = [...new Set(problemas)];
  if (u.length) mal("hay llamadas que pasan claves que el verbo no lee", u.slice(0, 5).join(" · "));
  else ok(`${n} llamadas del repo, ninguna con una clave de mas`);
}

titulo("ninguna herramienta MCP declara un parametro que el verbo no lee");

/*
 * El inverso, y es la familia del `proyecto` declarado y no reenviado: una herramienta que anuncia
 * un parametro que el verbo ignora promete algo que no hace nada, y quien lo pase se va a quedar
 * esperando un efecto que no llega.
 *
 * Solo el PRIMER NIVEL del inputSchema: adentro de `z.array(z.object({...}))` viven las claves de
 * los items, que no son parametros del verbo (`sacarRangos` recibe `rangos`, no `desde`/`hasta`).
 */
{
  const src = fs.readFileSync(path.join(raiz, "server/index.js"), "utf8");
  const GLOB = new Set(["proyecto", "secuencia"]);
  const problemas = [];
  let n = 0;
  for (const b of src.split(/registerTool\(/).slice(1)) {
    const nom = /^\s*["'`](\w+)["'`]/.exec(b);
    const iSchema = b.indexOf("inputSchema:");
    const iEnviar = b.search(/enviar\(\s*["'`](\w+)["'`]/);
    if (!nom || iSchema === -1 || iEnviar === -1) continue;
    const verbo = /enviar\(\s*["'`](\w+)["'`]/.exec(b.slice(iEnviar))[1];
    if (!DERIVADA[verbo]) { problemas.push(`${nom[1]} -> verbo desconocido "${verbo}"`); continue; }
    n++;
    const ok2 = new Set([...DERIVADA[verbo], ...GLOB]);
    for (const m of b.slice(iSchema, iEnviar).matchAll(/\n {6}([A-Za-z_$][\w$]*)\s*:\s*z\./g))
      if (!ok2.has(m[1])) problemas.push(`${nom[1]} (-> ${verbo}) declara "${m[1]}"`);
  }
  const u = [...new Set(problemas)];
  if (u.length) mal("hay herramientas MCP que declaran parametros muertos", u.slice(0, 5).join(" · "));
  else ok(`${n} herramientas MCP, ninguna declara un parametro que el verbo ignore`);
}

/* ---------- exportar: leer los in/out SIEMPRE, no solo cuando se pide rango ---------- */

titulo("exportar lee los in/out de la secuencia aunque no se le pida rango");

/*
 * `exportSequence` RESPETA los in/out de la secuencia. Eso ya estaba medido; lo que faltaba es que
 * el verbo lo DIJERA cuando no se le pide un rango, porque hasta el 2026-08-28 solo los leia
 * dentro del `if (hayRango)`.
 *
 * Medido el 2026-08-26 en un corporativo: VIDEO 1 salio de 232,52s con la secuencia terminando en 229,08
 * —3,44s de negro y silencio al final— y los otros dos, sin out point, salieron exactos. La UNICA
 * forma de detectarlo fue medir el archivo de afuera: un export que sale mas corto se nota, uno
 * que sale mas largo con negro al final se entrega.
 *
 * Se exige que la lectura este FUERA del `if (hayRango)` y que el resumen avise. Las dos mitades:
 * leer sin informar no sirve de nada, e informar sin leer no compila.
 */
{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const iExport = src.indexOf("async function exportar");
  const cuerpo = iExport === -1 ? "" : src.slice(iExport, iExport + 14000);
  const iLee = cuerpo.indexOf("inOutPrevio = {");
  const iSiRango = cuerpo.indexOf("if (hayRango) {");
  const avisa = /NO se pidi[^\n]*rango[\s\S]{0,200}?YA TIENE in\/out/.test(cuerpo);
  if (iExport === -1) {
    mal("no se encontro `exportar` en comandos.js", "el chequeo quedo apuntando a la nada");
  } else if (iLee === -1) {
    mal("`exportar` no lee los in/out de la secuencia fuera del pedido de rango",
      "un out viejo define el largo del archivo y nada lo menciona: ya salieron 3,44s de negro");
  } else if (iSiRango !== -1 && iLee > iSiRango) {
    mal("`exportar` lee los in/out DENTRO del `if (hayRango)`",
      "asi solo se entera cuando ya se le pidio un rango, que es justo el caso que no importa");
  } else if (!avisa) {
    mal("`exportar` lee los in/out pero no avisa en el RESUMEN cuando recortan",
      "un dato que esta en la respuesta y no en el resumen es un dato que no esta");
  } else {
    ok("lee los in/out siempre y avisa en el resumen cuando recortan");
  }
}

/* ---------- colocar_fragmentos: colision de nombres entre carpetas de material ---------- */

titulo("colocar_fragmentos compara la RUTA, no solo el nombre, antes de importar");

/*
 * El 2026-08-27 los subtitulos de dos temas del mismo proyecto se llamaban los dos `sub_NNN.png`,
 * en carpetas distintas. `importar` decide "ya esta" por NOMBRE, asi que informo "ya estaban" y no
 * importo nada; despues `insertar`, que tambien busca por nombre, agarro el medio del OTRO tema.
 *
 * Y la herramienta informo "42 de 42 colocados ... los 42 en su lugar y con su duracion", porque
 * verifica POSICION y DURACION y nunca que medio quedo. Tampoco lo vio `revisar`: los clips estan,
 * miden lo que tienen que medir y no hay hueco ni solape. Lo agarro un CUADRO.
 *
 * La asimetria fue la unica pista: el tema viejo llegaba hasta `sub_037`, asi que 38 clips salieron
 * mal y los 4 ultimos —sin homonimo— salieron bien.
 *
 * La guarda tiene que comparar la RUTA (que `medios` devuelve) y ABORTAR, no avisar: avisar y
 * seguir deja 42 clips con el contenido de otro tema y un informe de exito.
 */
{
  const src = fs.readFileSync(path.join(raiz, "herramientas/colocar_fragmentos.js"), "utf8");
  /*
   * Y SE EXIGE QUE NORMALICE UNICODE, no solo que compare la ruta.
   *
   * Sin normalizar, la guarda aborta la tanda declarando un choque que NO existe: macOS y
   * Premiere entregan los acentos en normalizaciones distintas, asi que dos rutas identicas en
   * pantalla dan `!==`. Medido el 2026-09-05 con el corte real de un videoclip cuyo material vive
   * bajo una ruta con acento: la guarda imprimio "quiero X · ya esta X" con las dos lineas iguales y
   * rechazo los 88 fragmentos. Rechazar lo correcto es el peor modo de fallo de una guarda, y
   * pasa en cualquier proyecto con un acento en la ruta.
   */
  const iGuarda = src.search(/yaEsta\[norm\(base\(ru\)\)\]\s*!==\s*norm\(ru\)/);
  const iImporta = src.indexOf('enviar("importar"');
  const sale = /yaEsta\[norm\(base\(ru\)\)\]\s*!==\s*norm\(ru\)[\s\S]{0,1600}?process\.exit\(1\)/.test(src);
  const pideRuta = /enviar\("medios"/.test(src);
  if (iGuarda === -1 || !pideRuta) {
    mal("`colocar_fragmentos.js` no compara la RUTA NORMALIZADA de los homonimos antes de importar",
      "`importar` saltea por NOMBRE e `insertar` agarra el medio viejo: la herramienta informa " +
      "exito con los clips mostrando el contenido de otra carpeta. Ya paso, 38 de 42");
  } else if (!sale) {
    mal("`colocar_fragmentos.js` detecta la colision de nombres pero no aborta",
      "avisar y seguir deja la pista armada con el material equivocado y un informe de exito");
  } else if (iImporta !== -1 && iGuarda > iImporta) {
    mal("la guarda de colision va DESPUES del importar",
      "para cuando se dispara, importar ya informo 'ya estaban' y no importo nada");
  } else {
    ok("compara la ruta de los homonimos y aborta antes de importar");
  }
}

/* ---------- colocar_fragmentos: no armar sobre una pista con contenido ---------- */

titulo("colocar_fragmentos se niega a armar encima sin --limpiar");

/*
 * El 2026-08-22 se corrio el colocador sin `--limpiar` sobre V1 con 95 clips y quedaron 183.
 * La causa es facil de pasar por alto: cada clip se inserta en el LIMBO —donde el overwrite no
 * pisa nada real— y despues se MUEVE con `createMoveAction`, que SOLAPA en vez de pisar. Asi
 * que el armado nuevo se encima sobre el viejo en la misma pista.
 *
 * El informe final lo agarro, pero recien al terminar, despues de ~360 transacciones sobre el
 * proyecto real. La guarda tiene que ser ANTES. Y no se limpia solo a proposito: barrer una
 * pista es destructivo y tiene que pedirse.
 */
{
  const src = fs.readFileSync(path.join(raiz, "herramientas/colocar_fragmentos.js"), "utf8");
  /* el chequeo tiene que estar ANTES del bloque que limpia, o no sirve de nada */
  const iGuarda = src.search(/cs\.length\s*&&\s*!flag\("limpiar"\)/);
  const iLimpia = src.indexOf('if (flag("limpiar")) {');
  const sale = /cs\.length\s*&&\s*!flag\("limpiar"\)[\s\S]{0,900}?process\.exit\(1\)/.test(src);
  if (iGuarda === -1) {
    mal("`colocar_fragmentos.js` no chequea que la pista este vacia antes de armar",
      "sin --limpiar los clips se MUEVEN a su lugar y createMoveAction SOLAPA en vez de pisar: " +
      "quedan los dos armados encimados. Ya paso: 95 + 88 = 183 clips en V1");
  } else if (!sale) {
    mal("`colocar_fragmentos.js` detecta la pista con contenido pero no aborta",
      "avisar y seguir deja el timeline con dos armados encimados");
  } else if (iLimpia !== -1 && iGuarda > iLimpia) {
    mal("la guarda de pista-no-vacia va DESPUES del bloque que limpia",
      "asi nunca se dispara en el caso que importa");
  } else {
    ok("chequea la pista antes de armar y aborta si tiene contenido sin --limpiar");
  }
}

/* ---------- las herramientas de VISION (python) ---------- */

titulo("Las herramientas de vision: que parseen y que digan su veredicto");

/*
 * Los .py de vision no van al README —su indice es `herramientas/VISION.md`— pero tienen dos
 * exigencias propias, y las dos salen de errores reales:
 *
 * 1. Que PARSEEN. `foco.py` se escribio con comentarios estilo C —barra-asterisco— adentro
 *    de un archivo Python y no arrancaba. Un `ast.parse` lo agarra en un segundo.
 *    (y ojo: escribir ese par de simbolos aca cierra ESTE comentario. Tambien paso.)
 * 2. Que las que PERDIERON lo digan en la primera linea. `estetica.py` quedo con sus pesos
 *    borrados a proposito y un encabezado que sonaba a invitacion a usarlo: un archivo que
 *    parece usable y no lo es es peor que no tenerlo. Este repo guarda los resultados negativos
 *    —ver `nitidez.py`— pero rotulados.
 */
{
  const VISION = {
    "sincro.py":   { veredicto: null,      nota: "sincroniza por audio, validada" },
    "nitidez.py":  { veredicto: "NO FUNCIONA", nota: "resultado negativo, ya rotulado" },
    "foco.py":     { veredicto: null,      nota: "TOPIQ, gano la comparacion" },
    "estetica.py": { veredicto: "PERDIO",  nota: "sus pesos se borraron; registro negativo" },
  };
  const py = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  let fallo = false;
  for (const [f, spec] of Object.entries(VISION)) {
    const ruta = path.join(raiz, "herramientas", f);
    if (!fs.existsSync(ruta)) { mal(`falta \`herramientas/${f}\``); fallo = true; continue; }
    // 1. parsea?
    try {
      execFileSync(py, ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", ruta], { stdio: "pipe" });
    } catch (e) {
      mal(`\`herramientas/${f}\` no parsea como Python`, String(e.stderr || e.message).trim().slice(0, 200));
      fallo = true; continue;
    }
    // 2. si perdio, lo dice en las primeras lineas?
    const cabeza = fs.readFileSync(ruta, "utf8").split("\n").slice(0, 6).join("\n");
    if (spec.veredicto && !cabeza.includes(spec.veredicto)) {
      mal(`\`herramientas/${f}\` no declara "${spec.veredicto}" en su encabezado`,
        "una herramienta que perdio y no lo dice se vuelve a usar; peor si sus pesos ya no estan");
      fallo = true; continue;
    }
    // 3. esta en el indice de vision?
    const vis = fs.readFileSync(path.join(raiz, "herramientas/VISION.md"), "utf8");
    if (!vis.includes(f)) {
      mal(`\`herramientas/${f}\` no esta en VISION.md`, "ese es su indice, no el README");
      fallo = true; continue;
    }
  }
  if (!fallo) ok(`las ${Object.keys(VISION).length} herramientas de vision parsean, estan en VISION.md y las que perdieron lo dicen`);
}

titulo("El chequeo de material: que siga sin depender de Premiere, y que foco.py no cruce resoluciones");

/*
 * Tres guardas, y cada una protege una CONCLUSION MEDIDA que se pierde en silencio si alguien
 * —yo— toca el archivo sin releer VISION.md.
 *
 * 1. `revisar_medios.js` no puede usar el bridge. Toda su razon de ser es correr sin Premiere
 *    abierto: es el chequeo que va ANTES de armar, y encima asi no toca ninguno de los cinco
 *    modos de crash. Una sola llamada a `enviar` le saca esa propiedad y nada lo avisaria.
 *
 * 2. `foco.py` tiene que leer la resolucion NATIVA y negarse a comparar entre resoluciones
 *    distintas. Medido: la resolucion sola mueve el score 8,6% en un cuadro y 9,3% en video, y
 *    la guarda del desvio interno es ~7%. Sin esto, en un corporativo —13 resoluciones— una diferencia
 *    de pura resolucion se informa como "mirarlo". Ya paso en la primera version.
 *
 * 3. El negativo medido tiene que seguir escrito. `cropdetect` dio CERO barras en 28 medios, y
 *    este repo guarda los negativos justamente para no volver a proponerlos. Si desaparece de
 *    VISION.md, el chequeo se reconstruye desde cero.
 */
{
  const rm = path.join(raiz, "herramientas/revisar_medios.js");
  if (!fs.existsSync(rm)) mal("falta `herramientas/revisar_medios.js`");
  else {
    const src = fs.readFileSync(rm, "utf8");
    // los comentarios se sacan: el encabezado NOMBRA al bridge para explicar que no lo usa
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/require\([^)]*bridge/.test(codigo) || /\benviar\s*\(/.test(codigo)) {
      mal("`revisar_medios.js` usa el bridge", "su promesa es correr sin Premiere abierto y sin riesgo de crash; con una llamada deja de valer");
    } else if (!/ffprobe/.test(codigo)) {
      mal("`revisar_medios.js` no llama a ffprobe", "es su unica fuente de datos");
    } else {
      ok("`revisar_medios.js` es ffprobe puro: no depende de Premiere");
    }
  }

  const fp = path.join(raiz, "herramientas/foco.py");
  const foco = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
  if (!foco) mal("falta `herramientas/foco.py`");
  else if (!/def resolucion\(/.test(foco) || !/"ancho"/.test(foco)) {
    mal("`foco.py` no lee la resolucion nativa", "normaliza a 768 de ancho, asi que sin leerla la diferencia queda invisible y aparece igual en el score");
  } else if (!/NO COMPARABLE/.test(foco)) {
    mal("`foco.py` no se niega a comparar entre resoluciones distintas", "la resolucion sola mueve el score 8,6% y la guarda de ruido es ~7%: se informa un falso 'mirarlo'");
  } else {
    ok("`foco.py` lee la resolucion nativa y no compara entre resoluciones distintas");
  }

  const vis = fs.readFileSync(path.join(raiz, "herramientas/VISION.md"), "utf8");
  const faltan = [];
  if (!/revisar_medios\.js/.test(vis)) faltan.push("revisar_medios.js");
  if (!/cropdetect/.test(vis)) faltan.push("el negativo medido de cropdetect");
  // Esto pedia que la deriva de VFR estuviera rotulada como PREDICCION. Se midio el 2026-08-23
  // —Premiere respeta los PTS— asi que lo que hay que sostener es el RESULTADO, no la cautela:
  // si desaparece, la sospecha vuelve y se marcan 35 archivos sanos como defectuosos.
  if (!/respeta los PTS/.test(vis)) faltan.push("que esta MEDIDO que Premiere respeta los PTS de un VFR");
  if (faltan.length) mal("VISION.md no registra: " + faltan.join(", "),
    "un negativo medido que no queda escrito se vuelve a construir, y una prediccion que se lee como medicion se usa como verdad");
  else ok("VISION.md registra la herramienta, el negativo de cropdetect y que la deriva es prediccion");
}

titulo("Las dos planchas son OPUESTAS en la rotacion, y eso hay que sostenerlo");

/*
 * La misma opcion de ffmpeg es OBLIGATORIA en unas herramientas y PROHIBIDA en otra, y depende
 * de que se este leyendo:
 *
 *     material de CAMARA con el flag mal puesto  ->  -noautorotate OBLIGATORIO, o sale acostado
 *     el EXPORT ya entregado                     ->  PROHIBIDO: hay que ver lo que ve un
 *                                                    reproductor, incluido el defecto
 *
 * Copiar la linea de una a la otra es lo natural —son casi la misma herramienta— y en la del
 * export esconde justo el defecto que vino a buscar. El flag de rotacion de un videoclip se descubrio
 * mirando el export, con el corte entero ya armado.
 *
 * Y esta guarda ya se cobro una: `broll.js` extraia SIN la opcion mientras `grilla_angulos.js` y
 * `familias.py` la tenian. Paso desapercibido porque el que hace la plancha es `planchas.js`, que
 * no extrae nada —solo hace el montage— asi que mirar ahi no mostraba el problema.
 *
 * Y la otra: `plancha_corte.js` tiene que ABORTAR si el corte no es de esa version del export.
 * Sin eso los tiempos caen en otros planos y la plancha sale plausible y equivocada, que es el
 * contador ciego de este repo aplicado a una imagen.
 *
 * Ese chequeo se mira sobre el CODIGO con los comentarios afuera. La primera version buscaba la
 * palabra "ABORTA" en el archivo entero y la satisfacia el encabezado, que la nombra para
 * explicar el comportamiento: una guarda que un comentario aprueba no protege nada. Se descubrio
 * al hacerla fallar, que es la unica forma de saberlo.
 */
{
  const pc = path.join(raiz, "herramientas/plancha_corte.js");
  if (!fs.existsSync(pc)) mal("falta `herramientas/plancha_corte.js`");
  else {
    const src = fs.readFileSync(pc, "utf8");
    // los comentarios se sacan: el encabezado NOMBRA la opcion para explicar por que no la usa
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Los que extraen cuadros de CAMARA. `planchas.js` no esta: solo hace el montage, los
    // cuadros se los da `broll.js` — y justamente por no mirar eso, broll.js estuvo extrayendo
    // sin la opcion mientras el resto la tenia. Lo encontro esta guarda.
    const DE_CAMARA = ["broll.js", "grilla_angulos.js", "familias.py"];
    const sinOpcion = DE_CAMARA.filter((f) => {
      const q = path.join(raiz, "herramientas", f);
      return fs.existsSync(q) && /ffmpeg/.test(fs.readFileSync(q, "utf8")) && !/noautorotate/.test(fs.readFileSync(q, "utf8"));
    });
    if (/noautorotate/.test(codigo)) {
      mal("`plancha_corte.js` usa -noautorotate", "lee el EXPORT: tiene que mostrar lo que muestra un reproductor, si no esconde el defecto que vino a buscar");
    } else if (sinOpcion.length) {
      mal("extraen cuadros de camara sin -noautorotate: " + sinOpcion.join(", "),
          "los clips con el flag mal puesto salen ACOSTADOS, y esas planchas existen para mirarlos");
    } else {
      // El aborto se prueba CORRIENDOLO, no leyendo el texto. Las dos primeras versiones de este
      // chequeo eran de texto y las dos pasaban con la guarda sacada: una la satisfacia la palabra
      // "ABORTA" del encabezado, y la otra un `process.exit(1)` de otro chequeo del mismo archivo.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plancha-test-"));
      let veredicto = null;
      try {
        const vid = path.join(tmp, "v.mp4");
        execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=25:d=5",
          "-pix_fmt", "yuv420p", vid, "-y"], { stdio: "pipe" });
        const corre = (planos) => {
          const j = path.join(tmp, "c.json");
          fs.writeFileSync(j, JSON.stringify({ planos }));
          try {
            execFileSync(process.execPath, [pc, "--video", vid, "--corte", j, "--destino", tmp], { stdio: "pipe" });
            return 0;
          } catch (e) { return e.status == null ? -1 : e.status; }
        };
        // el video mide 5s: un corte que dice 60 NO es de esta version y tiene que rebotar
        const desalineado = corre([{ clip: "x.mp4", desde: 0, dura: 60 }]);
        const alineado = corre([{ clip: "x.mp4", desde: 0, dura: 2.5 }, { clip: "y.mp4", desde: 2.5, dura: 2.5 }]);
        if (desalineado !== 1) veredicto = "no aborta con un corte que no corresponde (salio " + desalineado + ", esperaba 1)";
        else if (alineado !== 0) veredicto = "aborta con un corte que SI corresponde (salio " + alineado + ", esperaba 0)";
      } catch (e) {
        veredicto = "no se pudo probar: " + String(e.message).split("\n")[0].slice(0, 80);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      if (veredicto) {
        mal("`plancha_corte.js` " + veredicto,
            "los tiempos caerian en otros planos y la plancha saldria plausible y equivocada");
      } else {
        ok("las dos planchas mantienen la rotacion opuesta, y la del export aborta —probado corriendolo— si el corte no coincide");
      }
    }
  }
}

titulo("cotejar_export juzga por RANGO, y no puede prometer sincronia");

/*
 * Dos cosas, y las dos son conclusiones medidas que se pierden si alguien las "mejora".
 *
 * 1. El veredicto sale de comparar contra SEÑUELOS, no de un umbral. Medido: el valor absoluto
 *    del par correcto varia 13 veces entre planos —0,76 en percusion, 10,33 en un cantante con
 *    Lumetri— asi que un umbral calibrado con uno rechaza al otro. Poner una constante ahi es
 *    exactamente el error que este repo ya pago transfiriendo el umbral de z entre regimenes.
 *
 * 2. NO puede prometer sincronia. Medido: ±1 cuadro no se separa en 4 de 6 planos, y en uno el
 *    desfasado puntua MENOS. Si el verbo dijera "verificado" a secas, se leeria como que la
 *    sincro esta chequeada, y la sincro es justo lo que el usuario dijo que importa.
 */
{
  const ce = path.join(raiz, "herramientas/cotejar_export.js");
  if (!fs.existsSync(ce)) mal("falta `herramientas/cotejar_export.js`");
  else {
    const src = fs.readFileSync(ce, "utf8");
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // el veredicto compara pedido contra el senuelo, no contra un numero
    const porRango = /pedido\s*<\s*mejorSenuelo/.test(codigo);
    const porUmbral = /pedido\s*[<>]=?\s*\d/.test(codigo);
    if (!porRango || porUmbral) {
      mal("`cotejar_export.js` no juzga por rango contra el senuelo",
          "el par correcto varia 13 veces entre planos: un umbral calibrado con uno rechaza al otro");
    } else if (!/pedazo/.test(codigo) || /\bverificado\b/.test(codigo)) {
      mal("`cotejar_export.js` promete mas de lo que mide",
          "±1 cuadro no se separa, asi que confirma el PEDAZO y no la sincronia; decir 'verificado' se lee como que la sincro esta chequeada");
    } else {
      ok("`cotejar_export.js` juzga por rango y no promete sincronia");
    }
  }
}

titulo("La grilla de cuadro de los colocadores no puede estar hardcodeada");

/*
 * `colocar_fragmentos.js` tenia `const FPS = 25` fijo. En un multicamara —secuencia y material a 50fps—
 * cuantizar a 40ms movio el `desde` de 95,74 a 95,76 y dejo el desfase en 4,00 cuando el del clip
 * es 4,02: UN CUADRO de desincronizacion, en cinco de once clips.
 *
 * Y es de los que no avisan: el clip mide lo mismo, no hay hueco ni solape, y `revisar` no lo ve.
 * En material sincronizado —donde el in-point NO es una eleccion sino el offset de sincro— eso es
 * el defecto mas caro posible, porque se descubre escuchando y no mirando.
 *
 * La guarda es estatica a proposito: no hay forma de probar el sintoma sin un proyecto a 50fps.
 */
{
  const COLOCADORES = ["colocar_fragmentos.js", "colocar_sincro.js", "colocar_propuesta.js"];
  let fallo = false;
  for (const f of COLOCADORES) {
    const q = path.join(raiz, "herramientas", f);
    if (!fs.existsSync(q)) continue;
    const src = fs.readFileSync(q, "utf8");
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* un FPS constante y literal es el bug; tiene que venir de una opcion */
    const fijo = /const\s+FPS(_SEC)?\s*=\s*\d+\s*[,;]/.test(codigo);
    const deOpcion = /FPS(_SEC)?\s*=\s*Number\(opt\(/.test(codigo);
    if (fijo && !deOpcion) {
      mal("`herramientas/" + f + "` tiene la grilla de cuadro hardcodeada",
        "a 50fps cuantizar a 40ms corre el desfase un cuadro y desincroniza sin avisar");
      fallo = true;
    }
  }
  if (!fallo) ok("los colocadores toman la grilla de cuadro de una opcion, no de una constante");
}

titulo("Sin `entrada` en el corte, el in-point es EL DEL CLIP y no cero");

/*
 * Un medio SINTETICO --Transparent Video, y tambien un PNG fijo-- es un generador de una hora y
 * el clip nace POR EL MEDIO: in-point 3600. Pedirle `entrada: 0` y `salida: dura` cae ANTES del
 * in-point; Premiere lo ignora EN SILENCIO y el clip se queda con su duracion por defecto (5s
 * para una imagen). Ya paso dos veces: doce marcadores que quedaron de 32s en vez de 10, y las
 * nueve primeras placas de partitura del curso, que quedaron de 5s.
 *
 * Asi que cuando el fragmento NO trae `entrada`, el colocador tiene que LEER la del clip recien
 * insertado y calcular la salida sobre esa. Un `cuadro(fr.entrada)` a secas da NaN, y `entrada:
 * NaN` es justamente la escritura que falla sin avisar.
 *
 * Se verifico haciendo fallar la guarda por las dos ramas: volviendo a `entrada: cuadro(fr.entrada)`
 * y quitando la lectura del in-point real.
 */
{
  const p = path.join(raiz, "herramientas/colocar_fragmentos.js");
  const src = fs.readFileSync(p, "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const acepta = /entrada:\s*typeof fr\.entrada === "number"\s*\?\s*cuadro\(fr\.entrada\)\s*:\s*null/.test(codigo);
  const lee = /entQuiero\s*=\s*p\.entrada !== null \?\s*p\.entrada\s*:\s*cuadro\(mio\.entrada\)/.test(codigo);
  const salidaSobreEse = /salida:\s*Number\(\(entQuiero \+ p\.dura\)/.test(codigo);
  if (!acepta) {
    mal("`colocar_fragmentos.js` fuerza una `entrada` aunque el corte no la traiga",
      "un PNG o un Transparent Video nacen con in-point 3600: pedir 0 no recorta y no avisa");
  } else if (!lee || !salidaSobreEse) {
    mal("`colocar_fragmentos.js` no calcula la salida sobre el in-point REAL del clip",
      "3600 no se puede asumir: hay que leerlo del clip recien insertado");
  } else {
    ok("sin `entrada` en el corte se lee el in-point real del clip y la salida sale de ahi");
  }
}

titulo("El CSS de exportar_dc va ULTIMO, o no puede pisar nada");

/*
 * `--css` existe para partir un artboard en capas sin rediseñarlo: sacarle el logo a un fondo, o
 * aislar el logo. Solo sirve si se inyecta DESPUES de la hoja del exportador — si va antes, las
 * reglas `!important` del exportador ganan y el CSS del usuario no hace nada, en silencio.
 */
{
  const p = path.join(raiz, "herramientas/exportar_dc.js");
  const src = fs.readFileSync(p, "utf8");
  const i = src.indexOf("addStyleTag");
  const bloque = i === -1 ? "" : src.slice(i, i + 1400);
  if (!/opt\("css"/.test(src)) {
    mal("`exportar_dc.js` no tiene la opcion --css",
      "sin ella no hay forma de separar un artboard en capas sin editar el HTML");
  } else if (!/\(CSS \|\| ""\)/.test(bloque)) {
    mal("`exportar_dc.js` no inyecta el CSS del usuario en la hoja de estilos",
      "declarado y no usado es peor que no tenerlo");
  } else if (bloque.indexOf('(CSS || "")') < bloque.indexOf("data-omelette-chrome")) {
    mal("el CSS del usuario se inyecta ANTES de las reglas del exportador",
      "las de el llevan !important y le ganan: el CSS del usuario no haria nada, y en silencio");
  } else {
    ok("`exportar_dc.js` inyecta el --css del usuario al final, donde puede pisar");
  }
}

/* ---------- espaciado entre transacciones ---------- */

/*
 * Lo que tira Premiere es la SEPARACION REAL entre transacciones, y esa es la
 * SUMA de dos numeros que viven en archivos distintos: la `PAUSA` de la
 * herramienta y el `MS_POLL` del panel, que es el piso del transporte.
 *
 * Se chequea la suma y no cada uno porque el error que casi se comete el
 * 2026-09-05 fue exactamente ese: bajar `MS_POLL` de 700 a 200 —3,5x en toda
 * llamada, medido— sin tocar las `PAUSA`. En el proyecto de PRUEBA los ~205ms
 * resultantes aguantaron 200 transacciones; en un proyecto pesado (216 clips, 1284
 * medios) fallaron 2 de 2, en la 22 y en la 34.
 *
 * 500ms es el piso: el borde medido esta entre 205 y 355, y ~505 aguanto 150.
 */

titulo("El espaciado real entre transacciones (PAUSA + MS_POLL) no baja de 500ms");

{
  const MINIMO = 500;
  const srcPanel = fs.readFileSync(path.join(raiz, "plugin/index.js"), "utf8");
  const mPoll = srcPanel.match(/^const MS_POLL\s*=\s*(\d+)\s*;/m);
  if (!mPoll) {
    mal("no encontre `MS_POLL` en plugin/index.js",
      "es el piso del transporte; sin el no se puede saber cual es el espaciado real");
  } else {
    const poll = Number(mPoll[1]);
    const tools = ["colocar_propuesta", "colocar_sincro", "quirurgico", "colocar_fragmentos"];
    const flacas = [];
    const sinPausa = [];
    for (const t of tools) {
      const src = fs.readFileSync(path.join(raiz, "herramientas/" + t + ".js"), "utf8");
      const m = src.match(/^const PAUSA\s*=\s*(?:Number\(opt\("pausa",\s*")?(\d+)/m);
      if (!m) { sinPausa.push(t); continue; }
      const real = Number(m[1]) + poll;
      if (real < MINIMO) flacas.push(t + " (PAUSA " + m[1] + " + MS_POLL " + poll + " = " + real + "ms)");
    }
    if (sinPausa.length) {
      mal("no pude leer la PAUSA de: " + sinPausa.join(", "),
        "si una herramienta que espacia transacciones deja de declararla asi, este chequeo deja de protegerla");
    } else if (flacas.length) {
      mal("espaciado real por debajo de " + MINIMO + "ms en: " + flacas.join(", "),
        "medido en un proyecto pesado: a ~205ms Premiere se cae o se cuelga (2 de 2, en la 22 y en la 34).\n         " +
        "Si bajas MS_POLL hay que SUBIR la PAUSA: lo que importa es la suma.");
    } else {
      ok("las 4 herramientas espacian >= " + MINIMO + "ms reales", "MS_POLL " + poll);
    }
  }
}

/* ---------- el plugin instalado vs el del repo ---------- */

/*
 * Instalado, el plugin es una COPIA en ~/Library/.../UXP/Plugins/External, no un
 * symlink. Editar `plugin/` y no reinstalar deja el panel corriendo el codigo
 * VIEJO, y entonces se mide un cambio que no existe — que es el modo de fallar
 * nº1 de CLAUDE.md con un sujeto nuevo. Si no esta instalado no hay nada que
 * comprobar y el chequeo se saltea diciendolo.
 */

titulo("Si el plugin esta INSTALADO, la copia instalada es la del repo");

{
  /* Se DERIVA del manifest en vez de clavarse: cada quien instala con su propio `id`,
     y una ruta fija dejaria este chequeo mirando una carpeta que no existe —o sea
     pasando siempre, que es peor que no tenerlo. */
  const dir = path.join(os.homedir(),
    "Library/Application Support/Adobe/UXP/Plugins/External",
    `${manifest.id}_${manifest.version}`);
  if (!fs.existsSync(dir)) {
    ok("el plugin no esta instalado; se carga por UDT y no hay copia que se pueda desincronizar");
  } else {
    const difieren = [];
    for (const f of ["index.js", "manifest.json", "lib/comandos.js"]) {
      const a = path.join(dir, f), b = path.join(raiz, "plugin", f);
      if (!fs.existsSync(a)) { difieren.push(f + " (falta en la instalada)"); continue; }
      const ta = fs.readFileSync(a, "utf8"), tb = fs.readFileSync(b, "utf8");
      /*
       * El manifest se compara PARSEADO: UXP lo reescribe con otro formato al
       * instalar —773 bytes contra 672, mismo contenido— asi que compararlo byte
       * a byte da un falso positivo sobre un estado correcto, que es el modo de
       * fallo mas caro para una guarda. El codigo si va byte a byte: ahi un
       * espacio de mas no cambia nada pero tampoco aparece solo.
       */
      const distinto = f.endsWith(".json")
        ? JSON.stringify(JSON.parse(ta)) !== JSON.stringify(JSON.parse(tb))
        : ta !== tb;
      if (distinto) difieren.push(f);
    }
    if (difieren.length) {
      mal("la copia INSTALADA difiere del repo en: " + difieren.join(", "),
        "el panel esta corriendo codigo distinto del que estas editando. Reinstala antes de medir nada.");
    } else {
      ok("la copia instalada coincide con plugin/ del repo");
    }
  }
}

/* ---------- el hook instalado vs el del repo ---------- */

/*
 * Mismo modo de fallo que el plugin, con otro sujeto: git NO versiona
 * .git/hooks/, asi que el hook vive solo en la maquina donde se creo. La copia
 * buena es `herramientas/hooks/`; la instalada es `.git/hooks/`.
 *
 * Existe porque el 2026-09-10 `respaldar.sh` llevaba cuatro dias copiando CERO
 * memorias y diciendo que si — la ruta habia quedado vieja tras mudar el repo y
 * el script se salteaba en silencio. El hook es lo que evita que un respaldo se
 * atrase; que el hook se desincronice sin avisar seria el mismo bug un nivel
 * arriba.
 */

titulo("Si el hook esta INSTALADO, la copia instalada es la del repo");

{
  const repo = path.join(raiz, "herramientas/hooks/post-commit");
  const inst = path.join(raiz, ".git/hooks/post-commit");
  if (!fs.existsSync(repo)) {
    mal("falta herramientas/hooks/post-commit",
      "es la copia canonica del hook; sin ella un clone nuevo se queda sin respaldo automatico.");
  } else if (!fs.existsSync(inst)) {
    ok("el hook no esta instalado; los push son manuales (instalalo con herramientas/hooks/instalar.sh)");
  } else if (fs.readFileSync(repo, "utf8") !== fs.readFileSync(inst, "utf8")) {
    mal("el hook INSTALADO difiere del de herramientas/hooks/",
      "corre herramientas/hooks/instalar.sh. Mientras difieran no sabes cual de los dos esta corriendo.");
  } else {
    ok("el hook instalado coincide con herramientas/hooks/");
  }
}

/* ---------- `desactivar` arrastra el audio, y sin recorrer N veces ---------- */

/*
 * Hasta el 2026-09-10 apagar V2 dejaba SONANDO A2. Ya habia mordido: el paliativo
 * fue mutear A2/A3/A4 a mano en la secuencia del corte. Verificado contra Premiere ese dia, antes y
 * despues del arreglo.
 *
 * Las tres cosas se chequean juntas porque la segunda es la que hace peligroso al
 * arreglo obvio: `buscarVinculados` recorre TODAS las pistas por CADA clip, y este
 * verbo existe para tandas de sesenta suplentes. Llamarlo por clip serian sesenta
 * recorridos — el patron de ~139.000 llamadas que la revision del 2026-08-20 puso
 * primero en lo que puede destruir trabajo. O sea: arreglar el bug del audio con la
 * via obvia reintroduce el bug del crash.
 */

titulo("`desactivar` arrastra el audio vinculado, en UNA pasada, y juzga por el CAMBIO");

{
  const src = fs.readFileSync(path.join(raiz, "plugin/lib/comandos.js"), "utf8");
  const i = src.indexOf("async function desactivar(");
  const crudo = i === -1 ? "" : src.slice(i, src.indexOf("\n}\n", i));
  /*
   * SIN COMENTARIOS, y no es cosmetico: la primera version de este chequeo daba
   * FALSO POSITIVO en `buscarVinculados` porque el cuerpo lo NOMBRA —en el comentario
   * que explica por que NO se usa—. Un chequeo que matchea su propia prosa es el
   * corolario de CLAUDE.md aplicado a si mismo, y ya habia pasado con `proyectoNombre`.
   */
  const cuerpo = crudo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  if (!cuerpo) {
    mal("no encuentro el cuerpo de `desactivar`", "el chequeo no puede correr sobre nada.");
  } else {
    /* La accion sobre los socios tiene que estar DENTRO del bucle que los recorre:
       que exista la variable no prueba que se los toque. */
    const arrastra = /for\s*\(const \w+ of socios\)[\s\S]{0,160}createSetDisabledAction/.test(cuerpo);
    if (!arrastra) {
      mal("`desactivar` no arrastra los vinculados",
        "apagar V2 vuelve a dejar SONANDO A2. Ya paso una vez y se tapo muteando a mano.");
    } else {
      ok("arrastra los vinculados y los mete en la misma transaccion");
    }

    if (/buscarVinculados\s*\(/.test(cuerpo)) {
      mal("`desactivar` llama `buscarVinculados`",
        "esa funcion recorre TODAS las pistas por CADA clip; con 60 suplentes son 60 recorridos, "
        + "que es el patron medido como causa de crash. Indexa el otro tipo UNA vez.");
    } else {
      ok("no usa `buscarVinculados`: indexa el otro tipo en una sola pasada");
    }

    if (!/cambiaron/.test(cuerpo) || !/NO CAMBIÓ NADA/.test(cuerpo)) {
      mal("el veredicto de `desactivar` no mira el CAMBIO",
        "`quedaron` cuenta los que YA estaban: sin `cambiaron` vuelve a decir \"UN Cmd+Z los saca "
        + "todos\" sobre una tanda que no cambio nada, y ese Cmd+Z deshace la operacion ANTERIOR.");
    } else {
      ok("el veredicto distingue cambio de estado, y dice NO CAMBIÓ NADA cuando corresponde");
    }
  }
}

/* ---------- los tres agujeros de `colocar_sincro.js` ---------- */

/*
 * Tres hallazgos ALTA de la revision del 2026-08-20, verificados el 2026-09-10.
 * Los tres son la misma familia: el script confia en algo que no chequea.
 */

titulo("`sincro.py`: el solape estructural no descarta pasadas, y la fusion no envuelve");

/*
 * Dos ALTA de la revision del 2026-08-20, simulados con el codigo real el 2026-09-10.
 *
 * El solape de un grupo con el siguiente es ESTRUCTURAL —un grupo termina en
 * `ini + ventana` y el siguiente empieza en `ini + paso`— asi que dos pasadas contiguas
 * se solapan SIEMPRE. El resolvedor lo trataba como conflicto y se comia la mas chica:
 * 150 s de material colocados 42 s fuera de sincro, con `descartados` VACIO.
 *
 * Y la fusion buscaba en TODA la lista, asi que dos corridas del mismo offset con una
 * pasada distinta en el medio se fusionaban envolviendola, y el reparto por punto medio
 * terminaba con la fase cambiada entre dos tramos.
 */

{
  const sp = fs.readFileSync(path.join(raiz, "herramientas/sincro.py"), "utf8");
  const cuerpo = sp.replace(/^\s*#.*$/gm, "");

  /* Se exige la COMPARACION contra el umbral, no que los tokens existan: la primera
     version de esta guarda pasaba con `solape > 0`, porque `estructural` seguia
     declarado mas arriba. Chequear presencia no es chequear uso. */
  if (!/estructural\s*=\s*\(ventana\s*-\s*paso\)/.test(cuerpo) ||
      !/solape\s*>\s*estructural/.test(cuerpo)) {
    mal("el resolvedor de solapes de `sincro.py` no descuenta el solape ESTRUCTURAL",
      "dos pasadas contiguas se solapan siempre en `ventana - paso`, y la mas chica se "
      + "descarta: material colocado decenas de segundos fuera de sincro, sin aviso.");
  } else {
    ok("el resolvedor solo cuenta como conflicto un solape mayor que el estructural");
  }

  /* La CLAVE del registro, no la palabra: "porque" aparece tambien en prosa del archivo
     y la guarda pasaba sobre la mutacion que renombraba el campo. */
  if (!/"porque"\s*:/.test(cuerpo)) {
    mal("un tramo descartado por solape no se registra",
      "un tramo que desaparece sin dejar rastro es peor que uno mal medido: nadie lo va a mirar.");
  } else {
    ok("los tramos descartados por solape quedan registrados con su motivo");
  }

  if (/prev = next\(\(h for h in fusionados/.test(cuerpo)) {
    mal("la fusion de `sincro.py` busca en TODA la lista",
      "dos corridas del mismo offset con una pasada distinta en el medio se fusionan "
      + "envolviendola, y el reparto por punto medio deja la fase cambiada entre tramos.");
  } else if (!/fusionados\[-1\]/.test(cuerpo)) {
    mal("la fusion de `sincro.py` no se limita al tramo inmediatamente anterior");
  } else {
    ok("la fusion solo mira el tramo inmediatamente anterior, asi no envuelve a nadie");
  }
}

titulo("`colocar_propuesta.js`: piso del flag y planos en orden");

{
  const cp = fs.readFileSync(path.join(raiz, "herramientas/colocar_propuesta.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/PISTA_CORTE\s*<\s*1/.test(cp)) {
    mal("`--pista-corte` no tiene piso",
      "con 0 `pistaDeVideo` lo traduce a V1 en silencio y el audio de cada plano cae en A1 PISANDO el tema.");
  } else { ok("`--pista-corte` rebota con 0 o menos"); }

  if (!/tareas\.sort\(/.test(cp)) {
    mal("`tareas` no se ordena por `desde`",
      "el insert entra a longitud COMPLETA y el overwrite PISA: un plano fuera de orden borra "
      + "todo lo posterior de la pista, con su audio.");
  } else { ok("`tareas` se ordena por `desde` antes de colocar"); }
}

/* ---------- `pistaAudio` significa lo MISMO en los dos verbos ---------- */

/*
 * Hasta el 2026-09-10 no: `insertar` restaba 1 y `colocarLote` tomaba el valor crudo, asi que
 * el mismo `pistaAudio: 2` iba a A2 por un verbo y a A3 por el otro. Medido. Y no era teorico:
 * `colocar_fragmentos.js` tiene dos caminos y le pasa el MISMO valor a los dos — en el armado
 * real de un videoclip, 29 fragmentos por lote y 59 por pasos, con el audio en dos pistas distintas.
 */

titulo("`pistaAudio` es 1-based en TODOS los verbos que lo aceptan");

{
  const cuerpos = ["insertar", "colocarLote"].map((v) => {
    const i = srcComandos.indexOf("async function " + v + "(");
    return { v: v, txt: i === -1 ? "" : srcComandos.slice(i, srcComandos.indexOf("\n}\n", i)) };
  });
  const malos = cuerpos.filter((c) => !/params\.pistaAudio\s*-\s*1/.test(c.txt)).map((c) => c.v);
  if (malos.length) {
    mal("`pistaAudio` no es 1-based en: " + malos.join(", "),
      "un mismo nombre de parametro mandando el audio a pistas distintas segun el verbo. "
      + "El que lo pase igual a los dos reparte su audio en dos pistas sin enterarse.");
  } else {
    ok("`insertar` y `colocarLote` interpretan `pistaAudio` igual");
  }
}

titulo("`colocar_sincro.js`: piso del flag, clamp al material, y mirar los vinculados");

{
  const cs = fs.readFileSync(path.join(raiz, "herramientas/colocar_sincro.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /* 1. El encabezado prometia "nunca escribe en A1", pero eso es una condicion sobre el
        FLAG y no estaba chequeada: con `--desde-pista 0` el audio del primer tramo cae
        en A1 y PISA el tema. */
  if (!/DESDE\s*<\s*1/.test(cs) || !/process\.exit\(1\)/.test(cs)) {
    mal("`--desde-pista` no tiene piso",
      "con 0 el audio del primer tramo cae en A1 y PISA el tema, que es lo unico irremplazable.");
  } else {
    ok("`--desde-pista` rebota con 0 o menos");
  }

  /* 2. `salN` preservaba la duracion sin mirar cuanto dura el material —el dato estaba
        en `m.e.dur` y no se leia—, asi que pedia out-points que no existen. Es la causa
        de la anomalia que el propio archivo registraba como "sin causa identificada". */
  if (!/salN\s*=\s*redondear\(topeMat/.test(cs) && !/Math\.min\(salN/.test(cs)) {
    mal("`salN` no se clampea a la duracion del material",
      "pide un out-point que no existe, que es la familia de fallo silencioso de `editar salida`. "
      + "Medido: material 253,44 e in 3,10 pedian 253,48.");
  } else {
    ok("`salN` se clampea al final del material");
  }

  /* 3. Las tres respuestas de `editar` se descartaban, y con ellas el unico dato que dice
        si el audio siguio al video. El vinculo se deduce por rango EXACTO y un arrastre
        previo del usuario lo rompe: ahi el video se corrige SOLO y el "✓" era del video. */
  if (!/vinculados/.test(cs) || !/nVinc/.test(cs)) {
    mal("`--reparar` no mira los vinculados que devuelve `editar`",
      "si el vinculo estaba roto el video se corrige solo, el audio queda desincronizado y "
      + "huerfano, y el script imprime ✓.");
  } else {
    ok("`--reparar` mira los vinculados y no da por bueno un video sin su audio");
  }
}

/* ---------- desmarcar recuenta sobre el sujeto que borro ---------- */

/*
 * `desmarcar` puede operar sobre la SECUENCIA o sobre un MEDIO, y recontaba
 * siempre `getMarkers(sequence)`. Sacando los de un medio comparaba dos
 * poblaciones distintas: un clip con 3 marcadores en una secuencia con 10
 * informaba "3 -> 10 · NO SE SACO NINGUNO" sobre un borrado que si ocurrio, y
 * devolvia `sacados: -7`. El numero negativo es la firma.
 *
 * El chequeo va acotado al CUERPO del verbo y no al archivo entero, porque
 * `marcar`, `marcadores` y `cortesDeEscena` usan `getMarkers(sequence)` con toda
 * razon —su sujeto ES la secuencia—. Buscarlo en todo el archivo daria un
 * veredicto equivocado: es el falso positivo del `lista[` ya pagado.
 */

titulo("`desmarcar` recuenta sobre el sujeto del que borro, no sobre la secuencia");

{
  const m = srcComandos.match(/async function desmarcar\([\s\S]*?\n\}/);
  if (!m) {
    mal("no encontre el cuerpo de `desmarcar`", "sin el, este chequeo no protege nada");
  } else {
    /*
     * SIN COMENTARIOS. La primera version de este chequeo fallaba sobre el codigo
     * YA ARREGLADO, porque el comentario que explica el bug dice literalmente
     * `getMarkers(sequence)`. Es el chequeo que matchea su propia prosa, que en
     * este repo ya se pago tres veces —`proyectoNombre` en el texto del error,
     * `lista[` agarrando a `marcadores`, y este—. Un chequeo mira CODIGO.
     */
    const cuerpo = m[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const recuentos = [...cuerpo.matchAll(/getMarkers\((sequence|sujeto)\)/g)].map((x) => x[1]);
    if (!recuentos.length) {
      mal("`desmarcar` no lee marcadores de ningun sujeto reconocible",
        "cambio la forma de leerlos y este chequeo quedo ciego");
    } else if (recuentos.indexOf("sequence") !== -1) {
      mal("`desmarcar` usa `getMarkers(sequence)` en vez de `getMarkers(sujeto)`",
        "borra de un sujeto y cuenta en otro: informa NO SE SACO NINGUNO sobre un borrado real,\n         " +
        "y `sacados` sale NEGATIVO. Es un contador ciego en un verbo DESTRUCTIVO.");
    } else {
      ok("`desmarcar` lee y recuenta sobre `sujeto`", recuentos.length + " lecturas");
    }
  }
}

/* ---------- el README no puede recetar getKeyframePtr sin la advertencia ---------- */

/*
 * El README decia que `valorEnTiempo` no interpolaba y mandaba a usar
 * `p.getKeyframePtr(ts[ts.length-1]).value`. Las dos mitades quedaron falsas el
 * 2026-08-16 —se saco `getKeyframePtr` de `valorEnTiempo`, y `getValueAtTime` SI
 * interpola, medido— y lo peor es que `getKeyframePtr` es la causa del SIGBUS
 * que tiro Premiere tres veces. O sea: el archivo que CLAUDE.md pide leer ANTES
 * de tocar nada mandaba derecho al regimen que crashea.
 *
 * NO se chequea que la palabra no aparezca: la advertencia correcta TIENE que
 * nombrarla. Se exige que cada aparicion tenga `SIGBUS` cerca, que es lo unico
 * que distingue una advertencia de una receta.
 */

titulo("Cada mencion de `getKeyframePtr` en el README va con su advertencia");

{
  const VENTANA = 1500;
  const apariciones = [...srcReadme.matchAll(/getKeyframePtr/g)].map((x) => x.index);
  if (!apariciones.length) {
    ok("el README no menciona `getKeyframePtr`");
  } else {
    const huerfanas = apariciones.filter((i) =>
      srcReadme.slice(Math.max(0, i - VENTANA), i + VENTANA).indexOf("SIGBUS") === -1);
    if (huerfanas.length) {
      mal(huerfanas.length + " mencion(es) de `getKeyframePtr` en el README sin `SIGBUS` cerca",
        "devuelve un PUNTERO a la estructura interna del keyframe y en rafaga tira Premiere.\n         " +
        "Nombrarlo sin decir eso es una receta, no una advertencia. Para leer un valor va `getValueAtTime`.");
    } else {
      ok("las " + apariciones.length + " menciones de `getKeyframePtr` van con la advertencia del SIGBUS");
    }
  }
}

/* ---------- radiografia: trabajo DETECTADO y SIN VERIFICAR son cosas distintas ---------- */

/*
 * `intacto` es de TRES valores: false (hay trabajo), null (no se pudo verificar) y
 * true. El resumen filtraba con `!c.intacto`, y `!null` es true igual que `!false`,
 * asi que juntaba las dos poblaciones. Y como BASE_VIDEO es ["Opacity","Motion"] y un
 * clip de video intacto trae exactamente esos dos, el `motionSinLeer` se prende en TODO
 * clip de video: la bolsa quedaba llena de nulls.
 *
 * Resultado: los nulls se listaban con la flecha VACIA, se contaban OTRA VEZ en la
 * clausula del SIN VERIFICAR, y el resumen decia un numero mientras el payload decia
 * otro para lo mismo. El resumen es lo unico que se lee.
 *
 * Lo que NO se chequea es la politica —un null cuenta como "no destruir", esta declarado
 * y es el lado seguro—. Se chequea que el informe DISTINGA cual de las dos cosas es cada
 * uno.
 */

titulo("`radiografia` distingue el trabajo DETECTADO del que no pudo verificar");

{
  const m = srcComandos.match(/async function radiografia\([\s\S]*?\n\}/);
  if (!m) {
    mal("no encontre el cuerpo de `radiografia`", "el chequeo no puede correr");
  } else {
    const cuerpo = m[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const separa = /c\.intacto === false/.test(cuerpo) && /c\.intacto === null/.test(cuerpo);
    const juntaba = /filter\(\(c\) => !c\.intacto\)/.test(cuerpo);
    if (juntaba) {
      mal("`radiografia` vuelve a juntar los `false` con los `null` (`!c.intacto`)",
        "un clip que no se pudo verificar se informa como CON TRABAJO MANUAL, con la razon vacia,\n         " +
        "y se cuenta otra vez en la clausula del SIN VERIFICAR. Ademas el resumen deja de coincidir\n         " +
        "con `conTrabajo` del payload: dos numeros para lo mismo en la misma respuesta.");
    } else if (!separa) {
      mal("`radiografia` no separa `intacto === false` de `intacto === null`",
        "son cosas distintas: una es trabajo DETECTADO y la otra es NO SE SABE");
    } else {
      ok("`radiografia` informa por separado el trabajo detectado y lo que no pudo verificar");
    }
  }
}

/* ---------- los verbos de tanda juzgan por el ESTADO, y sin leer VALORES ---------- */

/*
 * `aplicarEscalas` y `aplicarAnim` barren la pista entera —94 clips en el flujo del
 * curso— y los dos contaban como aplicado sin mirar nada. Pero el arreglo obvio,
 * releer el valor de cada clip, seria el error: mete a un verbo de tanda en el
 * regimen de lecturas de param en VOLUMEN, que es el que tiro Premiere tres veces
 * (el crash de PromiseFulfillment). Por eso los dos se verifican con lo que es
 * GRATIS —`contarKeyframes`, que usa `getKeyframeListAsTickTimes` adentro del lock
 * y no lee un solo valor— y el resumen dice explicitamente que el valor NO se
 * releyo.
 *
 * El chequeo mira las dos direcciones: que verifiquen, y que NO se les haya
 * agregado una lectura de valor.
 */

titulo("Los verbos de TANDA verifican por el estado, y sin agregar lecturas de valor");

{
  /*
   * `sinLeerValores` NO es "este verbo no puede leer valores": es "no se le puede
   * AGREGAR una lectura para verificar". `aplicarZooms` lee dos por clip a
   * proposito —deriva el zoom del valor que el clip tiene HOY, no de uno supuesto—
   * y esta declarado con su cota en la guarda de "verbos que leen params". Exigirle
   * lo contrario era rechazar un estado correcto, que es el modo de fallo mas caro
   * para una guarda y esta escrito como corolario en CLAUDE.md. Se cometio al
   * extender este chequeo y lo agarro la primera corrida.
   */
  const casos = [
    { verbo: "aplicarEscalas", sinLeerValores: true, exige: [
        [/corrio = project\.executeTransaction/, "no captura el booleano de la transaccion"],
        [/contarKeyframes\(project, pEsc\)/, "no mira si el param esta ANIMADO, que es donde createSetValueAction devuelve true y no cambia nada"],
        [/animados\.push/, "no informa cuales tenian el param animado"]
      ] },
    { verbo: "aplicarZooms", sinLeerValores: false, exige: [
        [/okActivar = project\.executeTransaction/, "no captura el booleano de activar los keyframes"],
        [/okAgregar = project\.executeTransaction/, "no captura el booleano de agregarlos"],
        [/contarKeyframes\(project, w\.pEsc\)/, "no recuenta los keyframes: contaba 'N con zoom' porque las llamadas no tiraron"]
      ] },
    { verbo: "aplicarAnim", sinLeerValores: true, exige: [
        [/okLimpiar = project\.executeTransaction/, "no captura el booleano de la limpieza, que es su primer acto y es DESTRUCTIVO"],
        [/const espera = w?\.?anima \? 2 : 0/, "no sabe cuantos keyframes tiene que haber quedado"],
        [/rotos\.push/, "no informa los clips que quedaron mal despues de haberles limpiado la animacion"]
      ] }
  ];
  for (const c of casos) {
    const m = srcComandos.match(new RegExp("async function " + c.verbo + "\\([\\s\\S]*?\\n\\}"));
    if (!m) { mal("no encontre el cuerpo de `" + c.verbo + "`"); continue; }
    const cuerpo = m[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const falta = c.exige.filter(([re]) => !re.test(cuerpo));
    if (falta.length) {
      mal("`" + c.verbo + "` " + falta[0][1],
        "es un verbo de TANDA sobre la pista entera: contar como aplicado lo que no se comprobo\n         " +
        "multiplica el dano por 94 y el resumen dice 'terminado'");
    } else if (c.sinLeerValores && /await valorEnTiempo/.test(cuerpo)) {
      mal("`" + c.verbo + "` lee VALORES de param adentro de la tanda",
        "es el regimen que tiro Premiere tres veces (PromiseFulfillment). La verificacion barata es\n         " +
        "`contarKeyframes`; para los valores esta `leerEscalas`, que ya viene acotado con limite y siguiente");
    } else {
      ok("`" + c.verbo + "` verifica por el estado" +
        (c.sinLeerValores ? " y no lee valores de param" : " (lee valores a proposito, con su cota declarada)"));
    }
  }
}

/* ---------- el espaciado va antes de las ESCRITURAS, no de las lecturas ---------- */

/*
 * `dormir(PAUSA)` es la defensa contra rafagas de TRANSACCIONES. Antes de un `clips`,
 * un `medios` o un `revisar` no defiende de nada: no transaccionan y tampoco leen
 * valores de param, que es el otro regimen peligroso. Eran 10 pausas de ~505ms cada
 * una, ~40% del espaciado del bucle interno de los colocadores.
 *
 * Se saco despues de MEDIRLO, no por deduccion: en un proyecto pesado la lectura inmediata
 * ve el estado recien escrito 8 de 8 veces sobre un valor (`fijar` -> `param`) y 6 de
 * 6 sobre un clip recien insertado (`insertar` -> `clips`), con solo los ~203ms del
 * transporte en el medio.
 *
 * El chequeo mira LAS DOS direcciones, y la segunda importa mas: que no vuelva a
 * aparecer una pausa antes de una lectura (desperdicio), y que NO desaparezcan las
 * que estan antes de las escrituras (dano). La guarda del espaciado mira que la SUMA
 * sea >= 500ms, pero no que las pausas existan: borrarlas todas la dejaba pasar.
 */

titulo("El espaciado protege ESCRITURAS: ninguna pausa antes de una lectura, y las de escritura siguen");

{
  const LECTURAS = ["clips", "medios", "revisar", "estado", "marcadores"];
  const tools = ["colocar_fragmentos", "colocar_propuesta", "colocar_sincro", "quirurgico"];
  const desperdicio = [], sinPausa = [];
  for (const t of tools) {
    const lineas = fs.readFileSync(path.join(raiz, "herramientas/" + t + ".js"), "utf8").split("\n");
    let pausasAntesDeEscritura = 0;
    for (let i = 0; i < lineas.length; i++) {
      if (!/^\s*await dormir\(PAUSA\);\s*$/.test(lineas[i])) continue;
      const sig = lineas.slice(i + 1, i + 4).join("\n");
      const m = sig.match(/enviar\("(\w+)"/);
      if (!m) continue;
      if (LECTURAS.indexOf(m[1]) !== -1) desperdicio.push(t + ".js:" + (i + 1) + " antes de `" + m[1] + "`");
      else pausasAntesDeEscritura++;
    }
    if (!pausasAntesDeEscritura) sinPausa.push(t + ".js");
  }
  if (sinPausa.length) {
    mal("herramientas que ya no espacian NINGUNA escritura: " + sinPausa.join(", "),
      "la guarda del espaciado mira que PAUSA + MS_POLL sea >= 500ms, pero no que las pausas existan.\n         " +
      "Sin ellas, una tanda es la rafaga de transacciones que tira Premiere con SIGSEGV.");
  } else if (desperdicio.length) {
    mal(desperdicio.length + " pausa(s) de ~505ms antes de una LECTURA: " + desperdicio.join(", "),
      "el espaciado defiende contra rafagas de TRANSACCIONES; una lectura no transacciona.\n         " +
      "Medido: la lectura inmediata ve el estado recien escrito 8 de 8 y 6 de 6 veces.");
  } else {
    ok("las pausas estan solo antes de escrituras, y las cuatro herramientas siguen espaciando");
  }
}

/* ---------- el tope del lote es UNO SOLO y esta medido ---------- */

/*
 * Los tres verbos de tanda comparten `TOPE_LOTE`. Se chequea que ninguno vuelva a un
 * literal propio, porque el tope arranco en 50 —un numero que sonaba prudente— y a los
 * 50 Premiere dejo de responder con los 53 clips de un proyecto pesado, mientras que a 10 los
 * escribio en 6 transacciones y se releyeron 53 de 53.
 *
 * Entre 10 y 50 no hay ningun dato. Subirlo necesita una medicion, no una constante mas
 * grande, y tres topes sueltos se desincronizan sin que nadie lo note.
 */

titulo("El tope del lote es una sola constante, no un literal por verbo");

{
  const m = srcComandos.match(/^const TOPE_LOTE = (\d+);/m);
  if (!m) {
    mal("no existe `TOPE_LOTE` en comandos.js",
      "los tres verbos de tanda tienen que compartir el tope: sueltos se desincronizan");
  } else if (Number(m[1]) > 10) {
    mal("`TOPE_LOTE` es " + m[1] + ", y lo medido es 10",
      "con 50 Premiere dejo de responder sobre los 53 clips de un proyecto pesado; con 10 escribio\n         " +
      "en 6 transacciones y se releyeron 53 de 53. Entre 10 y 50 no hay dato: subirlo se mide.");
  } else {
    const sueltos = [];
    for (const v of ["aplicarEscalas", "aplicarZooms", "aplicarAnim"]) {
      const c = srcComandos.match(new RegExp("async function " + v + "\\([\\s\\S]*?\\n\\}"));
      if (!c) { sueltos.push(v + " (no se encontro)"); continue; }
      const cuerpo = c[0].replace(/\/\*[\s\S]*?\*\//g, "");
      if (!/Math\.min\(TOPE_LOTE,/.test(cuerpo)) sueltos.push(v);
    }
    if (sueltos.length) {
      mal("verbos de tanda que no usan `TOPE_LOTE`: " + sueltos.join(", "),
        "un tope propio se sube en uno y no en los otros, y nadie lo nota hasta que Premiere se cuelga");
    } else {
      ok("los tres verbos de tanda comparten `TOPE_LOTE`", "hoy " + m[1]);
    }
  }
}

/* ---------- y las TRANSACCIONES de un lote tambien se espacian ---------- */

/*
 * `TOPE_LOTE` acota las ACCIONES por transaccion. Esto es el otro eje: cuantas
 * TRANSACCIONES corren seguidas DENTRO de una sola llamada al panel.
 *
 * El `PAUSA` de las herramientas separa LLAMADAS, y la guarda de arriba exige que
 * `PAUSA + MS_POLL` sea >= 500 ms. `colocarLote` hace su propio bucle de lotes, asi que
 * todas sus transacciones caen dentro de UNA llamada y esa pausa no las alcanza: el
 * espaciado real era CERO. Eso crasheo Premiere el 2026-09-10 sobre un videoclip, con 27
 * transacciones seguidas, y en un proyecto pesado ~205 ms ya habia muerto en la 22.
 *
 * Se chequea POR POSICION y no por presencia: el identificador tambien aparece en el
 * comentario que lo explica, y este repo ya tuvo dos guardas que matchearon su propia
 * prosa. La espera tiene que estar DENTRO del bucle y ANTES de la primera transaccion.
 */

titulo("Las transacciones de `colocarLote` se espacian entre lotes");

{
  const m = srcComandos.match(/^const MS_ENTRE_TX = (\d+);/m);
  const c = srcComandos.match(/async function colocarLote\([\s\S]*?\n\}/);
  if (!m) {
    mal("no existe `MS_ENTRE_TX` en comandos.js",
      "sin el, el bucle de lotes de `colocarLote` corre sus transacciones sin una sola pausa");
  } else if (Number(m[1]) < 355) {
    mal("`MS_ENTRE_TX` es " + m[1] + "ms, y lo medido es que ~205ms mata",
      "en un proyecto pesado a ~205ms fallo 2 de 2 —EXC_BAD_ACCESS en la 22, colgado en la 34— y a\n         " +
      "~355 y ~505 aguanto 150. Bajarlo de 355 es entrar en el rango que ya se midio que falla.");
  } else if (!c) {
    mal("no se encontro el cuerpo de `colocarLote`");
  } else {
    const cuerpo = c[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const bucle = cuerpo.search(/for\s*\([^)]*lotes\s*\.\s*length/);
    const espera = cuerpo.search(/await\s+esperarEntreTx\s*\(/);
    const tx = cuerpo.indexOf("executeTransaction", bucle < 0 ? 0 : bucle);
    if (bucle < 0) {
      mal("`colocarLote` ya no recorre `lotes` con un for indexado",
        "la guarda ubica la espera respecto del bucle; si cambio la forma, hay que reescribirla");
    } else if (espera < 0) {
      mal("`colocarLote` NO espera entre lotes",
        "sus transacciones corren dentro de UNA llamada, donde el `PAUSA` de las herramientas\n         " +
        "no llega. Medido: 27 seguidas tiraron Premiere sobre un videoclip.");
    } else if (!(bucle < espera && espera < tx)) {
      mal("la espera de `colocarLote` no esta dentro del bucle y antes de la transaccion",
        "bucle en " + bucle + ", espera en " + espera + ", transaccion en " + tx + ".\n         " +
        "Una espera despues de las transacciones no separa nada.");
    } else {
      ok("`colocarLote` espera entre lotes", m[1] + "ms, dentro del bucle y antes de transaccionar");
    }
  }
}

/* ---------- final ---------- */

console.log("");
if (fallos) {
  console.log(fallos === 1 ? "1 falla" : fallos + " fallas");
  process.exit(1);
}
console.log("todo ok");
