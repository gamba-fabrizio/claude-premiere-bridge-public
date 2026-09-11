#!/usr/bin/env node
/* Dispara el Reload del panel por Keyboard Maestro y COMPRUEBA que haya entrado.
 *
 * Cada cambio en `plugin/` necesita un Reload en UDT. Automatizarlo con un clic es comodo y
 * peligroso a la vez: un clic que no encuentra el boton no avisa, y las pruebas siguientes corren
 * contra el codigo VIEJO pareciendo decir otra cosa. Es el modo de fallar numero uno del CLAUDE.md.
 *
 * Por eso esto NO informa "recargado" porque el macro no tiro: el panel escribe en su latido el
 * `cargadoEn` de cuando se cargo, y acá se espera a que ese sello sea POSTERIOR al archivo mas
 * nuevo de `plugin/`. Si no llega, se dice que no entro.
 *
 *   node herramientas/recargar.js              dispara el macro y comprueba
 *   node herramientas/recargar.js --mirar     SOLO mira si el panel esta al dia
 *   node herramientas/recargar.js "Otro macro"
 *
 * El modo `--mirar` es el que vale aunque no haya macro: saber que el panel esta desactualizado
 * ya evita el error caro —probar contra codigo viejo y creerle—. Automatizar el clic solo ahorra
 * cinco segundos; SABER es lo que evita perder una tarde.
 */
const fs = require("fs"), path = require("path"), { execFile } = require("child_process");

const RAIZ = path.join(__dirname, "..");
const LATIDO = path.join(RAIZ, "intercambio", "latido.json");
const args = process.argv.slice(2);
const SOLO_MIRAR = args.indexOf("--mirar") !== -1;
/*
 * `--reiniciar`: la unica forma de recargar el plugin cuando esta INSTALADO.
 *
 * Instalado, el panel lee sus archivos AL ARRANCAR Premiere, asi que el macro de UDT no aplica
 * y el reinicio ES la recarga. Y hasta hoy eso no se podia hacer sin el editor: Premiere NO
 * atiende su propio `quit` por AppleEvent —contesta `get name` sin problema pero `quit` y
 * `quit saving no` dan timeout (-1712) y la app sigue abierta 60s despues— y `osascript` no
 * puede simular un Cmd+Q porque no tiene Accesibilidad ("is not allowed to send keystrokes").
 *
 * Lo que SI funciona es un macro de Keyboard Maestro, porque KM ya tiene Accesibilidad —es como
 * clickea el boton de UDT—. Medido el 2026-09-05: cerro en 2 segundos y SIN escribir dump, o sea
 * limpio, a diferencia de `pkill`, que cierra pero deja el dialogo de crash y un dump de
 * terminacion por señal.
 */
const REINICIAR = args.indexOf("--reiniciar") !== -1;
const MACRO_CERRAR = "Cerrar Premiere";
const MACRO = args.filter((a) => a !== "--mirar" && a !== "--reiniciar")[0] || "Reload Bridge";
/* Y el macro para CARGARLO de cero, que no es el mismo: en UDT el boton dice `Load` cuando el
 * plugin no esta corriendo y `Reload` cuando si. Los macros clickean POR IMAGEN, asi que
 * disparar "Reload Bridge" con el panel muerto no encuentra nada y falla en silencio —
 * exactamente lo que paso el 2026-09-01: se reporto "el macro no encontro el boton" cuando el
 * problema era que se estaba pidiendo el macro equivocado. */
const MACRO_CARGA = "Load Bridge";

/*
 * LOS MACROS CLICKEAN POR IMAGEN, asi que UDT tiene que estar AL FRENTE y con su ventana
 * visible: si no, no hay boton en pantalla y el click no encuentra nada. El macro corre, KM
 * no tira error, y el panel nunca arranca — y la herramienta informaba "no arrancó en 120s",
 * que le echa la culpa al panel cuando el problema es la ventana.
 *
 * Medido el 2026-09-02: con Claude al frente, "Load Bridge" no hace nada. Y desde acá NO se
 * puede traer UDT adelante: ni `tell application ... to activate` ni `open -a` la levantan
 * —probadas las dos— y `System Events` no tiene acceso de asistencia para forzarlo.
 *
 * Asi que lo unico honesto es MIRAR y decirlo antes de esperar dos minutos al vacio.
 */
function alFrente() {
  try {
    return require("child_process").execFileSync("osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: "utf8", timeout: 8000 }).trim();
  } catch (e) { return null; }
}
function corriendo(patron) {
  try {
    require("child_process").execFileSync("pgrep", ["-f", patron], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch (e) { return false; }
}

/*
 * EL FLUJO EN FRIO, MEDIDO EL 2026-09-03 CON TODO CERRADO.
 *
 * La causa de que "Load Bridge" no anduviera NO era el macro ni el tiempo de arranque de UDT:
 * era EL FOCO. Con UDT al frente en el instante del click, el panel arranco en **1 segundo**.
 *
 * Y eso se pudo automatizar porque una afirmacion del CLAUDE.md era falsa: decia que desde aca
 * NO se puede traer UDT adelante, con tres metodos "probados". `activate` SI funciona — lo que
 * no funciona es sobre UDT **cerrado**, que es como se habia medido. Con UDT corriendo:
 *
 *     tell application "Adobe UXP Developer Tools" to activate   ->  queda al frente
 *
 * Asi que el orden es: Premiere (bloquea, porque necesita un proyecto que elige el usuario),
 * abrir UDT si hace falta, ESPERARLO, traerlo al frente, y recien ahi el macro.
 *
 * La espera es FIJA y se dice que lo es: `System Events` no tiene acceso de asistencia en esta
 * maquina —`get count of windows` contesta "not allowed assistive access"— asi que no hay forma
 * de detectar que UDT termino de inicializar. Un numero fijo y declarado es mas honesto que un
 * chequeo que no puede mirar.
 */
const ESPERA_UDT_MS = 9000;

function exigirPremiere() {
  if (corriendo("Adobe Premiere Pro")) return true;
  console.error("  PREMIERE NO ESTA ABIERTO. El panel del bridge corre ADENTRO de Premiere:\n" +
    "  sin host no hay nada que cargar, y el macro clickearia al vacio.\n" +
    "  Abri Premiere CON UN PROYECTO y volve a correr esto.");
  return false;
}

function osa(script, timeout) {
  try {
    return require("child_process").execFileSync("osascript", ["-e", script],
      { encoding: "utf8", timeout: timeout || 8000 }).trim();
  } catch (e) { return null; }
}

async function prepararUDT() {
  if (!corriendo("UXP Developer")) {
    console.log("  UDT no esta abierto, lo abro…");
    osa('tell application "Adobe UXP Developer Tools" to activate', 15000);
    for (let i = 0; i < 20 && !corriendo("UXP Developer"); i++) await dormir(1000);
    if (!corriendo("UXP Developer")) {
      console.error("  no pude abrir UDT. Abrilo a mano y volve a correr esto.");
      return false;
    }
    /* La primera apertura INICIALIZA y el click no corre si se dispara antes. Dicho por el
     * editor y confirmado: el macro abrio UDT y el panel no cargo. No se puede detectar, se
     * espera. */
    console.log(`  esperando ${ESPERA_UDT_MS / 1000}s a que UDT inicialice (no es detectable: ` +
                "System Events no tiene acceso de asistencia)…");
    await dormir(ESPERA_UDT_MS);
  }
  /* AL FRENTE, porque los macros clickean por IMAGEN. */
  osa('tell application "Adobe UXP Developer Tools" to activate');
  await dormir(1200);
  const f = alFrente();
  if (f && !/UXP Developer/i.test(f)) {
    console.error(`  no pude traer UDT al frente (quedo "${f}"). Traelo a mano y volve a correr esto.`);
    return false;
  }
  console.log("  UDT al frente.");
  return true;
}

/* El estado del entorno EN EL MOMENTO DEL FALLO, que es cuando explica algo. */
function porQueNoAndubo() {
  const udt = corriendo("UXP Developer");
  const f = alFrente();
  if (!udt) return "y UDT NI SIQUIERA ESTA ABIERTO.";
  if (f && !/UXP Developer/i.test(f)) {
    return `y al frente quedo "${f}": los macros clickean por IMAGEN, asi que el click no ` +
           "encontro el boton. Algo le robo el foco a UDT.";
  }
  return "UDT esta abierto y al frente, asi que el boton no estaba donde el macro lo busca: " +
         "fijate que UDT este en la fila del plugin y que la ventana no este tapada.";
}

const masNuevo = () => {
  const dir = path.join(RAIZ, "plugin");
  let t = 0;
  const rec = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.statSync(p);
      if (st.isDirectory()) rec(p);
      else if (/\.(js|html|json)$/.test(n)) t = Math.max(t, st.mtimeMs);
    }
  };
  rec(dir);
  return t;
};
const leerLatido = () => {
  try { return JSON.parse(fs.readFileSync(LATIDO, "utf8")); } catch (e) { return null; }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function reiniciarPremiere() {
  const { enviar } = require(path.join(RAIZ, "server", "bridge.js"));
  /* La ruta sale de `guardar`, que ademas GUARDA: es lo unico que hace que cerrar sea gratis. */
  let ruta = null;
  try {
    const g = await enviar("guardar", {}, 120000);
    ruta = g.ruta || null;
    console.log(`  guardado: ${ruta || "(sin ruta en la respuesta)"}`);
  } catch (e) {
    console.error(`  NO se pudo guardar antes de cerrar: ${e.message.split("\n")[0]}`);
    console.error("  no cierro nada. Guardá vos y volvé a intentar.");
    return false;
  }
  if (!ruta) {
    console.error("  `guardar` no devolvió la ruta del proyecto, así que no sabría cuál reabrir. No cierro.");
    return false;
  }

  const marca = Date.now();
  if (!osa(`tell application "Keyboard Maestro Engine" to do script "${MACRO_CERRAR}"`, 20000) &&
      corriendo("MacOS/Adobe Premiere Pro")) {
    /* `do script` devuelve "missing value" cuando anda, asi que no se juzga por el retorno: se
     * juzga por si el proceso se fue. Lo de siempre en este repo. */
  }
  console.log(`  macro "${MACRO_CERRAR}" disparado, esperando a que Premiere cierre…`);
  let cerro = false;
  for (let i = 0; i < 60; i++) {
    if (!corriendo("MacOS/Adobe Premiere Pro")) { cerro = true; console.log(`  cerró a los ${i}s`); break; }
    await dormir(1000);
  }
  if (!cerro) {
    console.error(`  Premiere SIGUE ABIERTO tras 60s. Puede haber un diálogo esperando en pantalla,`);
    console.error(`  o el macro "${MACRO_CERRAR}" no existe / está deshabilitado. NO lo fuerzo con pkill:`);
    console.error("  eso le deja a Premiere un dump de terminación anormal y al usuario un diálogo de crash.");
    return false;
  }

  /*
   * ESPERAR A LOS AUXILIARES, NO SOLO AL PROCESO PRINCIPAL (2026-09-11).
   *
   * Antes esto reabria 2 segundos despues de que el proceso principal desapareciera.
   * Premiere deja procesos auxiliares terminando —CEP, el host de UXP, el motor de
   * medios— y reabrir encima de ellos deja la app a medio inicializar: sale un modal
   *
   *     "Failed to initialize — An unexpected error occurred in SelectionFoundation."
   *
   * Premiere despues ANDA: abre el proyecto, edita, exporta, y el panel late. Lo que rompe
   * es el ciclo de esta herramienta, porque **un modal BLOQUEA el Cmd+Q**: el siguiente
   * `--reiniciar` se cuelga los 60s enteros y le echa la culpa al macro, que esta bien.
   *
   * Y el modal puede caer en OTRO MONITOR. Aca son tres pantallas y salio en la 1 con
   * Premiere trabajando en la 3, asi que desde el teclado no se ve y parece que no pasa
   * nada — hasta que el reinicio siguiente falla sin motivo aparente.
   *
   * A mano nunca se veia porque entre cerrar y reabrir pasan varios segundos.
   */
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (!corriendo("Adobe Premiere Pro")) break;       /* incluye los auxiliares */
    await dormir(1000);
  }
  const quedan = corriendo("Adobe Premiere Pro");
  await dormir(8000);                                   /* margen de asentado */
  if (quedan) console.log("  OJO: quedaban procesos de Premiere tras 45s; reabro igual");
  console.log(`  reabriendo ${path.basename(ruta)}…`);
  try {
    require("child_process").execFileSync("open", [ruta], { timeout: 20000 });
  } catch (e) {
    console.error(`  no se pudo reabrir: ${e.message.split("\n")[0]}`);
    return false;
  }
  /* EL VEREDICTO ES EL SELLO DE CARGA, no que el latido exista: el archivo viejo sigue en disco
   * y su mtime puede ser reciente si el panel moribundo alcanzo a escribirlo. Se exige un
   * `cargadoEn` POSTERIOR a la marca. */
  for (let i = 0; i < 90; i++) {
    await dormir(2000);
    const l = leerLatido();
    if (l && l.cargadoEn > marca) {
      console.log(`  panel NUEVO cargado a los ${i * 2}s (${new Date(l.cargadoEn).toLocaleTimeString()})`);
      return true;
    }
  }
  console.error("  Premiere reabrió pero el panel no cargó en 180s.");
  return false;
}

(async () => {
  if (REINICIAR) {
    if (!corriendo("MacOS/Adobe Premiere Pro")) {
      console.error("  Premiere no está abierto: no hay nada que reiniciar.");
      process.exit(1);
    }
    process.exit((await reiniciarPremiere()) ? 0 : 2);
  }
  const codigo = masNuevo();
  const antes = leerLatido();
  console.log(`  plugin mas nuevo: ${new Date(codigo).toLocaleTimeString()}`);

  /* EL PANEL MUERTO NECESITA `Load`, NO `Reload`, y eso decide QUE MACRO disparar.
   *
   * En UDT el boton dice `Load` cuando el plugin no esta corriendo y `Reload` cuando si, y los
   * macros clickean POR IMAGEN: pedir "Reload Bridge" con el panel caido no encuentra el boton
   * y el informe queda culpando al macro. La antiguedad del latido lo distingue sin ambiguedad
   * —el panel late ~1 vez por segundo—, asi que no hay que adivinar. */
  const edad = (() => { try { return (Date.now() - fs.statSync(LATIDO).mtimeMs) / 1000; } catch (e) { return Infinity; } })();
  /* LA ANTIGUEDAD DEL LATIDO NO ALCANZA PARA DECLARARLO MUERTO.
   *
   * El panel late ~1 vez por segundo, pero cuando Premiere esta ocupado el latido se atrasa: se
   * midio 13s con el panel PERFECTAMENTE VIVO —`estado` contestaba— y el umbral de 10s lo dio por
   * muerto. Eso habria disparado `Load Bridge` sobre un panel cargado, o sea cargarlo dos veces.
   *
   * Asi que un latido viejo es una SOSPECHA, no un veredicto: se confirma preguntandole al panel.
   * Es el "no se juzga por el mensaje, se juzga por el estado" de CLAUDE.md, con el latido en el
   * papel del mensaje. */
  let muerto = !antes;
  if (!muerto && edad > 10) {
    try {
      const { enviar } = require(path.join(RAIZ, "server", "bridge.js"));
      await enviar("estado", {}, 20000);
      console.log(`  el latido tiene ${Math.round(edad)}s pero el panel CONTESTA: esta vivo, solo atrasado.`);
    } catch (e) { muerto = true; }
  }
  if (muerto) {
    console.log(`  el panel NO esta latiendo (${antes ? Math.round(edad) + "s sin latir" : "sin archivo"}): hay que CARGARLO, no recargarlo.`);
    if (SOLO_MIRAR) process.exit(2);
    try {
      if (!exigirPremiere()) process.exit(1);
      if (!(await prepararUDT())) process.exit(1);
      await new Promise((res, rej) => execFile("osascript",
        ["-e", `tell application "Keyboard Maestro Engine" to do script "${MACRO_CARGA}"`],
        (e, so, se) => (e ? rej(new Error(String(se || e.message).trim())) : res())));
    } catch (e) {
      console.error(`  no se pudo disparar "${MACRO_CARGA}": ${e.message.split("\n")[0]}`);
      process.exit(2);
    }
    console.log(`  macro "${MACRO_CARGA}" disparado, esperando a que el panel arranque…`);
    for (let i = 0; i < 30; i++) {
      await dormir(4000);
      let e2 = Infinity;
      try { e2 = (Date.now() - fs.statSync(LATIDO).mtimeMs) / 1000; } catch (e) {}
      if (e2 < 5) {
        const ahora = leerLatido();
        console.log(`  el panel arrancó a los ${(i + 1) * 4}s` +
          (ahora && ahora.cargadoEn ? ` (cargado ${new Date(ahora.cargadoEn).toLocaleTimeString()})` : ""));
        /* Y se comprueba que ademas sea el codigo NUEVO: arrancar no es estar al dia. */
        if (ahora && ahora.cargadoEn && ahora.cargadoEn < codigo) {
          console.log("  OJO: arrancó pero con el codigo VIEJO. Recargá una vez mas.");
          process.exit(2);
        }
        process.exit(0);
      }
    }
    console.error("  no arrancó en 120s, " + porQueNoAndubo());
    process.exit(2);
  }
  if (antes.cargadoEn === undefined) {
    console.log("  el latido todavia no trae `cargadoEn`: este reload hay que hacerlo a mano UNA vez.");
  } else if (antes.cargadoEn > codigo) {
    console.log(`  ya estaba al dia (cargado ${new Date(antes.cargadoEn).toLocaleTimeString()}), no hago nada.`);
    process.exit(0);
  }

  console.log(`  el panel esta DESACTUALIZADO (cargado ${antes.cargadoEn ? new Date(antes.cargadoEn).toLocaleTimeString() : "?"}).`);
  if (SOLO_MIRAR) {
    console.log("  hay que recargar el panel en UDT para que corra el codigo nuevo.");
    process.exit(2);
  }

  /* Si KM no esta, o el macro no existe, se DICE — no se sigue como si hubiera recargado. */
  try {
    if (!exigirPremiere()) process.exit(1);
    if (!(await prepararUDT())) process.exit(1);
    await new Promise((res, rej) => execFile("osascript",
      ["-e", `tell application "Keyboard Maestro Engine" to do script "${MACRO}"`],
      (e, so, se) => (e ? rej(new Error(String(se || e.message).trim())) : res())));
  } catch (e) {
    console.error(`  no se pudo disparar el macro "${MACRO}": ${e.message.split("\n")[0]}`);
    console.error("  recargá el panel a mano en UDT.");
    process.exit(2);
  }
  console.log(`  macro "${MACRO}" disparado, esperando a que el panel vuelva…`);

  /* El veredicto es el SELLO, no que el macro no haya tirado. */
  for (let i = 0; i < 40; i++) {
    await dormir(500);
    const l = leerLatido();
    if (l && l.cargadoEn !== undefined && l.cargadoEn > codigo) {
      console.log(`  RECARGADO: el panel se cargo ${new Date(l.cargadoEn).toLocaleTimeString()}, ` +
                  `despues del ultimo cambio. Vuelta ${l.vuelta}.`);
      process.exit(0);
    }
  }
  console.error("  NO ENTRO: pasaron 20s y el panel sigue con el codigo viejo,\n  " +
                porQueNoAndubo());
  process.exit(1);
})().catch((e) => { console.error("  ERROR: " + e.message); process.exit(1); });
