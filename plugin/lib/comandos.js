/**
 * Los verbos del bridge: lo único que toca la API de Premiere.
 *
 * Regla de la casa, heredada de pelearse con esta API: **cada verbo devuelve qué
 * encontró, no si salió bien.** La API falla en silencio —devuelve éxito y no
 * hace nada, o hace otra cosa— así que un `ok: true` no es evidencia de nada.
 * Lo que sirve es un efecto observable: cuántos keyframes había antes y cuántos
 * después, qué clip se leyó, qué params expuso el componente.
 *
 * La contracara: los errores dicen QUÉ SE ENCONTRÓ, no qué faltaba. "El Motion
 * no expuso Scale, tiene: Position, Rotation…" se diagnostica; "no se pudo
 * aplicar" no.
 */

/* global ppro, uxp */

const ppro = require("premierepro");
const uxp = require("uxp");

/**
 * Exportar la secuencia activa. Era el único hueco real del bridge: se podía
 * armar un corte y no había forma de renderizarlo.
 *
 * Estuvo escrito acá y en el README que UXP no exponía exportación. Era FALSO y
 * nadie lo había mirado: `EncoderManager` existe desde 26.3 con `exportSequence`,
 * `encodeFile`, `encodeProjectItem` y eventos de progreso. Apareció leyendo el
 * mapa de cobertura de otro proyecto de MCP, y se confirmó reflejando la API.
 *
 * Tres modos, con los IDs que devuelve `Constants.ExportType`:
 *   · `ya` (IMMEDIATELY) — Premiere renderiza y BLOQUEA hasta terminar
 *   · `ame` (QUEUE_TO_AME) — lo encola en Media Encoder y vuelve al instante
 *   · `lote` (QUEUE_TO_APP) — lo encola en el render interno de Premiere
 *
 * La verificación es que el ARCHIVO APAREZCA, no que la llamada no tire: en modo
 * `ya` se relee el disco al terminar. En los modos de cola no puede verificarse
 * —el archivo lo escribe otro proceso después— y el verbo lo dice en vez de
 * fingir que confirmó algo.
 */
async function exportar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const preset = params.preset ? String(params.preset) : null;
  const salida = params.salida ? String(params.salida) : null;
  if (!preset) throw new Error("Falta `preset`: la ruta a un .epr. Premiere trae ~1000 en Contents/MediaIO/systempresets.");
  if (!salida) throw new Error("Falta `salida`: la ruta del archivo a escribir.");

  const em = ppro.EncoderManager.getManager();
  if (!em) throw new Error("EncoderManager.getManager() devolvió vacío.");

  /*
   * RANGO. `exportSequence` no toma tiempos: lo único que hay son los in/out de la
   * SECUENCIA, con `createSetInPointAction` y `createSetOutPointAction`. Si el
   * export los respeta, esto recorta; si los ignora, sale la secuencia entera y el
   * verbo lo dice comparando lo pedido contra lo que quedó.
   *
   * Los in/out viejos se leen ANTES y se reponen DESPUÉS: son estado visible del
   * usuario en el timeline, y dejárselos movidos por una exportación sería una
   * sorpresa fea. Los getters se llaman FUERA de lockedAccess porque adentro
   * devuelven Promises que pasan cualquier guarda (ver `cortar` en CLAUDE.md).
   */
  const hayRango = params.desde !== undefined || params.hasta !== undefined;
  let inViejo = null, outViejo = null, rangoPuesto = null, rangoError = null, aplico = null;
  const esperarUn = (ms) => new Promise((r) => setTimeout(r, ms));

  /*
   * LOS IN/OUT SE LEEN SIEMPRE, no sólo cuando se pide un rango.
   *
   * `exportSequence` los RESPETA, así que un out viejo —puesto a mano hace días— define el largo
   * del archivo sin que nada lo mencione. Medido el 2026-08-26 en un corporativo: VIDEO 1 salió de
   * 232,52s con la secuencia terminando en 229,08, o sea 3,44s de negro y silencio al final.
   * Los otros dos videos, sin out point, salieron exactos.
   *
   * Lo caro no fue el negro: fue que la ÚNICA forma de detectarlo fue medir el archivo de afuera.
   * Un export que sale más corto se nota; uno que sale más largo con negro al final se entrega.
   *
   * Se leen y se informan los NÚMEROS CRUDOS. La clasificación va aparte y a propósito: los
   * getters no devuelven lo mismo en todos los casos —el CLAUDE.md daba por sabido que sin marca
   * dan 0 y el final, y el 2026-08-27 en un multicamara dieron -400000, un sentinel— así que el verbo dice
   * qué leyó y no sólo qué concluyó.
   */
  let inOutPrevio = null, marca = null;
  try {
    const iP = await sequence.getInPoint(), oP = await sequence.getOutPoint();
    const finP = aSegundos(await sequence.getEndTime());
    const di = aSegundos(iP), ha = aSegundos(oP);
    inOutPrevio = { desde: di, hasta: ha, finSecuencia: finP };
    /* SENTINEL: un valor absurdo no es una marca. -400000 es el que se midió. */
    if (Math.abs(di) > 1e5 || Math.abs(ha) > 1e5) marca = "sin marca (sentinel)";
    /* Indistinguible de no tener marca, y por eso se nombra asi y no "sin marca". */
    else if (Math.abs(di) < 0.001 && Math.abs(ha - finP) < 0.05) marca = "abarca todo";
    else marca = "RECORTA";
  } catch (e) { inOutPrevio = null; marca = null; }

  if (hayRango) {
    try { inViejo = await sequence.getInPoint(); } catch (e) { inViejo = null; }
    try { outViejo = await sequence.getOutPoint(); } catch (e) { outViejo = null; }
    const desde = params.desde !== undefined ? Number(params.desde) : 0;
    const fin = await sequence.getEndTime();
    const hasta = params.hasta !== undefined ? Number(params.hasta) : aSegundos(fin);
    if (!(hasta > desde)) throw new Error(`El rango pedido no avanza: desde ${desde} hasta ${hasta}.`);
    /*
     * DOS TRANSACCIONES, y el IN primero. En una sola, medido el 2026-08-19, el
     * in NO se aplicaba: pidiendo 1–6 sobre una secuencia con in/out en
     * 160,48–181,32 salía un archivo de 6,000s —o sea 0→6— y el in releído daba
     * −400000s, un sentinel.
     *
     * La sospecha es el estado intermedio: si Premiere aplica el out primero,
     * queda out=6 con in=160,48, que es un rango invertido, y lo invalida. Poner
     * el in primero y en su propia transacción evita ese instante.
     *
     * Y se relee CADA UNA por separado, para saber cuál de las dos entró: con las
     * dos juntas, un solo booleano tapaba que una fallara.
     */
    let ok = false, okIn = null, okOut = null;
    try {
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => {
          a.addAction(sequence.createSetInPointAction(aTick(desde)));
        }, "in de exportación");
      });
      try { okIn = Math.abs(aSegundos(await sequence.getInPoint()) - desde) < 0.05; } catch (e) { okIn = null; }
      await esperarUn(1200);
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => {
          a.addAction(sequence.createSetOutPointAction(aTick(hasta)));
        }, "out de exportación") && ok;
      });
      try { okOut = Math.abs(aSegundos(await sequence.getOutPoint()) - hasta) < 0.05; } catch (e) { okOut = null; }
    } catch (e) { rangoError = e && e.message ? e.message : String(e); }
    if (!ok && !rangoError) rangoError = "executeTransaction devolvió false";
    // Se RELEE: que la transacción diga true no prueba que el valor haya entrado.
    if (!rangoError) {
      try {
        const i = await sequence.getInPoint(), o = await sequence.getOutPoint();
        rangoPuesto = { desde: aSegundos(i), hasta: aSegundos(o) };
      } catch (e) { rangoPuesto = null; }
    }
    if (rangoError) throw new Error(`No se pudo poner el rango: ${rangoError}`);
    // Si el IN no entró, el export va a arrancar en 0 y hay que DECIRLO: informar
    // "rango 1–6" sobre un archivo que empieza en 0 es mentir con un número.
    aplico = { in: okIn, out: okOut };
    await esperarUn(1200);   // no encadenar transacciones con lo que viene
  }

  let ame = null;
  try { ame = await em.isAMEInstalled; } catch (e) { ame = null; }

  const MODOS = {
    ya: ppro.Constants.ExportType.IMMEDIATELY,
    ame: ppro.Constants.ExportType.QUEUE_TO_AME,
    lote: ppro.Constants.ExportType.QUEUE_TO_APP
  };
  const modo = params.modo && MODOS[params.modo] ? params.modo : "ame";
  if (modo !== "ya" && ame === false) {
    throw new Error(`El modo "${modo}" necesita Media Encoder y isAMEInstalled dio false. Probá con modo "ya".`);
  }

  // ¿ya existía el archivo? Sin esto, un export que no hace nada sobre un archivo
  // viejo se informaría como exitoso.
  const existe = async (ruta) => {
    try { return !!(await uxp.storage.localFileSystem.getEntryWithUrl("file:" + ruta)); }
    catch (e) { return false; }
  };
  const habia = await existe(salida);

  /*
   * `getExportFileExtension` NO EXISTE en el manager —contesta "is not a function"—
   * aunque figuraba en el reflejo. Se sigue consultando porque no cuesta nada y
   * puede aparecer en otra versión, pero el error se INFORMA en vez de tragarse:
   * tragarlo dejaba "extensión null" sin decir por qué.
   */
  let ext = null, extError = null;
  try { ext = await em.getExportFileExtension(preset); }
  catch (e) { extError = e && e.message ? e.message : String(e); }

  /*
   * La aridad dice 0 y son varios, como en el resto de esta API. Se enumeran las
   * formas plausibles y gana la que no tira; el efecto se comprueba después.
   */
  const intentos = [];
  let via = null;
  /*
   * MEDIDO el 2026-08-19: la que anda es (secuencia, TIPO, salida, preset), con el
   * ExportType SEGUNDO. Va primera para no encadenar llamadas de más.
   *
   * Y la que estaba primera —(secuencia, salida, preset, tipo)— NO tira: devuelve
   * `false` y no escribe nada. El booleano era la evidencia y la primera versión de
   * este verbo lo descartaba, así que informaba "vía (secuencia, salida, preset,
   * tipo)" sobre un export que no existió.
   */
  const formas = [
    ["(secuencia, tipo, salida, preset)", () => em.exportSequence(sequence, MODOS[modo], salida, preset)],
    ["(secuencia, salida, preset, tipo)", () => em.exportSequence(sequence, salida, preset, MODOS[modo])],
    ["(secuencia, salida, preset)", () => em.exportSequence(sequence, salida, preset)]
  ];
  /*
   * NO se corta en la primera forma que no tira: esta API acepta llamadas y no
   * hace nada, así que "no tiró" no es evidencia. En modo `ya` se mira el DISCO
   * después de cada forma y sólo ahí se para. Medido: la forma
   * (secuencia, salida, preset, tipo) no tira y no escribe nada.
   *
   * Y se guarda lo que DEVUELVE cada una, que antes se descartaba.
   */
  const devoluciones = [];
  let ahora = null;
  for (const [etiqueta, fn] of formas) {
    let dev;
    try { dev = await fn(); }
    catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); continue; }
    devoluciones.push(etiqueta + " → " + (dev === undefined ? "undefined" : JSON.stringify(dev)));
    // `false` es un NO explícito: la firma equivocada contesta eso sin tirar.
    if (dev === false) { intentos.push(etiqueta + ": devolvió false"); continue; }
    if (modo !== "ya") { via = etiqueta; break; }
    if (await existe(salida)) { via = etiqueta; ahora = true; break; }
    intentos.push(etiqueta + ": no tiró pero NO escribió el archivo");
  }
  if (!via) {
    throw new Error(
      `exportSequence no exportó a "${salida}". Intentos: ${intentos.join(" | ")}.` +
      (devoluciones.length ? ` DEVOLVIERON: ${devoluciones.join(" | ")}.` : "") +
      ` Extensión del preset: ${ext || "(no se pudo leer" + (extError ? ": " + extError : "") + ")"}.` +
      ` AME instalado: ${ame}.`
    );
  }
  /*
   * Se reponen los in/out del usuario pase lo que pase con el export.
   *
   * PERO NO SE PUEDEN LIMPIAR. `Sequence` sólo expone createSetInPointAction y
   * createSetOutPointAction: no hay un createClearInOutPointsAction como el de
   * ClipProjectItem. Así que si la secuencia NO tenía in/out, los getters
   * devuelven 0 y el final, y reponer esos valores deja un in/out visible
   * abarcando todo donde antes no había ninguno.
   *
   * Se detecta y se AVISA, en vez de informar "repuesto" y dejarle al usuario una
   * marca que él no puso. Limpiarlo es Opt+X en Premiere.
   */
  let rangoRepuesto = null, noHabiaInOut = false;
  let inOutFinal = null, inOutOriginal = null, volvioBien = null;
  if (hayRango && inViejo && outViejo) {
    /*
     * "NO HABIA IN/OUT" SE DETECTA POR EL SENTINEL, y esto estaba escrito al revés.
     *
     * El CLAUDE.md afirmaba que sin marca los getters devuelven 0 y el final, y sobre esa premisa
     * se construyó el aviso de que reponer deja una marca donde no la había. Medido el 2026-08-28
     * en el proyecto de prueba, cuatro secuencias por la misma vía:
     *
     *     VERTICAL, Nested 01, Nested 02   ->  -400000 / -400000   (sin marca)
     *     HORIZONTAL FHD                   ->   499.88 /  499.92   (marca real)
     *
     * O sea que sin marca devuelven un SENTINEL, no 0 y el final. Y el sentinel SE PUEDE
     * REESCRIBIR: el export de un multicamara del 2026-08-27 lo repuso y la relectura dio -400000 otra vez,
     * así que el estado "sin marca" vuelve y no hay nada que avisar.
     *
     * Lo que sí es una marca real es `0 → final`: abarca todo, pero alguien la puso.
     */
    try {
      noHabiaInOut = Math.abs(aSegundos(inViejo)) > 1e5 || Math.abs(aSegundos(outViejo)) > 1e5;
    } catch (e) { noHabiaInOut = false; }
    await esperarUn(1200);
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(sequence.createSetInPointAction(inViejo));
          a.addAction(sequence.createSetOutPointAction(outViejo));
        }, "reponer in/out");
      });
      rangoRepuesto = true;
    } catch (e) { rangoRepuesto = false; }
    /*
     * Y SE RELEE. Que executeTransaction devuelva true no prueba que el in/out
     * haya vuelto a donde estaba: es el modo de fallar nº1 de CLAUDE.md. Se
     * informa lo que había, lo que quedó, y si coinciden.
     */
    try {
      const i2 = await sequence.getInPoint(), o2 = await sequence.getOutPoint();
      inOutFinal = { desde: aSegundos(i2), hasta: aSegundos(o2) };
      inOutOriginal = { desde: aSegundos(inViejo), hasta: aSegundos(outViejo) };
      volvioBien = Math.abs(inOutFinal.desde - inOutOriginal.desde) < 0.05 &&
                   Math.abs(inOutFinal.hasta - inOutOriginal.hasta) < 0.05;
    } catch (e) { inOutFinal = null; }
  }

  return {
    resumen:
      `"${sequence.name}" → ${salida}` +
      (hayRango
        ? ` · rango ${rangoPuesto ? rangoPuesto.desde.toFixed(2) + "–" + rangoPuesto.hasta.toFixed(2) + "s puesto en la secuencia" : "PEDIDO PERO NO CONFIRMADO"}` +
          (aplico && aplico.in === false ? " · OJO: el IN NO SE APLICÓ, el export arranca en 0" : "") +
          (aplico && aplico.out === false ? " · OJO: el OUT NO SE APLICÓ" : "") +
          (rangoRepuesto === false ? " · OJO: NO se pudieron reponer los in/out viejos" : "") +
          (noHabiaInOut
            ? (inOutFinal && Math.abs(inOutFinal.desde) > 1e5
                ? " · la secuencia no tenía in/out y volvió a no tenerlos (sentinel repuesto y releído)"
                : " · OJO: la secuencia NO tenía in/out y el sentinel NO volvió: puede haber quedado una marca. Se saca con Opt+X.")
            : (inOutFinal && inOutOriginal
                ? ` · in/out ${volvioBien ? "REPUESTOS y releídos" : "MAL REPUESTOS"}: eran ${inOutOriginal.desde.toFixed(2)}–${inOutOriginal.hasta.toFixed(2)}s y quedaron ${inOutFinal.desde.toFixed(2)}–${inOutFinal.hasta.toFixed(2)}s`
                : " · in/out repuestos pero NO se pudieron releer para confirmarlo"))
        : (marca === "RECORTA"
            ? ` · OJO: NO se pidió rango pero la secuencia YA TIENE in/out ` +
              `${inOutPrevio.desde.toFixed(2)}–${inOutPrevio.hasta.toFixed(2)}s (termina en ` +
              `${inOutPrevio.finSecuencia.toFixed(2)}s), y exportSequence los RESPETA: eso define ` +
              `el largo del archivo. Se sacan con Opt+X.`
            : (inOutPrevio
                ? ` · in/out de la secuencia: ${inOutPrevio.desde.toFixed(2)}–${inOutPrevio.hasta.toFixed(2)}s (${marca})`
                : " · los in/out de la secuencia NO se pudieron leer"))) +
      ` · modo ${modo}` + (via ? ` · vía ${via}` : "") +
      (ext ? ` · extensión del preset "${ext}"` : "") +
      (modo === "ya"
        ? (ahora
            ? (habia ? " · el archivo existe (YA EXISTÍA ANTES: no se puede afirmar que se reescribió)" : " · archivo escrito, confirmado en disco")
            : " · OJO: la llamada no tiró y el archivo NO está en disco")
        : " · encolado: el archivo lo escribe otro proceso, ESTO NO CONFIRMA que se haya exportado") +
      (intentos.length ? ` · descartadas: ${intentos.length} forma(s)` : ""),
    secuencia: sequence.name, salida: salida, modo: modo, via: via,
    extensionDelPreset: ext, errorDeExtension: extError, devoluciones: devoluciones, ameInstalado: ame,
    rangoPuesto: rangoPuesto, rangoRepuesto: rangoRepuesto, noHabiaInOut: noHabiaInOut, aplico: aplico,
    inOutPrevio: inOutPrevio, marcaPrevia: marca,
    inOutOriginal: inOutOriginal, inOutFinal: inOutFinal, volvioBien: volvioBien,
    existiaAntes: habia, existeAhora: ahora, intentos: intentos
  };
}

/* ---------- fundamentos ---------- */

/*
 * El proyecto SOLO, para los verbos que no tienen nada que ver con el timeline.
 *
 * Existe porque `getProyectoYSecuencia` exigía una secuencia activa incluso para
 * listar el panel de proyecto, guardar el archivo o reflejar la API. Medido el
 * 2026-08-17 sobre un proyecto recién creado: de siete verbos probados, seis
 * fallaban con "ninguna secuencia activa" y solo `secuencias` andaba. O sea que
 * el bridge era casi inútil en el momento en que arranca todo trabajo real.
 */
async function getProyecto() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");
  return project;
}

/**
 * Abre un proyecto que NO está abierto, o informa qué ve la API sin abrir nada.
 *
 * `Project` expone `open`, `getProject`, `isProject` y `createProject`, y hasta el 2026-08-29 no se
 * había llamado ninguno: sólo se sabía que los nombres existen. Este verbo los prueba.
 *
 * IMPORTA porque el bridge opera sobre el proyecto CON FOCO. Las herramientas mandan el nombre como
 * guarda, pero si el correcto no está abierto lo único que se puede hacer es rebotar y pedirle al
 * usuario que lo traiga al frente. Un `open` que funcione lo resuelve solo.
 *
 * SIN `ruta` NO ABRE NADA: informa el proyecto activo y qué contestan los lectores. Es el modo con
 * el que hay que empezar, porque abrir MUEVE EL FOCO — y el foco es la guarda que impide pegarle a
 * la secuencia equivocada. Estrenar esta llamada apuntando a algo del usuario es cambiarle el piso
 * a la única protección que hay.
 *
 * La aridad no ayuda a adivinar la firma: `open` reporta 0 y en este repo ya está medido que eso no
 * significa nada (`createRemoveItemsAction` también dice 0 y toma 3). Por eso se enumeran formas y
 * el veredicto sale de RELEER cuál quedó activo, no de que la llamada no tire.
 */
async function abrirProyecto(params) {
  const antesP = await ppro.Project.getActiveProject();
  const antes = antesP ? { nombre: String(antesP.name || ""), ruta: String(antesP.path || "") } : null;

  const lectores = {};
  for (const [etq, fn] of [
    ["getProject()", () => ppro.Project.getProject()],
    ["isProject(activo)", () => ppro.Project.isProject(antesP)],
    ["isProject(null)", () => ppro.Project.isProject(null)]
  ]) {
    try { lectores[etq] = JSON.stringify(await fn()); }
    catch (e) { lectores[etq] = "TIRÓ: " + (e && e.message ? e.message : String(e)); }
  }

  if (!params || !params.ruta) {
    return {
      resumen: `SIN ABRIR NADA (falta \`ruta\`) · activo: ${antes ? '"' + antes.nombre + '"' : "ninguno"}` +
        " · " + Object.entries(lectores).map(([k, v]) => k + " → " + String(v).slice(0, 60)).join(" · "),
      antes: antes, lectores: lectores, abrio: false
    };
  }

  const ruta = String(params.ruta);
  const formas = [
    ["open(ruta)", () => ppro.Project.open(ruta)],
    ["open('file://' + ruta)", () => ppro.Project.open("file://" + ruta)],
    ["getProject(ruta)", () => ppro.Project.getProject(ruta)]
  ];
  const intentos = [];
  let via = null, despues = null;
  for (const [etq, fn] of formas) {
    let tiro = null, devolvio = null;
    try { devolvio = await fn(); }
    catch (e) { tiro = e && e.message ? e.message : String(e); }
    /* El veredicto es el ESTADO, no lo que devolvió: se relee quién quedó activo. */
    let act = null;
    try {
      const p = await ppro.Project.getActiveProject();
      act = p ? { nombre: String(p.name || ""), ruta: String(p.path || "") } : null;
    } catch (e) { act = null; }
    const cambio = act && (!antes || act.ruta !== antes.ruta);
    intentos.push({ forma: etq, tiro: tiro, devolvio: devolvio ? "un objeto" : JSON.stringify(devolvio), activo: act, cambio: !!cambio });
    if (cambio) { via = etq; despues = act; break; }
  }

  return {
    resumen:
      `abrir "${ruta.split("/").pop()}" · antes activo ${antes ? '"' + antes.nombre + '"' : "ninguno"}` +
      (via ? ` · ABRIÓ vía ${via} · ahora activo "${despues.nombre}"`
           : ` · NO ABRIÓ: el activo sigue siendo ${antes ? '"' + antes.nombre + '"' : "ninguno"}`) +
      " · " + intentos.map((i) => i.forma + (i.tiro ? " tiró: " + i.tiro.slice(0, 45) : " no tiró")).join(" · "),
    antes: antes, despues: despues, via: via, intentos: intentos, lectores: lectores, abrio: !!via
  };
}

/**
 * Crea un proyecto nuevo. `Project.createProject` existe en el reflejo y nunca se habia llamado.
 *
 * Mismo patron que `abrirProyecto`: se enumeran formas y el veredicto sale del ESTADO —cual quedo
 * activo—, no de que la llamada no tire. Que devuelva un objeto no prueba que haya creado nada:
 * es el modo de fallar numero uno de este repo.
 *
 * El panel NO PUEDE leer el disco, asi que la comprobacion de que el archivo existe la hace el
 * lado del servidor, igual que `guardar` con la fecha de modificacion.
 */
async function crearProyecto(params) {
  if (!params || !params.ruta) {
    throw new Error("Falta `ruta`: la ruta ABSOLUTA del .prproj a crear, con su nombre.");
  }
  const ruta = String(params.ruta);
  const antesP = await ppro.Project.getActiveProject();
  const antes = antesP ? { nombre: String(antesP.name || ""), ruta: String(antesP.path || "") } : null;

  const carpeta = ruta.slice(0, ruta.lastIndexOf("/"));
  const nombre = ruta.slice(ruta.lastIndexOf("/") + 1).replace(/\.prproj$/i, "");
  const formas = [
    ["createProject(ruta)", () => ppro.Project.createProject(ruta)],
    ["createProject(nombre, carpeta)", () => ppro.Project.createProject(nombre, carpeta)],
    ["createProject(carpeta, nombre)", () => ppro.Project.createProject(carpeta, nombre)]
  ];
  const intentos = [];
  let via = null, despues = null;
  for (const [etq, fn] of formas) {
    let tiro = null, devolvio = null;
    try { devolvio = await fn(); }
    catch (e) { tiro = e && e.message ? e.message : String(e); }
    let act = null;
    try {
      const p = await ppro.Project.getActiveProject();
      act = p ? { nombre: String(p.name || ""), ruta: String(p.path || "") } : null;
    } catch (e) { act = null; }
    const cambio = act && (!antes || act.ruta !== antes.ruta);
    intentos.push({ forma: etq, tiro: tiro, devolvio: devolvio ? "un objeto" : JSON.stringify(devolvio),
                    activo: act, cambio: !!cambio });
    if (cambio) { via = etq; despues = act; break; }
  }

  return {
    resumen:
      `crear "${nombre}" en ${carpeta} · antes activo ${antes ? '"' + antes.nombre + '"' : "ninguno"}` +
      (via ? ` · CREO vía ${via} · ahora activo "${despues.nombre}"`
           : ` · NO CREÓ NADA: el activo sigue siendo ${antes ? '"' + antes.nombre + '"' : "ninguno"}`) +
      " · " + intentos.map((i) => i.forma + (i.tiro ? " tiró: " + i.tiro.slice(0, 40) : " no tiró")).join(" · "),
    antes: antes, despues: despues, via: via, intentos: intentos, ruta: ruta, creo: !!via
  };
}

/**
 * SONDA: copiar un componente de un clip a otro, con sus valores puestos.
 *
 * Es la pregunta que decide el pendiente 7. Replicar un stack de color hoy exige leer ~460 params
 * —el regimen que tiro Premiere tres veces— pero eso es asi SOLO si hay que reconstruir el efecto
 * param por param. `VideoComponentChain` expone `createAppendComponentAction`, y si acepta un
 * componente sacado del chain de OTRO clip, el efecto se copia entero y no hay que leer nada.
 *
 * Nunca se probo. Esto lo prueba, y el veredicto sale de RELEER un param del destino y compararlo
 * contra el del origen: que la transaccion devuelva true no prueba que los valores hayan viajado
 * —es el modo de fallar numero uno de este repo— y un efecto recien agregado nace con sus defaults,
 * que es justo lo que hay que poder distinguir.
 */
async function copiarEfecto(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  /* EL ORIGEN PUEDE ESTAR EN OTRA SECUENCIA, y ese es el caso que importa: replicar el stack de
   * color de un montaje en otro. Sin esto el verbo solo servia entre dos clips del mismo
   * timeline, que es la parte que uno menos necesita.
   *
   * La secuencia de origen NO se activa: se la agarra por nombre de `project.getSequences()` y se
   * le pide el clip. Activarla movería el timeline que el usuario está mirando, y el destino
   * tiene que seguir siendo la activa igual. */
  let seqOrigen = sequence, dondeOrigen = "la misma secuencia";
  if (params.secuenciaOrigen) {
    const lista = await project.getSequences();
    const nombres = [];
    let hallada = null;
    for (let i = 0; i < lista.length; i++) {
      const n = String(lista[i].name);
      nombres.push(n);
      if (!hallada && n.toLowerCase().indexOf(String(params.secuenciaOrigen).toLowerCase()) !== -1) hallada = lista[i];
    }
    if (!hallada) throw new Error(`No hay ninguna secuencia que coincida con "${params.secuenciaOrigen}". Hay: ${nombres.join(", ")}.`);
    if (String(hallada.name) === String(sequence.name)) {
      dondeOrigen = "la misma secuencia (secuenciaOrigen apunta a la activa)";
    } else {
      seqOrigen = hallada;
      dondeOrigen = `la secuencia "${hallada.name}"`;
    }
  }

  const orig = await ubicarClip(seqOrigen, { pista: params.pistaOrigen, indice: params.indiceOrigen });
  const dest = await ubicarClip(sequence, { pista: params.pistaDestino, indice: params.indiceDestino });
  if (!orig) throw new Error(`No hay clip en ${params.pistaOrigen}[${params.indiceOrigen}] de ${dondeOrigen}.`);
  if (!dest) throw new Error(`No hay clip en ${params.pistaDestino}[${params.indiceDestino}] de la secuencia activa.`);
  const buscado = String(params.efecto || "");
  if (!buscado) throw new Error("Falta `efecto`: el nombre visible del componente a copiar.");
  const paramTestigo = String(params.param || "");

  /* UN CLIP PUEDE TENER EL MISMO EFECTO VARIAS VECES, y no es raro: la capa base de un institucional
   * lleva DOS `Lumetri Color`. Buscar por nombre y quedarse con el primero copiaba uno solo y
   * dejaba un color a medias que se ve plausible — el peor resultado posible. `indiceEfecto`
   * elige CUAL de las apariciones, 0 la primera. Sin el se exige que no haya ambigüedad. */
  const chainO = await orig.clip.getComponentChain();
  const nO = await chainO.getComponentCount();
  const apariciones = [];
  for (let i = 0; i < nO; i++) {
    const c = await chainO.getComponentAtIndex(i);
    if (String(await c.getDisplayName()).toLowerCase() === buscado.toLowerCase()) apariciones.push({ c: c, i: i });
  }
  if (!apariciones.length) throw new Error(`El clip de origen no tiene un componente "${buscado}".`);
  const cual = params.indiceEfecto === undefined ? null : Number(params.indiceEfecto);
  if (cual === null && apariciones.length > 1) {
    throw new Error(`El clip de origen tiene ${apariciones.length} componentes "${buscado}" ` +
      `(en los indices ${apariciones.map((a) => a.i).join(", ")}). Pasá \`indiceEfecto\` (0 = el primero) ` +
      `para decir cual. NO se copió nada: elegir por vos dejaría el color a medias sin avisar.`);
  }
  const elegido = apariciones[cual === null ? 0 : cual];
  if (!elegido) throw new Error(`indiceEfecto ${cual}: el clip de origen tiene ${apariciones.length} "${buscado}" (0 a ${apariciones.length - 1}).`);
  const comp = elegido.c, idxO = elegido.i;

  /* El testigo se lee ANTES en los dos lados: sin el valor de origen no hay con que comparar, y
     sin el del destino no se sabe si ya estaba igual por casualidad. */
  const leer = async (clip) => {
    if (!paramTestigo) return null;
    try {
      const c = await getComponente(clip, buscado);
      if (!c) return null;
      const i = indiceDe(project, c, paramTestigo);
      if (i === -1) return "el param no existe en ese componente";
      /* Con `valorEnTiempo`, que es lo que usa el resto del archivo. La primera version hacia
       * `c.getParam(i).getValue()` adentro del lock y ESE METODO NO EXISTE en esta API: contestaba
       * "getValue is not a function" SIEMPRE, asi que el testigo nunca funciono y el verbo
       * informaba "no se pudo leer" en todas sus corridas desde que se escribio.
       *
       * No es cosmetico: el testigo es la unica parte del verbo que comprueba que los VALORES
       * hayan viajado y no solo el componente. Sin el, `copiarEfecto` contaba componentes —2 → 3—
       * y eso es verdad aunque el efecto llegue con sus defaults. Un verbo que no puede leer su
       * propia comprobacion informa exito parcial sobre algo que no miro. */
      /* El tiempo se pide en el reloj DEL MATERIAL, que es donde viven los keyframes de un
       * param: pasarle el de la secuencia devuelve un valor constante —el ultimo keyframe— en
       * vez del que corresponde. Es el bug que tenia `motion` y esta anotado en CLAUDE.md. */
      const reloj = await relojDelClip(clip);
      const v = await valorEnTiempo(project, c.getParam(i), reloj.aMaterial(await clip.getStartTime()));
      return aNumero(v);
    } catch (e) { return "no se pudo leer: " + (e && e.message ? e.message : String(e)); }
  };
  const testigoOrigen = await leer(orig.clip);
  const testigoDestinoAntes = await leer(dest.clip);

  const chainD = await dest.clip.getComponentChain();
  const antes = await chainD.getComponentCount();
  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => { a.addAction(chainD.createAppendComponentAction(comp)); },
                                      "copiar componente");
    });
  } catch (e) { error = e && e.message ? e.message : String(e); }

  await new Promise((r) => setTimeout(r, 600));
  const chainD2 = await dest.clip.getComponentChain();
  const despues = await chainD2.getComponentCount();
  const testigoDestinoDespues = await leer(dest.clip);

  const viajo = paramTestigo && typeof testigoOrigen === "number" &&
                typeof testigoDestinoDespues === "number" &&
                Math.abs(testigoOrigen - testigoDestinoDespues) < 0.001;

  return {
    resumen:
      `copiar "${buscado}"${apariciones.length > 1 ? ` (la ${(cual === null ? 0 : cual) + 1}ª de ${apariciones.length})` : ""} de ${params.pistaOrigen}[${params.indiceOrigen}] de ${dondeOrigen} a ` +
      `${params.pistaDestino}[${params.indiceDestino}] de la activa "${sequence.name}"` +
      ` · componentes del destino ${antes} → ${despues}` +
      (error ? ` · TIRÓ: ${error}` : ` · transacción ${JSON.stringify(ok)}`) +
      ` · OJO: NO ES UNA COPIA, ES LA MISMA INSTANCIA. createAppendComponentAction comparte el` +
      ` componente: tocar un valor, una mascara o el on/off en cualquiera de los dos clips lo` +
      ` cambia en los DOS. Medido: Exposure 0,4 → 2,5 escrito en el destino y releido 2,5 en el` +
      ` origen, en otra secuencia.` +
      (paramTestigo
        ? ` · testigo "${paramTestigo}": origen ${JSON.stringify(testigoOrigen)}, ` +
          `destino antes ${JSON.stringify(testigoDestinoAntes)} y después ${JSON.stringify(testigoDestinoDespues)}` +
          (viajo ? " · EL VALOR VIAJÓ" : " · el valor NO viajó (el efecto habrá nacido con su default)")
        : " · sin `param` testigo no se puede saber si los valores viajaron"),
    antes: antes, despues: despues, agrego: despues > antes, viajo: !!viajo, origen: dondeOrigen,
    testigoOrigen: testigoOrigen, testigoDestinoAntes: testigoDestinoAntes,
    testigoDestinoDespues: testigoDestinoDespues, indiceEnOrigen: idxO, error: error
  };
}

/**
 * Quita un efecto de un clip. Existe `agregarEfecto` y no habia forma de sacarlo: un efecto puesto
 * por error solo se quitaba a mano.
 *
 * `Motion` y `Opacity` son INTRINSECOS —todo clip de video los tiene— y no se quitan: pedirlos
 * rebota en vez de intentar algo que la API no hace.
 *
 * Objetivo explicito, como los verbos destructivos de este repo: se pide pista+indice. Un efecto
 * que desaparece del clip equivocado no deja hueco ni tira error, solo cambia la imagen.
 */
async function quitarEfecto(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const ubic = await ubicarClip(sequence, params);
  if (!ubic) throw new Error("Hay que decir QUÉ clip: `pista` e `indice`, o `nombre`.");
  const buscado = String(params.efecto || "");
  if (!buscado) throw new Error("Falta `efecto`: el nombre visible del efecto a quitar.");
  if (/^(motion|opacity)$/i.test(buscado.trim())) {
    throw new Error(`"${buscado}" es un componente intrínseco del clip: no se puede quitar, sólo cambiar sus valores.`);
  }

  const chain = await ubic.clip.getComponentChain();
  const antes = await chain.getComponentCount();
  const nombres = [];
  let idx = -1;
  for (let i = 0; i < antes; i++) {
    const n = String(await (await chain.getComponentAtIndex(i)).getDisplayName());
    nombres.push(n);
    if (idx === -1 && n.toLowerCase() === buscado.toLowerCase()) idx = i;
  }
  if (idx === -1) {
    throw new Error(`"${String(await ubic.clip.getName())}" no tiene un efecto "${buscado}". Tiene: ${nombres.join(", ")}.`);
  }

  const comp = await chain.getComponentAtIndex(idx);
  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => { a.addAction(chain.createRemoveComponentAction(comp)); },
                                      "quitar efecto");
    });
  } catch (e) { error = e && e.message ? e.message : String(e); }

  /* Se RELEE: que la transacción devuelva true no prueba que el componente se haya ido. */
  await new Promise((r) => setTimeout(r, 500));
  const chain2 = await ubic.clip.getComponentChain();
  const despues = await chain2.getComponentCount();
  const quedan = [];
  for (let i = 0; i < despues; i++) quedan.push(String(await (await chain2.getComponentAtIndex(i)).getDisplayName()));
  const sigue = quedan.some((n) => n.toLowerCase() === buscado.toLowerCase());

  return {
    resumen:
      `"${buscado}" en "${String(await ubic.clip.getName())}": efectos ${antes} → ${despues}` +
      (error ? ` · TIRÓ: ${error}` : ` · transacción ${JSON.stringify(ok)}`) +
      (sigue ? " · OJO: EL EFECTO SIGUE AHÍ" : " · se fue") +
      ` · quedan: ${quedan.join(", ")}`,
    antes: antes, despues: despues, seFue: !sigue, quedan: quedan, error: error
  };
}

async function getProyectoYSecuencia() {
  const project = await getProyecto();
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new Error(
      "Hay un proyecto abierto pero ninguna secuencia activa. " +
      "Los verbos que NO necesitan secuencia son: secuencias, medios, guardar, importar, api, armarSecuencia."
    );
  }
  return { project, sequence };
}

/**
 * ¿Es un clip de video? Se decide por sus componentes: si tiene Motion, es video.
 *
 * Hace falta porque al seleccionar un clip con audio vinculado la selección
 * devuelve DOS TrackItems —video y audio— y agarrar el primero a ciegas a veces
 * agarra el de audio, que no tiene ninguno de los params que buscamos.
 */
async function esClipDeVideo(item) {
  try {
    const chain = await item.getComponentChain();
    const n = await chain.getComponentCount();
    for (let i = 0; i < n; i++) {
      const c = await chain.getComponentAtIndex(i);
      if (String(await c.getDisplayName()).toLowerCase().indexOf("motion") !== -1) return true;
    }
  } catch (e) { /* si no se puede leer, lo damos por no-video */ }
  return false;
}

/** En qué pista de video vive un TrackItem (0-based), o -1. */
/* La pista de un TrackItem, PREGUNTÁNDOSELA AL ITEM (2026-09-01).
 *
 * Antes se recorrían las pistas buscando por nombre + tiempo de inicio y se devolvía la
 * PRIMERA coincidencia. Con un clip duplicado eso devuelve la pista más baja, que puede no
 * ser la suya: un alt-drag hacia arriba deja el mismo medio, en el mismo instante, en dos
 * pistas, y las dos matchean. Medido: `MM5165.MP4` en V1[37] y en V12[0], las dos
 * 62,48–63,44s; con el de V12 seleccionado, el bridge informaba V1.
 *
 * `TrackItem.getTrackIndex()` existe y contesta bien —V1 → 0, V12 → 11, 0-based—, medido con
 * una sonda en Premiere 26.3.2, no deducido del nombre.
 *
 * EL RECORRIDO QUEDA SÓLO DE RESPALDO, Y ARREGLADO: si encuentra DOS coincidencias devuelve
 * -1 en vez de la primera. Un índice equivocado es peor que ninguno — con -1 el verbo informa
 * que no sabe, con el equivocado informa una pista que no es y el que lo lea después actúa
 * sobre ella. Es la misma regla que ya rige en `moverKeyframe` y en el emparejado de proxies:
 * ante ambigüedad, no adivinar.
 */
async function ubicarPistaDeClip(sequence, clip) {
  try {
    const i = await clip.getTrackIndex();
    /* No se asume la forma: en esta API `getFrameRate()` devuelve un número pelado y
     * `getVideoFrameRate()` devuelve `{value}`. Suponer que es uniforme ya costó una vuelta. */
    const n = (i && typeof i === "object" && typeof i.value === "number") ? i.value : i;
    if (typeof n === "number" && n >= 0) return n;
  } catch (e) {
    /* No se traga: se cae al respaldo de abajo, que es deliberado y no puede mentir.
     * Existe por si una versión de Premiere no expone el método; si lo expone, no se usa. */
  }
  const total = await sequence.getVideoTrackCount();
  const clipStart = await clip.getStartTime();
  const nombreClip = await clip.getName();
  let encontrada = -1;
  for (let t = 0; t < total; t++) {
    const track = await sequence.getVideoTrack(t);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < items.length; i++) {
      const s = await items[i].getStartTime();
      if (String(s.ticks) === String(clipStart.ticks) && (await items[i].getName()) === nombreClip) {
        if (encontrada !== -1) return -1;   // gemelos: NO se elige, se dice que no se sabe
        encontrada = t;
      }
    }
  }
  return encontrada;
}

/**
 * El clip seleccionado, prefiriendo el de video.
 *
 * La preferencia importa: al seleccionar un clip con audio vinculado la
 * selección devuelve DOS TrackItems, y agarrar el primero a ciegas a veces
 * agarra el de audio, que no tiene los params que se suelen buscar.
 *
 * Pero si lo ÚNICO seleccionado es audio, se devuelve ese. La primera versión
 * contestaba "no hay ningún clip seleccionado" con un clip de audio marcado en
 * el timeline, que es falso y manda a buscar el problema donde no está.
 */
async function getClipSeleccionado(sequence) {
  let seleccion = null;
  try { seleccion = await sequence.getSelection(); } catch (e) { return null; }
  if (!seleccion) return null;

  const items = await seleccion.getTrackItems();
  if (!items || !items.length) return null;

  for (let i = 0; i < items.length; i++) {
    if (await esClipDeVideo(items[i])) {
      return {
        clip: items[i], esAudio: false,
        trackIndex: await ubicarPistaDeClip(sequence, items[i])
      };
    }
  }
  return { clip: items[0], esAudio: true, trackIndex: -1 };
}

/** Exige un clip seleccionado, y si no hay dice en qué secuencia estaba mirando. */
/**
 * El clip sobre el que trabajar: el que se PIDIÓ, o el seleccionado.
 *
 * Los verbos de lectura (`param`, `efectos`) usaban solo la selección y se
 * comían `pista`/`indice`/`nombre` sin decir nada. El 2026-08-16 eso hizo leer
 * los efectos de "Cap. 2.mp4" cuando se habían pedido los de la capa de ajuste
 * de V2 — y por poco lleva a concluir que un efecto no se había aplicado cuando
 * lo que pasaba era que se estaba mirando otro clip.
 */
async function clipPedidoOSeleccionado(sequence, params) {
  if (params && (params.nombre !== undefined || params.pista !== undefined || params.indice !== undefined)) {
    const e = await ubicarClip(sequence, params);
    return { clip: e.clip, pista: e.pista, indice: e.indice };
  }
  return await exigirClip(sequence);
}

async function exigirClip(sequence) {
  const sel = await getClipSeleccionado(sequence);
  if (!sel) {
    throw new Error(
      `No hay ningún clip seleccionado en la secuencia "${sequence.name}". ` +
      "Seleccioná uno en el timeline y volvé a pedirlo."
    );
  }
  return sel;
}

/* ---------- componentes y params ---------- */

async function getComponente(clip, nombre) {
  const chain = await clip.getComponentChain();
  const n = await chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = await chain.getComponentAtIndex(i);
    if (String(await c.getDisplayName()) === nombre) return c;
  }
  return null;
}

/**
 * Los nombres visibles de todos los params de un componente.
 *
 * Se usa para los mensajes de error: si no aparece el param que se pedía, el
 * mensaje lista los que SÍ están. Varios bugs se resolvieron solo porque el
 * estado decía qué había.
 */
function listarParams(project, componente) {
  const nombres = [];
  try {
    project.lockedAccess(() => {
      const n = componente.getParamCount();
      for (let i = 0; i < n; i++) {
        try { nombres.push(String(componente.getParam(i).displayName)); }
        catch (e) { nombres.push("<ilegible>"); }
      }
    });
  } catch (e) { /* devolvemos lo que se haya juntado */ }
  return nombres;
}

/*
 * Un param por nombre visible.
 *
 * Sincrónico y adentro de lockedAccess: estos métodos no son promesas, y una
 * referencia sacada de un lock no sirve afuera. Llamarlos con await da
 * "no es una función".
 */
function getParametro(project, componente, nombre) {
  let encontrado = null;
  project.lockedAccess(() => {
    const n = componente.getParamCount();
    for (let i = 0; i < n; i++) {
      const p = componente.getParam(i);
      if (String(p.displayName) === nombre) { encontrado = p; break; }
    }
  });
  return encontrado;
}

/*
 * En qué índice está un param, buscándolo por nombre visible.
 *
 * Hace falta porque los nombres NO son únicos: Lumetri Color repite "Saturation" tres veces,
 * "Temperature", "Tint", "Sharpen", "Look" y "HDR White" dos, y trae uno con nombre vacío —
 * cada grupo anidado tiene su propio juego. Guardar el índice junto al valor es lo único que
 * permite reponerlo en el grupo correcto.
 *
 * Devuelve -1 si no lo encuentra, que es distinto de 0.
 */
function indiceDe(project, componente, nombre) {
  let idx = -1;
  try {
    project.lockedAccess(() => {
      const n = componente.getParamCount();
      for (let i = 0; i < n; i++) {
        if (String(componente.getParam(i).displayName) === nombre) { idx = i; break; }
      }
    });
  } catch (e) { idx = -1; }
  return idx;
}

function contarKeyframes(project, param) {
  let n = -1;
  try {
    project.lockedAccess(() => {
      const t = param.getKeyframeListAsTickTimes();
      n = t && t.length ? t.length : 0;
    });
  } catch (e) { n = -1; }
  return n;
}

/*
 * Los valores de esta API no vienen siempre en la misma forma: el mismo dato
 * puede llegar como número, como string, o envuelto en un objeto {value} —a
 * veces más de una vez—. En vez de asumir una forma, se normaliza.
 */
function aNumero(v, profundidad) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "string") { const n = Number(v); return isNaN(n) ? null : n; }
  if (typeof v === "object" && (profundidad || 0) < 4) return aNumero(v.value, (profundidad || 0) + 1);
  return null;
}

/**
 * Describe qué llegó realmente, para diagnosticar sin adivinar.
 *
 * Existe porque la primera versión de `motion` devolvía `valor: null` y nada
 * más: no había forma de saber si el param no existía, si vino en una envoltura
 * inesperada, o si el normalizador estaba mal. Un null pelado no se depura.
 */
function describirValor(v, profundidad) {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return t + ":" + v;
  if (t === "object") {
    if ((profundidad || 0) > 3) return "objeto (muy anidado)";
    let claves;
    try { claves = Object.keys(v); } catch (e) { claves = null; }
    if (!claves || !claves.length) {
      // Sin claves propias enumerables puede ser una referencia de la API con
      // todo en getters: se prueban los nombres que nos interesan a mano.
      const sondas = ["x", "y", "value"];
      const vistos = [];
      for (let i = 0; i < sondas.length; i++) {
        try {
          const sub = v[sondas[i]];
          if (sub !== undefined) vistos.push(sondas[i] + "=" + describirValor(sub, (profundidad || 0) + 1));
        } catch (e) { vistos.push(sondas[i] + "=<tiró>"); }
      }
      return "objeto sin claves propias {" + (vistos.join(", ") || "nada de x/y/value") + "}";
    }
    return "objeto {" + claves.slice(0, 6).map((k) => {
      try { return k + "=" + describirValor(v[k], (profundidad || 0) + 1); }
      catch (e) { return k + "=<tiró>"; }
    }).join(", ") + "}";
  }
  return t;
}

/**
 * Un booleano, venga como venga.
 *
 * Hace falta porque hay params que son casillas —`Volume > Mute` llega como
 * `{value: false}`— y sin esto se leían como `null`, indistinguibles de un param
 * que no se pudo leer. Apareció recién al poder llegar a un clip de audio.
 */
function aBooleano(v, profundidad) {
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && (profundidad || 0) < 4) {
    return aBooleano(v.value, (profundidad || 0) + 1);
  }
  return null;
}

/**
 * Un punto, venga como venga.
 *
 * Position NO llega como {x, y}: medido en Premiere, llega envuelto y INDEXADO
 * POR NÚMERO — `{value: {0: 0.5, 1: 0.5}}`. Buscar solo `.x`/`.y` daba null y no
 * había forma de saber por qué hasta que el verbo reportó el dato crudo.
 */
function aPunto(v, profundidad) {
  const d = profundidad || 0;
  if (!v || d > 4) return null;

  if (typeof v === "object") {
    if (typeof v.x === "number" && typeof v.y === "number") return { x: v.x, y: v.y };

    // Indexado: array de verdad o un objeto array-like. No se distingue desde
    // afuera y no hace falta: alcanza con que 0 y 1 den números.
    const x = aNumero(v[0]), y = aNumero(v[1]);
    if (x !== null && y !== null) return { x: x, y: y };

    if (v.value !== undefined) return aPunto(v.value, d + 1);
    return null;
  }

  if (typeof v === "string") {
    const p = String(v).split(/[,\s]+/).map(parseFloat).filter(isFinite);
    if (p.length >= 2) return { x: p[0], y: p[1] };
  }
  return null;
}

/** El valor vigente de un param en un tiempo, probando las vías en orden. */
/**
 * El valor de un parámetro en un tiempo dado, en TIEMPO DE MATERIAL.
 *
 * `getValueAtTime` va PRIMERA, y las dos cosas que eso cambia son mejoras:
 *
 * 1) **Saca el puntero del camino caliente.** `getKeyframePtr` devuelve un
 *    puntero a la estructura del keyframe y en ráfaga tira Premiere con SIGBUS
 *    (ver la nota de `getKeyframePtr` más arriba). Esta función la llaman una
 *    docena de verbos, así que era el peor lugar donde tenerlo.
 *
 * 2) **Devuelve el valor INTERPOLADO y no el del keyframe anterior.** El puntero
 *    daba una escalera: en un clip que va de 100 a 110, a la mitad contestaba
 *    100. Medido el 2026-08-16 con las tres vías lado a lado:
 *
 *        frac    puntero   getValueAtTime
 *        0       100       100
 *        0.25    100       102.5
 *        0.5     100       105
 *        0.75    100       107.5
 *
 *    Eso arregla de paso el salto de la cola en `cortar`, que leía en el punto
 *    de corte y heredaba el valor de arranque.
 *
 * Se probó con y sin keyframes, sobre números (`Scale`) y sobre puntos
 * (`Position`), y anduvo en los cuatro casos devolviendo la misma forma
 * `{value}`. El puntero queda de última: si algún parámetro no soportara
 * `getValueAtTime`, una llamada suelta no hace daño — lo que mata es la ráfaga.
 */
async function valorEnTiempo(project, param, tickTime) {
  try {
    const v = await param.getValueAtTime(tickTime);
    if (v !== undefined && v !== null) return v;
  } catch (e) { /* seguimos */ }

  try {
    const kf = await param.getStartValue();
    if (kf) return kf.value;
  } catch (e) { /* seguimos */ }

  let crudo;
  try {
    project.lockedAccess(() => {
      const tiempos = param.getKeyframeListAsTickTimes();
      if (!tiempos || !tiempos.length) return;
      const t = Number(tickTime.ticks);
      let elegido = null;
      for (let i = 0; i < tiempos.length; i++) {
        const ti = Number(tiempos[i].ticks);
        if (ti <= t && (elegido === null || ti > Number(elegido.ticks))) elegido = tiempos[i];
      }
      if (!elegido) elegido = tiempos[0];
      const kf = param.getKeyframePtr(elegido);
      if (kf) crudo = kf.value;
    });
  } catch (e) { crudo = undefined; }
  return crudo !== undefined ? crudo : null;
}

/* ---------- pistas ---------- */

/**
 * Resuelve la etiqueta de pista de VIDEO y **rechaza las de audio**.
 *
 * Sin esto, `{pista: "A1"}` pasaba derecho: `parseInt("A1".slice(1)) - 1` da 0,
 * y el verbo llamaba `getVideoTrack(0)`, o sea **V1**. Operaba sobre la pista
 * equivocada sin decir una palabra — `cerrarHuecos({pista:"A1"})` estiraba
 * clips de video creyendo que arreglaba el audio.
 *
 * Es el peor tipo de error que puede tener este bridge: uno que devuelve éxito.
 * Y era fácil de encontrar de la peor manera, porque `clips` SÍ lista `A1` y los
 * verbos que apuntan a un clip suelto SÍ la aceptan, así que la etiqueta parece
 * válida en todos lados menos acá.
 */
function pistaDeVideo(valor, verbo) {
  const pista = typeof valor === "string" ? valor.toUpperCase() : "V" + (valor || 1);
  const m = /^V(\d+)$/.exec(pista);
  if (!m) {
    throw new Error(
      `\`${verbo}\` trabaja sobre pistas de VIDEO y le llegó "${pista}". ` +
      (/^A\d+$/.test(pista)
        ? `Las de audio no se pueden: el verbo habría operado sobre V${pista.slice(1)} sin avisar.`
        : `Se espera V1, V2, etc.`)
    );
  }
  return { pista: pista, pistaIndex: parseInt(m[1], 10) - 1 };
}

/**
 * Como `pistaDeVideo`, pero acepta las DOS letras. Solo para los verbos que de
 * verdad saben trabajar sobre audio: el resto tiene que seguir rechazando "A1",
 * porque operar sobre la pista equivocada en silencio es peor que no poder.
 */
function pistaDeSecuencia(valor, verbo) {
  const pista = typeof valor === "string" ? valor.toUpperCase() : "V" + (valor || 1);
  const m = /^([VA])(\d+)$/.exec(pista);
  if (!m) throw new Error(`\`${verbo}\`: no se entiende la pista "${pista}". Se espera V1, V2, A1, etc.`);
  return { pista: pista, pistaIndex: parseInt(m[2], 10) - 1, esAudio: m[1] === "A" };
}

/* ---------- tiempo ---------- */

// Un segundo de Premiere. Los tiempos de la API son ticks; los de la
// conversación son segundos, y la conversión va en un solo lugar.
const TICKS_POR_SEGUNDO = 254016000000;

const aSegundos = (tick) => Number(tick.ticks) / TICKS_POR_SEGUNDO;
const aTick = (segundos) =>
  ppro.TickTime.createWithTicks(String(Math.round(segundos * TICKS_POR_SEGUNDO)));

/**
 * Los keyframes NO viven en tiempo de secuencia: viven en TIEMPO DE MATERIAL.
 *
 * Un clip que empieza en el segundo 40 de la secuencia y está recortado para
 * arrancar en el segundo 12 de su fuente tiene su propio reloj. Un keyframe que
 * el usuario ve "en el playhead" se guarda en `inPoint + (playhead − start)`.
 *
 * Es una trampa cara porque en el caso fácil no se nota: si el clip empieza en 0
 * y no está recortado, los dos relojes coinciden y escribir el tiempo de
 * secuencia "funciona". Con UN solo keyframe tampoco se nota nunca, porque el
 * valor queda constante y no importa dónde cayó. Aparece recién al animar, con
 * el movimiento corrido respecto de donde se pidió.
 */
async function relojDelClip(clip) {
  const start = Number((await clip.getStartTime()).ticks);
  const inPoint = Number((await clip.getInPoint()).ticks);

  /*
   * LA VELOCIDAD ENTRA EN LA CUENTA. Un clip al 50% tiene su material corriendo
   * a la mitad, así que dos keyframes separados 5s en la secuencia están
   * separados 2,5s en el material.
   *
   *   material = velocidad × (entrada + secuencia − inicio)
   *
   * Medido: en un clip a 0.5x con entrada 15,84s, pedir keyframes en 100/105/110
   * los ponía en 215,84/225,84/235,84 del timeline —el espaciado duplicado, que
   * es 1/0.5—. La fórmula vieja no tenía el factor y era este mismo caso con la
   * velocidad en 1; por eso pasó todas las pruebas anteriores.
   */
  const velocidad = (await velocidadDe(clip)) || 1;
  const aMaterialTicks = (ticksSecuencia) => velocidad * (inPoint + ticksSecuencia - start);

  return {
    // Sin caer antes del arranque del material.
    aMaterial: (tickSecuencia) =>
      ppro.TickTime.createWithTicks(
        String(Math.round(Math.max(velocidad * inPoint, aMaterialTicks(Number(tickSecuencia.ticks)))))
      ),
    // Y la vuelta, para reportar los keyframes en el reloj que usa el usuario.
    aSegundosDeSecuencia: (tickMaterial) =>
      (Number(tickMaterial.ticks) / velocidad - inPoint + start) / TICKS_POR_SEGUNDO,
    velocidad: velocidad,
    desfaseSegundos: (inPoint - start) / TICKS_POR_SEGUNDO
  };
}

/* ---------- verbos ---------- */

/**
 * Reflexión sobre los objetos de la API: qué métodos existen de verdad.
 *
 * Es un verbo DIAGNÓSTICO y temporal. Existe porque hace falta saber cómo se
 * mueve la selección y el playhead, y la alternativa era probar nombres
 * inventados hasta que alguno no tire — que es como se rompen cosas y como se
 * escriben "no se puede" que después resultan falsos.
 *
 * Solo LEE nombres de métodos del prototipo. No llama a ninguno: una sonda que
 * enumeró llamando getters a lo bruto crasheó Premiere una vez.
 */
async function api(params) {
  // La secuencia es OPCIONAL: reflejar la API no la necesita, y este verbo es
  // justo el que hace falta cuando algo no anda en un proyecto recién creado.
  const project = await getProyecto();
  let sequence = null;
  try { sequence = await project.getActiveSequence(); } catch (e) { sequence = null; }

  /*
   * Con `objeto` refleja una fábrica del módulo por nombre —VideoFilterFactory,
   * SequenceEditor, TransitionFactory— en vez del juego fijo. Cada pregunta
   * nueva sobre la API costaba un Reload; así cuesta una llamada.
   *
   * Sigue sin LLAMAR a nada: lee nombres. Una sonda que enumeró llamando
   * getters a lo bruto crasheó Premiere.
   */
  if (typeof params.objeto === "string") {
    /*
     * Acepta rutas con puntos —"Constants.MediaType"— porque las constantes de
     * esta API viven anidadas y saber sus VALORES es lo que resolvió más de una
     * firma: el tercer argumento de createRemoveItemsAction salió de enumerar
     * Constants.MediaType y probar.
     */
    const partes = params.objeto.split(".");
    let obj = ppro;
    for (let i = 0; i < partes.length; i++) {
      const siguiente = obj ? obj[partes[i]] : undefined;
      if (siguiente === undefined) {
        throw new Error(
          `No se llegó a "${params.objeto}": ${partes.slice(0, i).join(".") || "premierepro"} ` +
          `no expone "${partes[i]}". Tiene: ` +
          Object.getOwnPropertyNames(obj || {}).sort().join(", ")
        );
      }
      obj = siguiente;
    }

    // Si es una bolsa de constantes, lo útil son los valores.
    const valores = {};
    let sonConstantes = false;
    try {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          valores[k] = v; sonConstantes = true;
        }
      }
    } catch (e) { /* no se pudo, seguimos con los nombres */ }
    /*
     * Las constantes SE SUMAN, no reemplazan. La primera versión cortaba acá y
     * devolvía solo los valores: SequenceSettings tiene decenas de constantes y
     * también los métodos que hacían falta, y quedaban escondidos.
     */
    const soloConstantes = sonConstantes ? valores : null;
    /*
     * Con la aridad al lado del nombre: `fn.length` dice cuántos argumentos
     * declara. No siempre es confiable en funciones puenteadas desde nativo —a
     * veces da 0— pero cuando da un número sirve, y es la diferencia entre
     * escribir una firma y adivinarla. Se lee, no se llama.
     */
    const conAridad = (contenedor, nombres) => nombres.map((n) => {
      try {
        const v = contenedor[n];
        return typeof v === "function" ? `${n}(${v.length})` : n;
      } catch (e) { return n + "(?)"; }
    });

    const estaticos = conAridad(
      obj, Object.getOwnPropertyNames(obj).filter((n) => n !== "prototype").sort());
    let deInstancia = [];
    try {
      if (obj.prototype) {
        deInstancia = conAridad(
          obj.prototype,
          Object.getOwnPropertyNames(obj.prototype).filter((n) => n !== "constructor").sort());
      }
    } catch (e) { /* puede no tener prototype accesible */ }
    return {
      resumen:
        `${params.objeto}: ${estaticos.length} estáticos` +
        (deInstancia.length ? `, ${deInstancia.length} de instancia` : "") +
        (soloConstantes ? `, ${Object.keys(soloConstantes).length} constantes` : "") +
        ` · estáticos: ${estaticos.join(", ")}` +
        (deInstancia.length ? ` · instancia: ${deInstancia.join(", ")}` : ""),
      estaticos: estaticos,
      deInstancia: deInstancia,
      constantes: soloConstantes
    };
  }

  const metodosDe = (obj) => {
    if (!obj) return ["<null>"];
    const nombres = new Set();
    try {
      let p = Object.getPrototypeOf(obj);
      let nivel = 0;
      while (p && p !== Object.prototype && nivel < 4) {
        for (const n of Object.getOwnPropertyNames(p)) {
          if (n !== "constructor") nombres.add(n);
        }
        p = Object.getPrototypeOf(p);
        nivel++;
      }
      for (const n of Object.getOwnPropertyNames(obj)) nombres.add(n);
    } catch (e) {
      return ["<no se pudo reflejar: " + e + ">"];
    }
    return [...nombres].sort();
  };

  const salida = {
    sequence: metodosDe(sequence),
    project: metodosDe(project)
  };

  const sel = await getClipSeleccionado(sequence);
  salida.trackItem = sel ? metodosDe(sel.clip) : ["<sin clip seleccionado>"];

  // Un PARAM de verdad: sus métodos no se pueden reflejar desde el módulo
  // porque no hay una clase Param expuesta, solo instancias que salen de un
  // componente.
  try {
    if (sel) {
      const mo = await getComponente(sel.clip, "Motion");
      if (mo) {
        const cual = getParametro(project, mo, "Scale") ? "Scale" : "Scale Height";
        const pp = getParametro(project, mo, cual);
        salida.param = pp ? metodosDe(pp) : ["<sin param de escala>"];
      } else salida.param = ["<el clip no tiene Motion>"];
    } else salida.param = ["<sin clip seleccionado>"];
  } catch (e) { salida.param = ["<no se pudo reflejar: " + e + ">"]; }

  try {
    const track = await sequence.getVideoTrack(0);
    salida.videoTrack = metodosDe(track);
  } catch (e) {
    salida.videoTrack = ["<no se pudo traer V1: " + e + ">"];
  }

  // setSelection existe, pero no cómo se ARMA lo que espera. Se mira el objeto
  // que devuelve getSelection (qué sabe hacer) y las fábricas de nivel superior
  // del módulo, que es donde viven los createX de esta API.
  try {
    const s = await sequence.getSelection();
    salida.selection = metodosDe(s);
  } catch (e) {
    salida.selection = ["<no se pudo traer la selección: " + e + ">"];
  }

  try {
    salida.fabricasDePpro = Object.getOwnPropertyNames(ppro)
      .filter((n) => /select|trackitem/i.test(n))
      .sort();
  } catch (e) {
    salida.fabricasDePpro = ["<no se pudo reflejar ppro: " + e + ">"];
  }

  return {
    resumen:
      `métodos: sequence ${salida.sequence.length}, project ${salida.project.length}, ` +
      `trackItem ${salida.trackItem.length}, videoTrack ${salida.videoTrack.length}`,
    metodos: salida
  };
}

/**
 * Lee el playhead, y opcionalmente lo mueve.
 *
 * Siempre RELEE después de mover y devuelve las dos cosas —a dónde se pidió ir y
 * dónde quedó— porque esta API puede aceptar la llamada y no moverse. La única
 * prueba es la posición posterior.
 */
async function playhead(params) {
  const { sequence } = await getProyectoYSecuencia();

  const antes = await sequence.getPlayerPosition();
  let intento = null;

  if (typeof params.segundos === "number") {
    try {
      await sequence.setPlayerPosition(aTick(params.segundos));
      intento = "setPlayerPosition";
    } catch (e) {
      intento = "setPlayerPosition tiró: " + (e && e.message ? e.message : e);
    }
  }

  const despues = await sequence.getPlayerPosition();
  const segAntes = aSegundos(antes);
  const segDespues = aSegundos(despues);

  return {
    resumen:
      typeof params.segundos === "number"
        ? `playhead ${segAntes.toFixed(2)}s → ${segDespues.toFixed(2)}s ` +
          `(se pidió ${params.segundos.toFixed(2)}s)` +
          (Math.abs(segDespues - params.segundos) > 0.05 ? " · NO SE MOVIÓ A DONDE SE PIDIÓ" : "")
        : `playhead en ${segDespues.toFixed(2)}s`,
    segundos: segDespues,
    segundosAntes: segAntes,
    pedido: typeof params.segundos === "number" ? params.segundos : null,
    via: intento
  };
}

/**
 * Los clips de la secuencia, pista por pista.
 *
 * Es lo que convierte al bridge en algo con lo que se puede trabajar: sin esto
 * solo se ve el clip que el usuario tenga seleccionado.
 */
async function clips(params) {
  const { sequence } = await getProyectoYSecuencia();

  /*
   * UN SOLO recorrido para video y audio. Antes eran dos bucles y divergieron:
   * el de audio no calculaba entrada, desfase ni velocidad porque se escribió
   * antes de que existieran esos campos, y los clips de audio salían con
   * `undefined`. Es el mismo achaque que tuvo `seleccionar` con su propio
   * escaneo: dos caminos para la misma pregunta se separan siempre.
   */
  const grupos = [
    { letra: "V", cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i) },
    { letra: "A", cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i) }
  ];

  // `pista` puede venir como número (1 = V1) o como etiqueta ("V2", "A1").
  const pedida =
    typeof params.pista === "number" ? "V" + params.pista
      : typeof params.pista === "string" ? params.pista.toUpperCase()
      : null;

  const disponibles = [];
  for (const g of grupos) for (let t = 0; t < g.cuantas; t++) disponibles.push(g.letra + (t + 1));
  if (pedida && disponibles.indexOf(pedida) === -1) {
    throw new Error(
      `La secuencia "${sequence.name}" no tiene una pista "${pedida}". Tiene: ${disponibles.join(", ")}.`
    );
  }

  const salida = [];
  for (const g of grupos) {
    for (let t = 0; t < g.cuantas; t++) {
      const etiqueta = g.letra + (t + 1);
      if (pedida && etiqueta !== pedida) continue;
      const track = await g.traer(t);
      if (!track) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (let i = 0; i < items.length; i++) {
        const t4 = await tiemposDe(items[i]);
        salida.push({
          pista: etiqueta,
          indice: i,
          nombre: String(await items[i].getName()),
          desde: t4.desde,
          hasta: t4.hasta,
          dura: Number((t4.hasta - t4.desde).toFixed(3)),
          entrada: t4.entrada,
          desfase: t4.desfase,
          // La velocidad importa para los keyframes y para los tiempos de la
          // transcripción: si no es 1, los dos relojes corren distinto.
          velocidad: await velocidadDe(items[i]),
          /*
           * Y si es CAPA DE AJUSTE, porque no se trata como un clip.
           *
           * Escalarla al 50 —lo que hace el flujo del curso con toda la pista—
           * deja la corrección en un rectángulo en el medio del cuadro y el
           * resto sin corregir. Medido y mirado en un frame el 2026-08-16.
           * Sin este dato no hay forma de distinguirla de un clip común.
           */
          esCapaDeAjuste: await esCapaDeAjuste(items[i])
        });
      }
    }
  }

  return {
    resumen:
      salida.length === 0
        ? `Sin clips en ${pedida || `"${sequence.name}"`}.`
        : `${salida.length} clips en ${pedida || `"${sequence.name}"`} · ` +
          salida.map((c) => `${c.pista}[${c.indice}] "${c.nombre}" ${c.desde}-${c.hasta}s`).join(" · "),
    clips: salida
  };
}

/**
 * Los efectos del clip seleccionado, con los nombres reales de sus params.
 *
 * Es el verbo de descubrimiento: sin esto hay que saber de antemano cómo se
 * llama cada cosa, y los nombres de esta API no son adivinables. El Gaussian
 * Blur se llama "Gaussian Blur (Legacy)"; Motion expone "Scale" y "Scale Width"
 * pero no "Scale Height", y Transform al revés. Listar es más barato que errar.
 */
async function efectos(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const sel = await clipPedidoOSeleccionado(sequence, params);
  const nombreClip = String(await sel.clip.getName());

  const chain = await sel.clip.getComponentChain();
  const n = await chain.getComponentCount();

  const salida = [];
  for (let i = 0; i < n; i++) {
    const c = await chain.getComponentAtIndex(i);
    const nombre = String(await c.getDisplayName());
    salida.push({ indice: i, nombre: nombre, params: listarParams(project, c) });
  }

  return {
    resumen:
      `"${nombreClip}" tiene ${salida.length} efectos: ` +
      salida.map((e) => `${e.nombre} (${e.params.length} params)`).join(", "),
    clip: nombreClip,
    efectos: salida
  };
}

/**
 * Un param de un efecto cualquiera, con sus keyframes en tiempo de SECUENCIA.
 *
 * Los tiempos se devuelven convertidos al reloj del usuario, no en el del
 * material: un keyframe reportado en tiempo de material sería un número que no
 * se corresponde con nada de lo que se ve en el timeline.
 */
async function param(params) {
  /*
   * `param` LEE. Si le llega un valor, hay que rebotarlo y decir con qué verbo
   * se escribe, porque el que lo mandó cree que escribió.
   *
   * Pasó el 2026-08-16 tratando de aplicar un look de Lumetri: se le pasó
   * `valor: 25` a `param`, el verbo lo ignoró y devolvió la lectura —"0"— sin
   * una palabra. Parecía que Lumetri no aceptaba escrituras, cuando lo que
   * pasaba era que se estaba usando el verbo equivocado.
   */
  if (params.valor !== undefined || typeof params.x === "number" || typeof params.y === "number") {
    throw new Error(
      "`param` solo LEE. Para escribir: `fijar` pone un valor fijo sin keyframes " +
      "—que es lo que querés para un color o una escala— y `keyframe` agrega un " +
      "keyframe en el playhead, que anima."
    );
  }
  const { project, sequence } = await getProyectoYSecuencia();
  const sel = await clipPedidoOSeleccionado(sequence, params);
  const nombreClip = String(await sel.clip.getName());
  const nombreEfecto = params.efecto || "Motion";

  const comp = await getComponente(sel.clip, nombreEfecto);
  if (!comp) {
    const chain = await sel.clip.getComponentChain();
    const n = await chain.getComponentCount();
    const hay = [];
    for (let i = 0; i < n; i++) hay.push(String(await (await chain.getComponentAtIndex(i)).getDisplayName()));
    throw new Error(`"${nombreClip}" no tiene un efecto "${nombreEfecto}". Tiene: ${hay.join(", ")}.`);
  }

  const p = getParametro(project, comp, params.param);
  if (!p) {
    throw new Error(
      `El efecto "${nombreEfecto}" de "${nombreClip}" no expuso "${params.param}". ` +
      `Tiene: ${listarParams(project, comp).join(", ")}.`
    );
  }

  const reloj = await relojDelClip(sel.clip);
  const playhead = await sequence.getPlayerPosition();
  const crudo = await valorEnTiempo(project, p, reloj.aMaterial(playhead));

  /*
   * Los tiempos Y el valor de cada keyframe. Sin los valores no se puede leer
   * una animación que ya existe —por ejemplo para copiarle la velocidad a otros
   * clips— y había que mover el playhead a cada uno, que es carísimo.
   */
  const tiempos = [];
  const enKeyframes = [];
  try {
    project.lockedAccess(() => {
      const ts = p.getKeyframeListAsTickTimes();
      if (!ts) return;
      for (let i = 0; i < ts.length; i++) {
        const seg = Number(reloj.aSegundosDeSecuencia(ts[i]).toFixed(3));
        tiempos.push(seg);
        let v = null;
        try { const kf = p.getKeyframePtr(ts[i]); if (kf) v = kf.value; } catch (e) { v = null; }
        const num = aNumero(v), pt = num === null ? aPunto(v) : null;
        enKeyframes.push({ segundos: seg, valor: num !== null ? num : pt });
      }
    });
  } catch (e) { /* sin keyframes o ilegible */ }

  // El orden importa: un booleano no es un número, y aNumero devolvería null
  // para él dejándolo indistinguible de un param ilegible.
  const numero = aNumero(crudo);
  const punto = numero === null ? aPunto(crudo) : null;
  const booleano = numero === null && punto === null ? aBooleano(crudo) : null;
  const salida = {
    clip: nombreClip,
    efecto: nombreEfecto,
    param: params.param,
    valor: numero !== null ? numero : punto !== null ? punto : booleano,
    keyframes: tiempos.length,
    keyframesEnSegundos: tiempos,
    valores: enKeyframes
  };
  if (salida.valor === null) salida.visto = describirValor(crudo);

  return Object.assign(
    {
      resumen:
        `${nombreEfecto} > ${params.param} en "${nombreClip}": ` +
        `${JSON.stringify(salida.valor)} · ${tiempos.length} keyframes` +
        (tiempos.length ? ` en ${tiempos.join("s, ")}s` : ""),
    },
    salida
  );
}

/* ---------- catálogo de efectos ---------- */

/**
 * Los efectos instalados, con su nombre visible y su match name.
 *
 * Se pueden enumerar —`VideoFilterFactory.getMatchNames()` y `getDisplayNames()`—
 * y eso es lo que hace usable a `agregarEfecto`: sin esto habría que saberse los
 * match names de memoria, que es como MZH terminó con "AE.ADBE Geometry2"
 * hardcodeado y descubierto a mano.
 *
 * Los nombres visibles NO son los que uno espera: el Gaussian Blur figura como
 * "Gaussian Blur (Legacy)". Por eso este verbo existe y no se adivina.
 */
/*
 * Estos dos son ASINCRÓNICOS. Sin await devuelven promesas, y una promesa tiene
 * `.length` undefined: el filtro recorre `i < undefined`, no entra nunca, y el
 * catálogo sale VACÍO sin error. Así se veía "0 efectos instalados" en una
 * máquina con Premiere entero.
 *
 * Y la guarda que tenía —comparar las dos longitudes— no lo agarró, porque
 * `undefined !== undefined` es falso. Por eso acá se verifica que sean ARRAYS y
 * no solo que midan lo mismo: una guarda que solo contempla el error imaginado
 * deja pasar el real.
 */
async function leerCatalogo() {
  let visibles, matches;
  try {
    visibles = await ppro.VideoFilterFactory.getDisplayNames();
    matches = await ppro.VideoFilterFactory.getMatchNames();
  } catch (e) {
    throw new Error("No se pudo leer el catálogo de efectos: " + (e && e.message ? e.message : e));
  }

  if (!Array.isArray(visibles) || !Array.isArray(matches)) {
    throw new Error(
      "El catálogo no llegó como listas. getDisplayNames devolvió " +
      describirValor(visibles) + " y getMatchNames " + describirValor(matches) + "."
    );
  }
  if (visibles.length !== matches.length) {
    throw new Error(
      `El catálogo llegó descuadrado: ${visibles.length} nombres visibles y ` +
      `${matches.length} match names. Emparejarlos daría match names falsos.`
    );
  }
  if (!visibles.length) {
    throw new Error("El catálogo llegó vacío: Premiere no reportó ningún efecto de video instalado.");
  }
  return { visibles: visibles, matches: matches };
}

async function catalogo(params) {
  /*
   * Con `transiciones: true` lista las TRANSICIONES en vez de los efectos. Son
   * catálogos distintos: Morph Cut no aparece buscando entre los filtros porque
   * es una transición, y buscarlo ahí y no encontrarlo llevaría a concluir que
   * no está instalado.
   *
   * getVideoTransitionMatchNames es asincrónico como sus equivalentes de
   * VideoFilterFactory; sin await devuelve una promesa y la lista sale vacía sin
   * error. Ya se pagó una vez.
   */
  if (params.transiciones) {
    let nombres;
    try { nombres = await ppro.TransitionFactory.getVideoTransitionMatchNames(); }
    catch (e) { throw new Error("No se pudo leer el catálogo de transiciones: " + (e && e.message ? e.message : e)); }
    if (!Array.isArray(nombres)) {
      throw new Error("El catálogo de transiciones no llegó como lista: " + describirValor(nombres));
    }
    const q = typeof params.buscar === "string" ? params.buscar.toLowerCase() : null;
    const hay = nombres.map(String).filter((n) => !q || n.toLowerCase().indexOf(q) !== -1);
    return {
      resumen:
        `${hay.length} transiciones` + (q ? ` con "${params.buscar}"` : " instaladas") +
        (hay.length ? " · " + hay.slice(0, 60).join(", ") : ""),
      total: hay.length,
      transiciones: hay.slice(0, 60)
    };
  }

  const { visibles, matches } = await leerCatalogo();

  const busca = typeof params.buscar === "string" ? params.buscar.toLowerCase() : null;
  const todos = [];
  for (let i = 0; i < visibles.length; i++) {
    const v = String(visibles[i]), m = String(matches[i]);
    if (busca && v.toLowerCase().indexOf(busca) === -1 && m.toLowerCase().indexOf(busca) === -1) continue;
    todos.push({ nombre: v, matchName: m });
  }

  // Sin filtro son cientos: se corta y se DICE que se cortó, en vez de devolver
  // una lista truncada que parece completa.
  const TOPE = 60;
  const recortada = todos.slice(0, TOPE);

  return {
    resumen:
      `${todos.length} efectos` + (busca ? ` con "${params.buscar}"` : " instalados") +
      (todos.length > TOPE ? ` · se muestran los primeros ${TOPE}, filtrá con "buscar"` : "") +
      (recortada.length ? " · " + recortada.map((e) => e.nombre).join(", ") : ""),
    total: todos.length,
    mostrados: recortada.length,
    efectos: recortada
  };
}

/**
 * Le agrega un efecto al clip seleccionado.
 *
 * Acepta el nombre visible o el match name: pedirle al usuario que sepa que el
 * Transform es "AE.ADBE Geometry2" sería inútil.
 *
 * Verifica releyendo la cadena de componentes. Y espera: un componente recién
 * insertado puede tardar en quedar disponible, y preguntarle los params en el
 * acto devuelve cero —MZH ya se comió esa—.
 */
async function agregarEfecto(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const sel = await exigirClip(sequence);
  const nombreClip = String(await sel.clip.getName());

  const pedido = String(params.efecto || "");
  if (!pedido) throw new Error("Falta `efecto`: el nombre visible o el match name.");

  const { visibles, matches } = await leerCatalogo();

  let matchName = null;
  let nombreVisible = null;
  for (let i = 0; i < matches.length; i++) {
    if (String(matches[i]) === pedido) { matchName = pedido; nombreVisible = String(visibles[i]); break; }
  }
  if (!matchName) {
    const bajo = pedido.toLowerCase();
    const candidatos = [];
    for (let i = 0; i < visibles.length; i++) {
      if (String(visibles[i]).toLowerCase().indexOf(bajo) !== -1) {
        candidatos.push({ nombre: String(visibles[i]), matchName: String(matches[i]) });
      }
    }
    const exacto = candidatos.filter((c) => c.nombre.toLowerCase() === bajo);
    const elegido = exacto.length ? exacto[0] : (candidatos.length === 1 ? candidatos[0] : null);
    if (!elegido) {
      throw new Error(
        candidatos.length
          ? `"${pedido}" es ambiguo. Coinciden: ${candidatos.map((c) => `"${c.nombre}"`).join(", ")}.`
          : `No hay ningún efecto que coincida con "${pedido}". Buscá con el verbo catalogo.`
      );
    }
    matchName = elegido.matchName;
    nombreVisible = elegido.nombre;
  }

  const antes = [];
  const chain = await sel.clip.getComponentChain();
  const n0 = await chain.getComponentCount();
  for (let i = 0; i < n0; i++) antes.push(String(await (await chain.getComponentAtIndex(i)).getDisplayName()));

  const componente = await ppro.VideoFilterFactory.createComponent(matchName);
  if (!componente) throw new Error(`createComponent devolvió nada para "${matchName}".`);

  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((acciones) => {
      acciones.addAction(chain.createAppendComponentAction(componente));
    }, "agregar " + nombreVisible);
  });

  // Recién insertado puede no responder todavía: se reintenta unas pocas veces
  // antes de darlo por perdido.
  let puesto = null;
  for (let intento = 0; intento < 5 && !puesto; intento++) {
    const c = await getComponente(sel.clip, nombreVisible);
    if (c) {
      let cuantos = 0;
      try { project.lockedAccess(() => { cuantos = c.getParamCount(); }); } catch (e) { cuantos = 0; }
      if (cuantos > 0) puesto = c;
    }
    if (!puesto) await new Promise((r) => setTimeout(r, 60));
  }

  const despues = [];
  const chain2 = await sel.clip.getComponentChain();
  const n1 = await chain2.getComponentCount();
  for (let i = 0; i < n1; i++) despues.push(String(await (await chain2.getComponentAtIndex(i)).getDisplayName()));

  return {
    resumen:
      `"${nombreVisible}" en "${nombreClip}": ${antes.length} → ${despues.length} efectos` +
      (despues.length > antes.length
        ? ` · params: ${puesto ? listarParams(project, puesto).join(", ") : "<no respondió a tiempo>"}`
        : " · NO SE AGREGÓ NADA" + (ok ? " (la transacción dijo que sí)" : "")),
    clip: nombreClip,
    efecto: nombreVisible,
    matchName: matchName,
    efectosAntes: antes,
    efectosDespues: despues,
    agrego: despues.length > antes.length,
    params: puesto ? listarParams(project, puesto) : []
  };
}

/* ---------- transcripciones ---------- */

/**
 * La transcripción de un clip, si Premiere ya la hizo.
 *
 * `Transcript` expone hasTranscript, exportToJSON, importFromJSON y
 * querySupportedLanguages: todo LEER y ESCRIBIR transcripciones que ya existen.
 * **No hay forma de disparar la transcripción desde la API** — eso se hace en
 * el panel Text de Premiere, una vez por clip.
 *
 * A qué se le pregunta no está documentado y la aridad solo dice "1", así que
 * se prueban los sujetos candidatos y se informa cuál contestó.
 */
async function transcripcion(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  /*
   * Tres formas de nombrar el sujeto, y la de `medio` NO necesita timeline:
   * hasTranscript trabaja sobre el ClipProjectItem, que sale del panel de
   * proyecto. La primera versión exigía que el clip estuviera en una secuencia y
   * eso dejaba sin consultar a cualquier material recién importado o ya sacado
   * del timeline, sin ninguna razón técnica.
   *
   * Sin clip en el timeline no hay reloj: los tiempos salen en FUENTE nomás,
   * porque "tiempo de secuencia" no significa nada para un material que no está
   * puesto en ningún lado.
   */
  let clip = null, nombreClip = null, projectItem = null;

  if (params.medio) {
    projectItem = await buscarMedio(project, params.medio);
    nombreClip = String(projectItem.name);
  } else if (params.nombre || params.pista) {
    const e = await ubicarClip(sequence, params);
    clip = e.clip; nombreClip = e.nombre;
  } else {
    const sel = await exigirClip(sequence);
    clip = sel.clip; nombreClip = String(await clip.getName());
  }

  if (!projectItem && clip) {
    try { projectItem = await clip.getProjectItem(); } catch (e) { projectItem = null; }
  }

  /*
   * Un ProjectItem crudo da "Invalid parameter": hay que castearlo a
   * ClipProjectItem, el mismo patrón que FolderItem para los bins. De los seis
   * sujetos probados es el único que contesta.
   */
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(projectItem); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${nombreClip}" a ClipProjectItem.`);

  let tiene = false;
  try { tiene = await ppro.Transcript.hasTranscript(clipItem); }
  catch (e) { throw new Error("hasTranscript tiró: " + (e && e.message ? e.message : e)); }

  if (tiene !== true && !(tiene && tiene.value === true)) {
    return {
      resumen:
        `"${nombreClip}" no tiene transcripción. Se dispara a mano en Premiere ` +
        "(panel Text > Transcribe): la API puede leerlas e importarlas, pero no crearlas.",
      clip: nombreClip, hay: false
    };
  }

  let crudo;
  try { crudo = await ppro.Transcript.exportToJSON(clipItem); }
  catch (e) { throw new Error("exportToJSON tiró: " + (e && e.message ? e.message : e)); }

  let datos = crudo;
  if (typeof crudo === "string") {
    try { datos = JSON.parse(crudo); }
    catch (e) {
      return {
        resumen: `Transcripción de "${nombreClip}", pero no es JSON. Empieza con: ${String(crudo).slice(0, 200)}`,
        clip: nombreClip, hay: true, crudo: String(crudo).slice(0, 4000)
      };
    }
  }

  /*
   * `crudo: true` devuelve el ESQUEMA en vez del contenido parseado.
   *
   * Existe porque `ppro.Transcript` tiene `importFromJSON`, o sea que se puede
   * inyectar una transcripción hecha afuera de Premiere — y para armar ese JSON
   * hay que conocer su forma exacta. La única fuente confiable es exportar uno
   * que Premiere ya acepte y mirarlo.
   *
   * Devuelve las claves y un segmento de muestra, no el JSON entero: una
   * transcripción de 20 minutos son cientos de KB y el esquema se ve en el
   * primero.
   */
  if (params.crudo === true) {
    let idiomas = null;
    try { idiomas = await ppro.Transcript.querySupportedLanguages(); } catch (e) { idiomas = "querySupportedLanguages tiró: " + (e && e.message ? e.message : e); }
    const segs = (datos && datos.segments) || [];
    const primero = segs[0] || null;
    return {
      resumen:
        `Esquema del JSON de "${nombreClip}": claves de arriba [${Object.keys(datos || {}).join(", ")}]` +
        ` · ${segs.length} segmento(s)` +
        (primero ? ` · claves del segmento [${Object.keys(primero).join(", ")}]` : "") +
        (primero && Array.isArray(primero.words) && primero.words[0]
          ? ` · claves de la palabra [${Object.keys(primero.words[0]).join(", ")}]`
          : ""),
      clip: nombreClip, hay: true,
      clavesArriba: Object.keys(datos || {}),
      sinSegments: Object.keys(datos || {}).reduce((o, k) => { if (k !== "segments") o[k] = datos[k]; return o; }, {}),
      cuantosSegmentos: segs.length,
      primerSegmento: primero,
      idiomasSoportados: idiomas,
      muestra: String(typeof crudo === "string" ? crudo : JSON.stringify(crudo)).slice(0, 2500)
    };
  }

  const crudos = (datos && datos.segments) || [];
  if (!crudos.length) {
    return {
      resumen: `"${nombreClip}" tiene transcripción pero vino sin segmentos.`,
      clip: nombreClip, hay: true, segmentos: []
    };
  }

  /*
   * LOS TIEMPOS SON DE LA FUENTE, no de la secuencia. La transcripción es del
   * ClipProjectItem —del material— así que cuenta desde el segundo 0 del
   * archivo y no sabe nada de dónde quedó el clip ni de qué parte se usó.
   *
   * Se convierten con el mismo reloj que los keyframes, velocidad incluida. Y se
   * marca lo que cae FUERA del clip: una palabra recortada sigue estando en la
   * transcripción, y mandar a cortar ahí sería mandar a un lugar que no existe.
   */
  const reloj = clip ? await relojDelClip(clip) : null;
  const t4 = clip ? await tiemposDe(clip) : null;
  // Sin clip en el timeline los tiempos quedan en fuente y todo "está dentro":
  // no hay recorte contra el cual medir.
  const aSec = (s) => (reloj ? Number(reloj.aSegundosDeSecuencia(aTick(s)).toFixed(3)) : Number(s.toFixed(3)));
  const dentro = (s) => (t4 ? s >= t4.desde - 0.001 && s <= t4.hasta + 0.001 : true);

  const segmentos = crudos.map((seg) => {
    const palabras = (seg.words || []).map((w) => ({
      texto: String(w.text),
      desde: aSec(w.start),
      hasta: aSec(w.start + (w.duration || 0)),
      // Los de FUENTE también: son los que pide createSetInOutPointsAction para
      // cortar un fragmento. Devolver solo los de secuencia obligaría a
      // reconvertir, que es donde se cuelan los errores de reloj.
      desdeFuente: Number(w.start.toFixed(3)),
      hastaFuente: Number((w.start + (w.duration || 0)).toFixed(3)),
      confianza: typeof w.confidence === "number" ? Number(w.confidence.toFixed(2)) : null,
      finDeOracion: !!w.eos
    }));
    return {
      desde: aSec(seg.start),
      hasta: aSec(seg.start + (seg.duration || 0)),
      desdeFuente: Number(seg.start.toFixed(3)),
      hastaFuente: Number((seg.start + (seg.duration || 0)).toFixed(3)),
      hablante: seg.speaker || null,
      texto: palabras.map((p) => p.texto).join(" "),
      palabras: palabras
    };
  });

  const fuera = segmentos.filter((sg) => !dentro(sg.desde) && !dentro(sg.hasta)).length;

  // Con `buscar`, solo las coincidencias y su tiempo: es lo que sirve para
  // "llevame a donde dice X" sin traerse la transcripción entera.
  if (typeof params.buscar === "string" && params.buscar.trim()) {
    const q = params.buscar.toLowerCase();
    const hits = [];
    for (const sg of segmentos) {
      for (const p of sg.palabras) {
        if (p.texto.toLowerCase().indexOf(q) !== -1) {
          hits.push({
            texto: p.texto, desde: p.desde, hasta: p.hasta,
            desdeFuente: p.desdeFuente, hastaFuente: p.hastaFuente,
            enElClip: dentro(p.desde)
          });
        }
      }
    }
    return {
      resumen:
        `"${params.buscar}" aparece ${hits.length} vez/veces en "${nombreClip}"` +
        (hits.length ? ": " + hits.map((h) => h.desde + "s" + (h.enElClip ? "" : " (recortada)")).join(", ") : "") + ".",
      clip: nombreClip, hay: true, coincidencias: hits
    };
  }

  const palabras = segmentos.reduce((a, x) => a + x.palabras.length, 0);
  const hablantes = [...new Set(segmentos.map((x) => x.hablante))].length;

  return {
    resumen:
      `"${nombreClip}": ${segmentos.length} segmentos, ${palabras} palabras, ${hablantes} hablante(s). ` +
      (clip
        ? `En tiempo de SECUENCIA va de ${segmentos[0].desde}s a ${segmentos[segmentos.length - 1].hasta}s`
        : `En tiempo de FUENTE va de ${segmentos[0].desde}s a ${segmentos[segmentos.length - 1].hasta}s ` +
          "(el material no está en ninguna secuencia, así que no hay tiempo de timeline)") +
      (fuera ? ` · ${fuera} segmento(s) caen fuera del clip (material recortado)` : "") +
      /*
       * Sin `palabras` hay que decir qué NO se está viendo, porque el silencio
       * de los datos se lee como ausencia de silencios en el audio.
       *
       * Premiere segmenta por ORACIÓN y deja 0.08s entre segmento y segmento
       * pase lo que pase. Leyendo solo los segmentos, un módulo entero parece
       * no tener una sola pausa. El 2026-08-15 eso llevó a concluir —y a
       * decirle al usuario— que en el M2 no había silencios que sacar: los
       * había, y una llamada con `palabras: true` los mostró enseguida.
       */
      (!params.palabras
        ? "\n\nOJO: los segmentos cortan por ORACIÓN, no por silencio — entre uno y otro " +
          "siempre hay 0.08s, así que ACÁ NO SE VEN las pausas ni las muletillas. " +
          "Para ubicarlas hace falta `palabras: true`, que da el tiempo de cada palabra."
        : "") +
      "\n\n" + segmentos.map((sg) => sg.texto).join(" "),
    clip: nombreClip,
    hay: true,
    idioma: datos.language || null,
    velocidadDelClip: reloj ? reloj.velocidad : null,
    // Las palabras solo si se piden: son cientos y casi nunca hacen falta enteras.
    segmentos: params.palabras
      ? segmentos
      : segmentos.map((sg) => ({
          desde: sg.desde, hasta: sg.hasta,
          desdeFuente: sg.desdeFuente, hastaFuente: sg.hastaFuente,
          hablante: sg.hablante, texto: sg.texto
        }))
  };
}

/** Busca un medio del proyecto por nombre, o tira diciendo qué hay. */
/*
 * COMPARAR NOMBRES SIN QUE LA NORMALIZACIÓN UNICODE DECIDA.
 *
 * macOS guarda los nombres de archivo en NFD —"á" es "a" más una tilde combinante— y
 * Premiere los devuelve en NFC, "á" como un solo punto de código. Se ven idénticos y NO
 * son la misma cadena: `===` da false y `indexOf` no encuentra nada.
 *
 * Medido el 2026-08-20 sobre "FX3_0490 (Estribillo solo, válida).MP4":
 *
 *     del disco  : 61 cc81 6c696461   ("a" + U+0301)
 *     de Premiere: c3a1   6c696461    (U+00E1)
 *
 * Costó dos cosas al mismo tiempo, las dos silenciosas: `importar` no reconoció que ya
 * estaban y los DUPLICÓ, e `insertar` informó "no hay ningún medio que coincida" con el
 * medio ahí. De 35 archivos, los únicos dos con tilde fueron los únicos dos que fallaron.
 *
 * En castellano esto no es un caso borde, es la mitad del material. Todas las
 * comparaciones de nombre pasan por acá.
 */
const norm = (x) => String(x == null ? "" : x).normalize("NFC");
const igualN = (a, b) => norm(a) === norm(b);
const contieneN = (heno, aguja) =>
  norm(heno).toLowerCase().indexOf(norm(aguja).toLowerCase()) !== -1;

async function buscarMedio(project, nombre) {
  const raiz = await project.getRootItem();
  const vistos = [];
  let encontrado = null;
  const recorrer = async (carpeta, prof) => {
    if (encontrado || prof > 8) return;
    const hijos = await hijosDe(carpeta);
    if (!hijos) return;
    for (let i = 0; i < hijos.length && !encontrado; i++) {
      const sub = await hijosDe(hijos[i]);
      if (sub === null) {
        const n = String(hijos[i].name);
        vistos.push(n);
        if (contieneN(n, nombre)) encontrado = hijos[i];
      } else await recorrer(hijos[i], prof + 1);
    }
  };
  await recorrer(raiz, 0);
  if (!encontrado) {
    throw new Error(
      `No hay ningún medio que coincida con "${nombre}". Hay: ` +
      (vistos.slice(0, 25).join(", ") || "nada") + (vistos.length > 25 ? ` y ${vistos.length - 25} más` : "")
    );
  }
  return encontrado;
}

/**
 * Arma una secuencia nueva con fragmentos de un medio, uno atrás del otro.
 *
 * Es lo que convierte "cortame las partes donde habla de X" en algo ejecutable:
 * la transcripción da los tiempos, esto los corta y los pega.
 *
 * **Los tiempos son de FUENTE**, los `desdeFuente`/`hastaFuente` que devuelve
 * `transcripcion`. Es a propósito: `createSetInOutPointsAction` trabaja sobre el
 * material, y aceptar tiempos de secuencia obligaría a reconvertir acá adentro,
 * que es justo donde se cuelan los errores de reloj.
 *
 * Cada fragmento se pega donde TERMINÓ el anterior, releído del timeline y no
 * calculado: la duración real difiere de la pedida por el redondeo a frames
 * (pedir 10s puede dar 10,01) y esos milisegundos acumulados dejan huecos.
 */
async function armarSecuencia(params) {
  const project = await getProyecto();

  const fragmentos = Array.isArray(params.fragmentos) ? params.fragmentos : [];
  if (!fragmentos.length) {
    throw new Error("Falta `fragmentos`: una lista de {desde, hasta} en segundos de la FUENTE.");
  }
  for (let i = 0; i < fragmentos.length; i++) {
    const f = fragmentos[i];
    if (typeof f.desde !== "number" || typeof f.hasta !== "number" || f.hasta <= f.desde) {
      throw new Error(`El fragmento ${i} no es válido: ${JSON.stringify(f)}. Se esperan números con hasta > desde.`);
    }
    if (!f.medio && !params.medio) {
      throw new Error(`El fragmento ${i} no dice de qué medio sale, y tampoco hay un \`medio\` general.`);
    }
  }

  /*
   * VARIOS MEDIOS. Cada fragmento puede nombrar el suyo, o heredar el `medio`
   * general si todos salen del mismo. Hacía falta para armar un módulo entero a
   * partir de siete grabaciones distintas; con un solo medio por secuencia había
   * que llamar al verbo siete veces y quedaban siete secuencias.
   *
   * Las búsquedas se cachean: buscarMedio recorre los bins recursivamente y
   * repetirlo por fragmento serían decenas de recorridos idénticos.
   */
  const cache = {};
  const resolver = async (nombre) => {
    if (!cache[nombre]) {
      const medio = await buscarMedio(project, nombre);
      let clipItem = null;
      try { clipItem = ppro.ClipProjectItem.cast(medio); } catch (e) { clipItem = null; }
      if (!clipItem) throw new Error(`No se pudo castear "${String(medio.name)}" a ClipProjectItem.`);
      cache[nombre] = { medio: medio, clipItem: clipItem, nombre: String(medio.name) };
    }
    return cache[nombre];
  };

  // Se resuelven TODOS antes de crear nada: si un nombre está mal, conviene
  // fallar sin haber dejado una secuencia a medio armar en el proyecto.
  for (let i = 0; i < fragmentos.length; i++) await resolver(fragmentos[i].medio || params.medio);

  /*
   * La secuencia se crea DESDE EL PRIMER MEDIO y no con createSequence, que la
   * arma con los ajustes por defecto. Si el material no es 1920x1080@25 —y una
   * cámara cualquiera puede no serlo— los clips entrarían reescalados o con
   * franjas, en silencio.
   *
   * El precio es que createSequenceFromMedia mete el clip entero adentro, así
   * que hay que vaciarla antes de pegar nada.
   */
  const nombre = params.nombre || "Corte";
  const primero = await resolver(fragmentos[0].medio || params.medio);

  /*
   * Con `preset` la secuencia se crea DESDE UN .sqpreset y no desde el material.
   *
   * Hace falta porque `setVideoFrameRate` NO acepta el valor: medido el
   * 2026-08-17 sobre una secuencia heredada de material 4K50, pidiéndole 25fps
   * con los cuatro envoltorios posibles. El TickTime de ticks por frame contestó
   * "Invalid parameter" —o sea que el TIPO era el correcto y el valor se
   * rechazó— y las otras tres formas "Illegal Parameter type". El número estaba
   * bien: un preset de fábrica de 25fps trae exactamente `10160640000`, que es lo
   * que se pasó. La sospecha es el modo de edición heredado del material, pero
   * NO está confirmada.
   *
   * Con preset entra de una, porque el .sqpreset trae los fps y el modo de
   * edición juntos. Igual se verifica releyendo: si la secuencia no quedó con lo
   * que el preset decía, este verbo lo dice en vez de dar por bueno que la
   * llamada no tiró.
   */
  let nueva = null, viaCreacion = null;
  if (params.preset) {
    try {
      nueva = await project.createSequenceWithPresetPath(nombre, String(params.preset));
      viaCreacion = "(nombre, rutaPreset)";
    } catch (e) {
      try {
        nueva = await project.createSequenceWithPresetPath(String(params.preset), nombre);
        viaCreacion = "(rutaPreset, nombre)";
      } catch (e2) {
        throw new Error(
          `createSequenceWithPresetPath falló con "${params.preset}": ` +
          `(nombre, ruta) → ${e && e.message ? e.message : e} · ` +
          `(ruta, nombre) → ${e2 && e2.message ? e2.message : e2}`
        );
      }
    }
    if (!nueva) throw new Error(`createSequenceWithPresetPath devolvió vacío con "${params.preset}".`);
    // Con preset la secuencia nace VACÍA: no hay clip que sacar.
  } else {
    nueva = await crearSecuenciaDesde(project, primero.medio, nombre);
    viaCreacion = "desde el material";
  }

  const sacados = params.preset ? 0 : await vaciarSecuencia(project, nueva);

  /*
   * El tamaño y los fps se ponen ACÁ: con la secuencia creada y todavía vacía.
   *
   * No es un detalle de orden. `createSequenceFromMedia` hereda del material, y
   * una cámara vertical moderna da 2160x3840 @ 50fps — que para redes no sirve.
   * Si los fps se cambiaran DESPUÉS de pegar, los cortes que cayeron en un frame
   * impar de 50 quedarían entre frames de 25, que es el bug de los huecos de un
   * frame que ya se pagó en el M1. Vacía, no hay nada que quede mal alineado.
   */
  let reajuste = null;
  if (params.ancho !== undefined || params.alto !== undefined || params.fps !== undefined) {
    reajuste = await ponerAjustes(project, nueva, params);
  }

  // Los ajustes que quedaron, para poder compararlos con los del material.
  let ajustes = null;
  try {
    const st = await nueva.getSettings();
    const rect = await st.getVideoFrameRect();
    const fps = await st.getVideoFrameRate();
    ajustes = {
      ancho: rect.width, alto: rect.height,
      fps: fps && fps.value ? Number(fps.value.toFixed(3)) : null
    };
  } catch (e) { ajustes = null; }

  const editor = ppro.SequenceEditor.getEditor(nueva);
  const puestos = [];
  const fallidos = [];
  let cursor = 0;

  for (let i = 0; i < fragmentos.length; i++) {
    const f = fragmentos[i];
    const m = await resolver(f.medio || params.medio);
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(m.clipItem.createSetInOutPointsAction(aTick(f.desde), aTick(f.hasta)));
        }, "entrada y salida del fragmento " + (i + 1));
      });
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          // el 4º argumento es la pista de AUDIO: A1 explícito, no -1
          a.addAction(editor.createOverwriteItemAction(m.medio, aTick(cursor), 0, 0));
        }, "pegar fragmento " + (i + 1));
      });
    } catch (e) {
      fallidos.push(`${i + 1} (${m.nombre} ${f.desde}-${f.hasta}s): ${e && e.message ? e.message : e}`);
      continue;
    }

    // Dónde terminó DE VERDAD, releído: el cursor calculado se desfasa por el
    // redondeo a frames y esos milisegundos acumulados dejan huecos.
    const track = await nueva.getVideoTrack(0);
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    if (items.length <= puestos.length) {
      fallidos.push(`${i + 1} (${m.nombre} ${f.desde}-${f.hasta}s): la transacción no tiró pero no apareció en el timeline`);
      continue;
    }
    let fin = 0;
    for (let k = 0; k < items.length; k++) {
      const t = await tiemposDe(items[k]);
      if (t.hasta > fin) fin = t.hasta;
    }
    puestos.push({
      medio: m.nombre, desdeFuente: f.desde, hastaFuente: f.hasta,
      enLaSecuencia: Number(cursor.toFixed(3)), hasta: fin
    });
    cursor = fin;
  }

  /*
   * CAPAS: medios puestos en una pista y un tiempo EXPLÍCITOS, en vez de uno
   * atrás del otro. Sirve para reconstruir anotaciones —una pista de Transparent
   * Video marcando dónde pasa algo— cuando la secuencia se rearma y todas las
   * posiciones cambian.
   *
   * La duración se fija con los puntos de entrada y salida del medio, igual que
   * los fragmentos: un Transparent Video trae su duración por defecto y sin esto
   * todas las marcas saldrían del mismo largo.
   */
  const capas = Array.isArray(params.capas) ? params.capas : [];
  const capasPuestas = [];
  const capasFallidas = [];

  for (let i = 0; i < capas.length; i++) {
    const c = capas[i];
    if (typeof c.en !== "number" || typeof c.dura !== "number" || c.dura <= 0) {
      capasFallidas.push(`capa ${i + 1}: falta "en" o "dura" válidos`);
      continue;
    }
    const pistaIndex = (typeof c.pista === "number" ? c.pista : 2) - 1;
    try {
      const mc = await resolver(c.medio);
      /*
       * `desde` es el punto de FUENTE donde arranca la capa. Antes siempre
       * arrancaba en 0, que alcanza para un Transparent Video —un generador
       * uniforme— y no para poner un pedazo concreto de un clip real, que es lo
       * que hace falta para una pista de tomas alternativas.
       */
      const fuenteDesde = typeof c.desde === "number" ? c.desde : 0;
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(mc.clipItem.createSetInOutPointsAction(aTick(fuenteDesde), aTick(fuenteDesde + c.dura)));
        }, "duración de la capa " + (i + 1));
      });
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          /* El CUARTO argumento se venía pasando en -1 y nunca se supo qué era.
           * Con -1 el audio de TODAS las capas cae en A1 y se pisan entre sí:
           * quince capas dejaban un solo audio audible. Se prueba pasarle el
           * índice de pista de audio; si resulta ser otra cosa, el verbo lo
           * informa contando dónde aparecieron los clips de audio. */
          const pistaAudio = typeof c.pistaAudio === "number" ? c.pistaAudio - 1 : pistaIndex;
          a.addAction(editor.createOverwriteItemAction(mc.medio, aTick(c.en), pistaIndex, pistaAudio));
        }, "poner la capa " + (i + 1));
      });
      const track = await nueva.getVideoTrack(pistaIndex);
      const its = track ? await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
      let ok = false;
      for (let k = 0; k < its.length; k++) {
        const t = await tiemposDe(its[k]);
        if (Math.abs(t.desde - c.en) < 0.15) {
          ok = true;
          /*
           * `nombre` y `apagado` van ACÁ y no en dos llamadas aparte porque cada
           * una sería otra transacción: nueve capas serían 18 transacciones de
           * más en ráfaga, y eso es lo que tira Premiere con SIGSEGV.
           */
          const acciones = [];
          if (typeof c.nombre === "string" && c.nombre.trim()) acciones.push(() => its[k].createSetNameAction(c.nombre));
          if (c.apagado === true) acciones.push(() => its[k].createSetDisabledAction(true));
          let extras = null;
          if (acciones.length) {
            try {
              project.lockedAccess(() => {
                project.executeTransaction((a) => { for (const f of acciones) a.addAction(f()); }, "nombre y estado de la capa " + (i + 1));
              });
            } catch (e) { extras = e && e.message ? e.message : String(e); }
          }
          const quedoNombre = typeof c.nombre === "string" && c.nombre.trim()
            ? String(await its[k].getName()) === c.nombre : null;
          capasPuestas.push({
            en: t.desde, hasta: t.hasta, pista: "V" + (pistaIndex + 1),
            medio: mc.nombre, fuenteDesde: fuenteDesde,
            nombre: typeof c.nombre === "string" ? String(await its[k].getName()) : undefined,
            nombreQuedo: quedoNombre, apagado: c.apagado === true || undefined,
            errorExtras: extras || undefined
          });
          if (quedoNombre === false) capasFallidas.push(`capa ${i + 1}: NO se renombró a "${c.nombre}"`);
          break;
        }
      }
      if (!ok) capasFallidas.push(`capa ${i + 1} (${c.en}s): no tiró pero no apareció`);
    } catch (e) {
      capasFallidas.push(`capa ${i + 1} (${c.en}s): ${e && e.message ? e.message : e}`);
    }
  }

  /*
   * RELEER LAS CAPAS AL FINAL, no sólo al ponerlas.
   *
   * Cada capa se verificaba a sí misma en el momento de ponerla, y eso NO alcanza:
   * `createOverwriteItemAction` PISA, así que dos capas en la misma pista y la
   * misma posición se comen entre sí y la segunda deja a la primera truncada.
   * Medido el 2026-08-17: dos tomas alternativas del mismo beat en V3 a 58,52s
   * dejaron 1,64s de la primera, y el verbo informó "3/3 capas". `revisar`
   * tampoco lo ve, porque un clip truncado es legal.
   *
   * Es el modo de fallar nº1 de este archivo —dar por bueno lo que cada paso dice
   * de sí mismo— en un verbo escrito para evitarlo.
   */
  const capasRotas = [];
  for (const c of capasPuestas) {
    try {
      const idx = Number(String(c.pista).replace("V", "")) - 1;
      const track = await nueva.getVideoTrack(idx);
      const its = track ? await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
      let sigue = false;
      for (let k = 0; k < its.length; k++) {
        const t = await tiemposDe(its[k]);
        if (Math.abs(t.desde - c.en) < 0.15 && Math.abs(t.hasta - c.hasta) < 0.15) { sigue = true; break; }
      }
      if (!sigue) capasRotas.push(`${c.pista} ${c.en.toFixed(2)}–${c.hasta.toFixed(2)}s (${c.medio || "?"})`);
    } catch (e) { capasRotas.push(`${c.pista} ${c.en}s: no se pudo releer`); }
  }

  /*
   * LIMPIAR LOS in/out DE LOS MEDIOS. No lo hacía, y es el mismo daño que ya
   * pagó `cortar`: `createSetInOutPointsAction` escribe en el ProjectItem, que es
   * de TODO el proyecto y no de este corte, así que cada medio quedaba recortado
   * en el panel para siempre. Cualquier cosa que después creara una secuencia
   * desde él arrancaba en el in-point viejo.
   *
   * Va en UNA transacción para no encadenar una por medio.
   */
  let inOutLimpiados = null;
  const tocados = Object.values(cache);
  if (tocados.length) {
    try {
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => {
          for (const t of tocados) a.addAction(t.clipItem.createClearInOutPointsAction());
        }, "devolver los in/out de los medios");
      });
      inOutLimpiados = ok ? tocados.length : 0;
    } catch (e) { inOutLimpiados = 0; }
  }

  const porMedio = {};
  for (const p of puestos) porMedio[p.medio] = (porMedio[p.medio] || 0) + 1;

  return {
    resumen:
      `Secuencia "${nombre}"` +
      (ajustes
        ? ` (${ajustes.ancho}x${ajustes.alto} @ ${ajustes.fps}fps, ` +
          (params.preset
            ? `del preset · vía ${viaCreacion}`
            : reajuste && reajuste.cambio
              ? `pedidos — el material daba ${reajuste.antes.ancho}x${reajuste.antes.alto} @ ${reajuste.antes.fps}fps`
              : "heredados del material") + ")"
        : "") +
      `: ${puestos.length} de ${fragmentos.length} fragmentos ` +
      `de ${Object.keys(porMedio).length} medio(s), ${cursor.toFixed(2)}s en total` +
      (sacados ? ` · se vació el clip que metió createSequenceFromMedia (${sacados})` : "") +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.join(" | ")}` : "") +
      (capas.length ? ` · ${capasPuestas.length - capasRotas.length}/${capas.length} capas` : "") +
      (capasRotas.length
        ? ` · ${capasRotas.length} capa(s) SE PISARON entre sí y ya no están enteras: ${capasRotas.join(", ")} — dos capas en la misma pista y la misma posición se comen; poné cada una en su pista`
        : "") +
      (capasFallidas.length ? ` · CAPAS FALLIDAS: ${capasFallidas.join(" | ")}` : "") +
      (inOutLimpiados === null ? "" :
        inOutLimpiados ? ` · in/out devueltos en ${inOutLimpiados} medio(s)` :
        " · OJO: NO se pudieron devolver los in/out de los medios, quedaron recortados en el panel") +
      " · " + Object.entries(porMedio).map(([k, v]) => `${k}: ${v}`).join(", "),
    secuencia: nombre,
    ajustes: ajustes,
    reajuste: reajuste,
    inOutLimpiados: inOutLimpiados,
    puestos: puestos,
    capasPuestas: capasPuestas,
    capasFallidas: capasFallidas,
    fallidos: fallidos,
    duracionTotal: Number(cursor.toFixed(3))
  };
}

/** Borra una secuencia del proyecto, por nombre. */
async function borrarSecuencia(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");

  const lista = await project.getSequences();
  const nombres = [];
  let objetivo = null;
  for (let i = 0; i < lista.length; i++) {
    const n = String(lista[i].name);
    nombres.push(n);
    if (!objetivo && n.toLowerCase().indexOf(String(params.nombre || "").toLowerCase()) !== -1) objetivo = lista[i];
  }
  if (!objetivo) throw new Error(`No hay ninguna secuencia que coincida con "${params.nombre}". Hay: ${nombres.join(", ")}.`);

  const nombreObjetivo = String(objetivo.name);
  let excepcion = null;
  try { await project.deleteSequence(objetivo); }
  catch (e) { excepcion = e && e.message ? e.message : String(e); }

  // La prueba es la lista posterior, no que la llamada no tire.
  const despues = await project.getSequences();
  const quedan = [];
  for (let i = 0; i < despues.length; i++) quedan.push(String(despues[i].name));

  return {
    resumen:
      `"${nombreObjetivo}": ${nombres.length} → ${quedan.length} secuencias` +
      (excepcion ? ` · excepción: ${excepcion}` : "") +
      (quedan.length < nombres.length ? "" : " · NO SE BORRÓ") +
      ` · quedan: ${quedan.join(", ")}`,
    borrada: quedan.length < nombres.length,
    quedan: quedan
  };
}

/* ---------- secuencias ---------- */

/**
 * Lista las secuencias del proyecto y opcionalmente cambia la activa.
 *
 * Sin esto el bridge trabaja sobre la que el usuario dejó abierta y no puede
 * moverse — el mismo problema que la selección de clips, un nivel más arriba.
 */
async function secuencias(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");

  const lista = await project.getSequences();
  const nombres = [];
  for (let i = 0; i < lista.length; i++) nombres.push(String(lista[i].name));

  const activaAntes = await project.getActiveSequence();
  const nombreAntes = activaAntes ? String(activaAntes.name) : null;

  let via = null;
  if (typeof params.nombre === "string") {
    const bajo = params.nombre.toLowerCase();
    /*
     * La coincidencia EXACTA gana. Con parcial nomás, pedir "M2" agarraba
     * "M2 BACKUP" —que estaba antes en la lista— y se hubiera editado la copia
     * creyendo que era la original. Un backup recién hecho es justo el caso
     * donde dos nombres se parecen.
     */
    let elegida = null;
    for (let i = 0; i < lista.length; i++) {
      if (String(lista[i].name).toLowerCase() === bajo) { elegida = lista[i]; break; }
    }
    if (!elegida) {
      const parciales = [];
      for (let i = 0; i < lista.length; i++) {
        if (String(lista[i].name).toLowerCase().indexOf(bajo) !== -1) parciales.push(lista[i]);
      }
      if (parciales.length > 1) {
        throw new Error(
          `"${params.nombre}" coincide con ${parciales.length} secuencias: ` +
          parciales.map((x) => `"${String(x.name)}"`).join(", ") + ". Poné el nombre exacto."
        );
      }
      elegida = parciales[0] || null;
    }
    if (!elegida) {
      throw new Error(`No hay ninguna secuencia que coincida con "${params.nombre}". Hay: ${nombres.join(", ")}.`);
    }
    // openSequence además la trae al frente en el timeline; setActiveSequence
    // sola puede dejarla activa sin que se vea. Se hacen las dos.
    try { await project.openSequence(elegida); via = "openSequence"; }
    catch (e) { /* seguimos con la otra */ }
    try { await project.setActiveSequence(elegida); via = via ? via + "+setActiveSequence" : "setActiveSequence"; }
    catch (e) { /* ya está */ }
  }

  const activaAhora = await project.getActiveSequence();
  const nombreAhora = activaAhora ? String(activaAhora.name) : null;

  return {
    resumen:
      `${nombres.length} secuencias: ${nombres.join(", ")} · activa: ${nombreAhora || "ninguna"}` +
      (params.nombre && nombreAhora !== nombreAntes ? ` (era ${nombreAntes}, vía ${via})` : "") +
      (params.nombre && nombreAhora === nombreAntes ? " · NO CAMBIÓ" : ""),
    secuencias: nombres,
    activa: nombreAhora,
    activaAntes: nombreAntes,
    cambio: nombreAhora !== nombreAntes,
    via: via
  };
}

/**
 * Renombra UN CLIP DEL TIMELINE, sin tocar el medio del panel.
 *
 * `VideoClipTrackItem` tiene su propio `createSetNameAction`, distinto del de
 * `ProjectItem`: renombrar el medio cambiaría el nombre de TODAS sus instancias,
 * y esto cambia solo la de esta secuencia.
 *
 * Para qué: marcar en el timeline dónde va a ir algo que todavía no existe —un
 * ejercicio, un gráfico— con un Video Transparente que diga "Acá va el Ej 1".
 * Un marcador también sirve, pero no ocupa lugar ni se ve en la pista.
 *
 * Lee el nombre ANTES y DESPUÉS: la API acepta acciones que no aplica.
 */
async function renombrar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (typeof params.nuevo !== "string" || !params.nuevo.trim()) {
    throw new Error("Falta `nuevo`: el nombre que va a tener el clip.");
  }
  const encontrado = await ubicarClip(sequence, params);
  const antes = String(await encontrado.clip.getName());

  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(encontrado.clip.createSetNameAction(params.nuevo));
      }, "renombrar el clip");
    });
  } catch (e) { error = e && e.message ? e.message : String(e); }

  const despues = String(await encontrado.clip.getName());
  const quedo = despues === params.nuevo;

  return {
    resumen:
      `${encontrado.pista}[${encontrado.indice}]: "${antes}" → "${despues}"` +
      (quedo ? "" : ` · NO QUEDÓ COMO SE PIDIÓ ("${params.nuevo}"), transacción ${ok}` + (error ? ` · ${error}` : "")),
    antes: antes, despues: despues, quedo: quedo,
    pista: encontrado.pista, indice: encontrado.indice
  };
}

/* ---------- el panel de proyecto ---------- */

/**
 * Guarda el proyecto.
 *
 * Devuelve la RUTA además de guardar, y no por prolijidad: el panel no puede
 * leer el disco fuera de su sandbox, así que no tiene forma de comprobar que el
 * archivo cambió. Con la ruta, el servidor —que corre en Node— mira la fecha de
 * modificación y confirma. Sin eso sería un verbo que contesta "ok" sin saber
 * nada, que es justo lo que este bridge no tiene que hacer.
 */
async function guardar() {
  // No necesita secuencia: guardar el proyecto es del proyecto.
  const project = await getProyecto();
  const nombre = String(project.name);
  let ruta = null;
  try { ruta = String(project.path); } catch (e) { ruta = null; }

  let ok = false, error = null;
  try { ok = await project.save(); }
  catch (e) { error = e && e.message ? e.message : String(e); }

  return {
    resumen: `"${nombre}": save() ${error ? "TIRÓ ERROR: " + error : "devolvió " + JSON.stringify(ok)}` +
      (ruta ? ` · ${ruta}` : " · sin ruta (¿proyecto nunca guardado?)"),
    proyecto: nombre,
    ruta: ruta,
    devolvio: ok,
    error: error
  };
}

/**
 * Los hijos de un item, si es carpeta.
 *
 * OJO: `getItems()` vive en FolderItem, NO en ProjectItem. Un bin llega como
 * ProjectItem sin ese método, así que preguntar `typeof item.getItems` da false
 * y sus hijos quedan INVISIBLES. Hay que castearlo primero.
 */
/**
 * El FolderItem de una ruta de bins tipo "Crudos/Entrevistas", creando los que
 * falten. Devuelve el destino.
 *
 * La firma de `createBinAction` no está documentada, así que se enumeran las
 * plausibles y **gana la que hace aparecer el bin al releer los hijos**, no la que
 * no tira excepción. Se cachea la vía para no reenumerar en cada nivel.
 */
let viaCrearBin = null;
async function asegurarBin(project, ruta) {
  const partes = String(ruta).split("/").map((p) => p.trim()).filter(Boolean);
  if (!partes.length) throw new Error("`bin` vacío.");

  let actual = await project.getRootItem();
  for (const nombre of partes) {
    const hijos = (await hijosDe(actual)) || [];
    let encontrado = null;
    for (const h of hijos) {
      if (String(h.name) !== nombre) continue;
      if ((await hijosDe(h)) !== null) { encontrado = h; break; }
    }
    if (encontrado) { actual = encontrado; continue; }

    const padre = ppro.FolderItem.cast(actual);
    if (!padre) throw new Error(`No se pudo castear "${String(actual.name)}" a FolderItem para crear "${nombre}".`);

    /*
     * La acción se crea ADENTRO de `lockedAccess`, no afuera.
     *
     * Creándola afuera, `createBinAction` contesta **"Requires locked access"** —
     * medido el 2026-08-17, y con `(nombre)` solo contesta "Not Enough
     * Parameters", así que la firma son dos argumentos. Es el patrón que ya usan
     * los verbos que andan (`desmarcar` crea sus acciones adentro), y hacerlo al
     * revés falla con un mensaje que suena a problema de permisos del proyecto.
     */
    const formas = [
      ["(nombre, true)", () => padre.createBinAction(nombre, true)],
      ["(nombre, false)", () => padre.createBinAction(nombre, false)],
      ["(nombre)", () => padre.createBinAction(nombre)]
    ];
    const intentos = [];
    const orden = viaCrearBin ? formas.filter((f) => f[0] === viaCrearBin).concat(formas) : formas;
    let creado = null;
    for (const [etiqueta, fn] of orden) {
      try {
        let dentroDelLock = null;
        project.lockedAccess(() => {
          project.executeTransaction((a) => {
            const accion = fn();
            dentroDelLock = accion ? "ok" : "devolvió " + describirValor(accion);
            if (accion) a.addAction(accion);
          }, `crear bin ${nombre}`);
        });
        if (dentroDelLock !== "ok") { intentos.push(etiqueta + ": " + dentroDelLock); continue; }
        // La prueba es releer, no que la llamada no tire.
        for (const h of (await hijosDe(actual)) || []) {
          if (String(h.name) === nombre && (await hijosDe(h)) !== null) { creado = h; break; }
        }
        if (creado) { viaCrearBin = etiqueta; break; }
        intentos.push(etiqueta + ": la transacción pasó y el bin no apareció");
      } catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); }
    }
    if (!creado) throw new Error(`No se pudo crear el bin "${nombre}" en "${String(actual.name)}". Intentos: ${intentos.join(" | ")}.`);
    actual = creado;
  }
  return actual;
}

/**
 * Mueve items a un bin. Devuelve cuáles entraron de verdad, releyendo el bin.
 *
 * **Una sola transacción para todos**, y eso no es una optimización: una ráfaga
 * de transacciones tira Premiere con SIGSEGV, y está medido que 18 a 200ms lo
 * hacen. Ordenar 29 medios serían 29 transacciones seguidas sin pausa desde
 * adentro del panel, que es justo el patrón que ya costó una edición.
 *
 * El precio es que la firma hay que aprenderla con UN item primero —esta API no
 * documenta `createMoveItemAction`— y recién después se manda el resto junto. Ese
 * primero paga dos transacciones; los otros N-1 van en una.
 */
let viaMover = null;
async function moverABin(project, destino, items) {
  const carpeta = ppro.FolderItem.cast(destino);
  if (!carpeta) throw new Error(`"${String(destino.name)}" no es un bin.`);
  if (!items.length) return { movidos: [], fallidos: [], intentos: [], via: viaMover, transacciones: 0 };

  const intentos = [];
  const accionDe = (it, etiqueta) => {
    if (etiqueta === "destino.createMoveItemAction(item)") return carpeta.createMoveItemAction(it);
    if (etiqueta === "destino.createMoveItemAction(item, destino)") return carpeta.createMoveItemAction(it, carpeta);
    return null;
  };
  const etiquetas = [
    "destino.createMoveItemAction(item)",
    "destino.createMoveItemAction(item, destino)"
  ];
  /*
   * Se cuenta por NOMBRE Y MULTIPLICIDAD, no con un Set.
   *
   * Premiere deja importar el mismo archivo muchas veces, así que los nombres NO
   * son únicos. Con un Set, cuatro items llamados igual entran como uno: se pidió
   * mover 4 copias del _7, quedó una afuera, y el verbo informó "4 de 4 movidos"
   * porque el nombre estaba presente. Es la misma clase de error que el
   * `undefined !== undefined` del catálogo: la guarda no distinguía lo que tenía
   * que distinguir.
   */
  const dentro = async () => {
    const c = new Map();
    for (const h of (await hijosDe(carpeta)) || []) {
      const n = String(h.name);
      c.set(n, (c.get(n) || 0) + 1);
    }
    return c;
  };

  /*
   * Los PENDIENTES se calculan primero, y la firma se aprende con uno de ellos.
   *
   * Aprendiéndola con `items[0]` a secas, si ese item YA ESTÁ en el bin el
   * movimiento no cambia nada, la comprobación da falso y el verbo concluye que
   * la firma no sirve: informó "0 de 4 movidos" con 3 ya adentro y 1 por mover.
   * El bug del Set lo venía tapando, porque decía "presente" y pasaba por bueno.
   *
   * Se descuentan por multiplicidad: si el bin ya tiene 3 copias del _7 y se
   * piden 4, falta mover UNA, no ninguna.
   */
  let transacciones = 0;
  const yaEstaInicial = await dentro();
  const cupoInicial = new Map(yaEstaInicial);
  const pendientes = [];
  for (const i of items) {
    const n = String(i.name);
    const q = cupoInicial.get(n) || 0;
    if (q > 0) cupoInicial.set(n, q - 1);
    else pendientes.push(i);
  }
  if (!pendientes.length) {
    const final0 = await dentro();
    const restante0 = new Map(final0);
    const movidos0 = [];
    for (const it of items) {
      const n = String(it.name);
      const q = restante0.get(n) || 0;
      if (q > 0) { restante0.set(n, q - 1); movidos0.push(n); }
    }
    return { movidos: movidos0, fallidos: [], intentos: ["ya estaban todos en el bin"], via: viaMover, transacciones: 0, yaEstaban: movidos0.length };
  }
  if (!viaMover) {
    const primero = pendientes[0];
    const antes = await dentro();
    for (const etiqueta of etiquetas) {
      try {
        // Igual que con createBinAction: la acción se crea ADENTRO del lock, o
        // contesta "Requires locked access".
        let estado = null;
        project.lockedAccess(() => {
          project.executeTransaction((a) => {
            const accion = accionDe(primero, etiqueta);
            estado = accion ? "ok" : "devolvió " + describirValor(accion);
            if (accion) a.addAction(accion);
          }, "mover al bin");
        });
        transacciones++;
        if (estado !== "ok") { intentos.push(etiqueta + ": " + estado); continue; }
        const ahora = await dentro();
        const n0 = String(primero.name);
        if ((ahora.get(n0) || 0) > (antes.get(n0) || 0)) { viaMover = etiqueta; break; }
        intentos.push(etiqueta + ": la transacción pasó y no quedó en el bin");
      } catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); }
    }
    if (!viaMover) {
      return { movidos: [], fallidos: items.map((i) => String(i.name)), intentos, via: null, transacciones };
    }
  }

  // 2) El resto, TODOS en una transacción. Se relee por si el aprendizaje ya movió uno.
  const yaEsta = await dentro();
  const cupo = new Map(yaEsta);
  const restantes = [];
  for (const i of items) {
    const n = String(i.name);
    const q = cupo.get(n) || 0;
    if (q > 0) cupo.set(n, q - 1);
    else restantes.push(i);
  }
  if (restantes.length) {
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          for (const it of restantes) {
            const accion = accionDe(it, viaMover);
            if (accion) a.addAction(accion);
          }
        }, `mover ${restantes.length} al bin`);
      });
      transacciones++;
    } catch (e) { intentos.push("la tanda: " + (e && e.message ? e.message : e)); }
  }

  const final = await dentro();
  const restante = new Map(final);
  const movidos = [], fallidos = [];
  for (const it of items) {
    const n = String(it.name);
    const q = restante.get(n) || 0;
    if (q > 0) { restante.set(n, q - 1); movidos.push(n); } else fallidos.push(n);
  }
  return { movidos, fallidos, intentos, via: viaMover, transacciones };
}

async function hijosDe(item) {
  if (item && typeof item.getItems === "function") {
    try { return await item.getItems(); } catch (e) { return null; }
  }
  let carpeta = null;
  try { carpeta = ppro.FolderItem.cast(item); } catch (e) { carpeta = null; }
  if (carpeta && typeof carpeta.getItems === "function") {
    try { return await carpeta.getItems(); } catch (e) { return null; }
  }
  return null;
}

/**
 * Lo que hay en el panel de proyecto, recorriendo los bins.
 *
 * El tope de profundidad no es paranoia de más: el cast a carpeta puede
 * "funcionar" sobre algo que no lo es y devolverse a sí mismo, y ahí el
 * recorrido no termina nunca.
 */
async function medios(params) {
  // No necesita secuencia: el panel de proyecto existe igual en un proyecto vacío.
  const project = await getProyecto();
  const raiz = await project.getRootItem();

  const busca = typeof params.buscar === "string" ? params.buscar.toLowerCase() : null;
  const encontrados = [];

  async function recorrer(item, ruta, profundidad) {
    if (profundidad > 8) return;
    const hijos = await hijosDe(item);
    if (!hijos) return;
    for (let i = 0; i < hijos.length; i++) {
      const nombre = String(hijos[i].name);
      const subHijos = await hijosDe(hijos[i]);
      const esCarpeta = subHijos !== null;
      if (!esCarpeta && (!busca || nombre.toLowerCase().indexOf(busca) !== -1)) {
        // Se guarda el item vivo para poder pedirle la ruta después, sin volver a recorrer.
        encontrados.push({ nombre: nombre, bin: ruta || "(raíz)", item: hijos[i] });
      }
      if (esCarpeta) await recorrer(hijos[i], ruta ? ruta + "/" + nombre : nombre, profundidad + 1);
    }
  }

  await recorrer(raiz, "", 0);

  const TOPE = 60;
  const recortada = encontrados.slice(0, TOPE);

  /*
   * La RUTA en disco, sólo para los que se devuelven.
   *
   * `getMediaFilePath` vive en ClipProjectItem y hay que castear, como con
   * FolderItem para los bins. Se pide únicamente para la tanda recortada —no para
   * los 137 del proyecto— porque es una llamada por medio: buscando uno son dos
   * llamadas, y recorrer todo serían doscientas en ráfaga, que es el patrón que ya
   * tiró Premiere (ver CLAUDE.md).
   *
   * Existe porque sin esto ubicar el archivo de un medio salía por `mdfind`, y un
   * `find` sobre /Volumes se comió un timeout de 180s el 2026-08-19.
   */
  for (let i = 0; i < recortada.length; i++) {
    const original = encontrados[i] && encontrados[i].item;
    if (!original) continue;
    try {
      const ci = ppro.ClipProjectItem.cast(original);
      recortada[i].ruta = ci ? String(await ci.getMediaFilePath()) : null;
    } catch (e) { recortada[i].ruta = null; }
    // Y se SACA el objeto vivo: `recortada` se serializa en la respuesta, y un
    // objeto de UXP ahí adentro la rompe o la llena de basura.
    delete recortada[i].item;
  }
  return {
    resumen:
      `${encontrados.length} medios` + (busca ? ` con "${params.buscar}"` : " en el proyecto") +
      (encontrados.length > TOPE ? ` · se muestran los primeros ${TOPE}, filtrá con "buscar"` : "") +
      (recortada.length ? " · " + recortada.map((m) => `"${m.nombre}"`).join(", ") : ""),
    total: encontrados.length,
    medios: recortada
  };
}

/**
 * Pone un medio del proyecto en el timeline, pisando lo que haya.
 *
 * Overwrite y no insert a propósito: insertar CORRE todo lo que está a la
 * derecha, y desde el bridge eso es un cambio grande y difícil de ver. Pisar
 * está acotado a la zona donde se pone.
 *
 * El cuarto argumento es la pista de audio. **-1 NO la deja afuera**: cae en A1 y PISA
 * lo que haya. Lo decia al reves hasta el 2026-09-10, y el hallazgo que lo encontro citaba
 * justamente esta linea. Por eso `pistaAudio` ahora tiene PISO y rebota con 0 o menos.
 */
async function insertar(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  const raiz = await project.getRootItem();
  const nombre = String(params.medio || "");
  if (!nombre) throw new Error("Falta `medio`: el nombre del item del proyecto que se quiere poner.");

  let item = null;
  const vistos = [];
  async function buscar(carpeta, profundidad) {
    if (item || profundidad > 8) return;
    const hijos = await hijosDe(carpeta);
    if (!hijos) return;
    for (let i = 0; i < hijos.length && !item; i++) {
      const n = String(hijos[i].name);
      const subHijos = await hijosDe(hijos[i]);
      if (subHijos === null) {
        vistos.push(n);
        if (igualN(n, nombre) || contieneN(n, nombre)) { item = hijos[i]; return; }
      } else {
        await buscar(hijos[i], profundidad + 1);
      }
    }
  }
  await buscar(raiz, 0);

  if (!item) {
    throw new Error(
      `No hay ningún medio que coincida con "${nombre}" en el proyecto. Hay: ` +
      (vistos.slice(0, 25).join(", ") || "nada") + (vistos.length > 25 ? ` … y ${vistos.length - 25} más` : "")
    );
  }

  /*
   * `pistaDeVideo` y no un `typeof === "number"`: la versión vieja aceptaba
   * "V2", el typeof no daba "number", y **caía al default V1 sin decir nada**.
   * Insertando una capa de ajuste sobre V2 eso la ponía en V1 y le pisaba cinco
   * segundos al clip de abajo, informando "quedó arrancando en 0s" como si todo
   * hubiera salido bien.
   *
   * Era el único verbo de pista que no usaba el resolver común, y por eso era el
   * único donde una etiqueta válida en todos lados fallaba en silencio.
   */
  const { pistaIndex: pista } = pistaDeVideo(params.pista, "insertar");
  const total = await sequence.getVideoTrackCount();
  if (pista < 0 || pista >= total) {
    throw new Error(`La secuencia "${sequence.name}" tiene ${total} pistas de video (V1 a V${total}); se pidió V${pista + 1}.`);
  }

  const segundos = typeof params.segundos === "number"
    ? params.segundos
    : aSegundos(await sequence.getPlayerPosition());

  const track = await sequence.getVideoTrack(pista);
  const itemsAntes = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const antes = itemsAntes.length;
  /*
   * QUE HABIA EXACTAMENTE EN ESE SEGUNDO, antes de escribir.
   *
   * El conteo solo no alcanza: un overwrite que cae JUSTO encima de un clip existente
   * lo reemplaza y la pista no crece, asi que juzgar por el conteo daria "NO SE PUSO
   * NADA" sobre una insercion que si ocurrio — el falso negativo que este verbo ya
   * pago una vez con el .wav del tema. Con el nombre de antes se distinguen los dos
   * casos: si en ese punto ahora hay OTRO nombre, entro aunque el conteo no se mueva.
   */
  let nombreAntesEnPunto = null;
  for (let i = 0; i < itemsAntes.length; i++) {
    const sA = aSegundos(await itemsAntes[i].getStartTime());
    if (Math.abs(sA - (typeof params.segundos === "number" ? params.segundos
        : aSegundos(await sequence.getPlayerPosition()))) < 0.05) {
      nombreAntesEnPunto = String(await itemsAntes[i].getName());
      break;
    }
  }
  const totalAntes = await contarItems(sequence);

  /*
   * LA PISTA DE AUDIO SE MIRA TAMBIÉN, y por un bug medido: insertando el .wav del tema,
   * el verbo contestó "NO SE PUSO NADA" y el archivo SÍ había entrado en A1. Contaba sólo
   * la pista de VIDEO, y un medio sin video no pone nada ahí.
   *
   * Es el contador ciego de `cortesDeEscena` en otro verbo: mira en el lugar equivocado y
   * declara un fracaso que no ocurrió. Ahí el falso negativo hizo repetir la operación
   * cuatro veces; acá, creerle habría hecho insertar el tema de nuevo y duplicarlo.
   */
  const pistaAudio = typeof params.pistaAudio === "number" ? params.pistaAudio - 1 : pista;
  /*
   * PISO, no techo. `pistaAudio: 0` daba -1 y el -1 se mandaba igual a
   * `createOverwriteItemAction`, que cae SIEMPRE en A1 y PISA lo que haya —el
   * overwrite no solapa, borra— mientras el resumen decia "A0 fuera de rango",
   * que se lee como "no escribi nada". Medido el 2026-09-10: con `pistaAudio: 0`
   * el audio aparecio en A1. En un proyecto real ahi vive el TEMA.
   *
   * El techo NO se valida a proposito: pedir una pista que no existe la CREA, y
   * eso esta medido y se usa (ver CLAUDE.md, "Pedir una pista de audio que NO
   * EXISTE la CREA"). Rechazar eso romperia un flujo que anda.
   */
  if (typeof params.pistaAudio === "number" && params.pistaAudio < 1) {
    throw new Error(
      `\`pistaAudio\` se cuenta desde 1 (A1 es 1), y vino ${params.pistaAudio}. ` +
      `Con 0 el indice interno queda en -1, que NO deja el audio afuera: lo tira en A1 PISANDO ` +
      `lo que haya. Si no querias audio, no hay forma de suprimirlo desde aca: se inserta y se borra.`
    );
  }
  const cuantasA = await sequence.getAudioTrackCount();
  const trackA = (pistaAudio >= 0 && pistaAudio < cuantasA) ? await sequence.getAudioTrack(pistaAudio) : null;
  const antesA = trackA
    ? (await trackA.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length : null;

  const editor = ppro.SequenceEditor.getEditor(sequence);
  let ok = false;
  let excepcion = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((acciones) => {
        /* El 4º argumento es la PISTA DE AUDIO, y con -1 cae siempre en A1.
         * Insertando en V3 el audio se iba a A1 y PISABA lo que hubiera ahí,
         * porque el overwrite no solapa: borra. Espeja el video salvo que se
         * pida otra. */
        acciones.addAction(editor.createOverwriteItemAction(item, aTick(segundos), pista, pistaAudio));
      }, `poner ${String(item.name)} en V${pista + 1}`);
    });
  } catch (e) {
    excepcion = e && e.message ? e.message : String(e);
  }

  // Contar antes y después: la transacción puede decir que sí y no poner nada.
  const track2 = await sequence.getVideoTrack(pista);
  const items = await track2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const puesto = [];
  for (let i = 0; i < items.length; i++) {
    const s = aSegundos(await items[i].getStartTime());
    if (Math.abs(s - segundos) < 0.05) puesto.push({ nombre: String(await items[i].getName()), desde: Number(s.toFixed(3)) });
  }

  /*
   * El AUDIO que vino de arrastre. Un medio con audio pone también sus pistas de
   * audio, y el cuarto argumento en -1 NO lo suprime —no sé qué significa
   * exactamente, y prefiero decirlo a inventarlo—. Se informa porque el usuario
   * tiene que saber que apareció algo que no pidió: `borrar` después se lo lleva
   * junto con el video, pero solo si sabe que está.
   */
  const totalDespues = await contarItems(sequence);
  const audioPuesto = totalDespues.audio - totalAntes.audio;

  /* Y en la pista de audio pedida, releída: si el medio no tenía video, esto es lo ÚNICO
   * que prueba que la inserción ocurrió. */
  let despuesA = null;
  const puestoA = [];
  if (trackA) {
    const trackA2 = await sequence.getAudioTrack(pistaAudio);
    const itemsA = await trackA2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    despuesA = itemsA.length;
    for (let i = 0; i < itemsA.length; i++) {
      const s2 = aSegundos(await itemsA[i].getStartTime());
      if (Math.abs(s2 - segundos) < 0.05) puestoA.push({ nombre: String(await itemsA[i].getName()), desde: Number(s2.toFixed(3)) });
    }
  }
  const etqA = "A" + (pistaAudio + 1);
  /* "No se puso nada" ahora exige que NO haya entrado ni en video ni en audio. */
  /*
   * `entro` SALE DEL CONTEO, no de "hay un clip en ese segundo".
   *
   * La version vieja miraba solo la lista de DESPUES y contaba como recien puesto
   * cualquier clip que arrancara en `segundos`, sin lista previa ni comparacion de
   * nombre. Con la insercion FALLADA y un clip viejo en ese punto informaba exito:
   * `colocar_sincro.js` valida con /quedo/, pasaba, y seguia recortando y moviendo
   * el clip VIEJO del usuario creyendo que editaba el que acababa de poner.
   *
   * El conteo ya estaba leido —`antes` y `antesA`— asi que esto no agrega ni una
   * llamada a la API: es el testigo barato que pide CLAUDE.md.
   */
  const crecioV = items.length > antes;
  const crecioA = despuesA !== null && antesA !== null && despuesA > antesA;
  /* Cambio de inquilino: mismo conteo, otro clip en ese segundo. Es el caso del
     overwrite exacto, que entra sin mover el conteo. */
  const cambioEnPunto = puesto.length > 0 && puesto[0].nombre !== nombreAntesEnPunto;
  const entro = crecioV || crecioA || audioPuesto > 0 || cambioEnPunto;
  const nadaEnNingunLado = !entro;
  /* Fantasma: hay un clip en ese segundo, pero es EL MISMO que ya estaba y nada crecio. */
  const fantasma = puesto.length > 0 && !crecioV && !cambioEnPunto;

  return {
    resumen:
      `"${String(item.name)}" a los ${segundos.toFixed(2)}s · V${pista + 1}: ${antes} → ${items.length}` +
      (despuesA !== null ? ` · ${etqA}: ${antesA} → ${despuesA}` : ` · ${etqA} fuera de rango (hay ${cuantasA})`) +
      (excepcion ? ` · excepción: ${excepcion}` : "") +
      (puesto.length ? ` · quedó en V${pista + 1} "${puesto[0].nombre}" arrancando en ${puesto[0].desde}s` : "") +
      (puestoA.length ? ` · y en ${etqA} arrancando en ${puestoA[0].desde}s` : "") +
      (!puesto.length && puestoA.length
        ? " · en V" + (pista + 1) + " NO puso nada, que es lo esperable si el medio no tiene video"
        : "") +
      (fantasma
        ? ` · OJO: hay un clip en ese segundo pero V${pista + 1} NO crecio (${antes} → ${items.length}): ` +
          `es el que YA ESTABA, la insercion no entro. NO lo edites creyendo que es el nuevo`
        : "") +
      (nadaEnNingunLado ? " · NO SE PUSO NADA, ni en video ni en audio" : "") +
      (audioPuesto > 0 && !puestoA.length
        ? ` · y aparecieron ${audioPuesto} clip(s) de audio en otra pista: el medio los trae`
        : ""),
    medio: String(item.name),
    pista: pista + 1,
    segundos: segundos,
    clipsAntes: antes,
    clipsDespues: items.length,
    pistaAudio: pistaAudio + 1,
    clipsAudioAntes: antesA,
    clipsAudioDespues: despuesA,
    audioPuesto: audioPuesto,
    puesto: puesto,
    puestoAudio: puestoA,
    entro: entro,
    crecioVideo: crecioV,
    crecioAudio: crecioA,
    fantasma: fantasma,
    nombreAntesEnPunto: nombreAntesEnPunto,
    transaccion: ok,
    excepcion: excepcion
  };
}

/**
 * Los items VINCULADOS a uno dado: el audio de un video, o al revés.
 *
 * La API NO expone el vínculo —el TrackItem no tiene ningún getLinkedItems— así
 * que se deduce: mismo medio de origen y mismo rango de tiempo. Es una
 * heurística, pero es la que se corresponde con lo que Premiere llama vinculado.
 *
 * Hace falta porque borrar sin esto deja el audio huérfano, que es exactamente
 * lo que pasó. Y `addItem(clip, true)` NO los incluye: probado, el segundo
 * argumento es otra cosa.
 */
/**
 * El audio que CUBRE el rango de un clip de video, aunque no coincida exacto.
 *
 * `buscarVinculados` exige que los ticks de inicio y fin sean idénticos, y eso
 * es lo correcto para `borrar` y `editar`: aflojarlo ahí agarraría clips que no
 * son el par. Pero rompe a `cortar` con `soloVideo`, que por diseño deja el
 * video partido y el audio entero — o sea que después del primer corte el par ya
 * no coincide, `audioAntes` queda vacío y la reparación no corre. No falla:
 * directamente no se ejecuta.
 *
 * Medido el 2026-08-16 con nueve cortes: **alineados 6 de 6 reparan,
 * desalineados 0 de 3**. Sin excepciones, y explica el "1 de cada 3" que se
 * venía viendo sin patrón — un corte exitoso desalinea el par y hace fallar al
 * siguiente de esa zona.
 */
async function audioQueCubre(sequence, clip) {
  const ini = Number((await clip.getStartTime()).ticks);
  const fin = Number((await clip.getEndTime()).ticks);
  let origen = null;
  try { origen = String((await clip.getProjectItem()).name); } catch (e) { origen = null; }

  const encontrados = [];
  const cuantas = await sequence.getAudioTrackCount();
  for (let t = 0; t < cuantas; t++) {
    const track = await sequence.getAudioTrack(t);
    if (!track) continue;
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < items.length; i++) {
      const a = Number((await items[i].getStartTime()).ticks);
      const b = Number((await items[i].getEndTime()).ticks);
      // Que CONTENGA el rango del video, no que lo toque: un clip de audio que
      // apenas se solapa es de otra toma, no el par de este.
      if (a > ini + 1 || b < fin - 1) continue;
      if (origen) {
        let otro = null;
        try { otro = String((await items[i].getProjectItem()).name); } catch (e) { otro = null; }
        if (otro !== origen) continue;
      }
      encontrados.push(items[i]);
    }
  }
  return encontrados;
}

/*
 * El vínculo se DEDUCE —la API no lo expone— por medio de origen y rango
 * iguales. Pero eso solo no alcanza, y el 2026-08-16 se midió por qué:
 *
 * Dos clips de VIDEO del mismo medio, en pistas distintas, que arrancan y
 * terminan en el mismo frame, se emparejaban entre sí. Y un par así no es un
 * vínculo: en Premiere un grupo vinculado es siempre video + audio.
 *
 * Lo que producía, reproducido en el proyecto de prueba: pedir que un clip de
 * V4 durara 3s le mandaba el MISMO `salida` de fuente al de V3, que arrancaba
 * 5 segundos antes en el material — así que uno quedaba en 5s y el otro en 10s.
 * Y no se podía ni armar el caso, porque el falso vínculo propagaba también
 * `entrada` y `desde`.
 *
 * En el proyecto real ya había pasado: recortando un marcador en V3, `editar`
 * se llevó puesto un Transparent Video del usuario en V1. Esa vez el resultado
 * dio bien de casualidad, porque los dos tenían la misma entrada.
 *
 * Por eso ahora se exige que el socio sea del OTRO tipo. `soloVideo` no usa
 * esta función —tiene `audioQueCubre`, que busca el audio que contiene el
 * rango— así que este cambio no lo toca.
 *
 * El tipo se decide por LA PISTA donde está el clip, no por `getMediaType()`.
 * Se probó con el getter primero y salió al revés: los valores de
 * `Constants.MediaType` (ANY, AUDIO, DATA, VIDEO) NO son primitivos, son
 * objetos, así que compararlos como texto da "[object Object]" y no matchea
 * nada. La pista es un dato inequívoco y se recorre igual.
 */
async function buscarVinculados(sequence, clip) {
  const inicio = String((await clip.getStartTime()).ticks);
  const fin = String((await clip.getEndTime()).ticks);

  let origen = null;
  try { origen = String((await clip.getProjectItem()).name); } catch (e) { origen = null; }

  const grupos = [
    { video: true, cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i) },
    { video: false, cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i) }
  ];

  /*
   * Una sola pasada: se juntan los candidatos anotando de qué grupo salió cada
   * uno, y de paso se ve en qué grupo está el clip que se pasó. Recién al final
   * se descartan los del mismo grupo — si se filtrara antes habría que recorrer
   * las pistas dos veces, y recorrerlas es lo caro.
   */
  const candidatos = [];
  let esVideo = null;
  for (const grupo of grupos) {
    for (let t = 0; t < grupo.cuantas; t++) {
      const track = await grupo.traer(t);
      if (!track) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (let i = 0; i < items.length; i++) {
        if (items[i] === clip) { esVideo = grupo.video; continue; }
        if (String((await items[i].getStartTime()).ticks) !== inicio) continue;
        if (String((await items[i].getEndTime()).ticks) !== fin) continue;
        if (origen) {
          let otro = null;
          try { otro = String((await items[i].getProjectItem()).name); } catch (e) { otro = null; }
          if (otro !== origen) continue;
        }
        candidatos.push({ item: items[i], video: grupo.video });
      }
    }
  }

  /*
   * Si el clip no apareció en ninguna pista —no debería pasar, pero la API
   * sorprende— se devuelve vacío en vez de adivinar el tipo. Con un vínculo de
   * menos se pierde el arrastre; con uno de más se recorta un clip ajeno.
   */
  if (esVideo === null) return [];
  return candidatos.filter((c) => c.video !== esVideo).map((c) => c.item);
}

/**
 * Cuenta TODO lo que hay en la secuencia, video y audio.
 *
 * Contar solo el video fue lo que dejó pasar un borrado a medias: la pista de
 * video quedaba en 0 y el audio seguía ahí. Una verificación que mira una parte
 * del efecto confirma lo que uno esperaba, no lo que pasó.
 */
async function contarItems(sequence) {
  let video = 0, audio = 0;
  const nv = await sequence.getVideoTrackCount();
  for (let t = 0; t < nv; t++) {
    const tr = await sequence.getVideoTrack(t);
    if (tr) video += (await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
  }
  const na = await sequence.getAudioTrackCount();
  for (let t = 0; t < na; t++) {
    const tr = await sequence.getAudioTrack(t);
    if (tr) audio += (await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
  }
  return { video: video, audio: audio, total: video + audio };
}

/**
 * Saca un clip del timeline.
 *
 * Es el inverso de `insertar`, y hace falta por una razón que va más allá de la
 * simetría: sin esto, si el bridge pone algo mal, depende de que el usuario lo
 * deshaga a mano. Un verbo que crea sin poder revertir obliga a mirar cada paso.
 *
 * `dejarHueco: true` (el default) saca el clip y no mueve nada más. En false
 * hace ripple: todo lo que está a la derecha se corre. El default es el que no
 * sorprende, igual que overwrite en `insertar`.
 */
async function borrar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const encontrado = await ubicarClip(sequence, params);
  // El track viene resuelto de ubicarClip: puede ser de video o de audio, y
  // pedirlo de nuevo por índice se equivocaría de tipo.
  const track = encontrado.track;
  const contarPista = async () =>
    (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
  const antes = await contarPista();
  const totalAntes = await contarItems(sequence);

  // La selección se arma reusando el objeto vivo y vaciándolo: TrackItemSelection
  // no tiene createEmpty y `new` devuelve "Connection to object lost".
  const seleccion = await sequence.getSelection();
  const previos = await seleccion.getTrackItems();
  for (let i = 0; i < previos.length; i++) seleccion.removeItem(previos[i]);

  try { seleccion.addItem(encontrado.clip, true); }
  catch (e) { seleccion.addItem(encontrado.clip); }

  /*
   * Y los vinculados a mano. El segundo argumento de addItem NO los trae —se
   * probó, y el audio quedó igual de huérfano—, así que se buscan por medio de
   * origen y rango de tiempo y se agregan uno por uno.
   *
   * Con `vinculados: false` se saca solo el que se pidió, por si alguna vez hace
   * falta separar el video del audio.
   */
  const vinculados = params.vinculados === false ? [] : await buscarVinculados(sequence, encontrado.clip);
  for (let i = 0; i < vinculados.length; i++) {
    try { seleccion.addItem(vinculados[i], true); }
    catch (e) { try { seleccion.addItem(vinculados[i]); } catch (e2) { /* que siga con el resto */ } }
  }

  const ripple = params.dejarHueco === false;
  const editor = ppro.SequenceEditor.getEditor(sequence);

  /*
   * La firma de createRemoveItemsAction no está documentada y la aridad no
   * ayuda: reporta 0, pero con dos argumentos contesta "Not Enough Parameters"
   * y con tres "Illegal Parameter type". O sea que son TRES y uno tiene el tipo
   * equivocado.
   *
   * En vez de adivinar cuál, se ENUMERAN los valores reales de las constantes
   * candidatas y se prueban todos. La prueba de cuál sirvió no es que la llamada
   * no tire —tirar es lo que van a hacer casi todas— sino que la pista quede con
   * menos clips.
   */
  /*
   * La que anduvo, medida: el tercero es MediaType.ANY. Va primera para no
   * reintentar a ciegas en cada llamada; el resto queda de red por si en otra
   * versión de Premiere cambia.
   */
  const terceros = [];
  try {
    if (ppro.Constants.MediaType && ppro.Constants.MediaType.ANY !== undefined) {
      terceros.push(["MediaType.ANY", ppro.Constants.MediaType.ANY]);
    }
  } catch (e) { /* queda la enumeración de abajo */ }

  terceros.push(["true", true], ["false", false]);
  for (const grupo of ["MediaType", "SequenceOperation"]) {
    try {
      const c = ppro.Constants[grupo];
      if (!c) continue;
      for (const k of Object.keys(c)) terceros.push([grupo + "." + k, c[k]]);
    } catch (e) { /* si no se puede leer, quedan los otros */ }
  }

  const formas = [];
  for (let i = 0; i < terceros.length; i++) {
    formas.push([
      `(seleccion, ${ripple}, ${terceros[i][0]})`,
      () => editor.createRemoveItemsAction(seleccion, ripple, terceros[i][1])
    ]);
  }
  // Y por si el primero tuviera que ser una lista de items y no una selección.
  formas.push([
    "([clip], ripple, true)",
    () => editor.createRemoveItemsAction([encontrado.clip], ripple, true)
  ]);

  const intentos = [];
  let via = null;
  for (let i = 0; i < formas.length && !via; i++) {
    try {
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((acciones) => {
          acciones.addAction(formas[i][1]());
        }, "sacar " + encontrado.nombre);
      });
      const ahora = await contarPista();
      if (ahora < antes) { via = formas[i][0]; break; }
      intentos.push(formas[i][0] + ": la transacción devolvió " + ok + " y la pista sigue con " + ahora);
    } catch (e) {
      intentos.push(formas[i][0] + ": " + (e && e.message ? e.message : e));
    }
  }

  const despues = await contarPista();

  if (despues >= antes) {
    throw new Error(
      /*
       * Cuando TODAS las formas committean `true` y la pista no cambia, la causa
       * casi siempre es que la pista está BLOQUEADA — pasó, y el mensaje viejo
       * escupía once intentos sin nombrarla nunca.
       *
       * No se puede confirmar desde acá: `VideoTrack` expone
       * `EVENT_TRACK_LOCK_CHANGED` pero NO un `isLocked()`. Así que se nombra la
       * sospecha y se dice que no se puede verificar, en vez de callarla o de
       * afirmarla.
       */
      `No se pudo sacar "${encontrado.nombre}" de ${encontrado.pista}: la pista sigue con ` +
      `${despues} clips` +
      (intentos.some((i) => /devolvió true/.test(i))
        ? `. Todas las formas committearon sin efecto: lo más probable es que ${encontrado.pista} esté BLOQUEADA ` +
          "(el candado en el timeline). La API no expone `isLocked()`, así que desde acá no se puede confirmar."
        : "") +
      `. Intentos: ${intentos.join(" | ")}.`
    );
  }

  // El conteo de TODA la secuencia, no solo de la pista: si el clip tenía audio
  // vinculado y quedó suelto, acá se ve. Contar una parte del efecto confirma lo
  // que uno esperaba, no lo que pasó.
  const totalDespues = await contarItems(sequence);
  const audioSuelto = totalDespues.audio === totalAntes.audio && totalAntes.audio > 0;

  return {
    resumen:
      `Sacado "${encontrado.nombre}" de ${encontrado.pista}: ${antes} → ${despues} clips en la pista` +
      ` · secuencia ${totalAntes.video}v+${totalAntes.audio}a → ${totalDespues.video}v+${totalDespues.audio}a` +
      (ripple ? " (con ripple: se corrió lo de la derecha)" : " (dejando el hueco)") +
      (vinculados.length ? ` · con ${vinculados.length} vinculado(s)` : "") +
      (audioSuelto ? " · OJO: no bajó ningún clip de audio, puede haber quedado suelto" : "") +
      ` · vía ${via} · se deshace con Cmd+Z`,
    clip: encontrado.nombre,
    pista: encontrado.pista,
    clipsAntes: antes,
    clipsDespues: despues,
    secuenciaAntes: totalAntes,
    secuenciaDespues: totalDespues,
    ripple: ripple,
    vinculadosSacados: vinculados.length,
    via: via
  };
}

/* ---------- editar el timeline ---------- */

/**
 * Encuentra un clip por pista+índice o por nombre, sin tocar la selección.
 *
 * Los verbos de edición no operan sobre "el seleccionado" como los de Motion:
 * mover un clip que el usuario no ve seleccionado es exactamente el tipo de
 * sorpresa que hay que evitar, así que se nombra explícitamente cuál.
 */
async function ubicarClip(sequence, params) {
  /*
   * Recorre video Y audio. La primera versión solo miraba video, y eso dejó un
   * audio huérfano imposible de sacar desde el bridge: se podía crear pero no
   * apuntar.
   *
   * `pista` acepta un número (1 = V1, por compatibilidad) o una etiqueta como
   * las que devuelve `clips`: "V2", "A1".
   */
  const etiquetaPedida =
    typeof params.pista === "number" ? "V" + params.pista
      : typeof params.pista === "string" ? params.pista.toUpperCase()
      : null;

  const grupos = [
    { letra: "V", cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i) },
    { letra: "A", cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i) }
  ];
  const pidePorNombre = typeof params.nombre === "string";

  /*
   * DOS RECORTES DE COSTO, y no son cosméticos: este verbo lo llaman `editar`, `cortar`,
   * `borrar` y `motion`, y un armado de 138 planos hace tres `editar` por plano. La
   * versión anterior pedía `getName()` por CADA item de CADA pista en CADA llamada, o sea
   * decenas de miles de llamadas a la API por tanda — que es exactamente el patrón que el
   * CLAUDE.md tiene medido como causa de crash con el proyecto real abierto.
   *
   * 1. Si vino `pista`, NINGUNA otra puede matchear: `porIndice` exige que la etiqueta
   *    coincida, y `porNombre` también cuando la etiqueta está pedida. Las demás se
   *    recorrían sólo para llenar el listado del mensaje de error.
   * 2. El nombre se pide sólo si hace falta —para comparar, o para devolverlo del item
   *    encontrado—, no para todos los items del camino.
   *
   * El listado del error se arma DESPUÉS, y sólo si hay que tirarlo: un fallo es raro y
   * ahí sí vale pagar el recorrido completo.
   */
  for (const grupo of grupos) {
    for (let t = 0; t < grupo.cuantas; t++) {
      const etiqueta = grupo.letra + (t + 1);
      if (etiquetaPedida && etiquetaPedida !== etiqueta) continue;
      const track = await grupo.traer(t);
      if (!track) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (let i = 0; i < items.length; i++) {
        const porIndice =
          etiquetaPedida === etiqueta && typeof params.indice === "number" && i === params.indice;
        let nombre = null, porNombre = false;
        if (pidePorNombre && !porIndice) {
          nombre = String(await items[i].getName());
          porNombre = contieneN(nombre, params.nombre) &&
                      (!etiquetaPedida || etiquetaPedida === etiqueta);
        }
        if (porNombre || porIndice) {
          if (nombre === null) nombre = String(await items[i].getName());
          return {
            clip: items[i], nombre: nombre, pista: etiqueta, indice: i,
            esAudio: grupo.letra === "A", track: track
          };
        }
      }
    }
  }

  /* Recién acá se paga el recorrido completo, para que el error diga qué SÍ había. */
  const vistos = [];
  for (const grupo of grupos) {
    for (let t = 0; t < grupo.cuantas; t++) {
      const track = await grupo.traer(t);
      if (!track) continue;
      const etiqueta = grupo.letra + (t + 1);
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (let i = 0; i < items.length; i++) {
        vistos.push(`${etiqueta}[${i}] "${String(await items[i].getName())}"`);
      }
    }
  }
  throw new Error(
    `No se encontró el clip pedido (${JSON.stringify(params)}). ` +
    `En "${sequence.name}" hay: ${vistos.join(", ") || "ningún clip"}.`
  );
}

/** La velocidad del clip (1 = normal), o null si no se puede leer. */
/*
 * Si el clip es una capa de ajuste. Devuelve false cuando no se puede saber:
 * los clips de audio no tienen el método, y ahí false es la respuesta correcta.
 *
 * Importa porque una capa de ajuste NO se escala. El efecto que lleva encima se
 * aplica al área que la capa ocupa, así que bajarla al 50% deja la corrección en
 * un rectángulo en el medio y el resto del cuadro sin corregir — se probó y se
 * miró el frame.
 */
async function esCapaDeAjuste(clip) {
  try {
    if (typeof clip.isAdjustmentLayer !== "function") return false;
    return !!(await clip.isAdjustmentLayer());
  } catch (e) { return false; }
}

async function velocidadDe(clip) {
  try {
    const v = await clip.getSpeed();
    const n = aNumero(v);
    return n === null ? null : Number(n.toFixed(4));
  } catch (e) { return null; }
}

/** Los cuatro tiempos de un clip, en segundos. */
async function tiemposDe(clip) {
  const desde = aSegundos(await clip.getStartTime());
  const hasta = aSegundos(await clip.getEndTime());
  const entrada = aSegundos(await clip.getInPoint());
  return {
    desde: Number(desde.toFixed(3)),
    hasta: Number(hasta.toFixed(3)),
    entrada: Number(entrada.toFixed(3)),
    desfase: Number((entrada - desde).toFixed(3))
  };
}

/**
 * Mueve un clip en el tiempo y/o recorta sus extremos.
 *
 * `createMoveAction` toma un DELTA y no un tiempo absoluto —o eso parece por el
 * nombre—, así que se calcula la diferencia contra donde está. Si resultara ser
 * absoluto, la relectura lo va a delatar: el clip quedaría en el lugar
 * equivocado y el resumen lo dice.
 *
 * Todo va en UNA transacción para que se deshaga con un solo Cmd+Z.
 */
async function editar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const encontrado = await ubicarClip(sequence, params);
  const clip = encontrado.clip;

  const antes = await tiemposDe(clip);

  /*
   * Los vinculados se buscan ANTES de tocar nada: se identifican por rango de
   * tiempo, así que después del cambio ya no coincidirían.
   *
   * Y hay que moverlos: `createMoveAction` mueve UN item. Sin esto, mover un
   * clip de video dejaba su audio donde estaba —medido: video a 30s, audio en
   * 5s, veinticinco segundos de desincronización— y nada avisaba. Es peor que
   * el audio huérfano de `borrar`, porque ahí queda algo visible de más y acá
   * queda algo que solo se nota reproduciendo.
   */
  const vinculados = params.vinculados === false ? [] : await buscarVinculados(sequence, clip);
  const antesVinculados = [];
  for (let i = 0; i < vinculados.length; i++) antesVinculados.push(await tiemposDe(vinculados[i]));

  const acciones = [];
  const pedido = [];

  /*
   * Cada acción se aplica al clip Y a sus vinculados, pero **traducida**, no
   * copiada. `apagado` no se propaga: apagar el video dejando el audio es una
   * operación legítima y la hace quien la pide.
   *
   * La fábrica recibe el clip y su propia foto de ANTES, porque `entrada` y
   * `salida` son puntos adentro del MATERIAL y el material de cada clip arranca
   * donde arranca. Copiarle al socio el mismo número absoluto fue un bug con
   * pérdida de datos, medido el 2026-08-16: un video que empieza en 5 y su
   * audio en 8, pidiendo `salida: 8`, dejaba el video en 3s y el audio en
   * **duración cero** — y Premiere acepta un clip de largo cero.
   *
   * Lo que se conserva entre vinculados es el DELTA sobre el material, que es
   * lo mismo que decir que los dos terminan en el mismo punto del timeline.
   * `desde` ya venía bien porque `createMoveAction` toma un delta.
   *
   * Asume que el par comparte velocidad. Para un vínculo real lo hacen; si
   * alguna vez no, se vería como un desalineado y el verbo lo informa.
   */
  const aTodos = (fabrica) => {
    acciones.push(() => fabrica(clip, antes));
    for (let i = 0; i < vinculados.length; i++) {
      const v = vinculados[i], suyo = antesVinculados[i];
      acciones.push(() => fabrica(v, suyo));
    }
  };

  if (typeof params.desde === "number") {
    const delta = aTick(params.desde - antes.desde);
    aTodos((c) => c.createMoveAction(delta));
    pedido.push(`mover a ${params.desde}s (delta ${(params.desde - antes.desde).toFixed(3)}s)`);
  }
  if (typeof params.entrada === "number") {
    const delta = params.entrada - antes.entrada;
    aTodos((c, suyo) => c.createSetInPointAction(aTick(suyo.entrada + delta)));
    pedido.push(`entrada a ${params.entrada}s (delta ${delta.toFixed(3)}s sobre el material)`);
  }
  if (typeof params.salida === "number") {
    const delta = params.salida - antes.entrada;
    aTodos((c, suyo) => c.createSetOutPointAction(aTick(suyo.entrada + delta)));
    pedido.push(`salida a ${params.salida}s (${delta.toFixed(3)}s después de su entrada)`);
  }
  if (typeof params.apagado === "boolean") {
    acciones.push(() => clip.createSetDisabledAction(params.apagado));
    pedido.push(params.apagado ? "apagar" : "prender");
  }

  if (!acciones.length) {
    return {
      resumen: `"${encontrado.nombre}" en ${encontrado.pista}: ${antes.desde}–${antes.hasta}s, ` +
               `entrada ${antes.entrada}s, desfase ${antes.desfase}s. No se pidió ningún cambio.`,
      clip: encontrado.nombre, antes: antes, despues: antes, cambio: false
    };
  }

  let excepcion = null;
  try {
    project.lockedAccess(() => {
      project.executeTransaction((a) => {
        for (let i = 0; i < acciones.length; i++) a.addAction(acciones[i]());
      }, "editar " + encontrado.nombre);
    });
  } catch (e) {
    excepcion = e && e.message ? e.message : String(e);
  }

  // La prueba: releer. Una transacción puede "salir bien" sin mover nada.
  const despues = await tiemposDe(clip);
  const cambio =
    antes.desde !== despues.desde || antes.hasta !== despues.hasta || antes.entrada !== despues.entrada;

  /*
   * Y releer los vinculados: no alcanza con que se hayan movido, tienen que
   * haber quedado ALINEADOS. Un vinculado que se movió otra cantidad está
   * desincronizado, que es el fallo que esto viene a evitar.
   */
  const desalineados = [];
  for (let i = 0; i < vinculados.length; i++) {
    const ahora = await tiemposDe(vinculados[i]);
    if (ahora.desde !== despues.desde || ahora.hasta !== despues.hasta) {
      /*
       * El rango ENTERO y contra qué se compara, no solo el `desde`.
       *
       * Antes decía `300s → 300s` cuando el desalineado estaba en el final: los
       * dos números salían iguales y el aviso se leía como ruido. Pasó de
       * verdad —un clip quedó en 5s y el otro en 10s— y el mensaje no dejaba
       * verlo. Un aviso que no muestra la diferencia que denuncia no sirve.
       */
      desalineados.push(
        `${ahora.desde}–${ahora.hasta}s cuando debía quedar en ${despues.desde}–${despues.hasta}s`
      );
    }
  }

  return {
    resumen:
      `"${encontrado.nombre}" en ${encontrado.pista}: ` +
      `${antes.desde}–${antes.hasta}s (entrada ${antes.entrada}s) → ` +
      `${despues.desde}–${despues.hasta}s (entrada ${despues.entrada}s, desfase ${despues.desfase}s)` +
      (vinculados.length ? ` · ${vinculados.length} vinculado(s) movidos con él` : "") +
      (desalineados.length
        ? ` · OJO: ${desalineados.length} quedaron DESALINEADOS (${desalineados.join(", ")})`
        : "") +
      (excepcion ? ` · excepción: ${excepcion}` : "") +
      (cambio ? " · un Cmd+Z lo deshace" : " · NO CAMBIÓ NADA"),
    clip: encontrado.nombre,
    pista: encontrado.pista,
    pedido: pedido,
    antes: antes,
    despues: despues,
    vinculados: vinculados.length,
    desalineados: desalineados,
    cambio: cambio,
    excepcion: excepcion
  };
}

/**
 * Selecciona un clip por pista e índice, o por nombre.
 *
 * `setSelection` existe y `TrackItemSelection` tiene addItem/removeItem, pero no
 * está documentado cómo se arma una selección vacía. Se prueban las vías en
 * orden y se informa cuál anduvo; si fallan todas, el error dice qué ofrece la
 * clase de verdad, así el próximo intento no es otra adivinanza.
 *
 * La prueba de que funcionó NO es que setSelection no tire: es releer la
 * selección después y ver que el clip sea el que se pidió.
 */
async function seleccionar(params) {
  const { sequence } = await getProyectoYSecuencia();

  /*
   * Buscar con ubicarClip y NO con un escaneo propio. La primera versión tenía
   * su propio recorrido, quedó video-only cuando ubicarClip aprendió de audio, y
   * el síntoma fue que "A1" no existía para este verbo aunque `clips` lo listaba.
   * Dos caminos de código para la misma pregunta divergen siempre.
   */
  const encontrado = await ubicarClip(sequence, params);
  const objetivo = encontrado.clip;
  const dondeEsta = { pista: encontrado.pista, indice: encontrado.indice, nombre: encontrado.nombre };

  // 2) Armar la selección. Las vías, de la más limpia a la más artesanal.
  const intentos = [];
  let via = null;

  const armar = [
    ["TrackItemSelection.createEmpty", () => ppro.TrackItemSelection.createEmpty()],
    ["new TrackItemSelection", () => new ppro.TrackItemSelection()],
    ["reusar getSelection y vaciarla", async () => {
      const s = await sequence.getSelection();
      const previos = await s.getTrackItems();
      for (let i = 0; i < previos.length; i++) s.removeItem(previos[i]);
      return s;
    }]
  ];

  for (let i = 0; i < armar.length && !via; i++) {
    try {
      const s = await armar[i][1]();
      if (!s) { intentos.push(armar[i][0] + ": devolvió " + s); continue; }
      // addItem a veces pide un segundo argumento (¿incluir vinculados?): se
      // prueban las dos formas antes de descartar la vía entera.
      try { s.addItem(objetivo); }
      catch (e) { s.addItem(objetivo, true); }
      await sequence.setSelection(s);
      via = armar[i][0];
    } catch (e) {
      intentos.push(armar[i][0] + ": " + (e && e.message ? e.message : e));
    }
  }

  // 3) La única prueba que vale: releer.
  const ahora = await getClipSeleccionado(sequence);
  const nombreAhora = ahora ? String(await ahora.clip.getName()) : null;
  const quedo = nombreAhora === dondeEsta.nombre;

  if (!quedo && !via) {
    let ofrece = [];
    try { ofrece = Object.getOwnPropertyNames(ppro.TrackItemSelection).sort(); } catch (e) { /* nada */ }
    throw new Error(
      `No se pudo armar la selección. Intentos: ${intentos.join(" | ")}. ` +
      `TrackItemSelection ofrece: ${ofrece.join(", ") || "<no se pudo reflejar>"}.`
    );
  }

  return {
    resumen: quedo
      ? `Seleccionado "${dondeEsta.nombre}" en ${dondeEsta.pista} (vía ${via}).`
      : `setSelection no tiró (vía ${via}) pero el clip seleccionado sigue siendo ` +
        `${nombreAhora ? `"${nombreAhora}"` : "ninguno"} y no "${dondeEsta.nombre}". NO SE SELECCIONÓ.`,
    pedido: dondeEsta,
    seleccionadoAhora: nombreAhora,
    quedo: quedo,
    via: via,
    intentos: intentos
  };
}

async function estado() {
  /*
   * NO EXIGE SECUENCIA. Antes usaba `getProyectoYSecuencia`, así que en un proyecto recién creado
   * —o en cualquiera sin secuencias— tiraba "Hay un proyecto abierto pero ninguna secuencia
   * activa": el verbo de ORIENTACIÓN negándose justo cuando más falta hace saber dónde se está
   * parado. Apareció el 2026-08-29 probando `crearProyecto`, que deja un proyecto vacío.
   *
   * Ahora informa el proyecto igual y dice que no hay secuencia, que es la respuesta correcta.
   */
  const project = await getProyecto();
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    const nom = project.path
      ? String(project.path).split("/").pop().replace(/\.prproj$/i, "")
      : (project.name ? String(project.name) : "sin guardar");
    return {
      resumen: `[${nom}] SIN SECUENCIA ACTIVA · el proyecto está abierto y no hay ninguna secuencia ` +
               "puesta al frente. Los verbos que no la necesitan: secuencias, medios, guardar, " +
               "importar, api, armarSecuencia, abrirProyecto, crearProyecto.",
      info: { secuencia: null, proyecto: project.path || null, proyectoNombre: nom, haySecuencia: false }
    };
  }

  // OJO: no existe settings.videoFrameWidth. El método real es
  // getVideoFrameRect(), que devuelve un RectF {width, height}.
  const settings = await sequence.getSettings();
  const rect = await settings.getVideoFrameRect();
  const fps = await settings.getVideoFrameRate();

  const info = {
    secuencia: sequence.name,
    ancho: rect.width,
    alto: rect.height,
    fps: fps && fps.value ? fps.value : null,
    pistasDeVideo: await sequence.getVideoTrackCount(),
    // El audio también: informar solo las pistas de video es mentir por omisión
    // sobre qué hay abierto, y fue parte de por qué el bridge lo ignoraba.
    pistasDeAudio: await sequence.getAudioTrackCount(),
    proyecto: project.path,
    /* El nombre suelto, para el resumen. `project.path` puede venir vacío en un proyecto sin
     * guardar, y ahí se dice eso en vez de mostrar una cadena vacía. */
    proyectoNombre: project.path ? String(project.path).split("/").pop().replace(/\.prproj$/i, "")
                                 : (project.name ? String(project.name) : "sin guardar"),
    clipSeleccionado: null,
    pistaDelClip: null,
    seleccionEsAudio: false,
    /* Los in/out de la SECUENCIA, porque definen el largo de un export sin que nada lo diga.
     * `exportSequence` los respeta: en un corporativo un out viejo dejo 3,44s de negro al final y la
     * unica forma de detectarlo fue medir el archivo de afuera. Un dato que se paga asi de caro
     * tiene que estar en el verbo que uno llama para orientarse. Aca solo se LEE. */
    inOut: null,
    marcaInOut: null,
    finSecuencia: null
  };

  try {
    const iP = await sequence.getInPoint(), oP = await sequence.getOutPoint();
    const finP = aSegundos(await sequence.getEndTime());
    const di = aSegundos(iP), ha = aSegundos(oP);
    info.finSecuencia = Number(finP.toFixed(3));
    info.inOut = { desde: Number(di.toFixed(3)), hasta: Number(ha.toFixed(3)) };
    /* Se informan los NUMEROS CRUDOS y aparte la clasificacion: los getters no devuelven lo
     * mismo en todos los casos —estaba escrito que sin marca dan 0 y el final, y el 2026-08-27
     * en un multicamara dieron -400000— asi que el verbo dice que leyo y no solo que concluyo. */
    if (Math.abs(di) > 1e5 || Math.abs(ha) > 1e5) info.marcaInOut = "sin marca (sentinel)";
    else if (Math.abs(di) < 0.001 && Math.abs(ha - finP) < 0.05) info.marcaInOut = "abarca todo";
    else info.marcaInOut = "RECORTA";
  } catch (e) { info.inOut = null; info.marcaInOut = null; }

  const sel = await getClipSeleccionado(sequence);
  if (sel) {
    info.clipSeleccionado = String(await sel.clip.getName());
    info.seleccionEsAudio = !!sel.esAudio;
    // trackIndex es -1 para audio: ubicarPistaDeClip solo recorre video.
    info.pistaDelClip = sel.trackIndex >= 0 ? sel.trackIndex + 1 : null;
  }

  return {
    /* EL PROYECTO VA PRIMERO, y no es cosmético.
     *
     * El dato estaba —`info.proyecto` sale de `project.path`— pero NO en el resumen, que es lo
     * único que uno lee. Así que el verbo de orientación más básico no decía dónde estabas
     * parado, y el nombre de la SECUENCIA se leía como si fuera el del proyecto: en el de un videoclip
     * la secuencia se llamaba "NOMBRE DEL PROYECTO ROUGH CUT", así que la
     * confusión pasaba desapercibida.
     *
     * Costó tres llamadas el 2026-08-22: Premiere había cambiado el foco al proyecto de prueba
     * y yo interrogaba `medios` y `bins` creyendo que contestaban sobre el corporativo. Fueron
     * lecturas, así que no hubo daño — pero un `borrar` con la misma confusión habría barrido
     * el timeline del proyecto equivocado, y nada lo habría avisado.
     *
     * Va el nombre del archivo, no la ruta entera: la ruta llena el resumen y lo que identifica
     * es el nombre. La ruta completa sigue en `info.proyecto`. */
    resumen:
      `[${info.proyectoNombre || "proyecto ?"}] ${info.secuencia} · ${info.ancho}x${info.alto} @ ${info.fps || "?"}fps · ` +
      `${info.pistasDeVideo} pistas de video y ${info.pistasDeAudio} de audio · ` +
      (info.clipSeleccionado
        ? `seleccionado: "${info.clipSeleccionado}"` +
          (info.pistaDelClip ? ` en V${info.pistaDelClip}` : info.seleccionEsAudio ? " (de audio)" : "")
        : "sin clip seleccionado") +
      /* El aviso va en el RESUMEN y no solo en `info`: un dato que esta en la respuesta y no en
       * el resumen es un dato que no esta. Ya se pago una vez, con el nombre del proyecto. */
      (info.marcaInOut === "RECORTA"
        ? ` · OJO: in/out ${info.inOut.desde.toFixed(2)}–${info.inOut.hasta.toFixed(2)}s sobre una ` +
          `secuencia que termina en ${info.finSecuencia.toFixed(2)}s: eso RECORTA el export. Opt+X los saca.`
        : (info.inOut ? ` · in/out ${info.inOut.desde.toFixed(2)}–${info.inOut.hasta.toFixed(2)} (${info.marcaInOut})` : "")),
    info: info
  };
}

async function motion() {
  const { project, sequence } = await getProyectoYSecuencia();
  const sel = await exigirClip(sequence);
  const nombreClip = String(await sel.clip.getName());

  const comp = await getComponente(sel.clip, "Motion");
  if (!comp) throw new Error(`El clip "${nombreClip}" no tiene componente Motion.`);

  /*
   * EL RELOJ DEL MATERIAL, y esto era un bug medido el 2026-08-25.
   *
   * Los keyframes de un param viven en el tiempo del MATERIAL, no en el de la secuencia.
   * `motion` le pasaba el playhead CRUDO a `valorEnTiempo`, sin convertir, y eso no daba un
   * valor corrido: daba uno CONSTANTE. Con el clip `FX3_3602.MP4` en 346,12s y dos keyframes
   * de Position:
   *
   *     playhead    motion (roto)        param (bien)
   *       352s      (0.800, 0.500)       x = 0.234
   *       367s      (0.800, 0.500)       x = 0.491
   *       383s      (0.800, 0.500)       x = 0.766
   *
   * 0,8 es el valor del ÚLTIMO keyframe: el tick de secuencia (352) cae muy pasado el rango
   * del param —que en material termina cerca de los 39s— y Premiere CLAMPEA al último. Así
   * que el verbo contestaba con confianza un número que no era el del playhead.
   *
   * Apareció leyendo el nest animado de VIDEO 1 en un corporativo: 20 keyframes de
   * posición, la tarjeta visiblemente en dos lugares distintos, y `motion` devolviendo
   * (0.500, 0.450) en los cuatro instantes. El corolario que importa: **no se puede "copiar
   * el Motion" de un clip animado leyéndolo con este verbo** — devolvía una constante.
   *
   * `param` ya lo hacía bien y era la referencia a la mano.
   */
  const reloj = await relojDelClip(sel.clip);
  const playhead = reloj.aMaterial(await sequence.getPlayerPosition());
  const salida = {};

  /*
   * El param de escala CAMBIA DE NOMBRE según la casilla *Uniform Scale*: se
   * llama "Scale" si está tildada y "Scale Height" si no. (El param sin nombre
   * que aparece entre medio es la casilla misma, que no tiene displayName.)
   *
   * Pedirlo con el nombre fijo funciona en los clips donde la casilla está
   * tildada y devuelve null en los otros, que es como se descubrió: un clip con
   * la casilla apagada reportó "Scale: null" teniendo escala de sobra.
   */
  const escala = getParametro(project, comp, "Scale") ? "Scale" : "Scale Height";
  const nombres = ["Position", escala, "Scale Width"];
  for (let i = 0; i < nombres.length; i++) {
    const p = getParametro(project, comp, nombres[i]);
    if (!p) { salida[nombres[i]] = null; continue; }
    const crudo = await valorEnTiempo(project, p, playhead);
    const valor = nombres[i] === "Position" ? aPunto(crudo) : aNumero(crudo);
    salida[nombres[i]] = { valor: valor, keyframes: contarKeyframes(project, p) };
    // Solo cuando el normalizador no supo qué hacer: así el diagnóstico viaja
    // con el dato en vez de obligar a otra corrida para averiguarlo.
    if (valor === null) salida[nombres[i]].visto = describirValor(crudo);
  }

  const pos = salida.Position && salida.Position.valor;
  return {
    resumen:
      `"${nombreClip}" · pos ${pos ? `(${pos.x.toFixed(3)}, ${pos.y.toFixed(3)})` : "?"} · ` +
      `${escala} ${salida[escala] ? salida[escala].valor : "?"} · ` +
      `keyframes pos/escala ${salida.Position ? salida.Position.keyframes : "?"}/${salida[escala] ? salida[escala].keyframes : "?"}`,
    clip: nombreClip,
    // Cómo se llama la escala acá, para que quien vaya a escribir use ese nombre
    // y no el del otro caso.
    paramDeEscala: escala,
    escalaUniforme: escala === "Scale",
    params: salida
  };
}

/**
 * Escribe uno o varios keyframes en un param de cualquier efecto.
 *
 * DOS TRANSACCIONES EN TOTAL, no dos por keyframe. Con veinticinco keyframes,
 * de a uno serían cincuenta Cmd+Z para deshacer una sola animación; así es uno.
 *
 * El orden de las llamadas no es decorativo: el keyframe se CREA adentro de
 * lockedAccess porque es una referencia de la API, y su `position` se asigna
 * AFUERA, porque adentro no toma.
 *
 * Los tiempos entran en segundos de SECUENCIA y se convierten al reloj del
 * material, que es donde viven los keyframes. Ver relojDelClip.
 */
async function keyframe(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const sel = await exigirClip(sequence);
  const nombreClip = String(await sel.clip.getName());
  const nombreEfecto = params.efecto || "Motion";
  const nombreParam = params.param;

  const comp = await getComponente(sel.clip, nombreEfecto);
  if (!comp) {
    const chain = await sel.clip.getComponentChain();
    const n = await chain.getComponentCount();
    const hay = [];
    for (let i = 0; i < n; i++) hay.push(String(await (await chain.getComponentAtIndex(i)).getDisplayName()));
    throw new Error(`"${nombreClip}" no tiene un efecto "${nombreEfecto}". Tiene: ${hay.join(", ")}.`);
  }

  const p = getParametro(project, comp, nombreParam);
  if (!p) {
    throw new Error(
      `El efecto "${nombreEfecto}" de "${nombreClip}" no expuso "${nombreParam}". Tiene: ` +
      listarParams(project, comp).join(", ")
    );
  }

  /*
   * Dos formas de pedirlo: `lista` para animar, o valor suelto para un keyframe
   * en el playhead. La segunda es la primera con un elemento, así que se
   * normaliza acá y abajo hay un solo camino.
   */
  const reloj = await relojDelClip(sel.clip);
  const playhead = await sequence.getPlayerPosition();

  const pedidos = Array.isArray(params.lista) && params.lista.length
    ? params.lista
    : [{ segundos: aSegundos(playhead), valor: params.valor, x: params.x, y: params.y }];

  const puntos = [];
  for (let i = 0; i < pedidos.length; i++) {
    const e = pedidos[i];
    let valor;
    if (typeof e.x === "number" && typeof e.y === "number") {
      valor = new ppro.PointF(e.x, e.y);
    } else if (typeof e.valor === "number" || typeof e.valor === "boolean") {
      // Booleano incluido: hay params que son casillas, como Volume > Mute.
      valor = e.valor;
    } else {
      throw new Error(
        `El keyframe ${i} no trae ni "valor" ni el par x/y. Llegó: ${JSON.stringify(e)}. ` +
        "Los params de punto (Position, Anchor Point) piden x e y; el resto, valor."
      );
    }
    const seg = typeof e.segundos === "number" ? e.segundos : aSegundos(playhead);
    puntos.push({ valor: valor, tick: reloj.aMaterial(aTick(seg)), segundos: seg });
  }

  const antes = contarKeyframes(project, p);
  let excepcion = null;

  /*
   * Activar keyframes es una transacción SEPARADA de agregarlos, así que el
   * deshacer puede costar uno o dos Cmd+Z. executeTransaction devuelve si hizo
   * algo: en un param que ya estaba activado no genera entrada de deshacer.
   *
   * Se cuenta en vez de suponerse porque decir "un Cmd+Z" cuando son dos deja al
   * usuario con medio cambio puesto y creyendo que lo sacó entero.
   */
  let transacciones = 0;

  try {
    project.lockedAccess(() => {
      const activo = project.executeTransaction((acciones) => {
        acciones.addAction(p.createSetTimeVaryingAction(true));
      }, "activar keyframes");
      if (activo) transacciones++;
    });

    const creados = [];
    project.lockedAccess(() => {
      for (let i = 0; i < puntos.length; i++) creados.push(p.createKeyframe(puntos[i].valor));
    });
    for (let i = 0; i < creados.length; i++) creados[i].position = puntos[i].tick;

    project.lockedAccess(() => {
      const puso = project.executeTransaction((acciones) => {
        for (let i = 0; i < creados.length; i++) acciones.addAction(p.createAddKeyframeAction(creados[i]));
      }, puntos.length === 1 ? "agregar keyframe" : "agregar " + puntos.length + " keyframes");
      if (puso) transacciones++;
    });
  } catch (e) {
    excepcion = e && e.message ? e.message : String(e);
  }

  const despues = contarKeyframes(project, p);

  // Releer DÓNDE quedaron, no solo cuántos: un keyframe en el tiempo equivocado
  // cuenta igual que uno bien puesto, y es el error que el reloj del material
  // provoca sin avisar.
  const quedaron = [];
  try {
    project.lockedAccess(() => {
      const ts = p.getKeyframeListAsTickTimes();
      if (ts) for (let i = 0; i < ts.length; i++) quedaron.push(Number(reloj.aSegundosDeSecuencia(ts[i]).toFixed(3)));
    });
  } catch (e) { /* ilegible */ }

  return {
    resumen:
      `${nombreEfecto} > ${nombreParam} en "${nombreClip}": keyframes ${antes} → ${despues}` +
      (excepcion ? ` (excepción: ${excepcion})` : "") +
      (despues > antes
        ? ` en ${quedaron.join("s, ")}s` +
          (reloj.velocidad !== 1 ? ` (clip a ${reloj.velocidad}x)` : "") +
          ` · se deshace con ${transacciones} Cmd+Z` +
          (transacciones > 1 ? " (uno agrega los keyframes, otro activa el param)" : "")
        : " · NO SE ESCRIBIÓ NADA"),
    clip: nombreClip,
    efecto: nombreEfecto,
    param: nombreParam,
    pedidos: puntos.map((x) => x.segundos),
    quedaronEnSegundos: quedaron,
    desfaseDelMaterialEnSegundos: Number(reloj.desfaseSegundos.toFixed(3)),
    // A la vista: si no es 1, el material corre a otro ritmo que la secuencia y
    // los tiempos pedidos pasan por esa cuenta.
    velocidadDelClip: reloj ? reloj.velocidad : null,
    keyframesAntes: antes,
    keyframesDespues: despues,
    escribio: despues > antes,
    excepcion: excepcion
  };
}

/* ---------- el frame ---------- */

function dirname(p) {
  const s = String(p).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : s;
}

/*
 * Dónde puede escribir Premiere el frame exportado. Se prueban varias porque
 * exportSequenceFrame devuelve éxito aunque no deje el archivo en ningún lado:
 * el único juez es si el archivo APARECE.
 */


/**
 * Los keyframes que EXISTEN, en el reloj de la SECUENCIA.
 *
 * `getKeyframeListAsTickTimes` devuelve TIEMPOS, no punteros. Es la vía segura y está
 * medido por qué: `getKeyframePtr` en ráfaga tira Premiere con SIGBUS (ver CLAUDE.md).
 */
function keyframesDe(project, param, reloj) {
  const ticks = [];
  try {
    project.lockedAccess(() => {
      const ts = param.getKeyframeListAsTickTimes();
      if (ts) for (let i = 0; i < ts.length; i++) ticks.push(ts[i]);
    });
  } catch (e) { /* devolvemos lo que se haya juntado */ }
  return ticks.map((t) => ({ tick: t, segundos: Number(reloj.aSegundosDeSecuencia(t).toFixed(3)) }));
}

/**
 * Resuelve clip + efecto + param, con el OBJETIVO EXPLÍCITO.
 *
 * Lo comparten `borrarKeyframe` y `moverKeyframe`, y exige el clip por nombre o por
 * pista+índice a propósito: operar sobre "el seleccionado" es una sorpresa fea en
 * cualquier verbo destructivo, y en éste más que en ninguno — **un keyframe borrado no
 * deja hueco, no tira error y no se ve en el timeline.** Sólo cambia la animación, y eso
 * se descubre reproduciendo.
 */
async function objetivoDeKeyframes(params, quien) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (params.nombre === undefined && params.pista === undefined && params.indice === undefined) {
    throw new Error(
      `\`${quien}\` exige el clip explícito: \`nombre\`, o \`pista\` + \`indice\`. ` +
      "Sobre el clip seleccionado no se hace: un keyframe borrado no se ve en el timeline."
    );
  }
  const enc = await ubicarClip(sequence, params);
  const nombreClip = enc.nombre !== undefined ? enc.nombre : String(await enc.clip.getName());
  const nombreEfecto = params.efecto || "Motion";

  const comp = await getComponente(enc.clip, nombreEfecto);
  if (!comp) {
    const chain = await enc.clip.getComponentChain();
    const n = await chain.getComponentCount();
    const hay = [];
    for (let i = 0; i < n; i++) hay.push(String(await (await chain.getComponentAtIndex(i)).getDisplayName()));
    throw new Error(`"${nombreClip}" no tiene un efecto "${nombreEfecto}". Tiene: ${hay.join(", ")}.`);
  }

  const nombreParam = params.param;
  if (typeof nombreParam !== "string" || !nombreParam) {
    throw new Error(`Falta \`param\`. El efecto "${nombreEfecto}" tiene: ` + listarParams(project, comp).join(", "));
  }

  /*
   * `indiceParam` gana si viene, porque los nombres NO son únicos: Lumetri repite
   * "Saturation" tres veces. Sin él se agarra el primero, que puede ser de otro grupo.
   */
  let p = null;
  if (typeof params.indiceParam === "number") {
    project.lockedAccess(() => {
      const n = comp.getParamCount();
      if (params.indiceParam >= 0 && params.indiceParam < n) p = comp.getParam(params.indiceParam);
    });
    if (p) {
      const real = String(p.displayName);
      if (real !== nombreParam) {
        throw new Error(
          `El índice ${params.indiceParam} de "${nombreEfecto}" es "${real}", no "${nombreParam}". ` +
          "O corregís el índice, o sacás `indiceParam` y se busca por nombre."
        );
      }
    }
  }
  if (!p) p = getParametro(project, comp, nombreParam);
  if (!p) {
    throw new Error(
      `El efecto "${nombreEfecto}" de "${nombreClip}" no expuso "${nombreParam}". Tiene: ` +
      listarParams(project, comp).join(", ")
    );
  }

  const reloj = await relojDelClip(enc.clip);
  return { project, sequence, enc, nombreClip, nombreEfecto, nombreParam, comp, p, reloj };
}

/**
 * BORRA keyframes de un param, por tiempo. El que faltaba.
 *
 * Hasta ahora sólo había dos extremos: `keyframe` agrega o sobrescribe, y `fijar` deja el
 * param en un valor fijo — lo que **borra TODOS** los del param. No había nada en el medio,
 * y por eso mover un keyframe de tiempo no se podía hacer por API.
 *
 * `segundos` van en el reloj de la SECUENCIA y se emparejan con tolerancia, porque un
 * keyframe vive en un tick exacto y pedirlo en segundos nunca cae justo. El default es
 * **medio cuadro a 25fps (0,02s)**: suficiente para agarrar el que se quiere y demasiado
 * poco para agarrar el de al lado.
 *
 * Devuelve **cuántos había, cuántos quedaron y en qué segundos**, que es la única prueba de
 * que pasó algo. Un booleano acá no distingue "borré el que pediste" de "borré todos".
 */
async function borrarKeyframe(params) {
  const o = await objetivoDeKeyframes(params, "borrarKeyframe");
  const tol = typeof params.tolerancia === "number" ? params.tolerancia : 0.02;

  const antes = keyframesDe(o.project, o.p, o.reloj);
  const pedidos = Array.isArray(params.segundos) ? params.segundos
    : typeof params.segundos === "number" ? [params.segundos] : null;
  if (!pedidos || !pedidos.length) {
    throw new Error(
      "Falta `segundos`: un número o una lista, en el reloj de la secuencia. " +
      (antes.length ? `Este param tiene keyframes en: ${antes.map((k) => k.segundos).join(", ")}.`
                    : "Este param no tiene ningún keyframe.")
    );
  }

  const aBorrar = [], sinMatch = [];
  for (let i = 0; i < pedidos.length; i++) {
    let mejor = null, dist = Infinity;
    for (let j = 0; j < antes.length; j++) {
      const d = Math.abs(antes[j].segundos - pedidos[i]);
      if (d < dist) { dist = d; mejor = antes[j]; }
    }
    if (mejor && dist <= tol && aBorrar.indexOf(mejor) === -1) aBorrar.push(mejor);
    else sinMatch.push(pedidos[i]);
  }

  if (!aBorrar.length) {
    return {
      resumen:
        `${o.nombreEfecto} > ${o.nombreParam} en "${o.nombreClip}": NO SE BORRÓ NADA · ` +
        `ninguno de los tiempos pedidos (${pedidos.join(", ")}) cae a menos de ${tol}s de un keyframe · ` +
        (antes.length ? `los que hay están en: ${antes.map((k) => k.segundos).join(", ")}`
                      : "el param no tiene keyframes"),
      antes: antes.map((k) => k.segundos), despues: antes.map((k) => k.segundos),
      borrados: [], sinMatch: sinMatch, transacciones: 0
    };
  }

  /*
   * UNA transacción para todos. Una ráfaga de transacciones tira Premiere con SIGSEGV
   * —medido: 200ms lo tira, 1200ms no— así que N borrados no pueden ser N transacciones.
   */
  let excepcion = null, transacciones = 0;
  try {
    o.project.lockedAccess(() => {
      const hizo = o.project.executeTransaction((acciones) => {
        for (let i = 0; i < aBorrar.length; i++) acciones.addAction(o.p.createRemoveKeyframeAction(aBorrar[i].tick));
      }, aBorrar.length === 1 ? "borrar keyframe" : "borrar " + aBorrar.length + " keyframes");
      if (hizo) transacciones++;
    });
  } catch (e) { excepcion = e && e.message ? e.message : String(e); }

  const despues = keyframesDe(o.project, o.p, o.reloj);
  const pedidosSeg = aBorrar.map((k) => k.segundos);
  const siguen = pedidosSeg.filter((s) => despues.some((k) => Math.abs(k.segundos - s) <= tol));

  return {
    resumen:
      `${o.nombreEfecto} > ${o.nombreParam} en "${o.nombreClip}": ` +
      `keyframes ${antes.length} → ${despues.length}` +
      (excepcion ? ` (excepción: ${excepcion})` : "") +
      ` · borrados ${pedidosSeg.length - siguen.length} de ${pedidosSeg.length} pedidos (${pedidosSeg.join(", ")}s)` +
      (siguen.length ? ` · OJO: SIGUEN AHÍ ${siguen.join(", ")}s` : "") +
      (sinMatch.length ? ` · sin match: ${sinMatch.join(", ")}s` : "") +
      ` · quedaron en: ${despues.length ? despues.map((k) => k.segundos).join(", ") : "ninguno"}` +
      (transacciones ? ` · se deshace con ${transacciones} Cmd+Z` : " · nada que deshacer"),
    antes: antes.map((k) => k.segundos),
    despues: despues.map((k) => k.segundos),
    borrados: pedidosSeg.filter((s) => siguen.indexOf(s) === -1),
    sinMatch: sinMatch,
    transacciones: transacciones
  };
}

/**
 * MUEVE un keyframe de tiempo, sin cambiarle el valor.
 *
 * Es la operación que faltaba de verdad: apareció en un corporativo alargando una placa de 5 a 10s,
 * donde había que correr dos keyframes 5 segundos y el único camino por API era reescribir
 * el del final para convertirlo en meseta y agregar dos nuevos, dejando keyframes
 * redundantes. Lo terminó haciendo el usuario con dos arrastres.
 *
 * Se compone de las dos mitades —escribir en el destino y borrar el origen— y por eso el
 * veredicto NO es que la llamada no tire: si entra la escritura y no el borrado, quedan DOS
 * keyframes donde tenía que haber uno. Se relee y se exige que el conteo no haya cambiado,
 * que el destino esté y que el origen no.
 *
 * Y NO escribe sobre un tiempo ocupado: el `CLAUDE.md` tiene registrado un crash de Premiere
 * al escribir un keyframe sobre otro que ya existía, con la causa SIN identificar. Con un
 * solo caso no alcanza para llamarlo un modo de fallo, pero tampoco para arriesgar el
 * proyecto del usuario: si el destino ya tiene uno, rebota y lo dice.
 */
async function moverKeyframe(params) {
  const o = await objetivoDeKeyframes(params, "moverKeyframe");
  const tol = typeof params.tolerancia === "number" ? params.tolerancia : 0.02;

  if (typeof params.de !== "number" || typeof params.a !== "number") {
    throw new Error("Faltan `de` y `a`, los dos en segundos de la secuencia.");
  }

  const antes = keyframesDe(o.project, o.p, o.reloj);
  let origen = null, dist = Infinity;
  for (let i = 0; i < antes.length; i++) {
    const d = Math.abs(antes[i].segundos - params.de);
    if (d < dist) { dist = d; origen = antes[i]; }
  }
  if (!origen || dist > tol) {
    throw new Error(
      `No hay keyframe a menos de ${tol}s de ${params.de}s. ` +
      (antes.length ? `Los que hay están en: ${antes.map((k) => k.segundos).join(", ")}.`
                    : "El param no tiene ninguno.")
    );
  }

  const ocupado = antes.filter((k) => k !== origen && Math.abs(k.segundos - params.a) <= tol);
  if (ocupado.length) {
    throw new Error(
      `El destino ${params.a}s ya tiene un keyframe (${ocupado[0].segundos}s) y NO se escribe encima: ` +
      "hay un crash de Premiere registrado en esa situación, con la causa sin identificar. " +
      "Borralo primero con `borrarKeyframe` si es lo que querés."
    );
  }

  /*
   * EL VALOR HAY QUE DESENVOLVERLO, y esto costó una vuelta entera.
   *
   * `valorEnTiempo` devuelve lo que da `getValueAtTime`, que **no es un número**: viene
   * envuelto como `{value: 100}` —a veces más de una vez—. Pasado así a `createKeyframe`,
   * Premiere contesta *"Illegal Parameter type"*, la transacción no entra y no se mueve nada.
   *
   * Es el "los valores de esta API no vienen siempre en la misma forma" del CLAUDE.md, que
   * ya tiene sus dos normalizadores escritos: `aNumero` y `aPunto`. Se prueba PRIMERO como
   * punto —Position y Anchor Point son pares— y si no lo es, como número.
   *
   * Lo agarró el propio verbo: informó `NO QUEDÓ BIEN` con la excepción y comprobó releyendo
   * que los keyframes seguían donde estaban. Un booleano habría dicho que sí.
   */
  const crudo = await valorEnTiempo(o.project, o.p, origen.tick);
  if (crudo === null || crudo === undefined) {
    throw new Error(`No se pudo leer el valor del keyframe en ${origen.segundos}s, así que no se mueve nada.`);
  }
  const punto = aPunto(crudo);
  const numero = aNumero(crudo);
  let valor;
  if (punto) valor = new ppro.PointF(punto.x, punto.y);
  else if (numero !== null) valor = numero;
  else if (typeof crudo === "boolean") valor = crudo;
  else {
    throw new Error(
      `El valor del keyframe en ${origen.segundos}s no se pudo normalizar. Llegó: ${describirValor(crudo)}. ` +
      "No se mueve nada."
    );
  }
  const tickDestino = o.reloj.aMaterial(aTick(params.a));

  let excepcion = null, transacciones = 0;
  try {
    let creado = null;
    o.project.lockedAccess(() => { creado = o.p.createKeyframe(valor); });
    creado.position = tickDestino;
    o.project.lockedAccess(() => {
      /* Las dos mitades en UNA transacción: así un Cmd+Z devuelve el keyframe a su lugar. */
      const hizo = o.project.executeTransaction((acciones) => {
        acciones.addAction(o.p.createAddKeyframeAction(creado));
        acciones.addAction(o.p.createRemoveKeyframeAction(origen.tick));
      }, "mover keyframe");
      if (hizo) transacciones++;
    });
  } catch (e) { excepcion = e && e.message ? e.message : String(e); }

  const despues = keyframesDe(o.project, o.p, o.reloj);
  const llego = despues.some((k) => Math.abs(k.segundos - params.a) <= tol);
  const seFue = !despues.some((k) => Math.abs(k.segundos - origen.segundos) <= tol);
  const mismoConteo = despues.length === antes.length;
  const bien = llego && seFue && mismoConteo;

  return {
    resumen:
      `${o.nombreEfecto} > ${o.nombreParam} en "${o.nombreClip}": ` +
      (bien ? `MOVIDO ${origen.segundos}s → ${params.a}s` : "NO QUEDÓ BIEN") +
      (excepcion ? ` (excepción: ${excepcion})` : "") +
      ` · keyframes ${antes.length} → ${despues.length}` +
      (bien ? "" :
        ` · llegó al destino: ${llego ? "sí" : "NO"} · se fue del origen: ${seFue ? "sí" : "NO"}` +
        (mismoConteo ? "" : " · CAMBIÓ LA CANTIDAD, puede haber quedado duplicado")) +
      ` · quedaron en: ${despues.length ? despues.map((k) => k.segundos).join(", ") : "ninguno"}` +
      (transacciones ? ` · se deshace con ${transacciones} Cmd+Z` : " · nada que deshacer"),
    ok: bien,
    antes: antes.map((k) => k.segundos),
    despues: despues.map((k) => k.segundos),
    de: origen.segundos,
    a: params.a,
    transacciones: transacciones
  };
}



/**
 * Cambia la CURVA de uno o varios keyframes: lineal, bezier o escalón.
 *
 * Es lo que separa una animación que "se nota" de una que acompaña. `keyframe` los crea con
 * la curva por defecto y hasta ahora no había forma de tocarla por API — había que ir a
 * Effect Controls y hacerlo a mano, keyframe por keyframe.
 *
 * Los modos salen de `Keyframe.INTERPOLATION_MODE_*`, leídos del reflejo y no inventados:
 *
 *   lineal   INTERPOLATION_MODE_LINEAR   velocidad constante
 *   bezier   INTERPOLATION_MODE_BEZIER   cambia el TIPO, NO el ease — ver abajo
 *   hold     INTERPOLATION_MODE_HOLD     escalón: mantiene el valor hasta el siguiente
 *   tiempo   INTERPOLATION_MODE_TIME     remapeo temporal
 *
 * *** EL BEZIER NO SUAVIZA NADA POR SI SOLO. *** La accion pone el TIPO; los tiradores —la
 * influencia, el ease— NO existen en la API. `Keyframe` expone `position`, `value` y el get/set
 * del modo, y nada mas. Un bezier con los tiradores en cero se interpola IGUAL que un lineal, y
 * en Effect Controls el icono SI cambia: parece que funciono. Medido el 2026-08-25 con 8
 * keyframes del nest de VIDEO 1 en un corporativo, y lo reporto el usuario mirando el movimiento.
 * Por eso el verbo lo AVISA en el resumen cuando el modo pedido es bezier.
 *
 * `hold` y `lineal` si cambian el movimiento: no dependen de tiradores.
 *
 * LA LECTURA DEL MODO ES BEST-EFFORT y el verbo lo dice en vez de fingir. Leerlo exige un
 * objeto Keyframe, o sea `findNearestKeyframe`, que devuelve una referencia a la estructura
 * interna — la misma familia que `getKeyframePtr`, que tiró Premiere con SIGBUS en ráfaga.
 * Acá se llama **una vez por keyframe pedido y dentro de un solo lock**, que es el régimen
 * que nunca falló; si igual no se puede leer, se informa "modo ilegible" y se sigue.
 */
async function curvaKeyframe(params) {
  const o = await objetivoDeKeyframes(params, "curvaKeyframe");
  const tol = typeof params.tolerancia === "number" ? params.tolerancia : 0.02;

  const MODOS = {
    lineal: "INTERPOLATION_MODE_LINEAR", linear: "INTERPOLATION_MODE_LINEAR",
    bezier: "INTERPOLATION_MODE_BEZIER", suave: "INTERPOLATION_MODE_BEZIER",
    hold: "INTERPOLATION_MODE_HOLD", escalon: "INTERPOLATION_MODE_HOLD",
    tiempo: "INTERPOLATION_MODE_TIME", time: "INTERPOLATION_MODE_TIME"
  };
  const pedido = String(params.modo || "").toLowerCase();
  const clave = MODOS[pedido];
  if (!clave) {
    throw new Error(`Falta \`modo\` o no se reconoce "${params.modo}". Son: ${Object.keys(MODOS).join(", ")}.`);
  }
  const valorModo = ppro.Keyframe[clave];
  if (valorModo === undefined) {
    throw new Error(`Esta versión de Premiere no expone Keyframe.${clave}.`);
  }

  const antes = keyframesDe(o.project, o.p, o.reloj);
  if (!antes.length) throw new Error(`"${o.nombreParam}" no tiene ningún keyframe, así que no hay curva que cambiar.`);

  /*
   * Sin `segundos` van TODOS, y eso es seguro acá: cambiar la curva no borra ni mueve nada,
   * y "todos los keyframes de este param" es el pedido normal. `borrarKeyframe` no tiene
   * este default a propósito — ahí "todos" es destructivo.
   */
  const pedidos = Array.isArray(params.segundos) ? params.segundos
    : typeof params.segundos === "number" ? [params.segundos] : null;

  let objetivo = antes, sinMatch = [];
  if (pedidos) {
    objetivo = [];
    for (let i = 0; i < pedidos.length; i++) {
      let mejor = null, dist = Infinity;
      for (let j = 0; j < antes.length; j++) {
        const d = Math.abs(antes[j].segundos - pedidos[i]);
        if (d < dist) { dist = d; mejor = antes[j]; }
      }
      if (mejor && dist <= tol && objetivo.indexOf(mejor) === -1) objetivo.push(mejor);
      else sinMatch.push(pedidos[i]);
    }
    if (!objetivo.length) {
      throw new Error(
        `Ninguno de los tiempos pedidos (${pedidos.join(", ")}) cae a menos de ${tol}s de un keyframe. ` +
        `Los que hay están en: ${antes.map((k) => k.segundos).join(", ")}.`
      );
    }
  }

  const leerModos = () => {
    const out = [];
    try {
      o.project.lockedAccess(() => {
        for (let i = 0; i < objetivo.length; i++) {
          try {
            const kf = o.p.findNearestKeyframe(objetivo[i].tick);
            out.push(kf ? String(kf.getTemporalInterpolationMode()) : "ilegible");
          } catch (e) { out.push("ilegible"); }
        }
      });
    } catch (e) { /* devolvemos lo que haya */ }
    return out;
  };

  const modosAntes = leerModos();
  let excepcion = null, transacciones = 0;
  try {
    /* UNA transacción para todos: una ráfaga de transacciones tira Premiere (SIGSEGV). */
    o.project.lockedAccess(() => {
      const hizo = o.project.executeTransaction((acciones) => {
        for (let i = 0; i < objetivo.length; i++) {
          acciones.addAction(o.p.createSetInterpolationAtKeyframeAction(objetivo[i].tick, valorModo));
        }
      }, objetivo.length === 1 ? "curva del keyframe" : "curva de " + objetivo.length + " keyframes");
      if (hizo) transacciones++;
    });
  } catch (e) { excepcion = e && e.message ? e.message : String(e); }

  const modosDespues = leerModos();
  const despues = keyframesDe(o.project, o.p, o.reloj);
  const legibles = modosDespues.filter((m) => m !== "ilegible").length;
  const enElModo = modosDespues.filter((m) => m === String(valorModo)).length;

  return {
    resumen:
      `${o.nombreEfecto} > ${o.nombreParam} en "${o.nombreClip}": ` +
      `curva "${pedido}" sobre ${objetivo.length} de ${antes.length} keyframes` +
      (excepcion ? ` · EXCEPCIÓN: ${excepcion}` : "") +
      (legibles
        ? ` · releídos: ${enElModo} de ${legibles} quedaron en el modo pedido` +
          (modosAntes.length ? ` (antes: ${modosAntes.join("/")} → ahora: ${modosDespues.join("/")})` : "")
        : " · el modo NO se pudo releer, así que esto NO confirma que haya entrado — miralo en Effect Controls") +
      (sinMatch.length ? ` · sin match: ${sinMatch.join(", ")}s` : "") +
      /*
       * EL AVISO DEL BEZIER, y es la mitad de la respuesta.
       *
       * `createSetInterpolationAtKeyframeAction` pone el TIPO. Los tiradores —la influencia,
       * el ease— NO están en la API: `Keyframe` expone position, value y el get/set del modo,
       * y nada más. Un bezier con los tiradores en cero se interpola IGUAL que un lineal.
       *
       * Medido el 2026-08-25: se pusieron 8 en bezier, el ícono cambió en Effect Controls y
       * el usuario reportó que **el movimiento seguía siendo lineal**. Sin este aviso el verbo
       * informa que hizo algo que se ve idéntico a no haber hecho nada — el modo de fallar
       * nº1 de este archivo, en un verbo escrito el mismo día.
       */
      (valorModo === ppro.Keyframe.INTERPOLATION_MODE_BEZIER
        ? " · OJO: bezier cambia el TIPO, no el EASE. Los tiradores no están en la API, así que " +
          "el movimiento se sigue viendo lineal hasta que los arrastres a mano o uses Ease In/Out " +
          "en Premiere (Cmd+Shift+F9 / F9)."
        : "") +
      ` · en: ${objetivo.map((k) => k.segundos).join(", ")}s` +
      (despues.length !== antes.length ? ` · OJO: la cantidad cambió, ${antes.length} → ${despues.length}` : "") +
      (transacciones ? ` · se deshace con ${transacciones} Cmd+Z` : " · nada que deshacer"),
    modo: pedido,
    tocados: objetivo.map((k) => k.segundos),
    modosAntes: modosAntes,
    modosDespues: modosDespues,
    sinMatch: sinMatch,
    transacciones: transacciones
  };
}

async function carpetasCandidatas() {
  const salida = [];
  try {
    const tmp = await uxp.storage.localFileSystem.getTemporaryFolder();
    const ruta = String(tmp.nativePath).replace(/[\\\/]+$/, "");
    const corte = ruta.indexOf("/Adobe/UXP");
    if (corte > 0) salida.push({ via: "temp del sistema", dir: ruta.slice(0, corte) });
    salida.push({ via: "temp del plugin", dir: ruta });
  } catch (e) { /* seguimos */ }
  try {
    const { project } = await getProyectoYSecuencia();
    if (project.path) salida.push({ via: "carpeta del proyecto", dir: dirname(project.path) });
  } catch (e) { /* seguimos */ }
  return salida;
}

async function buscarArchivo(rutas) {
  const fs = uxp.storage.localFileSystem;
  for (let i = 0; i < rutas.length; i++) {
    try {
      const e = await fs.getEntryWithUrl("file:" + rutas[i]);
      if (e) return e;
    } catch (err) { /* no está, probamos la siguiente */ }
  }
  return null;
}

/*
 * exportSequenceFrame devuelve true enseguida, pero el archivo puede tardar en
 * estar en disco. Buscarlo en el acto daba siempre "sin archivo".
 */
async function esperarArchivo(rutas, msMax) {
  const inicio = Date.now();
  while (Date.now() - inicio < msMax) {
    const a = await buscarArchivo(rutas);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** UXP no tiene btoa ni Buffer: el base64 se arma a mano. */
function aBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 || 0) << 8) | (b2 || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += (b1 === undefined) ? "=" : chars[(n >> 6) & 63];
    out += (b2 === undefined) ? "=" : chars[n & 63];
  }
  return out;
}

async function frame(params) {
  const { sequence } = await getProyectoYSecuencia();

  const settings = await sequence.getSettings();
  const rect = await settings.getVideoFrameRect();
  const ancho = Math.max(160, Math.round(params.ancho || 960));
  const alto = Math.max(90, Math.round(ancho * (rect.height / rect.width)));

  const playhead = await sequence.getPlayerPosition();
  /*
   * Dos cosas en este nombre, las dos pagadas:
   *
   *  - Termina en .png A PROPÓSITO. Premiere deduce el formato de la extensión;
   *    sin ella exportSequenceFrame tira "File Format is not supported" en todas
   *    las carpetas, que parece un problema de permisos y no lo es.
   *  - Lleva el tick del playhead. Sin eso, un archivo de una corrida anterior
   *    da un falso positivo y se devuelve el frame equivocado sin que nada avise.
   */
  const nombre = "bridge-" + String(playhead.ticks) + ".png";

  const carpetas = await carpetasCandidatas();
  const intentos = [];

  for (let i = 0; i < carpetas.length; i++) {
    const dir = carpetas[i].dir;
    const candidatos = [dir + "/" + nombre, dir + "/" + nombre + ".png"];

    let devolvio = null;
    try {
      devolvio = await ppro.Exporter.exportSequenceFrame(
        sequence, playhead, nombre, dir + "/", ancho, alto
      );
    } catch (e) {
      intentos.push(`${carpetas[i].via}: excepción ${e}`);
      continue;
    }

    const archivo = await esperarArchivo(candidatos, 5000);
    intentos.push(`${carpetas[i].via}: devolvió ${devolvio}` + (archivo ? " OK" : " sin archivo tras 5s"));
    if (archivo) {
      const buffer = await archivo.read({ format: uxp.storage.formats.binary });
      /*
       * Y se BORRA. El PNG existe solo para pasar los bytes; dejarlo acumula
       * basura en el temp del sistema —34 archivos y 3,4 MB en una tarde— y, si
       * alguna vez cae en la carpeta candidata del proyecto, se los deja al lado
       * del .prproj del usuario.
       */
      try { if (typeof archivo.delete === "function") await archivo.delete(); }
      catch (e) { /* si no se puede, no es motivo para fallar */ }
      return {
        resumen: `Frame de "${sequence.name}" en el playhead, ${ancho}x${alto} (vía ${carpetas[i].via}).`,
        pngBase64: aBase64(buffer)
      };
    }
  }

  throw new Error("No se pudo exportar el frame. Intentos: " + intentos.join(" | "));
}

/**
 * Varios cuadros repartidos por un rango, para ver de qué es el material.
 *
 * Sirve para "contame de qué es esto": con seis u ocho cuadros se reconoce el
 * escenario, quién habla, si hay gráficos en pantalla y dónde cambia el
 * contenido.
 *
 * Dos límites que conviene tener a la vista al usarlo:
 *
 *  - Son FOTOS, no video. Un plano fijo y una cámara que volvió al mismo encuadre
 *    se ven igual, y lo que pasa entre dos muestras no existe. Para detectar
 *    cortes con precisión está SequenceUtils.performSceneEditDetectionOnSelection,
 *    no el muestreo.
 *  - Cada cuadro es una exportación de Premiere más una imagen entera de
 *    contexto. Ocho está bien; ochenta no. Por eso hay tope.
 *
 * Deja el playhead donde estaba: mover el cursor del usuario y no devolverlo es
 * una sorpresa fea.
 */
async function vistazo(params) {
  const { sequence } = await getProyectoYSecuencia();
  const TOPE = 12;

  const cuantos = Math.max(2, Math.min(TOPE, Math.round(params.cuantos || 6)));
  const finSecuencia = aSegundos(await sequence.getEndTime());
  const desde = Math.max(0, typeof params.desde === "number" ? params.desde : 0);
  const hasta = Math.min(finSecuencia, typeof params.hasta === "number" ? params.hasta : finSecuencia);

  if (!(hasta > desde)) {
    throw new Error(
      `El rango pedido no tiene duración: ${desde}s a ${hasta}s. ` +
      `La secuencia "${sequence.name}" va de 0 a ${finSecuencia.toFixed(2)}s.`
    );
  }

  const original = await sequence.getPlayerPosition();

  /*
   * Un margen en las puntas. Muestrear exactamente el primer y el último frame
   * suele caer en un fundido de entrada o en negro, y desperdicia dos de los
   * seis cuadros — medido: el cuadro de 0s de un clip salió blanco.
   */
  const margen = (hasta - desde) * 0.02;
  const desdeReal = desde + margen;
  const hastaReal = hasta - margen;
  const paso = (hastaReal - desdeReal) / (cuantos - 1);
  const cuadros = [];
  const fallidos = [];

  for (let i = 0; i < cuantos; i++) {
    const s = desdeReal + paso * i;
    try {
      await sequence.setPlayerPosition(aTick(s));
      const f = await frame({ ancho: params.ancho || 280 });
      cuadros.push({ segundos: Number(s.toFixed(2)), pngBase64: f.pngBase64 });
    } catch (e) {
      fallidos.push(`${s.toFixed(2)}s: ${e && e.message ? e.message : e}`);
    }
  }

  // Devolver el playhead a donde estaba.
  try { await sequence.setPlayerPosition(original); } catch (e) { /* no es motivo para fallar */ }

  return {
    resumen:
      `${cuadros.length} cuadros de "${sequence.name}" entre ${desde.toFixed(1)}s y ${hasta.toFixed(1)}s` +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.join(" | ")}` : "") +
      ". Son fotos sueltas: lo que pasa entre una y otra no se ve.",
    secuencia: sequence.name,
    cuadros: cuadros,
    fallidos: fallidos
  };
}

/**
 * Saca todo lo que haya en una secuencia.
 *
 * Hace falta porque `createSequenceFromMedia` —la única forma de que la
 * secuencia herede resolución y fps del material— además mete el clip ENTERO
 * adentro. Sin vaciarla primero, los fragmentos se pegan encima de eso y queda
 * el sobrante del clip completo colgando al final.
 */
async function vaciarSecuencia(project, sequence) {
  const items = [];
  const grupos = [
    { cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i) },
    { cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i) }
  ];
  for (const g of grupos) {
    for (let t = 0; t < g.cuantas; t++) {
      const track = await g.traer(t);
      if (!track) continue;
      const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (let i = 0; i < its.length; i++) items.push(its[i]);
    }
  }
  if (!items.length) return 0;

  const seleccion = await sequence.getSelection();
  const previos = await seleccion.getTrackItems();
  for (let i = 0; i < previos.length; i++) seleccion.removeItem(previos[i]);
  for (let i = 0; i < items.length; i++) {
    try { seleccion.addItem(items[i], true); } catch (e) { try { seleccion.addItem(items[i]); } catch (e2) {} }
  }

  const editor = ppro.SequenceEditor.getEditor(sequence);
  project.lockedAccess(() => {
    project.executeTransaction((a) => {
      a.addAction(editor.createRemoveItemsAction(seleccion, false, ppro.Constants.MediaType.ANY));
    }, "vaciar la secuencia");
  });

  let quedan = 0;
  for (const g of grupos) {
    for (let t = 0; t < g.cuantas; t++) {
      const track = await g.traer(t);
      if (track) quedan += (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
    }
  }
  return items.length - quedan;
}

/**
 * Arma una secuencia a partir de un medio.
 *
 * La firma es **`createSequenceFromMedia(nombre, medio)`**: con un solo
 * argumento contesta "Illegal Parameter type". Se descubrió porque `mirarMedio`
 * probaba las dos formas y se quedaba con la que anduviera — pero no informaba
 * CUÁL, así que el dato se perdió y `analizar` volvió a escribir la equivocada.
 * De ahí que esto sea una función sola y no dos copias.
 *
 * La secuencia hereda resolución y fps del medio, así que el cuadro sale en su
 * proporción real y no metido dentro de otra.
 */
async function crearSecuenciaDesde(project, medio, nombre) {
  const intentos = [];
  const formas = [
    ["(nombre, medio)", () => project.createSequenceFromMedia(nombre || "BRIDGE temporal", medio)],
    ["(medio)", () => project.createSequenceFromMedia(medio)]
  ];
  for (let i = 0; i < formas.length; i++) {
    try {
      const r = await formas[i][1]();
      if (r) return r;
      intentos.push(formas[i][0] + " devolvió " + describirValor(r));
    } catch (e) {
      intentos.push(formas[i][0] + ": " + (e && e.message ? e.message : e));
    }
  }
  throw new Error(
    `No se pudo armar una secuencia con "${String(medio.name)}". Intentos: ${intentos.join(" | ")}.`
  );
}

/**
 * Mira un medio del proyecto sin ensuciar nada: arma una secuencia temporal con
 * él, saca los cuadros, y la borra.
 *
 * Hace falta porque `frame` y `vistazo` exportan de una SECUENCIA, no del panel
 * de proyecto: un clip recién importado se ve en `medios` pero no se puede
 * mirar hasta que esté en un timeline.
 *
 * Se usa `createSequenceFromMedia` y no crear-e-insertar porque además hereda la
 * resolución y los fps del medio, así que el cuadro sale en su proporción real y
 * no metido dentro de otra.
 *
 * La secuencia se borra SIEMPRE, incluso si algo falla en el medio: si no, cada
 * vistazo deja una secuencia suelta en el proyecto del usuario.
 */
async function mirarMedio(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");

  const medio = await buscarMedio(project, params.medio);
  const nombreMedio = String(medio.name);

  const antes = await project.getActiveSequence();
  const nombreAntes = antes ? String(antes.name) : null;

  const temporal = await crearSecuenciaDesde(project, medio, "BRIDGE mirar");
  const pedidos = Array.isArray(params.tiempos) ? params.tiempos.filter((t) => typeof t === "number") : null;

  const nombreTemporal = String(temporal.name);
  let salida = null;
  let fallo = null;

  try {
    await project.setActiveSequence(temporal);
    if (pedidos && pedidos.length) {
      /*
       * Tiempos EXPLÍCITOS, en segundos de la fuente. Sirve para ir a mirar un
       * momento concreto —un hueco sin transcripción, por ejemplo, a ver si hay
       * alguien tocando— en vez de repartir parejo y esperar tener suerte.
       *
       * Se convierten con el reloj del clip que quedó en la temporal en vez de
       * suponer que fuente y secuencia coinciden.
       */
      const track = await temporal.getVideoTrack(0);
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const reloj = items.length ? await relojDelClip(items[0]) : null;
      let largoTemporal = 0;
      for (let k = 0; k < items.length; k++) {
        const x = await tiemposDe(items[k]);
        if (x.hasta > largoTemporal) largoTemporal = x.hasta;
      }
      const cuadros = [];
      for (let i = 0; i < pedidos.length; i++) {
        const enTemporal = reloj ? reloj.aSegundosDeSecuencia(aTick(pedidos[i])) : pedidos[i];
        /*
         * El playhead se mueve sobre la secuencia ACTIVA pedida de nuevo, no
         * sobre la referencia `temporal`. Esa referencia queda vieja después de
         * las transacciones y `setPlayerPosition` sobre ella no hace nada —
         * mientras `frame()` sí pide la activa fresca. Resultado: todos los
         * cuadros salían idénticos, del segundo 0, y parecían decir que el
         * sujeto estaba inmóvil.
         */
        const { sequence: activa } = await getProyectoYSecuencia();
        /*
         * Fuera de rango se INFORMA, no se aplasta contra el borde.
         *
         * Antes había un `Math.max(0, enTemporal)`: con un tiempo negativo
         * —cosa que pasaba cuando el medio tenía in/out puestos y la temporal
         * no arrancaba en 0— los cuatro cuadros salían del segundo 0, idénticos,
         * y parecían una respuesta legítima que decía que no pasaba nada.
         * Devolver menos es mejor que devolver algo que no es.
         */
        if (enTemporal < -0.001 || enTemporal > largoTemporal + 0.001) {
          cuadros.push({
            segundos: pedidos[i],
            enLaTemporal: Number(enTemporal.toFixed(2)),
            fuera: true,
            porque: `cae fuera de la temporal, que va de 0 a ${largoTemporal.toFixed(2)}s` +
              (enTemporal < 0 ? " — el medio tiene in/out puestos en el panel de proyecto" : "")
          });
          continue;
        }
        await activa.setPlayerPosition(aTick(enTemporal));
        const quedo = aSegundos(await activa.getPlayerPosition());
        const f = await frame({ ancho: params.ancho || 280 });
        cuadros.push({
          segundos: pedidos[i],
          enLaTemporal: Number(enTemporal.toFixed(2)),
          playheadReal: Number(quedo.toFixed(2)),
          pngBase64: f.pngBase64
        });
      }
      salida = { cuadros: cuadros };
    } else {
      salida = await vistazo({
        cuantos: params.cuantos || 6,
        ancho: params.ancho || 280
      });
    }
  } catch (e) {
    fallo = e && e.message ? e.message : String(e);
  }

  // Limpieza, pase lo que pase: la secuencia era un andamio, no un resultado.
  const limpieza = [];
  try {
    await project.deleteSequence(temporal);
    limpieza.push("secuencia temporal borrada");
  } catch (e) {
    limpieza.push("NO se pudo borrar \"" + nombreTemporal + "\": " + (e && e.message ? e.message : e));
  }
  if (nombreAntes) {
    try {
      const lista = await project.getSequences();
      for (let i = 0; i < lista.length; i++) {
        if (String(lista[i].name) === nombreAntes) { await project.setActiveSequence(lista[i]); break; }
      }
    } catch (e) { limpieza.push("no se pudo volver a \"" + nombreAntes + "\""); }
  }

  if (fallo) throw new Error(`Se armó la secuencia pero fallaron los cuadros: ${fallo}. ${limpieza.join(" · ")}`);

  return {
    resumen:
      `"${nombreMedio}": ${salida.cuadros.filter((c) => !c.fuera).length} cuadros ` +
      `de una secuencia temporal · ` +
      (salida.cuadros.some((c) => c.fuera)
        ? `OJO: ${salida.cuadros.filter((c) => c.fuera).length} tiempo(s) quedaron FUERA y no se miraron — ` +
          salida.cuadros.filter((c) => c.fuera)[0].porque + " · "
        : "") +
      limpieza.join(" · ") +
      ". Son fotos sueltas: lo que pasa entre una y otra no se ve.",
    medio: nombreMedio,
    cuadros: salida.cuadros,
    limpieza: limpieza
  };
}

/**
 * Cuadros Y texto, alineados: cada imagen viene con lo que se dice ahí.
 *
 * Existe porque las dos fuentes dicen cosas DISTINTAS, no la misma dos veces.
 * Medido con un caso real: las imágenes mostraban un taller de arte y el texto
 * reveló que era una publicidad de porcelanato, con marca y todo. Mirando solo
 * los cuadros, la descripción salía bien del lugar y mal del video.
 *
 * El reparto no es decorativo: a cada cuadro le corresponde lo que se dice desde
 * él hasta el siguiente, así el texto entero queda distribuido y no se pierde
 * nada en los huecos.
 */
async function analizar(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");

  /*
   * Cada paso dice cuál es. La primera versión dejaba pasar el error crudo de la
   * API —"Illegal Parameter type" y nada más— y con seis llamadas distintas
   * adentro eso no se puede diagnosticar. Es la misma regla que el resto del
   * repo, aplicada acá tarde.
   */
  const etapa = async (nombreEtapa, fn) => {
    try { return await fn(); }
    catch (e) { throw new Error(`[${nombreEtapa}] ${e && e.message ? e.message : e}`); }
  };

  const cuantos = Math.max(2, Math.min(12, Math.round(params.cuantos || 6)));

  // 1) El texto primero: si no hay, conviene saberlo antes de armar nada.
  /*
   * `palabras: true` es obligatorio acá: sin eso `transcripcion` devuelve la
   * forma compacta —segmentos con su texto pero sin los tiempos por palabra— y
   * el reparto por cuadro se arma sobre un arreglo vacío. Salieron cinco cuadros
   * mudos.
   */
  const texto = await etapa("leer la transcripción", () =>
    transcripcion(Object.assign({}, params.medio ? { medio: params.medio } : params, { palabras: true })));
  if (!texto.hay) {
    throw new Error(
      `"${texto.clip}" no tiene transcripción, así que no hay texto que cruzar con las ` +
      "imágenes. Transcribilo en el panel Text de Premiere, o usá premiere_mirar_medio " +
      "para ver solo los cuadros."
    );
  }
  const nombre = texto.clip;

  // 2) Los cuadros. Con `medio` hay que montar una secuencia temporal, porque
  //    exportSequenceFrame exporta de una secuencia y no del panel de proyecto.
  let cuadros = [], limpieza = [];

  if (params.medio) {
    const medio = await etapa("encontrar el medio", () => buscarMedio(project, params.medio));
    const antes = await project.getActiveSequence();
    const nombreAntes = antes ? String(antes.name) : null;

    const temporal = await etapa("crear la secuencia temporal", () =>
      crearSecuenciaDesde(project, medio, "BRIDGE analizar"));
    if (!temporal) throw new Error(`No se pudo armar una secuencia con "${nombre}".`);

    try {
      await etapa("activar la temporal", () => project.setActiveSequence(temporal));
      /*
       * El muestreo va en tiempo de la secuencia TEMPORAL, y los tiempos del
       * texto son de fuente. Se convierten con el reloj del clip que quedó
       * adentro en vez de suponer que coinciden: normalmente el clip arranca en
       * 0 sin recorte y da lo mismo, pero suponerlo es exactamente el error que
       * ya se pagó dos veces en este repo.
       */
      const items = await etapa("leer el clip de la temporal", async () => {
        const track = await temporal.getVideoTrack(0);
        return await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      });
      const dentroDeLaTemporal = items.length
        ? (await etapa("armar el reloj del clip", () => relojDelClip(items[0]))).aSegundosDeSecuencia
        : null;
      const aTemporal = (segundosDeFuente) =>
        dentroDeLaTemporal ? dentroDeLaTemporal(aTick(segundosDeFuente)) : segundosDeFuente;

      const desdeT = Math.max(0, aTemporal(texto.segmentos[0].desdeFuente));
      const hastaT = aTemporal(texto.segmentos[texto.segmentos.length - 1].hastaFuente);
      if (!isFinite(desdeT) || !isFinite(hastaT) || hastaT <= desdeT) {
        throw new Error(
          `[calcular el rango] quedó ${desdeT} a ${hastaT} en la temporal, a partir de ` +
          `${texto.segmentos[0].desdeFuente}-${texto.segmentos[texto.segmentos.length - 1].hastaFuente}s de fuente.`
        );
      }
      const v = await etapa("sacar los cuadros", () =>
        vistazo({ cuantos: cuantos, desde: desdeT, hasta: hastaT, ancho: params.ancho || 280 }));
      cuadros = v.cuadros;
    } finally {
      try { await project.deleteSequence(temporal); limpieza.push("secuencia temporal borrada"); }
      catch (e) { limpieza.push("NO se pudo borrar la temporal: " + (e && e.message ? e.message : e)); }
      if (nombreAntes) {
        try {
          const lista = await project.getSequences();
          for (let i = 0; i < lista.length; i++) {
            if (String(lista[i].name) === nombreAntes) { await project.setActiveSequence(lista[i]); break; }
          }
        } catch (e) { /* no es motivo para fallar */ }
      }
    }
  } else {
    const v = await vistazo({ cuantos: cuantos, ancho: params.ancho || 280 });
    cuadros = v.cuadros;
  }

  /*
   * 3) El reparto. A cada cuadro le toca lo que se dice desde él hasta el
   *    siguiente. Se compara contra los tiempos de FUENTE porque son los que
   *    tiene el texto y son los que no dependen de dónde esté puesto el clip.
   */
  const palabras = texto.segmentos.flatMap((sg) =>
    (sg.palabras || []).map((w) => ({ t: w.desdeFuente, texto: w.texto })));
  if (!palabras.length) {
    throw new Error(
      `La transcripción de "${nombre}" vino sin tiempos por palabra (${texto.segmentos.length} ` +
      "segmentos), así que no hay con qué repartir el texto entre los cuadros."
    );
  }

  const primero = texto.segmentos[0].desdeFuente;
  const ultimo = texto.segmentos[texto.segmentos.length - 1].hastaFuente;
  const paso = cuadros.length > 1 ? (ultimo - primero) / (cuadros.length - 1) : ultimo - primero;

  const conTexto = cuadros.map((c, i) => {
    const desde = i === 0 ? -Infinity : primero + paso * (i - 0.5);
    const hasta = i === cuadros.length - 1 ? Infinity : primero + paso * (i + 0.5);
    const dice = palabras.filter((w) => w.t >= desde && w.t < hasta).map((w) => w.texto).join(" ");
    return { segundos: c.segundos, pngBase64: c.pngBase64, dice: dice || "(no se habla acá)" };
  });

  return {
    resumen:
      `"${nombre}": ${conTexto.length} cuadros con lo que se dice en cada uno · ` +
      `${palabras.length} palabras en total` +
      (limpieza.length ? " · " + limpieza.join(" · ") : "") +
      ". Las imágenes y el texto suelen decir cosas distintas: mirá las dos.",
    medio: nombre,
    cuadros: conTexto,
    textoCompleto: texto.segmentos.map((sg) => sg.texto).join(" ")
  };
}

/**
 * Parte un clip en dos, en un tiempo de la secuencia.
 *
 * **La API no tiene razor**, así que se emula: se recorta la salida del clip
 * hasta el punto de corte y se vuelve a insertar el mismo medio, con la entrada
 * corrida, justo ahí. El resultado es indistinguible de un corte.
 *
 * `SEQUENCE_OPERATION_APPLYCUT` no sirve para esto: es qué hacer con los cortes
 * que encuentra la detección de escenas, no un corte en un tiempo cualquiera.
 *
 * Los VINCULADOS se recortan también. Sin eso, partir un video deja su audio
 * entero por debajo y el segundo pedazo queda sonando encima del primero.
 */
async function cortar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (typeof params.segundos !== "number") throw new Error("Falta `segundos`: dónde partir.");

  /*
   * El punto de corte se CUANTIZA AL FRAME antes de tocar nada.
   *
   * `createSetEndAction` guarda el tick exacto —no snapea— y el overwrite de la
   * cola sí snapea al frame. Con un corte entre frames la cabeza terminaba en
   * 313.03 y la cola arrancaba en 313.04: un hueco de 10ms que en el timeline
   * es un parpadeo.
   *
   * Y no se arregla pegando la cola en el tick exacto de la cabeza, que fue el
   * primer intento: el problema es que ESE tick no está sobre un frame. En la
   * interfaz de Premiere no se puede cortar entre frames; acá tampoco debería.
   *
   * Pasó en el M1 siete veces, y se entiende: los puntos de corte salían de
   * tiempos de palabras de la transcripción, con decimales arbitrarios, así que
   * casi ninguno caía sobre un frame.
   */
  let tickCorte = aTick(params.segundos);
  /*
   * Y se INFORMA qué pasó al cuantizar. La primera versión tenía un `catch`
   * vacío, la cuantización no hizo nada, y la tanda de prueba dio idéntica sin
   * ninguna pista de por qué. Un intento que falla en silencio es el modo de
   * fallar nº1 de este archivo — cometido justo mientras se arreglaba otro.
   */
  let cuantizado = null;
  {
    let tb = null;
    try { tb = await sequence.getTimebase(); } catch (e) { tb = null; }
    const antesSeg = aSegundos(tickCorte);
    const intentos = [];

    /*
     * `alignToNearestFrame(timebase)` contesta "Illegal Parameter type", así que
     * la firma no es la obvia. Se enumeran las formas plausibles y se prueban,
     * igual que con `createAddMarkerAction`; la última no usa la API sino
     * aritmética entera sobre ticks, que no depende de ninguna firma.
     */
    const formas = [
      ["alignToNearestFrame(timebase)", () => tickCorte.alignToNearestFrame(tb)],
      ["alignToNearestFrame(Number(timebase))", () => tickCorte.alignToNearestFrame(Number(tb))],
      ["alignToNearestFrame(String(timebase))", () => tickCorte.alignToNearestFrame(String(tb))],
      ["alignToFrame(timebase)", () => tickCorte.alignToFrame(tb)],
      ["redondeo entero de ticks", () => {
        const tpf = Number(tb);
        if (!isFinite(tpf) || tpf <= 0) return null;
        const ticks = Number(tickCorte.ticks);
        return ppro.TickTime.createWithTicks(String(Math.round(ticks / tpf) * tpf));
      }]
    ];

    for (const [nombre, fn] of formas) {
      let r = null;
      try { r = fn(); } catch (e) { intentos.push(`${nombre}: ${e && e.message ? e.message : e}`); continue; }
      if (!r || r.ticks === undefined) { intentos.push(`${nombre}: devolvió ${r}`); continue; }
      const despuesSeg = aSegundos(r);
      // La prueba no es que no tire: es que caiga en un frame y no se vaya lejos.
      if (Math.abs(despuesSeg - antesSeg) > 0.2) { intentos.push(`${nombre}: se fue a ${despuesSeg}s`); continue; }
      tickCorte = r;
      cuantizado = (Math.abs(despuesSeg - antesSeg) < 0.0005
        ? `ya caía en un frame`
        : `corte cuantizado ${antesSeg.toFixed(4)}s → ${despuesSeg.toFixed(4)}s`) + ` · vía ${nombre}`;
      break;
    }
    if (!cuantizado) {
      cuantizado = `NO SE CUANTIZÓ (timebase ${JSON.stringify(tb)}): ${intentos.join(" | ")}`;
    }
  }
  const t = aSegundos(tickCorte);

  const encontrado = await ubicarClip(sequence, params);
  const clip = encontrado.clip;
  const antes = await tiemposDe(clip);

  if (!(t > antes.desde + 0.02 && t < antes.hasta - 0.02)) {
    throw new Error(
      `El corte en ${t}s cae fuera de "${encontrado.nombre}", que va de ${antes.desde} a ${antes.hasta}s ` +
      "(y no puede ser justo en un borde)."
    );
  }

  let medio = null;
  try { medio = await clip.getProjectItem(); } catch (e) { medio = null; }
  if (!medio) throw new Error(`No se pudo llegar al medio de "${encontrado.nombre}".`);
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(medio); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${String(medio.name)}" a ClipProjectItem.`);

  const vel = antes.velocidad === undefined ? 1 : 1;
  // Dónde cae el corte dentro del MATERIAL, y qué queda para la cola.
  const enFuente = antes.entrada + (t - antes.desde);
  const finFuente = antes.entrada + (antes.hasta - antes.desde);

  /*
   * `soloVideo` deja el audio de largo. Es lo correcto para un punch-in: el
   * corte existe para cambiar la escala del video, y partir el audio ahí no
   * aporta nada y agrega un empalme.
   *
   * No se puede pedir "insertá sin audio": el cuarto argumento de
   * createOverwriteItemAction en -1 igual lo trae (sigue sin saberse qué
   * significa). Así que se corta normal y después se REPARA el audio: se saca el
   * pedazo nuevo y se estira el anterior hasta donde llegaba.
   */
  /*
   * El Motion del clip ORIGINAL, leído antes de partir, para reponerlo después
   * en la cola.
   *
   * `createOverwriteItemAction` no copia nada: la cola nace con Motion por
   * defecto —escala 100, posición al centro—. En el M2 (2026-08-15) eso borró
   * el escalado de **20 clips que ya estaban en 50**, y el verbo informó los
   * cortes como exitosos, porque lo eran: partió bien y encima destruyó algo
   * que no estaba mirando. De ahí la regla de contar el efecto COMPLETO.
   *
   * Se lee en el PUNTO DE CORTE. Con un clip sin animación eso es exactamente
   * el valor del clip y la reposición queda perfecta, que es el caso que
   * importa (la regla es cortar primero y escalar después).
   *
   * Con keyframes la cola arranca en el valor CORRECTO —el interpolado en el
   * punto de corte— desde que `valorEnTiempo` usa `getValueAtTime`. Antes
   * heredaba el del keyframe anterior y quedaba un salto contra la cabeza.
   *
   * Lo que sigue sin hacerse es continuar la ANIMACIÓN: la cola queda fija en
   * ese valor en vez de seguir moviéndose. Se avisa, porque un clip que venía
   * animándose y de golpe se congela es un cambio visible.
   */
  let motionAntes = null;
  try {
    const mo = await getComponente(clip, "Motion");
    if (mo) {
      const cual = getParametro(project, mo, "Scale") ? "Scale" : "Scale Height";
      const pEsc = getParametro(project, mo, cual);
      const pPos = getParametro(project, mo, "Position");
      const reloj = await relojDelClip(clip);
      const enCorte = reloj.aMaterial(tickCorte);
      motionAntes = {
        cual: cual,
        escala: pEsc ? aNumero(await valorEnTiempo(project, pEsc, enCorte)) : null,
        pos: pPos ? aPunto(await valorEnTiempo(project, pPos, enCorte)) : null,
        animado:
          (pEsc ? contarKeyframes(project, pEsc) : 0) > 0 ||
          (pPos ? contarKeyframes(project, pPos) : 0) > 0
      };
    }
  } catch (e) { motionAntes = null; }

  const soloVideo = params.soloVideo === true;
  const vinculados = soloVideo ? [] : await buscarVinculados(sequence, clip);
  const audioAntes = [];
  if (soloVideo) {
    // `audioQueCubre` y no `buscarVinculados`: ver el comentario de esa función.
    // Con la búsqueda estricta, el segundo corte de una misma zona no reparaba.
    for (const v of await audioQueCubre(sequence, clip)) audioAntes.push({ item: v, t: await tiemposDe(v) });
  }
  const contar = async () => (await contarItems(sequence)).total;
  const itemsAntes = await contar();

  // 1) Recortar el clip (y sus vinculados) hasta el punto de corte.
  let excepcion = null;
  try {
    project.lockedAccess(() => {
      project.executeTransaction((a) => {
        // El tick YA cuantizado, no aTick(t): reconvertir desde segundos vuelve a
        // meter el redondeo que se acaba de sacar.
        a.addAction(clip.createSetEndAction(tickCorte));
        for (let i = 0; i < vinculados.length; i++) a.addAction(vinculados[i].createSetEndAction(tickCorte));
      }, "recortar para partir");
    });
  } catch (e) { excepcion = "recortar: " + (e && e.message ? e.message : e); }

  /*
   * 2) Reinsertar la cola DONDE EL CLIP TERMINÓ DE VERDAD, no donde se pidió el
   *    corte.
   *
   * createSetEndAction ajusta el final al frame más cercano y el overwrite ajusta
   * el inicio por su cuenta: si se usa el tiempo pedido para las dos cosas, entre
   * ellas queda un frame suelto. Con 32 cortes eso dejó 17 huecos de 1 a 1,5
   * frames — parpadeos negros. Leer el final real y usarlo cierra la junta.
   */
  const pistaIndex = parseInt(encontrado.pista.slice(1), 10) - 1;
  const trasRecorte = await tiemposDe(clip);
  const junta = trasRecorte.hasta;
  /*
   * El TickTime EXACTO del final, sin pasar por segundos, que es donde se va a
   * pegar la cola.
   *
   * `junta` sirve para las cuentas y para el informe, pero NO para posicionar:
   * viene de `tiemposDe`, que redondea a 3 decimales, y `aTick` redondea
   * segundos a ticks. Un final real de 329.8799… se vuelve 329.88 y en ticks
   * queda un pelo por encima del frame, así que Premiere empuja la cola al
   * siguiente: **un frame de hueco**.
   *
   * Medido el 2026-08-16 cortando en 329.9 —entre dos frames— sobre una
   * secuencia a 25fps: cabeza hasta 329.88, cola desde 329.92. Es el mismo
   * hueco de 1 frame que apareció siete veces en el M1, donde los puntos de
   * corte salían de tiempos de palabras y casi ninguno caía sobre un frame.
   */
  const juntaTick = await clip.getEndTime();
  const enFuenteReal = antes.entrada + (junta - antes.desde);
  /*
   * Los in/out del PROJECT ITEM son de todo el proyecto, no de este corte.
   *
   * Para armar la cola hay que escribirlos, pero si quedan puestos ensucian el
   * medio para cualquier cosa que después cree una secuencia desde él. Con eso,
   * `mirarMedio` sobre un medio ya cortado devolvía todos los cuadros iguales:
   * el tiempo pedido le daba NEGATIVO —la temporal arrancaba en el in-point que
   * dejó el último corte— y el clamp a 0 los aplastaba a todos al mismo frame.
   *
   * La aridad que reporta `getInPoint` es 1 y puede estar mintiendo, así que se
   * prueban las dos formas y el resumen informa qué se pudo hacer. Si no se
   * pueden leer, se limpian: un medio sin in/out es el estado neutro, y dejarlos
   * como los dejó el corte no lo es.
   */
  /*
   * Los getters van AWAITED y FUERA del lock. Llamados adentro y sin await
   * devuelven una Promise, que es truthy: la guarda `if (i && o)` la daba por
   * buena y `createSetInOutPointsAction` contestaba "Illegal Parameter type".
   * Un valor equivocado que pasa la guarda es peor que no leer nada.
   */
  let inOutPrevios = null;
  try {
    const i = await clipItem.getInPoint();
    const o = await clipItem.getOutPoint();
    if (i && o && i.ticks !== undefined && o.ticks !== undefined) {
      inOutPrevios = { entrada: i, salida: o };
    }
  } catch (e) { inOutPrevios = null; }

  let inOutRestaurado = null;
  try {
    project.lockedAccess(() => {
      project.executeTransaction((a) => {
        a.addAction(clipItem.createSetInOutPointsAction(aTick(enFuenteReal), aTick(finFuente)));
      }, "entrada y salida de la cola");
    });
    const editor = ppro.SequenceEditor.getEditor(sequence);
    project.lockedAccess(() => {
      project.executeTransaction((a) => {
          // el audio de la cola va a la pista que espeja su video, no a A1
        a.addAction(editor.createOverwriteItemAction(medio, juntaTick, pistaIndex, pistaIndex));
      }, "pegar la cola");
    });

    /*
     * Devolver el medio a como estaba, ya con la cola pegada.
     *
     * Se mira el booleano de `executeTransaction` Y SE VUELVE A LEER. La primera
     * versión de esto informaba "limpiados" apenas la llamada no tiraba, y no
     * limpiaba nada: los medios quedaban con el in/out del corte y el verbo
     * decía que estaban bien. Un verbo que miente sobre lo que hizo es peor que
     * uno que no lo hace.
     */
    try {
      let corrio = false;
      project.lockedAccess(() => {
        corrio = project.executeTransaction((a) => {
          if (inOutPrevios) {
            a.addAction(clipItem.createSetInOutPointsAction(inOutPrevios.entrada, inOutPrevios.salida));
          } else {
            a.addAction(clipItem.createClearInOutPointsAction());
          }
        }, "devolver los in/out del medio");
      });
      let quedo = null;
      try {
        const i = await clipItem.getInPoint();
        const o = await clipItem.getOutPoint();
        if (i && o && i.ticks !== undefined && o.ticks !== undefined) {
          quedo = Number((Number(o.ticks) - Number(i.ticks)) / TICKS_POR_SEGUNDO).toFixed(2) + "s";
        }
      } catch (e) { quedo = null; }
      inOutRestaurado =
        (corrio ? (inOutPrevios ? "restaurados" : "limpiados") : "LA TRANSACCION NO CORRIO") +
        (quedo !== null ? ` (el medio quedó abarcando ${quedo})` : " (no se pudo releer para confirmar)");
    } catch (e) { inOutRestaurado = "NO SE PUDO: " + (e && e.message ? e.message : e); }
  } catch (e) { excepcion = (excepcion ? excepcion + " · " : "") + "reinsertar: " + (e && e.message ? e.message : e); }

  // Reponer en la cola el Motion que se leyó del original (ver arriba por qué).
  let motionRepuesto = null;
  if (motionAntes && (motionAntes.escala !== null || motionAntes.pos)) {
    try {
      const trk = await sequence.getVideoTrack(pistaIndex);
      const its = trk ? await trk.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
      let cola = null;
      for (let i = 0; i < its.length; i++) {
        const x = await tiemposDe(its[i]);
        if (Math.abs(x.desde - junta) <= 0.05) { cola = its[i]; break; }
      }
      if (!cola) throw new Error(`no se encontró la cola en ${junta.toFixed(3)}s`);
      const mo = await getComponente(cola, "Motion");
      if (!mo) throw new Error("la cola no tiene Motion");
      const pEsc = getParametro(project, mo, motionAntes.cual);
      const pPos = getParametro(project, mo, "Position");
      let kE = null, kP = null;
      project.lockedAccess(() => {
        if (pEsc && motionAntes.escala !== null) kE = pEsc.createKeyframe(motionAntes.escala);
        if (pPos && motionAntes.pos) kP = pPos.createKeyframe(new ppro.PointF(motionAntes.pos.x, motionAntes.pos.y));
      });
      let corrioMotion = false;
      project.lockedAccess(() => {
        corrioMotion = project.executeTransaction((a) => {
          if (kE) a.addAction(pEsc.createSetValueAction(kE));
          if (kP) a.addAction(pPos.createSetValueAction(kP));
        }, "reponer el Motion en la cola");
      });
      /*
       * SE RELEE LA COLA. Esto informaba `motionAntes` —los valores del clip que se
       * CORTÓ— así que el resumen afirmaba "Motion repuesto en la cola (escala 80,
       * x 0.5453, y 0.66)" sin haber mirado la cola ni una vez, y con el booleano
       * de la transacción tirado.
       *
       * Y es justo el daño que este bloque existe para prevenir: 20 clips del M2
       * escalados a 50 que volvieron a 100 sin aviso. Afirmarlo sin leerlo lo
       * vuelve peor que no decir nada, porque en una tanda de cortes nadie lo mira
       * clip por clip — el defecto original se descubrió mirando el video.
       */
      const relojCola = await relojDelClip(cola);
      const enCola = relojCola.aMaterial(aTick(junta));
      const escalaReal = pEsc ? aNumero(await valorEnTiempo(project, pEsc, enCola)) : null;
      const posReal = pPos ? aPunto(await valorEnTiempo(project, pPos, enCola)) : null;
      const cerca = (a, b) => a === null || b === null ? a === b : Math.abs(a - b) < 0.01;
      motionRepuesto = {
        transaccion: corrioMotion,
        escala: escalaReal,
        x: posReal ? posReal.x : null,
        y: posReal ? posReal.y : null,
        pedido: {
          escala: motionAntes.escala,
          x: motionAntes.pos ? motionAntes.pos.x : null,
          y: motionAntes.pos ? motionAntes.pos.y : null
        },
        coincide: cerca(escalaReal, motionAntes.escala) &&
          cerca(posReal ? posReal.x : null, motionAntes.pos ? motionAntes.pos.x : null) &&
          cerca(posReal ? posReal.y : null, motionAntes.pos ? motionAntes.pos.y : null)
      };
    } catch (e) {
      excepcion = (excepcion ? excepcion + " · " : "") + "reponer Motion: " + (e && e.message ? e.message : e);
    }
  }

  // Reparar el audio: sacar el pedazo que trajo la inserción y estirar el anterior.
  const reparado = [];
  const falloReparar = [];
  if (soloVideo) {
    for (const a of audioAntes) {
      try {
        const naudio = await sequence.getAudioTrackCount();
        for (let at = 0; at < naudio; at++) {
          const tr = await sequence.getAudioTrack(at);
          if (!tr) continue;
          const its = await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
          for (let k = 0; k < its.length; k++) {
            const x = await tiemposDe(its[k]);
            /*
             * El pedazo nuevo arranca en la junta. Y NADA MÁS que eso.
             *
             * Antes se exigía además que terminara donde terminaba el audio
             * original, y eso sólo pasa cuando el clip de video que se corta
             * llega hasta el final del audio. En una edición de verdad el audio
             * es largo y tiene varios clips de video encima, así que la cola
             * insertada termina ANTES: la condición no matcheaba, no se reparaba
             * nada, y el verbo lo informaba como "sin reparar" mientras A1 se
             * llenaba de pedazos.
             *
             * Reproducido el 2026-08-16: clip 305–312 sobre audio 300–330,
             * cortando en 310. La cola quedó en 310–312 y se comparaba 312
             * contra 330.
             */
            if (Math.abs(x.desde - junta) < 0.06 && x.hasta <= a.t.hasta + 0.06) {
              const sel = await sequence.getSelection();
              const prev = await sel.getTrackItems();
              for (let z = 0; z < prev.length; z++) sel.removeItem(prev[z]);
              sel.addItem(its[k], false);
              const ed = ppro.SequenceEditor.getEditor(sequence);
              let okSacar = false, okEstirar = false;
              project.lockedAccess(() => {
                okSacar = project.executeTransaction((ac) => {
                  ac.addAction(ed.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY));
                }, "sacar el audio partido");
              });
              /*
               * Se estira hasta donde terminaba EL PEDAZO, no hasta el final
               * del audio original: si el audio seguía más allá, ese resto
               * sigue ahí y estirar por encima se solaparía.
               */
              project.lockedAccess(() => {
                okEstirar = project.executeTransaction((ac) => {
                  ac.addAction(a.item.createSetEndAction(aTick(x.hasta)));
                }, "estirar el audio");
              });

              /*
               * Y ACÁ SE MIRA SI QUEDÓ, que es lo que faltaba.
               *
               * Antes el push era incondicional: alcanzaba con que las dos
               * llamadas no tiraran para informar "audio reparado". Es el modo
               * de fallar nº1 de CLAUDE.md, y explica la discrepancia del M1
               * —informó 10 reparados de 13 y A1 ganó 6 clips, cuando 3 fallos
               * explican 3—: parte de esos 10 nunca reparó y nadie se enteró.
               *
               * La prueba no es el booleano de la transacción sino el estado:
               * que el clip vuelva a llegar hasta donde llegaba.
               */
              const quedo = await tiemposDe(a.item);
              if (Math.abs(quedo.hasta - x.hasta) < 0.06) {
                reparado.push(x.hasta);
              } else {
                falloReparar.push(
                  `${a.t.desde}–${a.t.hasta}s quedó en ${quedo.desde}–${quedo.hasta}s` +
                  (okSacar ? "" : " · no se pudo sacar el pedazo") +
                  (okEstirar ? "" : " · no se pudo estirar")
                );
              }
            }
          }
        }
      } catch (e) {
        falloReparar.push(`${a.t.desde}–${a.t.hasta}s: ${e && e.message ? e.message : e}`);
      }
    }
  }

  // La prueba: dos clips donde había uno, pegados y con las entradas correctas.
  const track = await sequence.getVideoTrack(pistaIndex);
  const items = track ? await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
  const cerca = [];
  for (let i = 0; i < items.length; i++) {
    const x = await tiemposDe(items[i]);
    if (x.hasta > antes.desde - 0.05 && x.desde < antes.hasta + 0.05) {
      cerca.push({ desde: x.desde, hasta: x.hasta, entrada: x.entrada });
    }
  }
  cerca.sort((a, b) => a.desde - b.desde);
  const pegados = cerca.length >= 2 && Math.abs(cerca[1].desde - cerca[0].hasta) < 0.05;
  const itemsDespues = await contar();

  return {
    resumen:
      `"${encontrado.nombre}" en ${encontrado.pista}: ${antes.desde}-${antes.hasta}s → ` +
      cerca.map((c) => `${c.desde}-${c.hasta}s (entrada ${c.entrada})`).join(" + ") +
      ` · items en la secuencia ${itemsAntes} → ${itemsDespues}` +
      (cerca.length < 2 ? " · NO SE PARTIÓ" : pegados ? "" : " · OJO: quedó un hueco entre las partes") +
      (soloVideo
        ? ` · audio ${
            falloReparar.length
              ? `NO SE REPARÓ (${falloReparar.join(" | ")})`
              : reparado.length
                ? "reparado (sigue de largo), verificado releyéndolo"
                : audioAntes.length
                  ? "SIN REPARAR: no se encontró el pedazo partido"
                  : "SIN REPARAR: no se encontró audio que cubriera el clip"
          }`
        : "") +
      /*
       * Se informa SIEMPRE, incluso cuando no había nada que reponer: si el
       * verbo callara en ese caso, el silencio se leería como "no hizo falta"
       * y es justo el punto ciego que costó 20 clips.
       */
      (motionAntes === null
        ? " · OJO: no se pudo leer el Motion del original, la cola puede haber quedado en 100"
        : motionRepuesto
        ? ` · Motion en la cola, RELEÍDO (escala ${motionRepuesto.escala}` +
          (motionRepuesto.x !== null ? `, x ${motionRepuesto.x}, y ${motionRepuesto.y}` : "") + ")" +
          (motionRepuesto.coincide
            ? ""
            : ` · NO QUEDÓ COMO EL ORIGINAL (escala ${motionRepuesto.pedido.escala}` +
              (motionRepuesto.pedido.x !== null ? `, x ${motionRepuesto.pedido.x}, y ${motionRepuesto.pedido.y}` : "") +
              `), transacción ${motionRepuesto.transaccion} — la cola perdió el escalado`) +
          (motionAntes.animado
            ? " · OJO: el original tenía KEYFRAMES. La cola arranca en el valor correcto del punto de corte" +
              " (no hay salto), pero queda FIJA ahí: la animación no sigue. Si tiene que seguir moviéndose," +
              " hay que rehacerla sobre las dos partes"
            : "")
        : " · el original no tenía Motion que reponer") +
      (inOutRestaurado ? ` · in/out del medio ${inOutRestaurado}` : "") +
      (cuantizado ? ` · ${cuantizado}` : "") +
      (excepcion ? ` · ${excepcion}` : ""),
    clip: encontrado.nombre,
    partes: cerca,
    partio: cerca.length >= 2,
    pegados: pegados,
    cuantizado: cuantizado,
    audioCubriendo: audioAntes.length,
    audioReparado: reparado.length,
    audioFallado: falloReparar,
    vinculadosRecortados: vinculados.length,
    motionRepuesto: motionRepuesto,
    inOutDelMedio: inOutRestaurado,
    motionAnimado: motionAntes ? motionAntes.animado : null,
    excepcion: excepcion
  };
}

/**
 * Saca uno o varios rangos de la secuencia, cerrando el hueco.
 *
 * Es lo que permite editar EN LA SECUENCIA en vez de reconstruirla: respeta
 * todo lo que el usuario haya hecho a mano, que reconstruir pierde.
 *
 * Cada rango son tres operaciones: partir en el inicio, partir en el final, y
 * borrar el pedazo del medio con ripple.
 *
 * **Los rangos se procesan del último al primero.** Cada ripple corre hacia la
 * izquierda todo lo que está a la derecha, así que si se fuera de adelante para
 * atrás, los tiempos de los rangos siguientes ya no valdrían. Yendo al revés,
 * lo que todavía no se tocó no se movió.
 */
async function sacarRangos(params) {
  const { sequence } = await getProyectoYSecuencia();
  const rangos = Array.isArray(params.rangos) ? params.rangos.slice() : [];
  if (!rangos.length) throw new Error("Falta `rangos`: una lista de {desde, hasta} en segundos de la SECUENCIA.");
  for (let i = 0; i < rangos.length; i++) {
    const r = rangos[i];
    if (typeof r.desde !== "number" || typeof r.hasta !== "number" || r.hasta <= r.desde) {
      throw new Error(`El rango ${i} no es válido: ${JSON.stringify(r)}.`);
    }
  }
  rangos.sort((a, b) => b.desde - a.desde);

  const { pista, pistaIndex } = pistaDeVideo(params.pista, "sacarRangos");

  const antesTotal = (await contarItems(sequence)).total;
  const duracionDe = async () => {
    const track = await sequence.getVideoTrack(pistaIndex);
    const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    let fin = 0;
    for (let i = 0; i < its.length; i++) { const t = await tiemposDe(its[i]); if (t.hasta > fin) fin = t.hasta; }
    return fin;
  };
  const duracionAntes = await duracionDe();

  // El índice del clip que contiene un tiempo dado, en esta pista.
  const indiceEn = async (t) => {
    const track = await sequence.getVideoTrack(pistaIndex);
    const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < its.length; i++) {
      const x = await tiemposDe(its[i]);
      if (t > x.desde + 0.02 && t < x.hasta - 0.02) return { indice: i, dentro: true, tiempos: x };
      if (Math.abs(t - x.desde) <= 0.02) return { indice: i, dentro: false, tiempos: x };
    }
    return null;
  };

  const hechos = [];
  const fallidos = [];

  for (let i = 0; i < rangos.length; i++) {
    const r = rangos[i];
    try {
      const a = await indiceEn(r.desde);
      if (!a) { fallidos.push(`${r.desde}-${r.hasta}s: no hay clip en ${r.desde}s`); continue; }
      const b = await indiceEn(r.hasta);
      if (!b) { fallidos.push(`${r.desde}-${r.hasta}s: no hay clip en ${r.hasta}s`); continue; }
      if (a.indice !== b.indice) {
        fallidos.push(`${r.desde}-${r.hasta}s: el rango cruza de un clip a otro (${a.indice} → ${b.indice}), no se toca`);
        continue;
      }

      // Partir en el inicio (si no cae justo en un borde).
      let objetivo = a.indice;
      if (a.dentro) {
        await cortar({ pista: pista, indice: a.indice, segundos: r.desde });
        objetivo = a.indice + 1;
      }
      // Partir en el final del rango.
      const b2 = await indiceEn(r.hasta);
      if (b2 && b2.dentro) await cortar({ pista: pista, indice: b2.indice, segundos: r.hasta });

      const antesBorrar = (await contarItems(sequence)).total;
      await borrar({ pista: pista, indice: objetivo, dejarHueco: false });
      const despuesBorrar = (await contarItems(sequence)).total;
      if (despuesBorrar >= antesBorrar) { fallidos.push(`${r.desde}-${r.hasta}s: el borrado no sacó nada`); continue; }

      hechos.push({ desde: r.desde, hasta: r.hasta, quito: Number((r.hasta - r.desde).toFixed(3)) });
    } catch (e) {
      fallidos.push(`${r.desde}-${r.hasta}s: ${e && e.message ? e.message : e}`);
    }
  }

  const duracionDespues = await duracionDe();
  const despuesTotal = (await contarItems(sequence)).total;
  const pedido = hechos.reduce((s, h) => s + h.quito, 0);
  const real = duracionAntes - duracionDespues;

  return {
    resumen:
      `"${sequence.name}" en ${pista}: ${hechos.length} de ${rangos.length} rangos · ` +
      `${duracionAntes.toFixed(2)}s → ${duracionDespues.toFixed(2)}s (se fueron ${real.toFixed(2)}s, ` +
      `se pidieron ${pedido.toFixed(2)}s)` +
      /*
       * La tolerancia ESCALA con la cantidad de rangos: cada corte ajusta al
       * frame y deja hasta medio frame de diferencia, así que 32 cortes suman
       * ~0,4s sin que nada esté mal. Con un umbral fijo de 0,3s eso disparaba
       * una alarma falsa justo cuando el verbo más se usa.
       */
      (Math.abs(real - pedido) > 0.15 + hechos.length * 0.02 ? " · OJO: no coinciden" : "") +
      ` · items ${antesTotal} → ${despuesTotal}` +
      (fallidos.length ? ` · NO SE PUDO: ${fallidos.join(" | ")}` : ""),
    hechos: hechos,
    fallidos: fallidos,
    duracionAntes: Number(duracionAntes.toFixed(3)),
    duracionDespues: Number(duracionDespues.toFixed(3)),
    sacadoReal: Number(real.toFixed(3))
  };
}

/**
 * Cierra los huecos chicos entre clips, estirando el clip anterior.
 *
 * Existe porque los cortes emulados dejan juntas de un frame: el recorte ajusta
 * el final a un frame y la reinserción ajusta el inicio a otro. Un hueco de 1
 * frame en una pista de video es un parpadeo negro.
 *
 * Se estira el clip ANTERIOR y no se mueve el siguiente: mover arrastraría todo
 * lo que está a la derecha y desalinearía las capas de anotación. Estirar
 * muestra uno o dos frames más del material, que es invisible.
 */
async function cerrarHuecos(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const tope = typeof params.tope === "number" ? params.tope : 0.25;
  const { pista, pistaIndex, esAudio } = pistaDeSecuencia(params.pista, "cerrarHuecos");

  const track = esAudio
    ? await sequence.getAudioTrack(pistaIndex)
    : await sequence.getVideoTrack(pistaIndex);
  if (!track) throw new Error(`La secuencia "${sequence.name}" no tiene la pista ${pista}.`);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const tiempos = [];
  for (let i = 0; i < items.length; i++) tiempos.push(await tiemposDe(items[i]));

  const huecos = [];
  for (let i = 1; i < items.length; i++) {
    const g = tiempos[i].desde - tiempos[i - 1].hasta;
    if (g > 0.002 && g <= tope) huecos.push({ i: i - 1, hasta: tiempos[i].desde, g: Number(g.toFixed(4)) });
  }
  if (!huecos.length) {
    return { resumen: `"${sequence.name}" en ${pista}: no hay huecos de hasta ${tope}s.`, cerrados: 0, huecos: [] };
  }

  const fallidos = [];
  for (const h of huecos) {
    try {
      /*
       * En audio NO se arrastran los vinculados. Estirar un clip de A1 estiraría
       * también su video, y si V1 no tenía hueco ahí el resultado es un solape.
       *
       * El caso que trajo esto fue justo ese: después de partir con `soloVideo`,
       * A1 quedó con dos huecos de un frame que V1 no tenía. Se arreglaron a mano
       * con `editar` clip por clip, y `soloVideo` falla 1 de cada 3, así que va a
       * volver a pasar.
       */
      const vinc = esAudio ? [] : await buscarVinculados(sequence, items[h.i]);
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(items[h.i].createSetEndAction(aTick(h.hasta)));
          for (let k = 0; k < vinc.length; k++) a.addAction(vinc[k].createSetEndAction(aTick(h.hasta)));
        }, "cerrar hueco");
      });
    } catch (e) {
      fallidos.push(`${h.hasta}s: ${e && e.message ? e.message : e}`);
    }
  }

  // Releer: la prueba es que ya no estén.
  const items2 = await (esAudio
    ? await sequence.getAudioTrack(pistaIndex)
    : await sequence.getVideoTrack(pistaIndex)
  ).getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  let quedan = 0, peor = 0;
  let prev = null;
  for (let i = 0; i < items2.length; i++) {
    const t = await tiemposDe(items2[i]);
    if (prev !== null) { const g = t.desde - prev; if (g > 0.002 && g <= tope) { quedan++; if (g > peor) peor = g; } }
    prev = t.hasta;
  }

  return {
    resumen:
      `"${sequence.name}" en ${pista}: ${huecos.length} huecos de hasta ${tope}s → quedan ${quedan}` +
      (quedan ? ` (el mayor ${peor.toFixed(3)}s)` : "") +
      (fallidos.length ? ` · FALLARON: ${fallidos.join(" | ")}` : ""),
    cerrados: huecos.length - quedan,
    quedan: quedan,
    fallidos: fallidos
  };
}

/**
 * Cambia la resolución de la secuencia activa.
 *
 * `SequenceSettings` tiene `setVideoFrameRect`, y el cambio se aplica con
 * `sequence.createSetSettingsAction`. Lo que no está documentado es cómo se
 * arma el rectángulo, así que se prueban las formas y se informa cuál anduvo —
 * `new` sobre las clases de esta API no siempre funciona: `new
 * ppro.TrackItemSelection()` devuelve "Connection to object lost".
 *
 * OJO: cambiar la resolución NO reescala los clips. Un material 4K en una
 * secuencia 1080 queda al 200% y recortado hasta que se lo ajuste.
 */
/**
 * Lee tamaño y fps de una secuencia. Los fps se sacan de DOS lados a propósito:
 * `getVideoFrameRate()` de los ajustes y `getTimebase()` de la secuencia, que
 * está medido y son ticks por frame. Si discrepan, es que el setter escribió los
 * ajustes sin que la secuencia los tomara — y eso hay que verlo, no promediarlo.
 */
async function leerAjustes(sequence) {
  const st = await sequence.getSettings();
  const rect = await st.getVideoFrameRect();
  /*
   * `getVideoFrameRate()` NO devuelve ticks: devuelve un objeto con `.value` que
   * trae los CUADROS POR SEGUNDO directamente. Se buscó `.ticks` primero —por
   * analogía con el resto de la API, donde el tiempo va en ticks— y dio null, con
   * lo cual el verbo informaba "nullfps" y parecía que el getter no andaba.
   *
   * `getTimebase()` sí son ticks por frame, y está medido. Se leen los dos a
   * propósito: si discrepan, es que la escritura entró en los ajustes sin que la
   * secuencia la tomara, y eso hay que verlo.
   */
  let fpsAjustes = null, tpfSecuencia = null, crudo = null;
  try {
    const fr = await st.getVideoFrameRate();
    crudo = fr;
    if (fr && typeof fr.value === "number") fpsAjustes = Math.round(fr.value * 1000) / 1000;
    else if (fr && fr.ticks !== undefined) fpsAjustes = Math.round((TICKS_POR_SEGUNDO / Number(fr.ticks)) * 1000) / 1000;
  } catch (e) { /* lo informa como null */ }
  try { tpfSecuencia = Number(await sequence.getTimebase()); } catch (e) { /* idem */ }
  return {
    st: st, crudoFrameRate: crudo,
    ancho: rect.width, alto: rect.height,
    fps: fpsAjustes,
    ticksPorFrameSecuencia: tpfSecuencia,
    fpsSecuencia: tpfSecuencia > 0 ? Math.round((TICKS_POR_SEGUNDO / tpfSecuencia) * 1000) / 1000 : null
  };
}

/**
 * Pone tamaño y/o fps de la secuencia activa. Devuelve el antes y el después de
 * las dos cosas, y por qué forma entró cada una.
 *
 * Los fps salen de los TICKS POR FRAME, no del número de cuadros: la API mide el
 * tiempo en ticks y 25fps son 254016000000/25 = 10160640000. La forma que acepta
 * `setVideoFrameRate` no está documentada, así que se enumeran y **gana la que
 * cambia el valor releído**, no la que no tira excepción — que en esta API es
 * distinto.
 */
async function ponerAjustes(project, sequence, params) {
  const quiereRect = params.ancho !== undefined || params.alto !== undefined;
  const ancho = Math.round(params.ancho), alto = Math.round(params.alto);
  if (quiereRect && !(ancho > 0 && alto > 0)) {
    throw new Error("`ancho` y `alto` van los dos, en píxeles.");
  }
  const fps = params.fps === undefined ? null : Number(params.fps);
  if (fps !== null && !(fps > 0 && fps <= 240)) {
    throw new Error(`\`fps\` fuera de rango: ${params.fps}.`);
  }
  if (!quiereRect && fps === null) throw new Error("No se pidió ni `ancho`/`alto` ni `fps`.");

  const antes = await leerAjustes(sequence);
  const intentos = [];
  let viaRect = null, viaFps = null;

  // El rect y el rate se escriben en pasadas separadas porque cada uno tiene su
  // propia incógnita de forma: mezclarlos deja sin saber cuál de los dos falló.
  if (quiereRect && (antes.ancho !== ancho || antes.alto !== alto)) {
    const formas = [
      ["new RectF(0,0,w,h)", () => new ppro.RectF(0, 0, ancho, alto)],
      ["new RectF(w,h)", () => new ppro.RectF(ancho, alto)],
      ["objeto {width,height}", () => ({ width: ancho, height: alto })],
      ["objeto {left,top,width,height}", () => ({ left: 0, top: 0, width: ancho, height: alto })]
    ];
    for (let i = 0; i < formas.length && !viaRect; i++) {
      try {
        const rect = formas[i][1]();
        if (!rect) { intentos.push("rect " + formas[i][0] + ": devolvió " + describirValor(rect)); continue; }
        const st = (await leerAjustes(sequence)).st;
        st.setVideoFrameRect(rect);
        let ok = false;
        project.lockedAccess(() => {
          ok = project.executeTransaction((a) => { a.addAction(sequence.createSetSettingsAction(st)); },
            "resolución de la secuencia");
        });
        const ahora = await leerAjustes(sequence);
        if (ahora.ancho === ancho && ahora.alto === alto) { viaRect = formas[i][0]; break; }
        intentos.push(`rect ${formas[i][0]}: transacción ${ok}, quedó ${ahora.ancho}x${ahora.alto}`);
      } catch (e) { intentos.push("rect " + formas[i][0] + ": " + (e && e.message ? e.message : e)); }
    }
  } else if (quiereRect) {
    viaRect = "ya estaba";
  }

  if (fps !== null) {
    const tpf = Math.round(TICKS_POR_SEGUNDO / fps);
    if (antes.fps !== null && Math.abs(antes.fps - fps) < 0.01) {
      viaFps = "ya estaba";
    } else {
      /*
       * El orden NO es arbitrario: primero las formas que hablan en CUADROS,
       * porque es lo que el getter devuelve —un objeto con `.value` en fps— y lo
       * más probable es que el setter quiera lo mismo. Las de ticks van después:
       * se probaron primero por analogía con el resto de la API y el TickTime
       * contestó "Invalid parameter" mientras las otras daban "Illegal Parameter
       * type", o sea que ni el tipo era el esperado.
       */
      const formas = [
        ["el objeto del getter con .value cambiado", async () => {
          const a = await leerAjustes(sequence);
          if (!a.crudoFrameRate || typeof a.crudoFrameRate.value !== "number") return null;
          a.crudoFrameRate.value = fps;
          return a.crudoFrameRate;
        }],
        ["objeto {value: fps}", () => ({ value: fps })],
        ["número de fps", () => fps],
        ["TickTime de ticks por frame", () => ppro.TickTime.createWithTicks(String(tpf))],
        ["número de ticks por frame", () => tpf]
      ];
      for (let i = 0; i < formas.length && !viaFps; i++) {
        try {
          const valor = await formas[i][1]();
          if (valor === null) { intentos.push("fps " + formas[i][0] + ": no se pudo armar el valor"); continue; }
          const st = (await leerAjustes(sequence)).st;
          st.setVideoFrameRate(valor);
          let ok = false;
          project.lockedAccess(() => {
            ok = project.executeTransaction((a) => { a.addAction(sequence.createSetSettingsAction(st)); },
              "fps de la secuencia");
          });
          const ahora = await leerAjustes(sequence);
          if (ahora.fps !== null && Math.abs(ahora.fps - fps) < 0.01) { viaFps = formas[i][0]; break; }
          intentos.push(`fps ${formas[i][0]}: transacción ${ok}, quedó ${ahora.fps}fps`);
        } catch (e) { intentos.push("fps " + formas[i][0] + ": " + (e && e.message ? e.message : e)); }
      }
    }
  }

  const despues = await leerAjustes(sequence);
  const fallo = [];
  if (quiereRect && (despues.ancho !== ancho || despues.alto !== alto)) {
    fallo.push(`el tamaño quedó en ${despues.ancho}x${despues.alto} y se pidió ${ancho}x${alto}`);
  }
  if (fps !== null && despues.fps !== null && Math.abs(despues.fps - fps) > 0.01) {
    fallo.push(`los fps quedaron en ${despues.fps} y se pidieron ${fps}`);
  }
  if (fallo.length) {
    throw new Error(`No se pudo ajustar "${sequence.name}": ${fallo.join("; ")}. Intentos: ${intentos.join(" | ")}.`);
  }

  /*
   * Los dos avisos son daños ya vistos, no cortesía.
   *
   * El de la escala: un clip de 2160 de ancho en un cuadro de 1080 entra al 100%
   * de Motion, que son píxeles 1:1, así que se ve el centro y el resto queda
   * afuera. No hay franjas ni error: se ve mal y nada lo dice.
   *
   * El de los fps: bajar de 50 a 25 duplica el largo del frame, así que los
   * cortes que caían en un frame impar de 50 quedan ENTRE frames de 25. Por eso
   * conviene poner los fps antes de pegar nada, y `revisar` mide los huecos en
   * frames justamente para cazar esto.
   */
  const avisos = [];
  if (viaRect && viaRect !== "ya estaba") avisos.push("los clips NO se reescalaron: se ve el centro del cuadro, hay que escalarlos aparte");
  if (viaFps && viaFps !== "ya estaba") avisos.push("cambiar los fps con clips ya puestos puede dejar cortes ENTRE frames: corré `revisar`");

  return {
    resumen:
      `"${sequence.name}": ${antes.ancho}x${antes.alto} @ ${antes.fps}fps → ` +
      `${despues.ancho}x${despues.alto} @ ${despues.fps}fps` +
      (viaRect ? ` · tamaño vía ${viaRect}` : "") + (viaFps ? ` · fps vía ${viaFps}` : "") +
      (despues.fpsSecuencia !== null && despues.fps !== null && Math.abs(despues.fpsSecuencia - despues.fps) > 0.01
        ? ` · OJO: getTimebase() dice ${despues.fpsSecuencia}fps y los ajustes ${despues.fps}fps` : "") +
      (avisos.length ? " · " + avisos.join(" · ") : "") + " · se deshace con Cmd+Z",
    antes: { ancho: antes.ancho, alto: antes.alto, fps: antes.fps },
    despues: { ancho: despues.ancho, alto: despues.alto, fps: despues.fps },
    fpsSegunGetTimebase: despues.fpsSecuencia,
    cambio: (viaRect && viaRect !== "ya estaba") || (viaFps && viaFps !== "ya estaba"),
    viaRect: viaRect, viaFps: viaFps, intentos: intentos
  };
}

async function resolucion(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  return await ponerAjustes(project, sequence, params);
}

/**
 * Ajusta los medios de la secuencia al tamaño del cuadro ("Set to Frame Size").
 *
 * `createSetScaleToFrameSizeAction` vive en el **ClipProjectItem**, no en el
 * clip del timeline. Eso importa: se aplica al MEDIO, así que puede afectarlo en
 * todas las secuencias donde esté, no solo en esta. El verbo dice sobre cuántos
 * medios operó para que ese alcance quede a la vista.
 *
 * La alternativa sería poner Motion Scale al 50%, que es por clip y reversible
 * clip a clip, pero es un transform encima y no un ajuste de la fuente: deja el
 * Motion ocupado y confunde cualquier punch-in posterior.
 */
async function ajustarAlCuadro(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const st = await sequence.getSettings();
  const rect = await st.getVideoFrameRect();

  const total = await sequence.getVideoTrackCount();
  const medios = {};
  for (let t = 0; t < total; t++) {
    const track = await sequence.getVideoTrack(t);
    if (!track) continue;
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < items.length; i++) {
      try {
        const pi = await items[i].getProjectItem();
        const n = String(pi.name);
        if (!medios[n]) medios[n] = { item: pi, clips: 0 };
        medios[n].clips++;
      } catch (e) { /* un clip sin project item: se ignora */ }
    }
  }

  const nombres = Object.keys(medios);
  if (!nombres.length) throw new Error(`"${sequence.name}" no tiene clips de video.`);

  const hechos = [], fallidos = [];
  for (const n of nombres) {
    if (params.solo && n.toLowerCase().indexOf(String(params.solo).toLowerCase()) === -1) continue;
    try {
      const ci = ppro.ClipProjectItem.cast(medios[n].item);
      if (!ci) { fallidos.push(n + ": no se pudo castear"); continue; }
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => { a.addAction(ci.createSetScaleToFrameSizeAction()); },
          "ajustar al cuadro");
      });
      hechos.push({ medio: n, clips: medios[n].clips, transaccion: ok });
    } catch (e) {
      fallidos.push(n + ": " + (e && e.message ? e.message : e));
    }
  }

  return {
    resumen:
      `"${sequence.name}" (${rect.width}x${rect.height}): ajustados ${hechos.length} medios ` +
      `que cubren ${hechos.reduce((s, h) => s + h.clips, 0)} clips` +
      (fallidos.length ? ` · FALLARON: ${fallidos.join(" | ")}` : "") +
      ". Se aplica al MEDIO, así que puede verse en otras secuencias que lo usen. " +
      "Mirá un cuadro para confirmar que entró bien.",
    cuadro: { ancho: rect.width, alto: rect.height },
    hechos: hechos,
    fallidos: fallidos
  };
}

/**
 * Pone la escala del Motion en todos los clips de la secuencia.
 *
 * Es lo que hace "Set to Frame Size": con material del doble de la secuencia,
 * el ajuste es 50. Se hace por CLIP y no sobre el medio, así que no toca ese
 * material en otras secuencias.
 *
 * El valor va sin keyframes —es un ajuste, no una animación— y la forma de
 * fijarlo no está documentada, así que se prueban las plausibles. Si ninguna
 * anda queda el último recurso: un keyframe único, que da el mismo resultado
 * visual pero deja el param animado.
 */
async function escalaFija(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const valor = typeof params.valor === "number" ? params.valor : 50;

  const total = await sequence.getVideoTrackCount();
  const objetivo = params.pista ? String(params.pista).toUpperCase() : null;
  const clips = [];
  for (let t = 0; t < total; t++) {
    const etiqueta = "V" + (t + 1);
    if (objetivo && etiqueta !== objetivo) continue;
    const track = await sequence.getVideoTrack(t);
    if (!track) continue;
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < items.length; i++) clips.push({ clip: items[i], pista: etiqueta, indice: i });
  }
  if (!clips.length) throw new Error(`No hay clips de video en ${objetivo || `"${sequence.name}"`}.`);

  /*
   * Las capas de ajuste se SALTEAN, y se informa cuáles.
   *
   * Este verbo escala toda una pista de una, y escalar una capa de ajuste deja
   * la corrección en un rectángulo en el medio del cuadro con el resto sin
   * corregir — probado y mirado en un frame el 2026-08-16. En el flujo del curso
   * la pista se escala entera al 50, así que una capa de ajuste en el medio se
   * arruinaba sin que nada lo dijera.
   */
  const salteadas = [];
  for (let i = clips.length - 1; i >= 0; i--) {
    if (await esCapaDeAjuste(clips[i].clip)) {
      salteadas.push(`${clips[i].pista}[${clips[i].indice}] "${String(await clips[i].clip.getName())}"`);
      clips.splice(i, 1);
    }
  }
  salteadas.reverse();
  if (!clips.length) {
    throw new Error(
      `En ${objetivo || `"${sequence.name}"`} solo hay capas de ajuste (${salteadas.join(", ")}), ` +
      "y esas no se escalan: la corrección quedaría en un rectángulo en el medio del cuadro."
    );
  }

  const hechos = [], fallidos = [];
  let via = null;
  const intentos = [];

  for (const c of clips) {
    let nombre = "?";
    try {
      nombre = String(await c.clip.getName());
      const motion = await getComponente(c.clip, "Motion");
      if (!motion) { fallidos.push(`${c.pista}[${c.indice}] "${nombre}": sin Motion`); continue; }

      // El param de escala cambia de nombre con Uniform Scale.
      const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
      const p = getParametro(project, motion, cual);
      if (!p) { fallidos.push(`${c.pista}[${c.indice}] "${nombre}": sin param de escala`); continue; }

      /*
       * Un número crudo da "Illegal Parameter type": el patrón de esta API es
       * pasar un objeto Keyframe, igual que createAddKeyframeAction. El keyframe
       * se crea adentro de lockedAccess porque es una referencia de la API.
       */
      let kf = null;
      try { project.lockedAccess(() => { kf = p.createKeyframe(valor); }); } catch (e) { kf = null; }

      const formas = [
        ["createSetValueAction(keyframe)", () => p.createSetValueAction(kf)],
        ["createSetValueAction(keyframe, true)", () => p.createSetValueAction(kf, true)],
        ["createSetValueAction(valor)", () => p.createSetValueAction(valor)]
      ];
      let puesto = false;
      for (let i = 0; i < formas.length && !puesto; i++) {
        if (via && formas[i][0] !== via) continue; // ya sabemos cuál sirve
        try {
          project.lockedAccess(() => {
            project.executeTransaction((a) => { a.addAction(formas[i][1]()); }, "escala del clip");
          });
          const leido = aNumero(await valorEnTiempo(project, p, await c.clip.getStartTime()));
          if (leido !== null && Math.abs(leido - valor) < 0.5) { puesto = true; via = formas[i][0]; }
          else if (!via) intentos.push(`${formas[i][0]}: quedó ${leido}`);
        } catch (e) {
          if (!via) intentos.push(formas[i][0] + ": " + (e && e.message ? e.message : e));
        }
      }
      if (puesto) hechos.push({ pista: c.pista, indice: c.indice, param: cual });
      else fallidos.push(`${c.pista}[${c.indice}] "${nombre}": no se pudo fijar`);
    } catch (e) {
      fallidos.push(`${c.pista}[${c.indice}] "${nombre}": ${e && e.message ? e.message : e}`);
    }
  }

  return {
    resumen:
      `Escala ${valor} en ${hechos.length} de ${clips.length} clips` +
      (via ? ` · vía ${via}` : "") +
      (salteadas.length
        ? ` · SALTEADA(S) ${salteadas.length} capa(s) de ajuste (${salteadas.join(", ")}): escalarlas dejaría la corrección en un rectángulo`
        : "") +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.slice(0, 3).join(" | ")}` : "") +
      (!via && intentos.length ? ` · intentos: ${intentos.slice(0, 4).join(" | ")}` : ""),
    valor: valor, hechos: hechos.length, total: clips.length, via: via,
    fallidos: fallidos, capasDeAjusteSalteadas: salteadas
  };
}

/**
 * Fija un param del Motion en un clip, sin keyframes.
 *
 * Generaliza lo de escalaFija a cualquier param y a un clip puntual. El valor va
 * envuelto en un Keyframe aunque no se anime: `createSetValueAction` con un
 * número crudo contesta "Illegal Parameter type".
 */
async function fijar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const encontrado = await ubicarClip(sequence, params);
  const nombreClip = encontrado.nombre;

  const efecto = params.efecto || "Motion";
  const comp = await getComponente(encontrado.clip, efecto);
  if (!comp) throw new Error(`"${nombreClip}" no tiene el efecto "${efecto}".`);

  let cual = params.param;
  let p = null, avisoAmbiguo = null;
  /*
   * `indiceParam` gana sobre `param`, y existe porque LOS NOMBRES SE REPITEN.
   *
   * Lumetri Color trae "Saturation" tres veces, "Temperature"/"Tint"/"Sharpen"/"Look"/
   * "HDR White" dos, y uno con nombre vacío: cada grupo anidado tiene su propio juego.
   * `getParametro` devuelve el PRIMERO que coincida, así que reponer "Saturation" por nombre
   * puede escribirlo en el grupo equivocado — y eso no da error, da un color raro que nadie
   * atribuye a esto. Con el índice el objetivo es exacto.
   */
  if (typeof params.indiceParam === "number") {
    const n = await (async () => { let k = 0; project.lockedAccess(() => { k = comp.getParamCount(); }); return k; })();
    if (params.indiceParam < 0 || params.indiceParam >= n) {
      throw new Error(`"${efecto}" de "${nombreClip}" tiene ${n} params y se pidió el índice ${params.indiceParam}.`);
    }
    project.lockedAccess(() => { const q = comp.getParam(params.indiceParam); cual = String(q.displayName); p = q; });
    /* Si además vino `param`, tiene que coincidir: no coincidir significa que la cadena de
     * efectos cambió y el índice guardado ya no apunta a lo mismo. Se avisa en vez de
     * escribir sobre otra cosa. */
    if (typeof params.param === "string" && params.param !== cual) {
      throw new Error(
        `El índice ${params.indiceParam} de "${efecto}" es "${cual}" y se esperaba "${params.param}". ` +
        `La cadena de efectos cambió: el índice guardado ya no sirve. Volvé a leerla.`
      );
    }
  } else {
    // La escala cambia de nombre con Uniform Scale: se acepta "Scale" y se resuelve.
    if (cual === "Scale" && !getParametro(project, comp, "Scale")) cual = "Scale Height";
    p = getParametro(project, comp, cual);
    /* Y si el nombre está repetido, se dice cuál se agarró: escribir el primero puede ser
     * correcto o puede ser el grupo de al lado, y el usuario tiene que poder saberlo. */
    const todos = listarParams(project, comp);
    const veces = todos.filter((x) => x === cual).length;
    if (veces > 1) avisoAmbiguo = `OJO: "${cual}" aparece ${veces} veces en "${efecto}" y se escribió el ` +
      `índice ${indiceDe(project, comp, cual)}. Para apuntar a otro, pasá \`indiceParam\`.`;
  }
  if (!p) {
    throw new Error(
      `"${efecto}" de "${nombreClip}" no expuso "${cual}". Tiene: ` + listarParams(project, comp).join(", ")
    );
  }

  /*
   * Los strings se aceptan para los params que son un ARCHIVO —`LUTAsset`,
   * `LookAsset`— donde el valor es la ruta a un `.cube` o un `.look`. No se sabe
   * si la API los toma; el verbo lo averigua solo, porque lee antes y después y
   * avisa cuando no quedó lo que se pidió.
   */
  let valor;
  const esTexto = typeof params.valor === "string";
  if (typeof params.x === "number" && typeof params.y === "number") valor = new ppro.PointF(params.x, params.y);
  else if (typeof params.valor === "number" || typeof params.valor === "boolean" || esTexto) valor = params.valor;
  else throw new Error(`Falta "valor" o el par x/y para ${cual}.`);

  const antes = await valorEnTiempo(project, p, await encontrado.clip.getStartTime());

  let kf = null;
  let alCrear = null;
  try {
    project.lockedAccess(() => { kf = p.createKeyframe(valor); });
  } catch (e) { alCrear = e && e.message ? e.message : String(e); }
  if (!kf) {
    throw new Error(
      `"${cual}" no aceptó el valor ${JSON.stringify(params.valor)}` +
      (alCrear ? `: ${alCrear}` : " (createKeyframe no devolvió nada)")
    );
  }
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((a) => { a.addAction(p.createSetValueAction(kf)); }, "fijar " + cual);
  });

  const despues = await valorEnTiempo(project, p, await encontrado.clip.getStartTime());
  const leido = cual === "Position" ? aPunto(despues)
    : esTexto ? (despues && despues.value !== undefined ? despues.value : despues)
    : aNumero(despues);
  const esperado = cual === "Position" ? { x: params.x, y: params.y } : params.valor;
  const quedo = cual === "Position"
    ? leido && Math.abs(leido.x - params.x) < 0.002 && Math.abs(leido.y - params.y) < 0.002
    : esTexto ? String(leido) === String(params.valor)
    : leido !== null && Math.abs(leido - params.valor) < 0.5;

  return {
    resumen:
      `${efecto} > ${cual} en "${nombreClip}" (${encontrado.pista}[${encontrado.indice}]): ` +
      `${JSON.stringify(cual === "Position" ? aPunto(antes) : esTexto ? antes : aNumero(antes))} → ${JSON.stringify(leido)}` +
      (quedo ? "" : ` · NO QUEDÓ COMO SE PIDIÓ (${JSON.stringify(esperado)}), transacción ${ok}`) +
      (avisoAmbiguo ? ` · ${avisoAmbiguo}` : ""),
    clip: nombreClip, param: cual, valor: leido, quedo: quedo,
    ambiguo: avisoAmbiguo || null
  };
}

/**
 * Une los clips de audio contiguos que son continuación uno del otro.
 *
 * Los cortes de video con `soloVideo` reparan el audio, pero la reparación falla
 * cuando el pedazo ya venía partido de un corte anterior: busca un clip que
 * termine donde terminaba el original y no lo encuentra. Este verbo limpia
 * después, que es más simple que hacer la reparación perfecta.
 *
 * Se unen solo los que son CONTINUOS en el material —el siguiente arranca en la
 * fuente justo donde termina el anterior— porque unir dos pedazos que no lo son
 * cambiaría lo que se escucha.
 */
async function unirAudio(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const naudio = await sequence.getAudioTrackCount();
  const editor = ppro.SequenceEditor.getEditor(sequence);

  let unidos = 0, revisados = 0;
  const fallidos = [];

  for (let t = 0; t < naudio; t++) {
    let vueltas = 0;
    // Se repite hasta que no quede nada por unir: cada unión cambia la lista.
    while (vueltas++ < 200) {
      const track = await sequence.getAudioTrack(t);
      if (!track) break;
      const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      if (its.length < 2) break;

      const tiempos = [];
      for (let i = 0; i < its.length; i++) tiempos.push(await tiemposDe(its[i]));

      let par = -1;
      for (let i = 1; i < its.length; i++) {
        const a = tiempos[i - 1], b = tiempos[i];
        const pegados = Math.abs(b.desde - a.hasta) < 0.03;
        const continuos = Math.abs(b.entrada - (a.entrada + (a.hasta - a.desde))) < 0.05;
        let mismoMedio = true;
        try { mismoMedio = String((await its[i].getProjectItem()).name) === String((await its[i - 1].getProjectItem()).name); }
        catch (e) { mismoMedio = false; }
        if (pegados && continuos && mismoMedio) { par = i; break; }
      }
      if (par < 0) break;
      revisados++;

      try {
        const finalReal = tiempos[par].hasta;
        const sel = await sequence.getSelection();
        const prev = await sel.getTrackItems();
        for (let z = 0; z < prev.length; z++) sel.removeItem(prev[z]);
        sel.addItem(its[par], false);
        project.lockedAccess(() => {
          project.executeTransaction((a) => {
            a.addAction(editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY));
          }, "sacar el pedazo de audio");
        });
        project.lockedAccess(() => {
          project.executeTransaction((a) => {
            a.addAction(its[par - 1].createSetEndAction(aTick(finalReal)));
          }, "estirar el audio anterior");
        });
        unidos++;
      } catch (e) {
        fallidos.push(`A${t + 1} en ${tiempos[par].desde}s: ${e && e.message ? e.message : e}`);
        break;
      }
    }
  }

  // Cuántos quedan, para poder decir si terminó el trabajo.
  let quedan = 0;
  for (let t = 0; t < naudio; t++) {
    const tr = await sequence.getAudioTrack(t);
    if (tr) quedan += (await tr.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
  }

  return {
    resumen:
      `Unidos ${unidos} pedazos de audio · quedan ${quedan} clips de audio` +
      (fallidos.length ? ` · FALLARON: ${fallidos.slice(0, 3).join(" | ")}` : ""),
    unidos: unidos, quedan: quedan, fallidos: fallidos
  };
}

/**
 * Aplica escala y posición a muchos clips, en UNA sola pasada.
 *
 * Existe porque llamar a `fijar` en un bucle crasheó Premiere: ese verbo ubica
 * el clip recorriendo todas las pistas y pidiendo el nombre de cada item, así
 * que con 94 clips de video y 48 de audio son ~140 llamadas por operación. Cien
 * operaciones son veinte mil llamadas en ráfaga. Está escrito en el CLAUDE.md de
 * este repo —no enumerar a lo bruto— y se hizo igual.
 *
 * Acá se recorre la pista una vez, se resuelve cada clip por su tiempo de inicio,
 * y se aplica. Y hay `limite` para hacerlo de a tandas: una llamada que hace 94
 * clips es un solo punto de falla y no se puede retomar.
 */
/*
 * TOPE DEL LOTE: 10, que es lo MEDIDO, no lo que parecia razonable.
 *
 * El tope arranco en 50 porque sonaba prudente. Medido el 2026-09-05 sobre los 53
 * clips de V1 de un proyecto pesado:
 *
 *   porTransaccion 10   ->  6 transacciones · 0,3s · RELEIDO 53 de 53 · Premiere vivo
 *   porTransaccion 50   ->  2 transacciones · Premiere dejo de responder
 *
 * Entre 10 y 50 no hay ningun dato, asi que el tope se pone en el numero que se
 * comprobo a escala y no en uno interpolado. Subirlo es una decision que necesita
 * medicion, no una constante mas grande.
 */
const TOPE_LOTE = 10;

/*
 * MS_ENTRE_TX — LA OTRA MITAD DE LA REGLA, y faltaba entera (2026-09-11).
 *
 * `TOPE_LOTE` acota cuantas ACCIONES entran en una transaccion. Esto acota otra cosa:
 * cuantas TRANSACCIONES corren SEGUIDAS adentro de una sola llamada al panel.
 *
 * El `PAUSA` de las herramientas espacia LLAMADAS, y `test.js` exige que `PAUSA + MS_POLL`
 * sea >= 500 ms. Pero un verbo que hace su propio bucle de lotes corre todas sus
 * transacciones DENTRO de una llamada, donde esa pausa no llega: el espaciado real es CERO.
 *
 * Es lo que crasheo Premiere el 2026-09-10 con `colocar_propuesta.js` sobre un videoclip, y los
 * numeros cierran:
 *
 *   colocar_fragmentos  29 fragmentos ->  ~15 transacciones seguidas  ->  sobrevivio
 *   colocar_propuesta   88 fragmentos ->   27 transacciones seguidas  ->  CRASHEO
 *   un proyecto pesado, ~205 ms de espaciado ->   murio en la transaccion 22
 *
 * Y la trampa que casi se pisa al bisecar: `--por-transaccion 1` parece lo conservador y es
 * lo PEOR — sobre esos 88 planos da 177 transacciones en vez de 27. Menos acciones por
 * transaccion es MAS transacciones, o sea mas rafaga.
 *
 * El valor sale de lo medido en un proyecto pesado: a ~205 ms fallo 2 de 2, a ~355 y ~505 aguanto
 * 150. 400 esta arriba del borde conocido. Aca no hay `MS_POLL` que sumar —no hay viaje por
 * el intercambio entre lote y lote— asi que este numero ES el espaciado.
 *
 * Lo usa `colocarLote` y NO los tres `aplicar*`: esos hacen lecturas de Motion POR CLIP
 * entre transaccion y transaccion, asi que su bucle nunca es tan apretado, y tienen medido
 * que corren bien. Tocar un verbo estable por un riesgo que no se materializa es el error
 * mas caro que registra este repo.
 */
const MS_ENTRE_TX = 400;
const esperarEntreTx = () => new Promise((r) => setTimeout(r, MS_ENTRE_TX));

async function aplicarEscalas(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const plan = Array.isArray(params.plan) ? params.plan : [];
  if (!plan.length) throw new Error("Falta `plan`: [{desde, escala, x, y}] con `desde` en segundos de la secuencia.");

  const { pista, pistaIndex } = pistaDeVideo(params.pista, "aplicarEscalas");
  const track = await sequence.getVideoTrack(pistaIndex);
  if (!track) throw new Error(`No existe la pista ${pista}.`);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const desde = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  const limite = typeof params.limite === "number" ? params.limite : items.length;
  const hasta = Math.min(items.length, desde + limite);

  /*
   * `porTransaccion`: CUANTOS CLIPS ENTRAN EN UNA MISMA TRANSACCION.
   *
   * El espaciado entre transacciones —505ms medidos, ver CLAUDE.md— se paga POR
   * TRANSACCION, no por clip. Con una por clip, 94 clips son 94 esperas: ~47s de
   * puro dormir. Agrupando 10, son 10.
   *
   * El default es 1 A PROPOSITO: no cambia el comportamiento de nada de lo que ya
   * andaba, y agrupar se pide.
   *
   * Y va en la direccion CORRECTA respecto del crash: lo que tira Premiere es una
   * RAFAGA de transacciones, y esto tiene menos transacciones, no mas. Una
   * transaccion grande ademas se deshace con UN Cmd+Z en vez de 94.
   *
   * El costo es que la transaccion es TODO O NADA: si no corre, fallan los N del
   * lote juntos, y el informe los nombra a los N.
   */
  const porTx = Math.max(1, Math.min(TOPE_LOTE, typeof params.porTransaccion === "number" ? params.porTransaccion : 1));

  const hechos = [], fallidos = [], saltados = [], animados = [];
  let lote = [], transacciones = 0;

  /* Manda el lote en UNA transaccion y lo vacia. Los keyframes ya se crearon. */
  const soltarLote = () => {
    if (!lote.length) return;
    let corrio = false;
    project.lockedAccess(() => {
      corrio = project.executeTransaction((a) => {
        for (const w of lote) {
          a.addAction(w.pEsc.createSetValueAction(w.kEsc));
          if (w.kPos) a.addAction(w.pPos.createSetValueAction(w.kPos));
        }
      }, lote.length === 1 ? "escala y posición" : `escala y posición (${lote.length} clips)`);
    });
    transacciones++;
    for (const w of lote) {
      if (!corrio) { fallidos.push(`[${w.i}] en ${w.desde}s: la transacción del lote NO corrió`); continue; }
      if (w.animado) animados.push(`[${w.i}] en ${w.desde}s (${w.kfEsc} kf de escala, ${w.kfPos} de posición)`);
      hechos.push({ i: w.i, desde: w.desde, escala: w.escala, pos: w.pos, animado: w.animado });
    }
    lote = [];
  };

  for (let i = desde; i < hasta; i++) {
    let t;
    try { t = await tiemposDe(items[i]); } catch (e) { fallidos.push(`[${i}]: no se pudo leer`); continue; }

    let mejor = null, dist = Infinity;
    for (const u of plan) { const d = Math.abs(u.desde - t.desde); if (d < dist) { dist = d; mejor = u; } }
    if (!mejor || dist > 1.0) { saltados.push(`[${i}] en ${t.desde}s: sin plan a menos de 1s`); continue; }

    try {
      const motion = await getComponente(items[i], "Motion");
      if (!motion) { fallidos.push(`[${i}]: sin Motion`); continue; }

      const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
      const pEsc = getParametro(project, motion, cual);
      const pPos = typeof mejor.x === "number" ? getParametro(project, motion, "Position") : null;
      if (!pEsc) { fallidos.push(`[${i}]: sin param de escala`); continue; }

      // Los keyframes se crean adentro del lock; la acción va en una transacción
      // por clip. Agrupar más no se puede: cada param necesita su propio objeto.
      let kEsc = null, kPos = null;
      project.lockedAccess(() => {
        kEsc = pEsc.createKeyframe(mejor.escala);
        if (pPos) kPos = pPos.createKeyframe(new ppro.PointF(mejor.x, mejor.y));
      });
      /*
       * ANIMADO = LA ESCRITURA NO SE VA A VER, y hay que decirlo ANTES.
       *
       * `createSetValueAction` devuelve true sobre un param animado y no cambia
       * nada de lo que se ve: la escritura va al valor BASE y los keyframes la
       * tapan. Medido en CLAUDE.md —"fijar 55 sobre Scale animado -> 80 -> 80 ·
       * NO QUEDÓ COMO SE PIDIÓ (55), transacción true"—. Y en esta pista es el
       * caso NORMAL y no el borde: `aplicarZooms` y `aplicarAnim` le ponen
       * keyframes de Scale y Position a la pista entera.
       *
       * Se detecta con `contarKeyframes`, que usa `getKeyframeListAsTickTimes` —
       * el que quedó DESPUÉS de sacar `getKeyframePtr`: sincrónico, adentro del
       * lock, sin leer un solo VALOR—. Releer el valor de cada clip sería lo
       * obvio y sería el error: mete a un verbo que barre 94 clips en el régimen
       * de lecturas de param en volumen, que es el que tiró Premiere tres veces.
       * Para confirmar los valores está `leerEscalas`, que ya viene acotado.
       */
      const kfEsc = contarKeyframes(project, pEsc);
      const kfPos = pPos ? contarKeyframes(project, pPos) : 0;
      lote.push({ i, desde: t.desde, escala: mejor.escala, pos: kPos ? [mejor.x, mejor.y] : null,
                  pEsc, kEsc, pPos, kPos, kfEsc, kfPos, animado: kfEsc > 0 || kfPos > 0 });
      if (lote.length >= porTx) soltarLote();
    } catch (e) {
      fallidos.push(`[${i}] en ${t.desde}s: ${e && e.message ? e.message : e}`);
    }
  }

  soltarLote();

  return {
    resumen:
      `${pista}: clips ${desde} a ${hasta - 1} de ${items.length} · ${hechos.length} ESCRITOS ` +
      `en ${transacciones} transacción(es)` + (porTx > 1 ? ` de hasta ${porTx} clips` : "") +
      " (el valor NO se releyó, confirmalo con `leerEscalas`)" +
      (saltados.length ? ` · ${saltados.length} sin plan` : "") +
      (animados.length
        ? ` · OJO: ${animados.length} tenían el param ANIMADO, y ahí la escritura va al valor BASE y los ` +
          `keyframes la TAPAN: no se va a ver ningún cambio. ${animados.slice(0, 3).join(" | ")}` +
          (animados.length > 3 ? ` (y ${animados.length - 3} más)` : "")
        : "") +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.slice(0, 3).join(" | ")}` : "") +
      (hasta < items.length ? ` · FALTAN desde el índice ${hasta}` : " · terminado"),
    aplicados: hechos.length,
    animados: animados,
    transacciones: transacciones,
    siguiente: hasta < items.length ? hasta : null,
    total: items.length,
    fallidos: fallidos,
    saltados: saltados
  };
}

/**
 * Anima un zoom in en muchos clips, en UNA pasada y por tandas.
 *
 * La velocidad es constante —unidades de escala por segundo— pero con un TOPE de
 * recorrido: en un plano largo, mantener la velocidad terminaría demasiado
 * cerca, así que a partir de cierta duración el zoom se vuelve más lento en vez
 * de más grande. Es lo que pidió el usuario para las partes de bajo.
 *
 * La posición acompaña: al agrandar, la imagen crece hacia arriba y le corta la
 * cabeza al sujeto, así que la `y` baja proporcionalmente al avance de escala.
 * La proporción salió de medir un clip que el usuario animó a mano.
 *
 * Los keyframes van en tiempo de MATERIAL —ver relojDelClip— y en dos
 * transacciones por clip: activar el param y agregar los keyframes.
 */
async function aplicarZooms(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const vel = typeof params.velocidad === "number" ? params.velocidad : 0.534;
  const tope = typeof params.tope === "number" ? params.tope : 8;
  const ratioY = typeof params.ratioY === "number" ? params.ratioY : 0.0052;

  const { pista, pistaIndex } = pistaDeVideo(params.pista, "aplicarZooms");
  const track = await sequence.getVideoTrack(pistaIndex);
  if (!track) throw new Error(`No existe la pista ${pista}.`);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const desde = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  const hasta = Math.min(items.length, desde + (typeof params.limite === "number" ? params.limite : items.length));

  /*
   * `porTransaccion`: cuantos clips entran en cada transaccion. Ver la seccion
   * "Agrupar por transaccion gana MAS que apretar el espaciado" de CLAUDE.md.
   *
   * Este verbo hace DOS transacciones por clip —activar los keyframes y despues
   * agregarlos— y hay que respetar ese orden, asi que se agrupa POR FASE: un lote
   * de N clips son 2 transacciones en vez de 2N. Meterlas en una sola seria otra
   * apuesta y no esta medida.
   *
   * Default 1: no cambia nada de lo que ya andaba.
   */
  const porTx = Math.max(1, Math.min(TOPE_LOTE, typeof params.porTransaccion === "number" ? params.porTransaccion : 1));

  const hechos = [], fallidos = [];
  let lote = [], transacciones = 0;

  const soltarLote = () => {
    if (!lote.length) return;
    let okActivar = false, okAgregar = false;
    project.lockedAccess(() => {
      okActivar = project.executeTransaction((a) => {
        for (const w of lote) {
          a.addAction(w.pEsc.createSetTimeVaryingAction(true));
          a.addAction(w.pPos.createSetTimeVaryingAction(true));
        }
      }, `activar keyframes (${lote.length})`);
    });
    project.lockedAccess(() => {
      okAgregar = project.executeTransaction((a) => {
        for (const w of lote) {
          a.addAction(w.pEsc.createAddKeyframeAction(w.k1));
          a.addAction(w.pEsc.createAddKeyframeAction(w.k2));
          a.addAction(w.pPos.createAddKeyframeAction(w.p1));
          a.addAction(w.pPos.createAddKeyframeAction(w.p2));
        }
      }, `zoom (${lote.length} clips)`);
    });
    transacciones += 2;
    for (const w of lote) {
      /*
       * SE RECUENTAN LOS KEYFRAMES. Antes esto contaba "N con zoom" porque las dos
       * llamadas no habian tirado, sin haber contado un solo keyframe: un clip a
       * velocidad distinta de 1x —o cualquier keyframe que caiga fuera del rango
       * por la conversion de reloj de material— daba "20 con zoom · terminado"
       * sobre clips que no se mueven. Contar es gratis: `getKeyframeListAsTickTimes`
       * adentro del lock, sin leer un solo VALOR.
       */
      const kE = contarKeyframes(project, w.pEsc), kP = contarKeyframes(project, w.pPos);
      if (!okActivar || !okAgregar || kE < 2 || kP < 2) {
        fallidos.push(`[${w.i}] en ${w.desde}s: quedo con ${kE} kf de escala y ${kP} de posicion ` +
          `(se esperaban 2 y 2) · activar ${okActivar} · agregar ${okAgregar}`);
        continue;
      }
      hechos.push(w.info);
    }
    lote = [];
  };

  for (let i = desde; i < hasta; i++) {
    let t;
    try { t = await tiemposDe(items[i]); } catch (e) { fallidos.push(`[${i}]: no se pudo leer`); continue; }
    const dura = t.hasta - t.desde;
    if (dura < 0.5) { fallidos.push(`[${i}] en ${t.desde}s: dura ${dura.toFixed(2)}s, muy corto`); continue; }

    try {
      const motion = await getComponente(items[i], "Motion");
      if (!motion) { fallidos.push(`[${i}]: sin Motion`); continue; }
      const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
      const pEsc = getParametro(project, motion, cual);
      const pPos = getParametro(project, motion, "Position");
      if (!pEsc || !pPos) { fallidos.push(`[${i}]: faltan params`); continue; }

      const reloj = await relojDelClip(items[i]);
      const inicio = aTick(t.desde), fin = aTick(t.hasta);

      // De dónde sale: el valor que el clip tiene HOY, no uno supuesto.
      const escIni = aNumero(await valorEnTiempo(project, pEsc, reloj.aMaterial(inicio)));
      const posIni = aPunto(await valorEnTiempo(project, pPos, reloj.aMaterial(inicio)));
      if (escIni === null || !posIni) { fallidos.push(`[${i}]: no se pudo leer el estado actual`); continue; }

      const avance = Math.min(vel * dura, tope);
      const escFin = Number((escIni + avance).toFixed(2));
      const yFin = Number((posIni.y + ratioY * avance).toFixed(6));

      let k1 = null, k2 = null, p1 = null, p2 = null;
      project.lockedAccess(() => {
        k1 = pEsc.createKeyframe(escIni); k2 = pEsc.createKeyframe(escFin);
        p1 = pPos.createKeyframe(new ppro.PointF(posIni.x, posIni.y));
        p2 = pPos.createKeyframe(new ppro.PointF(posIni.x, yFin));
      });
      k1.position = reloj.aMaterial(inicio); k2.position = reloj.aMaterial(fin);
      p1.position = reloj.aMaterial(inicio); p2.position = reloj.aMaterial(fin);

      lote.push({ i, desde: t.desde, pEsc, pPos, k1, k2, p1, p2,
        info: { i, desde: t.desde, dura: Number(dura.toFixed(2)), escala: [escIni, escFin],
                yFin: yFin, topeAplicado: vel * dura > tope } });
      if (lote.length >= porTx) soltarLote();
    } catch (e) {
      fallidos.push(`[${i}] en ${t.desde}s: ${e && e.message ? e.message : e}`);
    }
  }

  soltarLote();

  const topados = hechos.filter((h) => h.topeAplicado).length;
  return {
    resumen:
      `${pista}: clips ${desde} a ${hasta - 1} de ${items.length} · ${hechos.length} con zoom ` +
      `(keyframes RECONTADOS, no supuestos) en ${transacciones} transacción(es)` +
      (porTx > 1 ? ` de hasta ${porTx} clips` : "") +
      (topados ? ` · ${topados} llegaron al tope de ${tope} unidades` : "") +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.slice(0, 3).join(" | ")}` : "") +
      (hasta < items.length ? ` · FALTAN desde ${hasta}` : " · terminado"),
    hechos: hechos.length, topados: topados, transacciones: transacciones,
    siguiente: hasta < items.length ? hasta : null,
    fallidos: fallidos
  };
}

/**
 * Lee la escala y la posición de TODOS los clips de una pista, en una pasada.
 *
 * Leer no parece peligroso, pero `param` ubica el clip recorriendo todas las
 * pistas: setenta y nueve lecturas son diez mil llamadas. El crash que costó una
 * sesión vino de un bucle así, y era de escritura, pero el costo es el mismo.
 *
 * Devuelve, por clip: la base (el valor en su inicio), el valor final si está
 * animado, y la posición. Con eso se puede diagnosticar una secuencia entera sin
 * tocarla.
 */
async function leerEscalas(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const { pista, pistaIndex } = pistaDeVideo(params.pista, "leerEscalas");
  const track = await sequence.getVideoTrack(pistaIndex);
  if (!track) throw new Error(`No existe la pista ${pista}.`);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const desde = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  const hasta = Math.min(items.length, desde + (typeof params.limite === "number" ? params.limite : items.length));

  const salida = [];
  for (let i = desde; i < hasta; i++) {
    const t = await tiemposDe(items[i]);
    const fila = {
      i, desde: t.desde, hasta: t.hasta, dura: Number((t.hasta - t.desde).toFixed(2)),
      nombre: String(await items[i].getName()),
      base: null, fin: null, keyframes: 0, x: null, y: null, yFin: null
    };
    try {
      const motion = await getComponente(items[i], "Motion");
      if (motion) {
        const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
        const pEsc = getParametro(project, motion, cual);
        const pPos = getParametro(project, motion, "Position");
        const reloj = await relojDelClip(items[i]);
        if (pEsc) {
          fila.base = aNumero(await valorEnTiempo(project, pEsc, reloj.aMaterial(aTick(t.desde))));
          fila.keyframes = contarKeyframes(project, pEsc);
          /*
           * El final sale del ÚLTIMO KEYFRAME, no de leer "cerca del final".
           * valorEnTiempo devuelve el valor del keyframe anterior al tiempo
           * pedido, no el interpolado: leyendo en `hasta - 0.02` devolvía el
           * valor de ARRANQUE y hacía ver como rota una animación correcta.
           *
           * Pero el valor se saca con `getValueAtTime`, NO con `getKeyframePtr`.
           *
           * Ese método devuelve un PUNTERO a la estructura interna del keyframe,
           * y llamarlo en ráfaga mata Premiere: el 2026-08-16, tres `leerEscalas`
           * seguidos sobre 30 clips —90 punteros en dos segundos— lo tiraron con
           * **señal 10 (SIGBUS) en el hilo main**, según el evento de Sentry.
           * El crash es DIFERIDO: las tres llamadas contestaron bien y Premiere
           * se murió después, que es lo que hizo tan difícil atribuirlo.
           *
           * Eso explica lo que no cerraba: por qué batchear de a 10 no alcanzaba
           * (baja la ráfaga, no saca el puntero), por qué MZH no crashea (lo
           * llama de a uno) y por qué daba igual `Scale` que `Position`.
           *
           * De la lista de ticks se sigue usando `getKeyframeListAsTickTimes`,
           * que devuelve tiempos y no punteros.
           */
          if (fila.keyframes > 0) {
            let ultimoTick = null;
            try {
              project.lockedAccess(() => {
                const ts = pEsc.getKeyframeListAsTickTimes();
                if (ts && ts.length) ultimoTick = ts[ts.length - 1];
              });
            } catch (e) { ultimoTick = null; }
            if (ultimoTick) {
              try { fila.fin = aNumero(await pEsc.getValueAtTime(ultimoTick)); }
              catch (e) { fila.fin = null; }
            }
          } else fila.fin = fila.base;
        }
        if (pPos) {
          const a = aPunto(await valorEnTiempo(project, pPos, reloj.aMaterial(aTick(t.desde))));
          if (a) { fila.x = Number(a.x.toFixed(4)); fila.y = Number(a.y.toFixed(4)); }
          /*
           * `yFin` queda en null A PROPÓSITO, y no es que falte hacerlo.
           *
           * Leerlo en `hasta - 0.02` devuelve el keyframe ANTERIOR —o sea el
           * de arranque— y mentía diciendo que la `y` no acompañaba al zoom.
           *
           * Se puede hacer bien con el mismo patrón que la escala de arriba:
           * `getKeyframeListAsTickTimes` para el último tick y `getValueAtTime`
           * para el valor. Lo que NO hay que usar es `getKeyframePtr`, que fue
           * lo que se probó el 2026-08-15 y tiró Premiere: devuelve un puntero
           * y en ráfaga termina en SIGBUS (ver la nota de la escala).
           *
           * Queda en null igual, pero por otra razón: sumar una lectura por
           * clip a un verbo que ya se llama sobre decenas es justo lo que hay
           * que evitar mientras el hilo de los crashes siga abierto. Si algún
           * día hace falta, el camino está escrito.
           *
           * Un valor equivocado es peor que ninguno. Si hace falta confirmar
           * que la `y` acompaña, se mira un frame del principio y otro del
           * final del clip; ahí se ve si la cabeza se corta o no.
           */
        }
      }
    } catch (e) { fila.error = e && e.message ? e.message : String(e); }
    salida.push(fila);
  }

  return {
    resumen: `${pista}: leídos ${salida.length} de ${items.length} clips` +
             (hasta < items.length ? ` · FALTAN desde ${hasta}` : ""),
    clips: salida,
    siguiente: hasta < items.length ? hasta : null,
    total: items.length
  };
}

/**
 * Aplica una animación de escala y posición, clip por clip, en UNA pasada.
 *
 * El plan viene calculado de afuera: por índice de clip, con qué valores empieza
 * y termina. Así el verbo no decide nada —no sabe de secciones ni de
 * velocidades— y toda la política vive donde se puede revisar.
 *
 * **Limpia antes de escribir.** Los clips traen keyframes de aplicaciones
 * anteriores, y al haberlos recortado quedaron fuera del rango visible: el clip
 * muestra un valor constante y agregar encima deja una animación impredecible.
 * `createSetTimeVaryingAction(false)` los saca.
 */
async function aplicarAnim(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const plan = Array.isArray(params.plan) ? params.plan : [];
  if (!plan.length) throw new Error("Falta `plan`: [{i, escalaIni, escalaFin, x, yIni, yFin}].");

  const { pista, pistaIndex } = pistaDeVideo(params.pista, "aplicarAnim");
  const track = await sequence.getVideoTrack(pistaIndex);
  if (!track) throw new Error(`No existe la pista ${pista}.`);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const porIndice = {};
  for (const u of plan) porIndice[u.i] = u;

  const desde = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  const hasta = Math.min(items.length, desde + (typeof params.limite === "number" ? params.limite : items.length));

  /*
   * `porTransaccion` acá tiene un costo que los otros dos no tienen: la PRIMERA
   * fase es DESTRUCTIVA —limpia los keyframes que hubiera— así que agrupar
   * agranda el radio de daño. Si la limpieza del lote entra y la escritura no,
   * son N clips los que pierden su animación en vez de uno.
   *
   * Se agrupa igual, por tres razones: el recuento de keyframes lo detecta y los
   * NOMBRA a los N; menos transacciones es menos exposición al régimen que tira
   * Premiere, que es de donde vendría el fallo; y el default es 1, así que el
   * radio grande se pide a propósito.
   *
   * Tres fases por lote en vez de tres por clip: limpiar · (valor fijo +
   * activar) · agregar keyframes. La segunda junta los dos casos porque son
   * clips DISTINTOS y no compiten por el orden.
   */
  const porTx = Math.max(1, Math.min(TOPE_LOTE, typeof params.porTransaccion === "number" ? params.porTransaccion : 1));

  const hechos = [], fallidos = [], saltados = [], rotos = [];
  let lote = [], transacciones = 0;

  const soltarLote = () => {
    if (!lote.length) return;
    let okLimpiar = false, okEscribir = false, okAgregar = true;
    project.lockedAccess(() => {
      okLimpiar = project.executeTransaction((a) => {
        for (const w of lote) {
          a.addAction(w.pEsc.createSetTimeVaryingAction(false));
          a.addAction(w.pPos.createSetTimeVaryingAction(false));
        }
      }, `limpiar keyframes (${lote.length})`);
    });
    project.lockedAccess(() => {
      okEscribir = project.executeTransaction((a) => {
        for (const w of lote) {
          if (!w.anima) {
            a.addAction(w.pEsc.createSetValueAction(w.k1));
            a.addAction(w.pPos.createSetValueAction(w.p1));
          } else {
            a.addAction(w.pEsc.createSetTimeVaryingAction(true));
            a.addAction(w.pPos.createSetTimeVaryingAction(true));
          }
        }
      }, `valor fijo y activar (${lote.length})`);
    });
    const conAnim = lote.filter((w) => w.anima);
    if (conAnim.length) {
      project.lockedAccess(() => {
        okAgregar = project.executeTransaction((a) => {
          for (const w of conAnim) {
            a.addAction(w.pEsc.createAddKeyframeAction(w.k1));
            a.addAction(w.pEsc.createAddKeyframeAction(w.k2));
            a.addAction(w.pPos.createAddKeyframeAction(w.p1));
            a.addAction(w.pPos.createAddKeyframeAction(w.p2));
          }
        }, `animación (${conAnim.length} clips)`);
      });
      transacciones++;
    }
    transacciones += 2;
    for (const w of lote) {
      const espera = w.anima ? 2 : 0;
      const finEsc = contarKeyframes(project, w.pEsc);
      const finPos = contarKeyframes(project, w.pPos);
      if (finEsc !== espera || finPos !== espera) {
        rotos.push(`[${w.i}]: quedó con ${finEsc} kf de escala y ${finPos} de posición, se esperaban ` +
          `${espera} · limpieza ${okLimpiar} · escritura ${okEscribir} · agregado ${okAgregar}` +
          (okLimpiar && finEsc === 0 && espera === 2
            ? " — SE LIMPIÓ Y NO SE ESCRIBIÓ: el clip perdió la animación que tenía"
            : ""));
        continue;
      }
      hechos.push(w.i);
    }
    lote = [];
  };

  for (let i = desde; i < hasta; i++) {
    const u = porIndice[i];
    if (!u) { saltados.push(i); continue; }
    try {
      const t = await tiemposDe(items[i]);
      const motion = await getComponente(items[i], "Motion");
      if (!motion) { fallidos.push(`[${i}]: sin Motion`); continue; }
      const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
      const pEsc = getParametro(project, motion, cual);
      const pPos = getParametro(project, motion, "Position");
      if (!pEsc || !pPos) { fallidos.push(`[${i}]: faltan params`); continue; }

      const reloj = await relojDelClip(items[i]);
      const tIni = reloj.aMaterial(aTick(t.desde));
      const tFin = reloj.aMaterial(aTick(t.hasta));

      /*
       * NO SE ESCRIBE ACA: se ENCOLA. Las tres fases —limpiar, escribir, agregar—
       * las manda `soltarLote`, una vez por lote en vez de una por clip. Los
       * keyframes se crean igual acá, adentro del lock, porque cada param necesita
       * su propio objeto.
       */
      const anima = Math.abs(u.escalaFin - u.escalaIni) > 0.01 || Math.abs((u.yFin ?? u.yIni) - u.yIni) > 0.0001;
      let k1 = null, k2 = null, p1 = null, p2 = null;
      project.lockedAccess(() => {
        k1 = pEsc.createKeyframe(u.escalaIni);
        p1 = pPos.createKeyframe(new ppro.PointF(u.x, u.yIni));
        if (anima) {
          k2 = pEsc.createKeyframe(u.escalaFin);
          p2 = pPos.createKeyframe(new ppro.PointF(u.x, u.yFin ?? u.yIni));
        }
      });
      if (anima) {
        k1.position = tIni; k2.position = tFin;
        p1.position = tIni; p2.position = tFin;
      }
      lote.push({ i, pEsc, pPos, k1, k2, p1, p2, anima });
      if (lote.length >= porTx) soltarLote();
    } catch (e) {
      fallidos.push(`[${i}]: ${e && e.message ? e.message : e}`);
    }
  }

  soltarLote();

  return {
    resumen:
      `${pista}: clips ${desde} a ${hasta - 1} de ${items.length} · ${hechos.length} aplicados ` +
      `(keyframes RECONTADOS, no supuestos) en ${transacciones} transacción(es)` +
      (porTx > 1 ? ` de hasta ${porTx} clips` : "") +
      (saltados.length ? ` · ${saltados.length} sin plan (se dejaron como estaban)` : "") +
      (rotos.length
        ? ` · OJO, ${rotos.length} QUEDARON MAL y este verbo limpia ANTES de escribir, así que pueden ` +
          `haber perdido la animación que tenían: ${rotos.slice(0, 3).join(" | ")}` +
          (rotos.length > 3 ? ` (y ${rotos.length - 3} más)` : "")
        : "") +
      (fallidos.length ? ` · FALLARON ${fallidos.length}: ${fallidos.slice(0, 3).join(" | ")}` : "") +
      (hasta < items.length ? ` · FALTAN desde ${hasta}` : " · terminado"),
    hechos: hechos.length, saltados: saltados.length, fallidos: fallidos, rotos: rotos,
    transacciones: transacciones,
    siguiente: hasta < items.length ? hasta : null
  };
}

/**
 * Fusiona clips de video contiguos, sin tocar el audio.
 *
 * Deshace los cortes que no sacaron material —los que se hicieron solo para
 * cambiar la escala— y deja los que sí, porque ahí el clip siguiente no continúa
 * al anterior y unirlos cambiaría lo que se ve.
 *
 * Se saca con `MediaType.VIDEO` y no `ANY`: con ANY se llevaría el audio de
 * abajo, que en un punch-in nunca se cortó y tiene que seguir de largo.
 *
 * Cada rango se procesa releyendo la pista, porque cada fusión corre los índices.
 */
async function unirVideo(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const rangos = Array.isArray(params.rangos) ? params.rangos : [];
  if (!rangos.length) throw new Error("Falta `rangos`: [{desde, hasta}] en segundos de la secuencia.");

  const { pista, pistaIndex } = pistaDeVideo(params.pista, "unirVideo");
  const editor = ppro.SequenceEditor.getEditor(sequence);

  const traer = async () => {
    const track = await sequence.getVideoTrack(pistaIndex);
    const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    const out = [];
    for (let i = 0; i < its.length; i++) out.push({ item: its[i], t: await tiemposDe(its[i]) });
    return out;
  };

  const hechos = [], fallidos = [];
  // De atrás para adelante no hace falta —no hay ripple— pero se relee igual.
  for (const r of rangos) {
    try {
      const lista = await traer();
      const dentro = lista.filter((x) => x.t.desde >= r.desde - 0.03 && x.t.hasta <= r.hasta + 0.03);
      if (dentro.length < 2) { continue; }

      const primero = dentro[0];
      const resto = dentro.slice(1);

      const sel = await sequence.getSelection();
      const prev = await sel.getTrackItems();
      for (let z = 0; z < prev.length; z++) sel.removeItem(prev[z]);
      for (const x of resto) { try { sel.addItem(x.item, false); } catch (e) { /* sigue */ } }

      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.VIDEO));
        }, "sacar los pedazos a fusionar");
      });
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(primero.item.createSetEndAction(aTick(r.hasta)));
        }, "estirar el primero");
      });

      // La prueba: en ese rango tiene que quedar UN solo clip, del largo pedido.
      const despues = (await traer()).filter((x) => x.t.desde >= r.desde - 0.03 && x.t.hasta <= r.hasta + 0.03);
      if (despues.length === 1 && Math.abs(despues[0].t.hasta - r.hasta) < 0.05) {
        hechos.push({ desde: r.desde, hasta: r.hasta, unio: dentro.length });
      } else {
        fallidos.push(`${r.desde}-${r.hasta}s: quedaron ${despues.length} clips`);
      }
    } catch (e) {
      fallidos.push(`${r.desde}-${r.hasta}s: ${e && e.message ? e.message : e}`);
    }
  }

  const total = (await traer()).length;
  return {
    resumen:
      `${pista}: ${hechos.length} fusiones de ${rangos.length} pedidas · quedan ${total} clips` +
      (fallidos.length ? ` · FALLARON: ${fallidos.slice(0, 3).join(" | ")}` : ""),
    hechos: hechos.length, quedan: total, fallidos: fallidos
  };
}

/**
 * Duplica una secuencia del proyecto.
 *
 * `sequence.createCloneAction()` existe pero no está documentado qué toma ni
 * cómo se llama la copia, así que se prueban las formas y la prueba es que
 * aparezca una secuencia más — no que la llamada no tire.
 *
 * Sirve para trabajar sobre una copia antes de una tanda grande de cambios: el
 * bridge hace decenas de operaciones encadenadas y deshacerlas a mano es
 * inviable.
 */
async function duplicarSecuencia(params) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No hay un proyecto abierto en Premiere.");

  const lista = await project.getSequences();
  const nombres = [];
  let objetivo = null;
  const buscada = String(params.nombre || "").toLowerCase();
  for (let i = 0; i < lista.length; i++) {
    const n = String(lista[i].name);
    nombres.push(n);
    if (!objetivo && buscada && n.toLowerCase().indexOf(buscada) !== -1) objetivo = lista[i];
  }
  if (!objetivo) {
    throw new Error(`No hay ninguna secuencia que coincida con "${params.nombre}". Hay: ${nombres.join(", ")}.`);
  }
  const nombreOrigen = String(objetivo.name);
  const antes = lista.length;

  const intentos = [];
  let via = null;
  const formas = [
    ["createCloneAction()", () => objetivo.createCloneAction()],
    ["createCloneAction(true)", () => objetivo.createCloneAction(true)]
  ];
  for (let i = 0; i < formas.length && !via; i++) {
    try {
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => { a.addAction(formas[i][1]()); }, "duplicar secuencia");
      });
      const ahora = await project.getSequences();
      if (ahora.length > antes) { via = formas[i][0]; break; }
      intentos.push(formas[i][0] + ": transacción " + ok + " y siguen " + ahora.length);
    } catch (e) {
      intentos.push(formas[i][0] + ": " + (e && e.message ? e.message : e));
    }
  }

  const despues = await project.getSequences();
  if (despues.length <= antes) {
    throw new Error(`No se pudo duplicar "${nombreOrigen}". Intentos: ${intentos.join(" | ")}.`);
  }

  // Cuál es la nueva: la que no estaba antes.
  const nuevos = [];
  for (let i = 0; i < despues.length; i++) {
    const n = String(despues[i].name);
    if (nombres.indexOf(n) === -1) nuevos.push({ seq: despues[i], nombre: n });
  }
  /*
   * El renombre va por el ProjectItem, NO por la Sequence: `Sequence` no tiene
   * createSetNameAction —está en ProjectItem— y llamarlo ahí tira. La primera
   * versión se tragaba ese error y decía que había renombrado cuando la copia
   * seguía llamándose "M2 Copy".
   */
  let renombrada = null;
  let fallaRenombre = null;
  if (params.nuevoNombre && nuevos.length === 1) {
    const quiero = String(params.nuevoNombre);
    try {
      const raiz = await project.getRootItem();
      let item = null;
      const buscar = async (carpeta, prof) => {
        if (item || prof > 8) return;
        const hijos = await hijosDe(carpeta);
        if (!hijos) return;
        for (let i = 0; i < hijos.length && !item; i++) {
          if (String(hijos[i].name) === nuevos[0].nombre) { item = hijos[i]; return; }
          await buscar(hijos[i], prof + 1);
        }
      };
      await buscar(raiz, 0);
      if (!item) throw new Error(`no se encontró "${nuevos[0].nombre}" en el panel de proyecto`);

      project.lockedAccess(() => {
        project.executeTransaction((a) => { a.addAction(item.createSetNameAction(quiero)); }, "renombrar la copia");
      });
      // La prueba: releer la lista de secuencias.
      const rel = await project.getSequences();
      for (let i = 0; i < rel.length; i++) if (String(rel[i].name) === quiero) renombrada = quiero;
      if (!renombrada) fallaRenombre = `la copia sigue llamándose "${nuevos[0].nombre}"`;
    } catch (e) {
      fallaRenombre = e && e.message ? e.message : String(e);
    }
  }

  const finales = await project.getSequences();
  const listaFinal = [];
  for (let i = 0; i < finales.length; i++) listaFinal.push(String(finales[i].name));

  return {
    resumen:
      `Duplicada "${nombreOrigen}": ${antes} → ${despues.length} secuencias · ` +
      `la copia se llama "${renombrada || (nuevos[0] ? nuevos[0].nombre : "?")}" · vía ${via}` +
      (fallaRenombre ? ` · NO SE PUDO RENOMBRAR: ${fallaRenombre}` : ""),
    origen: nombreOrigen,
    copia: renombrada || (nuevos[0] ? nuevos[0].nombre : null),
    secuencias: listaFinal
  };
}

/* ---------- marcadores ---------- */

/** Los marcadores de la secuencia activa, con su tiempo y su comentario. */
async function marcadores(params) {
  const { sequence } = await getProyectoYSecuencia();
  const col = await ppro.Markers.getMarkers(sequence);
  const lista = await col.getMarkers();

  const salida = [];
  for (let i = 0; i < lista.length; i++) {
    const m = lista[i];
    let seg = null;
    try { seg = Number(aSegundos(await m.getStart()).toFixed(3)); } catch (e) { seg = null; }
    const indice = await m.getColorIndex();
    salida.push({
      segundos: seg,
      nombre: String(await m.getName()),
      comentario: String(await m.getComments() || ""),
      color: indice,
      colorNombre: nombreDeColor(indice)
    });
  }
  salida.sort((a, b) => (a.segundos || 0) - (b.segundos || 0));

  return {
    resumen:
      salida.length
        ? `${salida.length} marcadores en "${sequence.name}": ` +
          salida.map((m) => `${m.segundos}s [${m.colorNombre}] "${m.nombre}"`).join(" · ")
        : `"${sequence.name}" no tiene marcadores.`,
    secuencia: sequence.name,
    marcadores: salida
  };
}

/**
 * Pone un marcador con un comentario en la secuencia activa.
 *
 * Sirve para dejar las observaciones DONDE PASAN en vez de en una lista aparte:
 * "acá la frase queda colgada" puesto en el segundo exacto vale más que el mismo
 * texto en un chat.
 *
 * La firma de `createAddMarkerAction` no está documentada y la aridad reporta 0,
 * que en esta API no significa nada. Se prueban las formas plausibles y **se
 * informa cuál anduvo**: la vez anterior que no lo hice —con
 * createSequenceFromMedia— el dato se perdió y hubo que redescubrirlo.
 */
async function marcar(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  if (typeof params.segundos !== "number") throw new Error("Falta `segundos`: dónde va el marcador.");
  const nombre = String(params.nombre || "Nota");
  const comentario = String(params.comentario || "");
  /*
   * EL MARCADOR SE CUANTIZA AL FRAME DE LA SECUENCIA. En la interfaz de Premiere no se
   * puede poner un marcador entre frames, asi que subframe no es un estado que el usuario
   * pueda crear a mano: lo producia este verbo y nada mas.
   *
   * Se descubrio el 2026-09-03 poniendo 139 marcadores en el beat de una musica a 96 BPM:
   * el beat mide 15,625 cuadros a 25fps, asi que solo 1 de cada 8 caia en cuadro justo y
   * 121 de los 139 quedaron subframe. Lo vio el editor, no yo — y estaba escrito en el
   * CLAUDE.md de este repo, en la nota de los huecos de un frame de `cortar`.
   *
   * No es grave porque al cortar Premiere aproxima, pero el marcador deja de decir donde
   * esta el corte: se corre hasta medio cuadro. Y a 96 BPM eso es inevitable —un beat de
   * 15,625 cuadros NO puede caer en cuadro y en beat a la vez— asi que gana el cuadro,
   * que es lo unico que el timeline puede sostener.
   *
   * La via es aritmetica entera sobre ticks con `getTimebase()`, que son ticks por frame.
   * `alignToNearestFrame` contesta "Illegal Parameter type"; ya esta medido en `cortar`.
   */
  let tick = aTick(params.segundos);
  let cuantizado = null;
  {
    let tb = null;
    try { tb = Number(await sequence.getTimebase()); } catch (e) { tb = null; }
    const antesSeg = aSegundos(tick);
    if (!isFinite(tb) || tb <= 0) {
      cuantizado = `NO SE CUANTIZÓ: getTimebase() devolvió ${JSON.stringify(tb)}`;
    } else {
      const ticks = Number(tick.ticks);
      const alineado = ppro.TickTime.createWithTicks(String(Math.round(ticks / tb) * tb));
      const despuesSeg = aSegundos(alineado);
      /* La prueba no es que no tire: es que no se haya ido lejos. Medio frame es el maximo
       * que puede moverse un redondeo correcto. */
      if (Math.abs(despuesSeg - antesSeg) > 0.5 / (TICKS_POR_SEGUNDO / tb)) {
        cuantizado = `NO SE CUANTIZÓ: el redondeo se fue de ${antesSeg}s a ${despuesSeg}s`;
      } else {
        tick = alineado;
        cuantizado = Math.abs(despuesSeg - antesSeg) < 0.0005
          ? "ya caía en un frame"
          : `cuantizado al frame: se pidió ${antesSeg.toFixed(4)}s y quedó en ${despuesSeg.toFixed(4)}s`;
      }
    }
  }
  const segundosReales = aSegundos(tick);
  const duracion = aTick(typeof params.duracion === "number" ? params.duracion : 0);

  const traer = async () => await (await ppro.Markers.getMarkers(sequence)).getMarkers();
  const listaAntes = await traer();
  const antes = listaAntes.length;
  const guidsAntes = listaAntes.map((m) => String(m.guid));

  /*
   * Las formas plausibles de createAddMarkerAction, que no está documentada y
   * cuya aridad reporta 0.
   *
   * Y ojo con cómo se decide cuál sirvió: la primera versión daba por buena la
   * que hiciera aparecer un marcador, y la primera forma HACE aparecer uno —con
   * el comentario en el valor por defecto, "Comment"—. O sea que el marcador
   * quedaba puesto y la nota se perdía, en silencio. Ahora se relee el marcador
   * y se exige que coincidan NOMBRE Y COMENTARIO; si no, se lo saca y se sigue
   * probando.
   */
  const col = await ppro.Markers.getMarkers(sequence);
  const formas = [
    ["(nombre, comentario, tick, duracion, tipo)",
      () => col.createAddMarkerAction(nombre, comentario, tick, duracion, ppro.Marker.MARKER_TYPE_COMMENT)],
    ["(nombre, tick, duracion, tipo, comentario)",
      () => col.createAddMarkerAction(nombre, tick, duracion, ppro.Marker.MARKER_TYPE_COMMENT, comentario)],
    ["(nombre, comentario, tick, duracion)",
      () => col.createAddMarkerAction(nombre, comentario, tick, duracion)],
    ["(nombre, tick, duracion, comentario)",
      () => col.createAddMarkerAction(nombre, tick, duracion, comentario)],
    ["(tick, nombre, comentario)", () => col.createAddMarkerAction(tick, nombre, comentario)]
  ];

  const intentos = [];
  let via = null, puesto = null;

  for (let i = 0; i < formas.length && !via; i++) {
    let nuevo = null;
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => { a.addAction(formas[i][1]()); }, "poner marcador");
      });
      const ahora = await traer();
      if (ahora.length <= antes) { intentos.push(formas[i][0] + ": no tiró pero no apareció"); continue; }
      /*
       * El marcador nuevo se identifica por GUID, no agarrando el último de la
       * lista: getMarkers() los devuelve ordenados por TIEMPO, así que uno
       * puesto antes que los existentes no queda al final. Agarrar el último
       * verificaba un marcador ajeno, lo daba por fallido y LO BORRABA. Pasó:
       * se perdieron dos marcadores buenos y quedaron dos rotos.
       */
      const nuevos = ahora.filter((m) => guidsAntes.indexOf(String(m.guid)) === -1);
      if (!nuevos.length) { intentos.push(formas[i][0] + ": apareció uno pero no se pudo identificar"); continue; }
      nuevo = nuevos[0];
    } catch (e) {
      intentos.push(formas[i][0] + ": " + (e && e.message ? e.message : e));
      continue;
    }

    const nom = String(await nuevo.getName());

    /*
     * El comentario se pone con su SETTER, no por posición de argumento.
     * Probando las cinco formas, ninguna lo guardaba: con cinco argumentos queda
     * en "Comment" —el valor por defecto— y con cuatro, vacío. El segundo
     * argumento acepta un string y lo ignora.
     *
     * createSetCommentsAction es explícito y no hay que adivinar nada.
     */
    if (comentario) {
      try {
        project.lockedAccess(() => {
          project.executeTransaction((a) => { a.addAction(nuevo.createSetCommentsAction(comentario)); },
            "comentario del marcador");
        });
      } catch (e) { intentos.push(formas[i][0] + ": el setter del comentario tiró: " + (e && e.message ? e.message : e)); }
    }

    const com = String((await nuevo.getComments()) || "");
    if (nom === nombre && (!comentario || com === comentario)) {
      // Se guarda el Marker, no solo sus textos: el color se pinta después
      // sobre este mismo objeto, y la colección no da forma de volver a él.
      via = formas[i][0]; puesto = { nombre: nom, comentario: com, marker: nuevo };
      break;
    }

    intentos.push(`${formas[i][0]}: quedó nombre="${nom}" comentario="${com}"`);
    // No sirvió: se lo saca antes de probar la siguiente, para no dejar basura.
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => { a.addAction(col.createRemoveMarkerAction(nuevo)); }, "sacar marcador de prueba");
      });
    } catch (e) { intentos.push("(y no se pudo sacar: " + (e && e.message ? e.message : e) + ")"); }
  }

  const despues = (await traer()).length;
  if (!via) {
    throw new Error(
      `No se pudo poner el marcador con su comentario en ${params.segundos}s. ` +
      `Intentos: ${intentos.join(" | ")}.`
    );
  }

  /*
   * El color va en una transacción APARTE, después de que el marcador existe:
   * `createAddMarkerAction` no lo toma en ninguna de sus formas —se probó— y el
   * setter vive en el Marker, no en la colección.
   *
   * Por eso son DOS Cmd+Z cuando se pide color, y el resumen lo dice. Decir uno
   * cuando son dos deja al usuario con el marcador puesto y sin color, creyendo
   * que lo sacó.
   *
   * Los índices salen de Constants.MarkerColor, reflejado:
   *   GREEN 0 · RED 1 · MAGNETA 2 · ORANGE 3 · YELLOW 4 · BLUE 6 · CYAN 7
   * El 5 NO existe en esa constante — no es un olvido de esta lista.
   */
  let color = null, colorPedido = null, colorError = null;
  if (params.color !== undefined && params.color !== null) {
    colorPedido = indiceDeColor(params.color);
    try {
      project.lockedAccess(() => {
        project.executeTransaction((a) => {
          a.addAction(puesto.marker.createSetColorByIndexAction(colorPedido));
        }, "pintar el marcador");
      });
    } catch (e) { colorError = e && e.message ? e.message : String(e); }
    // Se relee del marcador: esta API acepta escrituras que no aplica.
    try { color = await puesto.marker.getColorIndex(); } catch (e) { color = null; }
  }

  const colorDicho =
    colorPedido === null
      ? ""
      : color === colorPedido
        ? ` · color ${nombreDeColor(color)} (${color}) · son DOS Cmd+Z`
        : ` · EL COLOR NO QUEDÓ: se pidió ${colorPedido} y está en ${color}` +
          (colorError ? ` · ${colorError}` : "");

  return {
    resumen:
      `Marcador "${puesto.nombre}" en ${segundosReales}s de "${sequence.name}": ` +
      `${antes} → ${despues} marcadores · comentario guardado: "${puesto.comentario}" · ` +
      `${cuantizado} · vía ${via}${colorDicho}` + (colorPedido === null ? " · se deshace con Cmd+Z" : ""),
    secuencia: sequence.name,
    segundos: segundosReales,
    segundosPedidos: params.segundos,
    cuantizado: cuantizado,
    nombre: puesto.nombre,
    comentario: puesto.comentario,
    color: color,
    colorPedido: colorPedido,
    via: via,
    marcadoresAntes: antes,
    marcadoresDespues: despues
  };
}

/*
 * Los colores de marcador se aceptan por nombre además de por número, porque
 * un índice suelto en el llamado no dice nada y "MAGNETA" está mal escrito en
 * la propia API — con el nombre bien escrito no anda, así que acá se acepta
 * "magenta" y se traduce.
 */
const COLORES_MARCADOR = {
  verde: 0, green: 0,
  rojo: 1, red: 1,
  magenta: 2, magneta: 2,
  naranja: 3, orange: 3,
  amarillo: 4, yellow: 4,
  azul: 6, blue: 6,
  cyan: 7, celeste: 7
};

function indiceDeColor(valor) {
  if (typeof valor === "number") return valor;
  const clave = String(valor).trim().toLowerCase();
  if (!(clave in COLORES_MARCADOR)) {
    throw new Error(
      `Color de marcador desconocido: "${valor}". Hay: ` +
      Object.keys(COLORES_MARCADOR).join(", ") + " — o el índice directo."
    );
  }
  return COLORES_MARCADOR[clave];
}

function nombreDeColor(indice) {
  for (const k of ["verde", "rojo", "magenta", "naranja", "amarillo", "azul", "cyan"]) {
    if (COLORES_MARCADOR[k] === indice) return k;
  }
  return "índice " + indice;
}

/** Saca un marcador por nombre, o todos los que coincidan. */
async function desmarcar(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  /*
   * SOBRE LA SECUENCIA O SOBRE UN CLIP.
   *
   * Sin esto sólo se podían sacar los de la secuencia, y `cortesDeEscena` en modo
   * `marcar` crea marcadores de CLIP: un verbo que los pone sin forma de sacarlos
   * es una trampa, no una función. Peor, el resumen de ese verbo decía "se sacan
   * con premiere_desmarcar" — una promesa que no se había verificado.
   *
   * Por defecto sigue siendo la secuencia, así que nada de lo que ya funcionaba
   * cambia de comportamiento.
   */
  let sujeto = sequence, dondeEsta = `la secuencia "${sequence.name}"`;
  if (params.clip || params.pista !== undefined) {
    const donde = await ubicarClip(sequence, {
      nombre: params.clip || params.nombre, pista: params.pista, indice: params.indice
    });
    /*
     * EL SUJETO ES EL MEDIO, no el TrackItem.
     *
     * `Markers.getMarkers(trackItem)` contesta "Invalid parameter." —tipos bien,
     * valor mal— y los marcadores que crea la detección de escenas viven en el
     * ClipProjectItem. Consecuencia que importa al usarlos: son del MATERIAL, así
     * que se ven en toda instancia de ese medio, no sólo en el clip que se analizó.
     *
     * Se prueban los dos y se informa cuál contestó, porque "marcador de clip" en
     * esta API puede significar cualquiera de los dos y no está documentado.
     */
    const candidatos = [];
    try {
      const ci = ppro.ClipProjectItem.cast(await donde.clip.getProjectItem());
      if (ci) candidatos.push(["el medio de \"" + donde.nombre + "\"", ci]);
    } catch (e) { /* sigue con el TrackItem */ }
    candidatos.push([`el clip "${donde.nombre}" (${donde.pista})`, donde.clip]);
    let porQue = [];
    for (const [comoSeLlama, cand] of candidatos) {
      try {
        const c = await ppro.Markers.getMarkers(cand);
        const l = await c.getMarkers();
        if (l) { sujeto = cand; dondeEsta = comoSeLlama; porQue = null; break; }
      } catch (e) { porQue.push(comoSeLlama + ": " + (e && e.message ? e.message : e)); }
    }
    if (porQue) {
      throw new Error(`No se pudo leer los marcadores de "${donde.nombre}". ${porQue.join(" | ")}.`);
    }
  }
  const col = await ppro.Markers.getMarkers(sujeto);
  const lista = await col.getMarkers();

  const q = String(params.nombre || "").toLowerCase();
  const objetivos = [];
  const vistos = [];
  for (let i = 0; i < lista.length; i++) {
    const n = String(await lista[i].getName());
    vistos.push(n);
    if (params.todos || (q && n.toLowerCase().indexOf(q) !== -1)) objetivos.push(lista[i]);
  }
  if (!objetivos.length) {
    throw new Error(
      `No hay marcadores en ${dondeEsta} que coincidan con "${params.nombre}". ` +
      `Hay ${vistos.length}: ${vistos.slice(0, 25).join(", ") || "ninguno"}${vistos.length > 25 ? "…" : ""}.`
    );
  }

  project.lockedAccess(() => {
    project.executeTransaction((a) => {
      for (let i = 0; i < objetivos.length; i++) a.addAction(col.createRemoveMarkerAction(objetivos[i]));
    }, "sacar marcadores");
  });

  /*
   * SE RECUENTA SOBRE `sujeto`, NO SOBRE `sequence`.
   *
   * Decía `getMarkers(sequence)` clavado, así que sacando los marcadores de un
   * MEDIO comparaba `lista.length` —los del medio— contra los de la SECUENCIA:
   * dos poblaciones distintas. Un clip con 3 marcadores en una secuencia que
   * tiene 10 informaba "3 → 10 marcadores · NO SE SACÓ NINGUNO" sobre un borrado
   * que SÍ ocurrió, y devolvía `sacados: -7`. El número negativo es la firma.
   *
   * Es el contador ciego de `cortesDeEscena` en un verbo DESTRUCTIVO, y es el
   * peor lugar: un falso "no saqué nada" invita a repetir la operación. El
   * comentario de acá abajo prueba que el sujeto equivocado ya se había
   * arreglado en el NOMBRE y nadie miró el CONTEO — una regla aplicada a medias
   * adentro del mismo verbo.
   */
  const quedan = (await (await ppro.Markers.getMarkers(sujeto)).getMarkers()).length;
  return {
    resumen:
      // Nombra el sujeto REAL. Decía `sequence.name` siempre, así que limpiando los
      // marcadores de un medio informaba "en HORIZONTAL FHD" — el lugar equivocado
      // en un verbo destructivo, que es el peor lugar para un informe impreciso.
      `${lista.length} → ${quedan} marcadores en ${dondeEsta}` +
      ` (se apuntó a ${objetivos.length})` +
      (quedan < lista.length ? "" : " · NO SE SACÓ NINGUNO"),
    sujeto: dondeEsta,
    sacados: lista.length - quedan,
    quedan: quedan
  };
}

/**
 * Revisa la secuencia entera y devuelve lo que quedó MAL. Solo lee.
 *
 * Por qué existe: cada verbo se verifica a sí mismo, pero nadie verifica el
 * resultado COMBINADO de una tanda. Y la verificación simétrica se confirma
 * sola — que un verbo diga "reparado" no prueba que la secuencia esté sana.
 * Este es el chequeo de afuera, y es el que encontró los tres huecos de un
 * frame en el audio del M4 que ningún verbo había informado.
 *
 * Los cuatro chequeos son inequívocos a propósito: nada de heurísticas que
 * llenen de falsos positivos. Cada uno corresponde a un daño que ya pasó.
 */
/*
 * La "firma" de Motion de un clip: escala, posición y si está animado.
 *
 * Sirve para decidir si un corte tiene razón de ser. Un corte donde los dos
 * lados quedan con distinto Motion es DELIBERADO —así se hace la alternancia de
 * escalas del curso— y unirlo destruiría el escalado. Sin esto, `revisar`
 * marcaba 34 juntas "removibles" en un módulo y ninguna lo era.
 *
 * Devuelve null si no se pudo leer, y ahí el que llama decide no opinar.
 */
async function firmaMotion(project, clip) {
  try {
    const motion = await getComponente(clip, "Motion");
    if (!motion) return null;
    const cual = getParametro(project, motion, "Scale") ? "Scale" : "Scale Height";
    const pEsc = getParametro(project, motion, cual);
    const pPos = getParametro(project, motion, "Position");
    if (!pEsc && !pPos) return null;
    const enIn = await clip.getInPoint();
    const esc = pEsc ? aNumero(await valorEnTiempo(project, pEsc, enIn)) : null;
    const pos = pPos ? aPunto(await valorEnTiempo(project, pPos, enIn)) : null;
    const kf = (pEsc ? contarKeyframes(project, pEsc) : 0) + (pPos ? contarKeyframes(project, pPos) : 0);
    return [
      esc === null ? "?" : Number(esc).toFixed(2),
      pos ? Number(pos.x).toFixed(4) + "," + Number(pos.y).toFixed(4) : "?",
      "kf" + kf
    ].join("|");
  } catch (e) { return null; }
}

async function revisar(params) {
  const { project, sequence } = await getProyectoYSecuencia();

  /*
   * `getTimebase()` son los TICKS POR FRAME. Medido el 2026-08-16 arreglando los
   * huecos de `cortar`: la aritmética entera con este número cuantiza bien, y
   * `alignToNearestFrame` contesta "Illegal Parameter type".
   *
   * Los huecos se informan en FRAMES y no en milisegundos porque "20ms" no dice
   * nada y "1 frame" sí — y el mismo hueco es 1 frame a 50fps y medio a 25.
   */
  let tpf = null;
  try { tpf = Number(await sequence.getTimebase()); } catch (e) { tpf = null; }
  if (!isFinite(tpf) || tpf <= 0) tpf = null;
  const enFrames = (ticks) => (tpf ? Number((ticks / tpf).toFixed(2)) : null);
  const enSeg = (ticks) => Number((ticks / TICKS_POR_SEGUNDO).toFixed(3));
  const mmss = (ticks) => {
    const s = ticks / TICKS_POR_SEGUNDO;
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  };

  // Qué cuenta como hueco "chico", es decir sospechoso de ser un corte entre
  // frames y no algo que el usuario dejó a propósito.
  const topeFrames = typeof params.topeFrames === "number" ? params.topeFrames : 2;

  const grupos = [
    { letra: "V", cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i) },
    { letra: "A", cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i) }
  ];
  const pedido = params.pista ? String(params.pista).toUpperCase() : null;

  const pistas = [];
  let ceros = 0, solapes = 0, huecosChicos = 0, huecosGrandes = 0, juntas = 0, deliberados = 0;

  for (const g of grupos) {
    for (let t = 0; t < g.cuantas; t++) {
      const etiqueta = g.letra + (t + 1);
      if (pedido && etiqueta !== pedido) continue;
      const track = await g.traer(t);
      if (!track) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      if (!items.length) continue;

      const l = [];
      for (let i = 0; i < items.length; i++) {
        let entrada = null;
        try { entrada = Number((await items[i].getInPoint()).ticks); } catch (e) { entrada = null; }
        l.push({
          indice: i,
          nombre: String(await items[i].getName()),
          ini: Number((await items[i].getStartTime()).ticks),
          fin: Number((await items[i].getEndTime()).ticks),
          entrada: entrada
        });
      }
      l.sort((a, b) => a.ini - b.ini);

      const info = {
        pista: etiqueta, clips: l.length,
        ceros: [], solapes: [], huecos: [], juntas: [], cortesConMotionDistinto: 0
      };
      // La firma de Motion se lee solo para los candidatos y se cachea: cada
      // clip aparece en dos pares como mucho, y no hace falta para el resto.
      const firmas = {};
      const firmaDe = async (i) => {
        if (!(i in firmas)) firmas[i] = g.letra === "V" ? await firmaMotion(project, items[l[i].indice]) : null;
        return firmas[i];
      };

      for (const c of l) {
        // Duración cero: el residuo del vinculado que recibía un punto de fuente
        // que no era el suyo. Premiere los acepta y no se ven en el timeline.
        if (c.fin - c.ini < 1) info.ceros.push({ en: mmss(c.ini), segundos: enSeg(c.ini), nombre: c.nombre });
      }

      for (let i = 1; i < l.length; i++) {
        const a = l[i - 1], b = l[i];
        const d = b.ini - a.fin;
        if (d < -1) {
          info.solapes.push({ en: mmss(b.ini), segundos: enSeg(b.ini), frames: enFrames(-d) });
        } else if (d > 1) {
          info.huecos.push({ en: mmss(a.fin), segundos: enSeg(a.fin), frames: enFrames(d) });
        } else if (
          // Junta removible: pegados, mismo medio y CONTINUOS en el material —
          // o sea un corte que no corta nada. Es lo que deja una reparación de
          // audio, y se limpia con `unirAudio`.
          a.nombre === b.nombre && a.entrada !== null && b.entrada !== null &&
          Math.abs(a.entrada + (a.fin - a.ini) - b.entrada) < 1
        ) {
          /*
           * Pero en VIDEO un corte así puede ser deliberado: la alternancia de
           * escalas parte un clip justo para darle otro Motion a cada mitad, y
           * eso es continuo en el material por definición. Unirlo destruiría el
           * escalado. Así que solo cuenta como removible si los dos lados tienen
           * la MISMA firma de Motion.
           *
           * Si no se pudo leer la firma, no se opina: se lo trata como
           * deliberado. Un falso negativo deja una junta sin limpiar; un falso
           * positivo invita a romper el escalado.
           */
          let removible = true;
          if (g.letra === "V") {
            const fa = await firmaDe(i - 1), fb = await firmaDe(i);
            removible = fa !== null && fb !== null && fa === fb;
          }
          if (removible) info.juntas.push({ en: mmss(b.ini), segundos: enSeg(b.ini), nombre: b.nombre });
          else info.cortesConMotionDistinto++;
        }
      }

      const chicos = info.huecos.filter((h) => h.frames !== null && h.frames <= topeFrames);
      info.huecosChicos = chicos.length;
      info.huecosGrandes = info.huecos.length - chicos.length;
      ceros += info.ceros.length;
      solapes += info.solapes.length;
      huecosChicos += chicos.length;
      huecosGrandes += info.huecosGrandes;
      juntas += info.juntas.length;
      deliberados += info.cortesConMotionDistinto;
      pistas.push(info);
    }
  }

  const partes = [];
  if (ceros) partes.push(`${ceros} clip(s) de DURACIÓN CERO`);
  if (solapes) partes.push(`${solapes} solape(s)`);
  if (huecosChicos) partes.push(`${huecosChicos} hueco(s) de hasta ${topeFrames} frame(s)`);
  if (juntas) partes.push(`${juntas} junta(s) removible(s)`);

  const detalle = pistas
    .filter((p) => p.ceros.length || p.solapes.length || p.huecosChicos || p.juntas.length)
    .map((p) => {
      const q = [];
      if (p.ceros.length) q.push(`CERO en ${p.ceros.map((x) => x.en).join(", ")}`);
      if (p.solapes.length) q.push(`solapes en ${p.solapes.map((x) => `${x.en} (${x.frames}f)`).join(", ")}`);
      const chicos = p.huecos.filter((h) => h.frames !== null && h.frames <= topeFrames);
      if (chicos.length) q.push(`huecos en ${chicos.map((x) => `${x.en} (${x.frames}f)`).join(", ")}`);
      if (p.juntas.length) q.push(`${p.juntas.length} junta(s) en ${p.juntas.slice(0, 6).map((x) => x.en).join(", ")}`);
      return `${p.pista}: ${q.join(" · ")}`;
    });

  return {
    resumen:
      `"${sequence.name}"${pedido ? ` (solo ${pedido})` : ""}: ` +
      (partes.length ? `${partes.join(" · ")}` : "sin problemas") +
      ` · ${pistas.length} pista(s) con contenido, ${pistas.reduce((n, p) => n + p.clips, 0)} clips` +
      (huecosGrandes ? ` · ${huecosGrandes} hueco(s) grande(s), probablemente a propósito` : "") +
      (deliberados ? ` · ${deliberados} corte(s) de video continuos pero con distinto Motion: son deliberados, NO unir` : "") +
      (tpf === null ? " · OJO: no se pudo leer el timebase, los huecos van sin medir en frames" : "") +
      (detalle.length ? `\n  ${detalle.join("\n  ")}` : ""),
    secuencia: sequence.name,
    ticksPorFrame: tpf,
    topeFrames: topeFrames,
    ceros: ceros, solapes: solapes,
    huecosChicos: huecosChicos, huecosGrandes: huecosGrandes,
    juntasRemovibles: juntas,
    cortesDeliberados: deliberados,
    pistas: pistas
  };
}

/**
 * Inyecta una transcripción hecha AFUERA de Premiere en un medio del panel.
 *
 * `ppro.Transcript` expone `importFromJSON` —el inverso de `exportToJSON`— así
 * que una transcripción de Whisper puede quedar visible en el panel Text, con
 * búsqueda de palabras y salto del playhead. El JSON se arma con
 * `herramientas/audio.js`, que ya lo emite en este esquema.
 *
 * ESTADO AL 2026-08-18: NO IMPORTA. El espacio está cerrado, no es falta de
 * ideas. `TextSegments` reflejado no tiene fábrica ni constructor —sólo los dos
 * JSON, sin propiedades de instancia— y no existe una clase `TextSegment`, así
 * que la única entrada posible es un string. El esquema no es la sospecha: lo
 * emite `herramientas/audio.js` copiado de un export real de Premiere, y
 * `TextSegments.exportToJSON` sobre el parseado igual devuelve vacío.
 *
 * Y el MCP de terceros que dice tenerlo (leancoderkavy, `import_transcript_uxp`)
 * usa EXACTAMENTE la combinación que acá se midió como fallida
 * —`Transcript.importFromJSON` + `createImportTextSegmentsAction`— y su propio
 * manifiesto dice `liveHostVerificationStatus: "not_run"`: nunca lo corrieron
 * contra Premiere. Su dispatcher igual informa `verified` con la sola condición
 * de que la transacción devuelva true, que es el modo de fallar nº1 de
 * CLAUDE.md. No hay nada que copiarles.
 *
 * LA CAUSA ESTÁ IDENTIFICADA (2026-08-18): `Transcript.importFromJSON` devuelve
 * un CASCARÓN. El `TextSegments` no tiene una sola propiedad propia y su puntero
 * interno es null: `TextSegments.exportToJSON(segs)` contesta "A nullptr was
 * dereferenced.".
 *
 * Probado con el JSON que PREMIERE MISMO exportó de un clip transcripto por
 * Adobe, así que el esquema es idéntico y el GUID del speaker es real — eso mató
 * la última hipótesis, que era el `00000000-…-0001` inventado por `audio.js`.
 *
 * Es un bug de la API, no nuestro, y explica los dos síntomas: la acción dice
 * "Invalid parameter." porque el valor envuelve null, y con los argumentos al
 * revés committea `true` sobre la nada.
 *
 * NO llamar `TextSegments.exportToJSON` sobre un parseado fuera de este
 * diagnóstico: dereferencia un nullptr, la misma familia del `getKeyframePtr`
 * que tiró Premiere con SIGBUS.
 *
 * Mientras siga así, el camino que SÍ funciona es el SRT de `audio.js` por
 * `File > Import`: entra como pista de subtítulos, que no es una transcripción
 * pero da el texto en el timeline.
 *
 * La firma no está documentada y la aridad de esta API miente, así que se
 * enumeran las formas plausibles. Y la prueba de cuál sirvió NO es que la llamada
 * no tire: es que `hasTranscript` pase de false a true y que lo que se relee
 * tenga la misma cantidad de palabras que lo que se mandó.
 */
async function importarTranscripcion(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (!params.medio) throw new Error("Falta `medio`: el nombre del medio del panel de proyecto.");
  if (!params.json && !params.desdeMedio) throw new Error("Falta `json` (o `desdeMedio` para copiar el de otro medio).");

  /*
   * `desdeMedio` toma el JSON que Premiere EXPORTÓ de otro medio, en vez del que
   * armamos nosotros. Sirve para aislar dos variables que se confunden: si esto
   * tampoco importa, el problema es el mecanismo o el destino; si esto importa y
   * el nuestro no, el problema es nuestro JSON.
   */
  if (params.desdeMedio) {
    const otro = await buscarMedio(project, params.desdeMedio);
    if (!otro) throw new Error(`No se encontró el medio "${params.desdeMedio}" para copiarle la transcripción.`);
    const otroClip = ppro.ClipProjectItem.cast(otro);
    const crudo = await ppro.Transcript.exportToJSON(otroClip);
    params.json = typeof crudo === "string" ? crudo : JSON.stringify(crudo);
  }
  const datos = typeof params.json === "string" ? JSON.parse(params.json) : params.json;
  const texto = JSON.stringify(datos);
  const cuantasMandadas = (datos.segments || []).reduce((n, s) => n + (s.words || []).length, 0);
  if (!cuantasMandadas) throw new Error("El JSON no trae palabras: se esperan `segments[].words[]`.");

  const encontrado = await buscarMedio(project, params.medio);
  if (!encontrado) throw new Error(`No se encontró el medio "${params.medio}" en el panel de proyecto.`);
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(encontrado); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${String(encontrado.name)}" a ClipProjectItem.`);

  let antes = null;
  try { antes = !!(await ppro.Transcript.hasTranscript(clipItem)); } catch (e) { antes = null; }

  /*
   * Las formas plausibles, y el orden importa poco porque se prueban todas hasta
   * que UNA deje la transcripción puesta.
   *
   * Medido en la primera vuelta: `(clipItem, string)`, `(clipItem, objeto)` y
   * `(clipItem)` contestan "Illegal Parameter type", y `(string, clipItem)` no
   * tira pero tampoco importa nada. Así que el contenido del JSON no es lo que
   * espera — de ahí las variantes con RUTA y la vía transaccional de
   * `createImportTextSegmentsAction`, que existe y reporta aridad 2.
   */
  const ruta = params.ruta ? String(params.ruta) : null;

  /*
   * HAY DOS `importFromJSON`, y ahí estuvo el error durante trece intentos:
   * `Transcript.importFromJSON` y `TextSegments.importFromJSON`. Se venía
   * llamando al de `Transcript`, que devuelve un objeto que
   * `createImportTextSegmentsAction` rechaza con "Invalid parameter." — tipos
   * bien, valor mal, o sea el objeto de la fábrica equivocada.
   */
  const conSegments = (fabrica, orden) => () => {
    const segs = fabrica();
    if (!segs) throw new Error("no devolvió TextSegments");
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(orden === "clipPrimero"
          ? ppro.Transcript.createImportTextSegmentsAction(clipItem, segs)
          : ppro.Transcript.createImportTextSegmentsAction(segs, clipItem));
      }, "importar la transcripción");
    });
    if (!ok) throw new Error("executeTransaction devolvió false");
    return ok;
  };

  /*
   * `TextSegments.importFromJSON(json)` contesta "Not Enough Parameters": quiere
   * un segundo argumento y no se sabe cuál. Se prueban los candidatos razonables
   * y se mira qué devuelve cada uno.
   */
  const segundos = [
    ["clipItem", () => clipItem],
    ["idioma", () => String(datos.language || "es-es")],
    ["secuencia", () => sequence],
    ["speakers", () => datos.speakers],
    ["null", () => null]
  ];
  const formas = [];

  /*
   * EL DIAGNÓSTICO DECISIVO, antes de seguir probando firmas.
   *
   * La documentación confirma `createImportTextSegmentsAction(textSegments,
   * clipProjectItem)`, que es la forma que committea y no hace nada. Así que la
   * pregunta ya no es la firma: es si el `TextSegments` que devuelve el parser
   * está POBLADO. `TextSegments.exportToJSON` existe y es el único modo de
   * mirarlo — el objeto no expone ninguna propiedad.
   *
   * Vacío ⇒ el JSON tiene la forma mal. Poblado ⇒ la acción de Premiere no
   * aplica, y no hay nada que hacer del lado del bridge.
   */
  /*
   * OJO CON LEER ESTE DIAGNÓSTICO. La primera versión sobreescribía el nombre de
   * la vía en cada vuelta, así que si las dos lecturas tiraban se perdía el primer
   * error y quedaba `leido` sin asignar — y lo informaba como
   * "devolvió 4 caracteres: null", que parece la medición del TextSegments y es
   * `JSON.stringify(null)` de una variable vacía. Es el modo de fallar nº1 del
   * repo cometido adentro del código que venía a evitarlo. Ahora distingue
   * "leyó null" de "no se pudo leer" y guarda TODAS las vías.
   */
  formas.push(["DIAGNÓSTICO: ¿el TextSegments quedó poblado?", async () => {
    const segs = ppro.Transcript.importFromJSON(texto);
    const vias = [];
    let leido, huboLectura = false;
    for (const [nombre, fn] of [
      ["TextSegments.exportToJSON(segs)", () => ppro.TextSegments.exportToJSON(segs)],
      ["Transcript.exportToJSON(segs)", () => ppro.Transcript.exportToJSON(segs)],
      ["segs.exportToJSON()", () => segs.exportToJSON()]
    ]) {
      try { leido = await fn(); huboLectura = true; vias.push(nombre + " → LEYÓ"); break; }
      catch (e) { vias.push(nombre + " tiró: " + (e && e.message ? e.message : e)); }
    }
    const txt = typeof leido === "string" ? leido : JSON.stringify(leido);
    throw new Error(
      "DIAGNÓSTICO (no es un fallo de importación): " +
      (huboLectura
        ? `el TextSegments SE PUDO LEER y devolvió ${txt === undefined ? "undefined" : (txt || "").length + " caracteres"} · arranca con: ${String(txt).slice(0, 300)}`
        : "NINGUNA vía pudo leer el TextSegments, así que NO se sabe si está poblado") +
      ` · vías: ${vias.join(" | ")} · lo que devolvió importFromJSON: ${describir(segs)}`
    );
  }]);

  /*
   * El orden INVERSO en `TextSegments`, que es lo que el patrón de errores
   * sugiere: con un argumento dice "Not Enough Parameters" y con dos dice
   * "Illegal Parameter type", así que el string tampoco va primero ahí. Si el
   * destino va primero, este es el parser de verdad.
   */
  for (const [comoSeLlama, dame] of [["clipItem", () => clipItem], ["secuencia", () => sequence]]) {
    formas.push([`TextSegments.importFromJSON(${comoSeLlama}, json) SOLO`,
      () => ppro.TextSegments.importFromJSON(dame(), texto)]);
    formas.push([`TextSegments.importFromJSON(${comoSeLlama}, json) → (clipItem, segs)`,
      conSegments(() => ppro.TextSegments.importFromJSON(dame(), texto), "clipPrimero")]);
    formas.push([`TextSegments.importFromJSON(${comoSeLlama}, objeto) SOLO`,
      () => ppro.TextSegments.importFromJSON(dame(), datos)]);
  }

  for (const [comoSeLlama, dame] of segundos) {
    formas.push([`TextSegments.importFromJSON(json, ${comoSeLlama}) SOLO`,
      () => ppro.TextSegments.importFromJSON(texto, dame())]);
    formas.push([`TextSegments.importFromJSON(json, ${comoSeLlama}) → (clipItem, segs)`,
      conSegments(() => ppro.TextSegments.importFromJSON(texto, dame()), "clipPrimero")]);
  }

  /*
   * Y la otra mitad de la duda: quizá el "Invalid parameter." se queja del PRIMER
   * argumento y no del TextSegments. El Import del panel opera sobre secuencia o
   * sobre clip, así que la acción puede querer una secuencia.
   */
  formas.push([`Transcript.importFromJSON → createImportTextSegmentsAction(SECUENCIA, segs)`, () => {
    const segs = ppro.Transcript.importFromJSON(texto);
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(ppro.Transcript.createImportTextSegmentsAction(sequence, segs));
      }, "importar la transcripción");
    });
    if (!ok) throw new Error("executeTransaction devolvió false");
    return ok;
  }]);

  formas.push(
    /*
     * La cadena que se creía correcta, y el nombre del método engaña.
     *
     * `importFromJSON` no importa nada: es un PARSER. Recibe el JSON como string
     * —y sólo como string: pasarle una ruta contesta "Failed to parse input
     * string into JSON", que es lo que delató el argumento— y devuelve un objeto
     * `TextSegments`. Eso se descubrió mirando lo que la llamada DEVUELVE, porque
     * no tiraba error y tampoco hacía nada.
     *
     * El que importa de verdad es `createImportTextSegmentsAction(clipItem,
     * TextSegments)` dentro de una transacción. Pasarle el array de segmentos
     * crudo contesta "Illegal Parameter type": quiere el objeto, no los datos.
     */
    ["importFromJSON(json) → createImportTextSegmentsAction(clipItem, TextSegments)", () => {
      const segs = ppro.Transcript.importFromJSON(texto);
      if (!segs) throw new Error("importFromJSON no devolvió TextSegments");
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => {
          a.addAction(ppro.Transcript.createImportTextSegmentsAction(clipItem, segs));
        }, "importar la transcripción");
      });
      if (!ok) throw new Error("executeTransaction devolvió false");
      return ok;
    }],
    ["TextSegments.importFromJSON(json) SOLO, para ver qué devuelve", () => ppro.TextSegments.importFromJSON(texto)],
    ["idem con los argumentos al revés", () => {
      const segs = ppro.Transcript.importFromJSON(texto);
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => {
          a.addAction(ppro.Transcript.createImportTextSegmentsAction(segs, clipItem));
        }, "importar la transcripción");
      });
      if (!ok) throw new Error("executeTransaction devolvió false");
      return ok;
    }],
    ["(clipItem, string)", () => ppro.Transcript.importFromJSON(clipItem, texto)],
    ["(clipItem, objeto)", () => ppro.Transcript.importFromJSON(clipItem, datos)],
    ["(string, clipItem)", () => ppro.Transcript.importFromJSON(texto, clipItem)],
    ["(clipItem)", () => ppro.Transcript.importFromJSON(clipItem)],
    ["(projectItem sin castear, string)", () => ppro.Transcript.importFromJSON(encontrado, texto)]
  );
  if (ruta) {
    formas.push(
      ["(clipItem, RUTA)", () => ppro.Transcript.importFromJSON(clipItem, ruta)],
      ["(RUTA, clipItem)", () => ppro.Transcript.importFromJSON(ruta, clipItem)],
      ["(RUTA)", () => ppro.Transcript.importFromJSON(ruta)]
    );
  }
  // Dentro de lockedAccess: varios métodos de esta API solo andan ahí.
  formas.push(["(SOLO el json)", () => ppro.Transcript.importFromJSON(texto)]);
  formas.push(["(clipItem, string) dentro de lockedAccess", () => {
    let r = null;
    project.lockedAccess(() => { r = ppro.Transcript.importFromJSON(clipItem, texto); });
    return r;
  }]);
  // Y la vía transaccional, que es el patrón normal para escribir en esta API.
  formas.push(["createImportTextSegmentsAction(clipItem, segments) en transacción", () => {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(ppro.Transcript.createImportTextSegmentsAction(clipItem, datos.segments));
      }, "importar la transcripción");
    });
    if (!ok) throw new Error("executeTransaction devolvió false");
    return ok;
  }]);
  formas.push(["createImportTextSegmentsAction(clipItem, JSON entero) en transacción", () => {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(ppro.Transcript.createImportTextSegmentsAction(clipItem, datos));
      }, "importar la transcripción");
    });
    if (!ok) throw new Error("executeTransaction devolvió false");
    return ok;
  }]);

  /*
   * Y se MIRA lo que devuelve cada forma, no sólo si tiró.
   *
   * Medido: con el JSON como primer argumento la llamada NO tira —el error
   * "Failed to parse input string into JSON" al pasarle una ruta prueba que el
   * primer argumento es el contenido— pero tampoco importa nada. Así que lo que
   * devuelve es la pista que falta: si es una Action, hay que meterla en una
   * transacción, que es el patrón del resto de esta API.
   */
  const describir = (v) => {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    const t = typeof v;
    if (t !== "object") return `${t} ${String(v).slice(0, 60)}`;
    let ctor = "?";
    try { ctor = v.constructor && v.constructor.name ? v.constructor.name : "sin constructor"; } catch (e) { ctor = "?"; }
    let claves = [];
    try { claves = Object.getOwnPropertyNames(v).slice(0, 12); } catch (e) { claves = []; }
    let proto = [];
    try { proto = Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).slice(0, 14); } catch (e) { proto = []; }
    return `objeto ${ctor} · propias [${claves.join(", ")}] · proto [${proto.join(", ")}]`;
  };

  const intentos = [];
  const devoluciones = [];
  let via = null, cuantasQuedaron = null;

  /*
   * ESPACIADAS 1,2s, y no es prolijidad: una decena de estas formas committea una
   * transacción, y encadenar transacciones tira Premiere con SIGSEGV — medido,
   * 200ms lo tira y 1200ms no (ver CLAUDE.md). Este bucle es el peor caso posible
   * del patrón: ~10 transacciones en menos de un segundo. La sonda tarda medio
   * minuto y no se cae, que es el intercambio correcto para algo que corre una vez.
   */
  const esperar = (ms) => new Promise((res) => setTimeout(res, ms));
  let primera = true;
  /*
   * POR DEFECTO corre SÓLO el diagnóstico, que lee y no committea. Barrer las 30
   * formas cuesta ~10 transacciones sobre el proyecto abierto y 36 segundos —más
   * que el timeout de 30s del transporte, así que la respuesta queda huérfana en
   * `intercambio/`— y ya no hay hipótesis que probar: el parser devuelve null.
   * Con `todasLasFormas: true` se barre igual, si algún día cambia la API.
   */
  const aProbar = params.todasLasFormas === true ? formas : formas.slice(0, 1);
  for (const [nombre, fn] of aProbar) {
    if (!primera) await esperar(1200);
    primera = false;
    let devuelto;
    try { devuelto = await fn(); } catch (e) { intentos.push(`${nombre}: ${e && e.message ? e.message : e}`); continue; }
    devoluciones.push(`${nombre} → ${describir(devuelto)}`);
    let hay = false, n = 0;
    try {
      hay = !!(await ppro.Transcript.hasTranscript(clipItem));
      if (hay) {
        const crudo = await ppro.Transcript.exportToJSON(clipItem);
        const leido = typeof crudo === "string" ? JSON.parse(crudo) : crudo;
        n = (leido.segments || []).reduce((a, s) => a + (s.words || []).length, 0);
      }
    } catch (e) { intentos.push(`${nombre}: no tiró, pero releer falló: ${e && e.message ? e.message : e}`); continue; }
    if (!hay) { intentos.push(`${nombre}: no tiró y sigue sin transcripción`); continue; }
    if (Math.abs(n - cuantasMandadas) > Math.max(2, cuantasMandadas * 0.02)) {
      intentos.push(`${nombre}: quedó con ${n} palabras y se mandaron ${cuantasMandadas}`);
      continue;
    }
    via = nombre; cuantasQuedaron = n;
    break;
  }

  if (!via) {
    throw new Error(
      `No se pudo importar la transcripción a "${String(encontrado.name)}". ` +
      `Intentos: ${intentos.join(" | ")}.` +
      (devoluciones.length ? ` DEVOLVIERON: ${devoluciones.join(" | ")}.` : "")
    );
  }

  return {
    resumen:
      `Transcripción importada a "${String(encontrado.name)}": ` +
      `tenía ${antes === null ? "?" : antes ? "una" : "ninguna"} → ahora ${cuantasQuedaron} palabras ` +
      `(se mandaron ${cuantasMandadas}) · vía ${via}` +
      (intentos.length ? ` · formas que no sirvieron: ${intentos.length}` : "") +
      " · MIRALO en el panel Text de Premiere: eso es la verificación de verdad",
    medio: String(encontrado.name),
    teniaAntes: antes,
    palabrasMandadas: cuantasMandadas,
    palabrasQuedaron: cuantasQuedaron,
    via: via,
    intentos: intentos
  };
}

/**
 * Importa archivos al panel de proyecto.
 *
 * `Project.importFiles` existía desde siempre y ningún verbo lo usaba, así que
 * desde el bridge no se podía arrancar un trabajo: había que importar a mano
 * antes de que el bridge sirviera para algo.
 *
 * NO necesita secuencia activa, y eso es el punto: en un proyecto recién creado
 * esto es lo primero que se hace.
 *
 * Devuelve cuántos medios había antes y después, y CUÁLES entraron — no un
 * booleano. Si un archivo no se pudo importar, el conteo lo delata.
 */
async function importar(params) {
  const project = await getProyecto();

  let rutas = params.archivos;
  if (typeof rutas === "string") rutas = [rutas];
  if (!Array.isArray(rutas) || !rutas.length) {
    throw new Error("Falta `archivos`: una ruta o una lista de rutas absolutas.");
  }

  /*
   * Recorre con `hijosDe` y NO con `getItems()` a secas.
   *
   * Un bin creado con `createBinAction` no contesta `getItems()` directo: hay que
   * castearlo a FolderItem primero, que es exactamente para lo que existe
   * `hijosDe`. Llamándolo a secas el recorrido no entraba a ningún bin, así que
   * apenas los medios pasaron a vivir en bins este verbo quedó CIEGO y empezó a
   * informar "no está ninguno de los pedidos" con los medios ahí.
   *
   * Costó dos diagnósticos equivocados —primero el reintento, después el
   * conteo— porque el síntoma es el mismo y los dos eran defectos reales. La
   * pista que lo resolvió fue que `bins`, que sí usa `hijosDe`, contaba 8 medios
   * en el mismo bin donde éste no veía ninguno.
   */
  const nombresDe = async () => {
    const salida = [];
    const raiz = await project.getRootItem();
    const pendientes = [raiz];
    while (pendientes.length) {
      const it = pendientes.pop();
      for (const h of (await hijosDe(it)) || []) {
        salida.push(String(h.name));
        if ((await hijosDe(h)) !== null) pendientes.push(h);
      }
    }
    return salida;
  };

  const antes = await nombresDe();

  /*
   * La aridad de `importFiles` no es confiable —como en todo este repo— así que
   * se prueban las formas plausibles. `suppressUI` en true evita que Premiere
   * abra diálogos que colgarían el panel esperando un clic que nadie va a dar.
   */
  const intentos = [];
  let via = null;
  /*
   * OJO con el bin: `getRootItem()` es ASYNC. La primera versión lo pasaba sin
   * `await`, así que `importFiles` recibía una Promise y contestaba "Illegal
   * Parameter type" — y como la forma de dos argumentos sí andaba, el verbo
   * importaba bien a la raíz y el fallo del bin parecía una limitación de la API.
   * Lo era de mi llamada.
   */
  /*
   * NO se le pide a Premiere lo que ya está: `importFiles` no deduplica, crea otro
   * ProjectItem del mismo archivo. Medido el 2026-08-17 sobre este proyecto: siete
   * medios duplicados, dos de ellos CUATRO veces, por llamar al verbo en cada
   * corrida de un script que rearmaba las secuencias.
   *
   * El duplicado no rompe nada visible —las secuencias siguen apuntando a su
   * instancia— y por eso pasó desapercibido hasta contar los nombres.
   */
  const yaEnProyecto = new Set(antes);
  const porImportar = rutas.filter((r) => !yaEnProyecto.has(String(r).split(/[\\/]/).pop()));
  const salteados = rutas.length - porImportar.length;

  const destino = params.bin ? await asegurarBin(project, String(params.bin)) : await project.getRootItem();
  /*
   * Si se pidió un bin, las formas SIN bin van igual como último recurso —pero
   * después se mueve y se informa qué pasó. Antes esto caía a la de dos
   * argumentos, importaba a la raíz y no lo decía: el bin se ignoraba en
   * silencio, que es el modo de fallar nº1.
   */
  const formas = [
    ["(rutas, suppressUI, bin, comoNumbered)", () => project.importFiles(porImportar, true, destino, false)],
    ["(rutas, suppressUI, bin)", () => project.importFiles(porImportar, true, destino)],
    ["(rutas, suppressUI)", () => project.importFiles(porImportar, true)],
    ["(rutas)", () => project.importFiles(porImportar)]
  ];
  if (!porImportar.length) {
    via = "no se llamó: ya estaban todos";
  } else {
    for (const [nombre, fn] of formas) {
      try { await fn(); via = nombre; break; }
      catch (e) { intentos.push(`${nombre}: ${e && e.message ? e.message : e}`); }
    }
  }

  /*
   * La pregunta correcta es **si están los archivos pedidos**, no si creció el
   * total. Contando el total, "ya estaban" se informaba como fracaso: rearmando
   * las secuencias sobre medios ya importados, el verbo tiró "no entró ningún
   * medio de los 2 pedidos" con los dos en su bin. Medido el 2026-08-17.
   *
   * Y se reintenta, porque `importFiles` vuelve antes de que los medios aparezcan
   * en el panel: una sola lectura también daba cero con la importación andando.
   * Son dos causas distintas del mismo informe falso y hacían falta las dos.
   */
  const pedidos = [...new Set(rutas.map((r) => String(r).split(/[\\/]/).pop()))];
  const faltabanAntes = pedidos.filter((n) => antes.indexOf(n) === -1);
  let despues = await nombresDe();
  for (let intento = 0; intento < 6 && faltabanAntes.some((n) => despues.indexOf(n) === -1); intento++) {
    await new Promise((r) => setTimeout(r, 400));
    despues = await nombresDe();
  }
  const unicos = faltabanAntes.filter((n) => despues.indexOf(n) !== -1);
  const yaEstaban = pedidos.filter((n) => antes.indexOf(n) !== -1);
  const faltan = pedidos.filter((n) => !despues.some((d) => igualN(d, n)));

  if (faltan.length === pedidos.length) {
    /*
     * NO ALCANZA CON QUE FALTEN LOS NOMBRES PEDIDOS: hay que mirar si el proyecto CRECIO.
     *
     * Importar un `.prproj` trae los medios de ADENTRO, con sus propios nombres, así que
     * ninguno coincide con el archivo pedido y la comprobación dice "no entró nada" sobre algo
     * que funcionó. Medido el 2026-08-29: el proyecto descartable pasó de 1 a 33 medios y el
     * verbo informó fracaso. Es el contador ciego de `cortesDeEscena`, con otro sujeto.
     *
     * Se distingue por el CONTEO, que es el dato que no depende de los nombres.
     */
    const crecio = despues.length - antes.length;
    if (crecio > 0) {
      const nuevos = despues.filter((d) => antes.indexOf(d) === -1);
      return {
        resumen:
          `NINGUNO de los ${pedidos.length} pedidos aparece por su nombre, PERO el proyecto creció ` +
          `${antes.length} → ${despues.length} medios (+${crecio}). Entró algo con OTRO nombre: ` +
          `${nuevos.slice(0, 6).join(", ")}${nuevos.length > 6 ? ", …" : ""}. ` +
          `Pasa al importar un .prproj, que trae los medios de adentro. Vía ${via || "?"}.`,
        importados: [], yaEstaban: [], faltan: faltan, nuevosConOtroNombre: nuevos,
        antes: antes.length, despues: despues.length, via: via, intentos: intentos
      };
    }
    throw new Error(
      `No está en el proyecto ninguno de los ${pedidos.length} pedidos, y el proyecto NO creció ` +
      `(${antes.length} medios antes y después). ` +
      (via ? `La llamada no tiró (vía ${via}), así que Premiere la aceptó y no importó nada. ` : "") +
      `Intentos: ${intentos.join(" | ") || "ninguno falló"}.`
    );
  }

  /*
   * Se pidió un bin: hay que COMPROBAR que quedaron ahí, no confiar en la vía.
   * Si la forma que entró fue una sin bin, los medios están en la raíz y hay que
   * moverlos — y decirlo, porque "importados 12" con el bin vacío es un informe
   * que miente por omisión.
   */
  // El bin se comprueba sobre TODOS los pedidos que están, no sólo los recién
  // importados: si uno ya estaba pero suelto en la raíz, también hay que moverlo.
  /* `enOtroBin` se declara ACÁ y no adentro del `if (params.bin)`: se usa en el resumen,
   * que está afuera del bloque. Declarado con `const` adentro, el identificador no existe
   * afuera y el verbo tiraba "enOtroBin is not defined" en TODA llamada. `node --check` no
   * lo ve —es error de ejecución, no de sintaxis— y el chequeo de test.js tampoco, porque
   * sólo mira el último return. Apareció importando 35 clips. */
  let enBin = null, moviditos = null, enOtroBin = null;
  const presentes = pedidos.filter((n) => !faltan.some((f) => igualN(f, n)));
  if (params.bin) {
    const dentro = ((await hijosDe(destino)) || []).map((h) => String(h.name));
    /* Sólo se mueven los que están SUELTOS EN LA RAÍZ, no los que ya viven en un
     * bin. La versión anterior movía "lo que estuviera afuera del destino", que
     * es otra cosa: en un proyecto ya catalogado se llevó 46 clips de los bins
     * del usuario a uno plano. En un proyecto vacío no se nota; en uno ordenado
     * te desarma el panel. */
    const raiz = await project.getRootItem();
    /* Se recorre con un for y no con `.filter(async ...)`: un predicado async
     * devuelve una PROMISE, que siempre es truthy, así que el filtro no filtra
     * nada. Es el mismo error que el `undefined !== undefined` del catálogo, y
     * acá habría metido los bins en la lista de medios sueltos. */
    const enLaRaiz = new Set();
    for (const h of (await hijosDe(raiz)) || []) {
      if ((await hijosDe(h)) === null) enLaRaiz.add(String(h.name));
    }
    const afuera = presentes.filter((n) => dentro.indexOf(n) === -1 && enLaRaiz.has(n));
    enOtroBin = presentes.filter((n) => dentro.indexOf(n) === -1 && !enLaRaiz.has(n));
    if (afuera.length) {
      const sueltos = [];
      for (const h of (await hijosDe(raiz)) || []) {
        if ((await hijosDe(h)) === null && afuera.indexOf(String(h.name)) !== -1) sueltos.push(h);
      }
      if (sueltos.length) moviditos = await moverABin(project, destino, sueltos);
    }
    const dentroF = ((await hijosDe(destino)) || []).map((h) => String(h.name));
    enBin = presentes.filter((n) => dentroF.indexOf(n) !== -1).length;
  }

  return {
    resumen:
      `${presentes.length} de ${pedidos.length} pedidos en el proyecto` +
      (unicos.length ? ` · importados ${unicos.length}: ${unicos.slice(0, 6).join(", ")}${unicos.length > 6 ? ` y ${unicos.length - 6} más` : ""}` : "") +
      (yaEstaban.length ? ` · ${yaEstaban.length} ya estaban (no se volvieron a pedir: Premiere no deduplica, los importaría de nuevo)` : "") +
      ` · medios en el proyecto ${antes.length} → ${despues.length}` +
      (via ? ` · vía ${via}` : "") +
      (params.bin
        ? ` · en el bin "${params.bin}": ${enBin} de ${presentes.length}` +
          (moviditos ? ` (${moviditos.movidos.length} movidos, vía ${moviditos.via || "ninguna"})` : "") +
          (enOtroBin && enOtroBin.length ? ` · ${enOtroBin.length} ya vivían en otro bin y NO se movieron: ${enOtroBin.slice(0, 5).join(", ")}` : "") +
          (enBin < presentes.length - (enOtroBin ? enOtroBin.length : 0) ? ` · OJO: quedaron FUERA del bin` : "")
        : "") +
      (faltan.length ? ` · OJO: NO están ${faltan.join(", ")} — revisá que la ruta exista` : ""),
    pedidos: pedidos.length,
    importados: unicos,
    yaEstaban: yaEstaban,
    faltan: faltan,
    mediosAntes: antes.length,
    mediosDespues: despues.length,
    bin: params.bin || null,
    enBin: enBin,
    movidos: moviditos,
    via: via,
    intentos: intentos
  };
}

/**
 * Crear bins, mover medios adentro, y listar el árbol. Sin argumentos sólo lee.
 *
 * `medios` acepta nombres parciales. Devuelve qué movió y qué no, releyendo el
 * bin: `createMoveItemAction` es una transacción como cualquier otra de esta API,
 * o sea que puede pasar sin aplicar.
 */
async function bins(params) {
  const project = await getProyecto();
  const raiz = await project.getRootItem();

  const arbol = async () => {
    const salida = [];
    const recorrer = async (item, ruta, prof) => {
      if (prof > 8) return;
      for (const h of (await hijosDe(item)) || []) {
        const nombre = String(h.name);
        const esBin = (await hijosDe(h)) !== null;
        const aca = ruta ? ruta + "/" + nombre : nombre;
        if (esBin) { salida.push({ bin: aca, medios: 0 }); await recorrer(h, aca, prof + 1); }
        else {
          const dueño = salida.filter((s) => s.bin === ruta)[0];
          if (dueño) dueño.medios++;
          else if (!ruta) salida.raiz = (salida.raiz || 0) + 1;
        }
      }
    };
    await recorrer(raiz, "", 0);
    return salida;
  };

  if (!params.bin) {
    const a = await arbol();
    return {
      resumen: `${a.length} bin(s)` + (a.raiz ? ` · ${a.raiz} medio(s) sueltos en la raíz` : "") +
        (a.length ? " · " + a.map((s) => `${s.bin} (${s.medios})`).join(", ") : ""),
      bins: a, enLaRaiz: a.raiz || 0
    };
  }

  /* Borrar un bin: sólo si está VACÍO, salvo que se insista.
   *
   * Va con guarda porque es lo único destructivo de este verbo, y un bin con
   * medios adentro se lleva los medios: eso deja las secuencias que los usaban
   * apuntando a nada. `asegurarBin` no se usa acá —crearlo para borrarlo sería
   * absurdo—: si no existe, se dice y no se hace nada. */
  if (params.borrar === true) {
    const partes = String(params.bin).split("/").map((x) => x.trim()).filter(Boolean);
    let padre = await project.getRootItem(), bin = null;
    for (let i = 0; i < partes.length; i++) {
      let hallado = null;
      for (const h of (await hijosDe(padre)) || []) {
        if (String(h.name) === partes[i] && (await hijosDe(h)) !== null) { hallado = h; break; }
      }
      if (!hallado) throw new Error(`No existe el bin "${params.bin}" (falló en "${partes[i]}").`);
      if (i === partes.length - 1) bin = hallado; else padre = hallado;
    }
    const dentro = (await hijosDe(bin)) || [];
    if (dentro.length && params.aunqueTengaCosas !== true) {
      throw new Error(
        `El bin "${params.bin}" tiene ${dentro.length} cosa(s) adentro: ${dentro.slice(0, 6).map((h) => String(h.name)).join(", ")}` +
        `${dentro.length > 6 ? "…" : ""}. Borrarlo se las lleva y deja sin medio a las secuencias que las usen. ` +
        "Si igual querés, pasá `aunqueTengaCosas: true`."
      );
    }
    const carpetaPadre = ppro.FolderItem.cast(padre);
    if (!carpetaPadre) throw new Error(`No se pudo castear el padre de "${params.bin}" a FolderItem.`);
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => { a.addAction(carpetaPadre.createRemoveItemAction(bin)); }, "borrar el bin");
    });
    // la prueba es releer, no el booleano
    let sigue = false;
    for (const h of (await hijosDe(padre)) || []) if (String(h.name) === partes[partes.length - 1]) { sigue = true; break; }
    return {
      resumen: sigue
        ? `NO se borró el bin "${params.bin}": la transacción devolvió ${ok} y sigue estando.`
        : `Bin "${params.bin}" borrado (tenía ${dentro.length} cosa(s) adentro).`,
      borrado: !sigue, tenia: dentro.length
    };
  }

  const destino = await asegurarBin(project, String(params.bin));
  const antes = ((await hijosDe(destino)) || []).length;

  let resultado = null, buscados = [], noEncontrados = [];
  if (params.medios) {
    const patrones = (Array.isArray(params.medios) ? params.medios : [params.medios]).map(String);
    // Se busca en TODO el proyecto, no sólo en la raíz: un medio puede estar ya
    // en otro bin y querer moverse.
    const todos = [];
    const juntar = async (item, prof) => {
      if (prof > 8) return;
      for (const h of (await hijosDe(item)) || []) {
        if ((await hijosDe(h)) !== null) await juntar(h, prof + 1);
        else todos.push(h);
      }
    };
    await juntar(raiz, 0);
    for (const p of patrones) {
      const hit = todos.filter((h) => String(h.name).toLowerCase().indexOf(p.toLowerCase()) !== -1);
      if (!hit.length) noEncontrados.push(p);
      for (const h of hit) if (buscados.indexOf(h) === -1) buscados.push(h);
    }
    if (buscados.length) resultado = await moverABin(project, destino, buscados);
  }

  const despues = ((await hijosDe(destino)) || []).length;
  return {
    resumen:
      `Bin "${params.bin}": ${antes} → ${despues} medios` +
      /*
       * "Movidos" cuenta lo que SE MOVIÓ, no lo que está. Decir "movidos 4 de 4"
       * cuando los cuatro ya estaban adentro y no se abrió ninguna transacción es
       * la misma clase de informe que este archivo persigue: cierto de casualidad
       * y engañoso sobre lo que pasó.
       */
      (resultado
        ? (resultado.yaEstaban
            ? ` · ya estaban los ${resultado.yaEstaban}, no se movió ninguno`
            : ` · movidos ${resultado.movidos.length} de ${buscados.length} pedidos, vía ${resultado.via || "ninguna"}`)
        : "") +
      (resultado && resultado.fallidos.length ? ` · NO SE MOVIERON: ${resultado.fallidos.join(", ")}` : "") +
      (noEncontrados.length ? ` · sin coincidencia en el proyecto: ${noEncontrados.join(", ")}` : ""),
    bin: params.bin,
    antes: antes, despues: despues,
    movidos: resultado ? resultado.movidos : [],
    fallidos: resultado ? resultado.fallidos : [],
    noEncontrados: noEncontrados,
    via: resultado ? resultado.via : null,
    intentos: resultado ? resultado.intentos : []
  };
}

/* ---------- despacho ---------- */

/**
 * Detección de cortes de escena sobre UN clip, en los tres modos que da la API.
 *
 * `SequenceUtils.performSceneEditDetectionOnSelection` analiza el material y
 * encuentra dónde cambia el plano. Sirve para material largo de una sola pieza
 * —una cámara que grabó toda la jornada, un archivo con varias tomas pegadas—
 * donde marcar los cortes a mano es media hora de trabajo.
 *
 * Las tres constantes son strings primitivos, verificado reflejando:
 * "ApplyCuts", "CreateMarkers", "CreateSubclips". OJO que NO todas las constantes
 * de esta API lo son: las de `Constants.MediaType` son objetos y comparadas como
 * texto dan "[object Object]" (ver CLAUDE.md).
 *
 * EL OBJETIVO VA EXPLÍCITO. La API opera sobre "la selección", y un verbo que
 * corte lo que haya seleccionado es una sorpresa fea cuando el usuario no está
 * mirando. Se pide el clip por nombre o pista+índice, se lo selecciona con
 * `seleccionar` —que verifica releyendo— y recién entonces se corre.
 *
 * Por defecto `marcar`, que es el modo que NO toca el timeline: de los tres es el
 * único reversible con sólo borrar marcadores.
 *
 * Y TARDA: analiza el medio, así que puede pasarse del timeout de 30s del
 * transporte. Llamalo con un timeout largo; si la respuesta se pierde, queda
 * huérfana en `intercambio/respuesta.json` y se lee de ahí.
 */
async function cortesDeEscena(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (!params.nombre && params.pista === undefined) {
    throw new Error(
      "Falta el objetivo: `nombre` del clip, o `pista` + `indice`. " +
      "Este verbo puede CORTAR, así que no opera sobre lo que esté seleccionado."
    );
  }

  /*
   * DOS FUENTES para la operación, y no son intercambiables a priori:
   * `SequenceUtils.SEQUENCE_OPERATION_*` y `Constants.SequenceOperation.*`.
   *
   * Reflejadas se imprimen IGUAL —"ApplyCuts"— pero eso no prueba que sean el
   * mismo valor: el reflejo hace String(), y un objeto con toString se ve idéntico
   * a un string. Es la trampa de `Constants.MediaType`, que son objetos y como
   * texto dan "[object Object]" (ver CLAUDE.md).
   *
   * La primera vuelta pasó la de SequenceUtils con seis tipos distintos de primer
   * argumento y las 19 formas dieron "Illegal Parameter type", así que el segundo
   * argumento es el sospechoso.
   */
  const MODOS = {
    cortar: ppro.SequenceUtils.SEQUENCE_OPERATION_APPLYCUT,
    marcar: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATEMARKER,
    subclips: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATESUBCLIP
  };
  const MODOS2 = ppro.Constants && ppro.Constants.SequenceOperation ? {
    cortar: ppro.Constants.SequenceOperation.APPLYCUT,
    marcar: ppro.Constants.SequenceOperation.CREATEMARKER,
    subclips: ppro.Constants.SequenceOperation.CREATESUBCLIP
  } : {};
  const modo = params.modo && MODOS[params.modo] ? params.modo : "marcar";
  const operacion = MODOS[modo];
  if (!operacion) {
    throw new Error(`Modo "${params.modo}" desconocido. Son: cortar, marcar, subclips.`);
  }

  const donde = await ubicarClip(sequence, params);
  const track = donde.track;
  // El ProjectItem se resuelve acá arriba porque los contadores lo necesitan.
  let mediaItem = null;
  try { mediaItem = ppro.ClipProjectItem.cast(await donde.clip.getProjectItem()); } catch (e) { mediaItem = null; }

  // Contadores del efecto REAL de cada modo, no un booleano.
  const contarClips = async () =>
    (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)).length;
  /*
   * LOS MARCADORES SE CUENTAN EN LOS TRES LUGARES, no sólo en la secuencia.
   *
   * La detección de escenas de Premiere, en modo Create Markers, los pone sobre el
   * CLIP —así funciona en la interfaz— y un contador que sólo mira la secuencia los
   * declara inexistentes. La llamada devolvía `true` y el verbo informaba "no
   * cambió nada": el punto ciego era mío, no de la API.
   *
   * `Markers.getMarkers` acepta distintos sujetos y no está documentado cuáles, así
   * que cada uno va en su try: el que no conteste suma 0 en vez de romper la cuenta.
   */
  const contarEn = async (sujeto) => {
    if (!sujeto) return 0;
    try {
      const col = await ppro.Markers.getMarkers(sujeto);
      const l = await col.getMarkers();
      return l ? l.length : 0;
    } catch (e) { return 0; }
  };
  const contarMarcadores = async () =>
    (await contarEn(sequence)) + (await contarEn(donde.clip)) + (await contarEn(mediaItem));
  const detalleMarcadores = async () => ({
    secuencia: await contarEn(sequence),
    clip: await contarEn(donde.clip),
    medio: await contarEn(mediaItem)
  });
  const contarMedios = async () => {
    // Una sola pasada, recursiva sobre bins: `getItems()` a secas no entra a los
    // bins creados por API y hay que castear (ver `hijosDe` y CLAUDE.md).
    let n = 0;
    const ver = async (item) => {
      const hijos = await hijosDe(item);
      if (!hijos) { n++; return; }
      for (let i = 0; i < hijos.length; i++) await ver(hijos[i]);
    };
    await ver(await project.getRootItem());
    return n;
  };

  const antes = {
    clipsEnPista: await contarClips(),
    marcadores: await contarMarcadores(),
    medios: modo === "subclips" ? await contarMedios() : null
  };

  // Se selecciona con el verbo que ya existe, que verifica releyendo la selección.
  let seleccion = null;
  try {
    seleccion = await seleccionar({ nombre: params.nombre, pista: params.pista, indice: params.indice });
  } catch (e) {
    throw new Error(`No se pudo seleccionar "${donde.nombre}" para analizarlo: ${e && e.message ? e.message : e}`);
  }

  /*
   * La aridad dice 0 y miente, como en el resto de esta API. Se enumeran las
   * formas y la prueba de cuál sirvió NO es que no tire: es que los contadores se
   * muevan. El cuarto argumento candidato es "aplicar también al audio vinculado",
   * que es lo que ofrece el diálogo de Premiere.
   */
  const intentos = [];
  const devoluciones = [];
  let via = null, despues = null;
  const cambio = (d) =>
    modo === "cortar" ? d.clipsEnPista > antes.clipsEnPista
    : modo === "marcar" ? d.marcadores > antes.marcadores
    : d.medios > antes.medios;

  /*
   * PRIMERA VUELTA, medida: con la SECUENCIA como primer argumento las cinco formas
   * contestan "Illegal Parameter type", y `(operacion)` sola dice "Not Enough
   * Parameters" — así que quiere 2 argumentos o más y el primero NO es la secuencia.
   * El nombre dice "OnSelection", así que se prueban la selección, los items y el
   * clip. Se enumera todo de una porque cada Reload del panel cuesta una vuelta.
   */
  const sel = await sequence.getSelection();
  let itemsSel = [];
  try { itemsSel = await sel.getTrackItems(); } catch (e) { itemsSel = []; }
  const P = (f) => ppro.SequenceUtils.performSceneEditDetectionOnSelection(...f);
  const opciones = [];
  if (MODOS[modo] !== undefined) opciones.push(["SequenceUtils", MODOS[modo]]);
  if (MODOS2[modo] !== undefined) opciones.push(["Constants.SequenceOperation", MODOS2[modo]]);
  // Qué son de verdad estos valores: va al informe, porque es el dato que falta.
  const queSon = opciones.map(([n, v]) => `${n}: typeof ${typeof v}, String "${String(v)}"`).join(" | ") +
    ` · la selección tiene ${itemsSel.length} item(s)` +
    ` · marcadores por lugar: ${JSON.stringify(await detalleMarcadores())}`;

  /*
   * LA FIRMA, MEDIDA el 2026-08-19:
   *
   *   performSceneEditDetectionOnSelection(operacionString, TrackItemSelection)
   *
   * La operación va PRIMERO. Con el objetivo primero, las 20 formas probadas dan
   * "Illegal Parameter type"; el orden salió de leer el plugin de leancoderkavy y
   * se confirmó por el efecto, no por su palabra —ellos lo marcan `not_verified`.
   *
   * Y las dos fuentes del enum sirven igual: `SequenceUtils.SEQUENCE_OPERATION_*` y
   * `Constants.SequenceOperation.*` son el MISMO string ("CreateMarkers"), medido
   * con typeof.
   *
   * El segundo argumento tiene que ser la SELECCIÓN. Pasarle el clip o la secuencia
   * da "Invalid parameter." —tipos bien, valor mal— y un array de items da "Illegal
   * Parameter type".
   *
   * Va PRIMERA y sola en la lista: mientras estuvo enterrada entre formas que
   * fallaban, el verbo corrió el análisis CUATRO veces sobre el mismo clip y dejó
   * 68 marcadores de más, porque el contador no los veía (ver abajo). Las otras
   * quedan sólo como diagnóstico si esta algún día deja de andar.
   */
  const formas = [];
  for (const [nOp, op] of opciones) {
    formas.push([`(op de ${nOp}, selección)`, () => P([op, sel])]);
  }
  for (const [nOp, op] of opciones) {
    formas.push([`(op de ${nOp}, selección, true)`, () => P([op, sel, true])]);
    formas.push([`(op de ${nOp}, clip)`, () => P([op, donde.clip])]);
    formas.push([`(op de ${nOp}, secuencia)`, () => P([op, sequence])]);
  }

  for (const [etiqueta, fn] of formas) {
    let dev;
    try { dev = await fn(); }
    catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); continue; }
    devoluciones.push(etiqueta + " → " + (dev === undefined ? "undefined" : JSON.stringify(dev)));
    if (dev === false) { intentos.push(etiqueta + ": devolvió false"); continue; }
    /*
     * SE ESPERA Y SE VUELVE A MIRAR. La detección de escenas de Premiere es
     * ASÍNCRONA —levanta una barra de progreso y termina después—, así que medir
     * los contadores justo después de la llamada da "no cambió nada" incluso
     * cuando arrancó bien. Sin esta espera, el bucle concluye que falló y sigue
     * con la forma siguiente: diecinueve análisis encolados sobre el mismo clip.
     *
     * 6 segundos de tope, mirando cada 1,5s. Medido: con la firma correcta el
     * análisis de un clip de 55s se completa en ~12s totales incluyendo el resto
     * del verbo, así que el resultado está antes de la primera relectura.
     */
    const leer = async () => ({
      clipsEnPista: await contarClips(),
      marcadores: await contarMarcadores(),
      medios: modo === "subclips" ? await contarMedios() : null
    });
    let d = await leer(), movio = cambio(d);
    for (let esperas = 0; !movio && esperas < 4; esperas++) {
      await new Promise((r) => setTimeout(r, 1500));
      d = await leer();
      movio = cambio(d);
    }
    if (movio) { via = etiqueta; despues = d; break; }
    intentos.push(etiqueta + ": no tiró y a los 6s NO cambió nada");
  }

  if (!via) {
    throw new Error(
      `La detección de cortes no produjo NADA sobre "${donde.nombre}" (${donde.pista}) en modo "${modo}". ` +
      `Antes: ${antes.clipsEnPista} clip(s) en la pista, ${antes.marcadores} marcador(es). ` +
      `Intentos: ${intentos.join(" | ")}.` +
      (devoluciones.length ? ` DEVOLVIERON: ${devoluciones.join(" | ")}.` : "") +
      ` LAS OPERACIONES SON → ${queSon}.`
    );
  }

  const desglose = await detalleMarcadores();
  const detectados =
    modo === "cortar" ? despues.clipsEnPista - antes.clipsEnPista
    : modo === "marcar" ? despues.marcadores - antes.marcadores
    : despues.medios - antes.medios;

  return {
    resumen:
      `"${donde.nombre}" (${donde.pista}) · modo ${modo} · vía ${via} · ` +
      `${detectados} corte(s) detectado(s)` +
      (modo === "marcar" ? ` · quedaron en ${JSON.stringify(desglose)}` : "") +
      (modo === "cortar"
        ? ` · la pista pasó de ${antes.clipsEnPista} a ${despues.clipsEnPista} clip(s)`
        : modo === "marcar"
          ? ` · marcadores ${antes.marcadores} → ${despues.marcadores}`
          : ` · medios del proyecto ${antes.medios} → ${despues.medios}`) +
      (intentos.length ? ` · descartadas: ${intentos.length} forma(s)` : "") +
      /*
       * EL UNDO NO ESTÁ CONFIRMADO. Esto no pasa por executeTransaction, así que
       * no hay razón para prometer un Cmd+Z: el plugin de terceros marca
       * `undoSupported: false` para esta misma llamada. Sobre el modo `cortar`,
       * prometer undo y que no lo haya es dejar al usuario con el timeline partido
       * creyendo que lo puede deshacer.
       */
      (modo === "marcar"
        ? " · van sobre el CLIP, no sobre la secuencia; se sacan con premiere_desmarcar pidiendo ese clip"
        : " · OJO: el undo NO está confirmado para esta llamada, no pasa por una transacción") +
      (modo === "cortar" ? " · y revisá el audio vinculado, no está medido si lo arrastra" : ""),
    clip: donde.nombre, pista: donde.pista, modo: modo, via: via,
    detectados: detectados, antes: antes, despues: despues,
    seleccion: seleccion && seleccion.resumen ? seleccion.resumen : null,
    intentos: intentos, devoluciones: devoluciones
  };
}

/**
 * Etiquetas de color en el panel de proyecto.
 *
 * Para lo que sirve de verdad: marcar SUPLENTES. Cuando el bridge propone tomas
 * —titulares y alternativas— la lista en texto obliga a ir a buscar cada clip a
 * mano. Con un color el juicio se hace mirando el panel.
 *
 * `Constants.ProjectItemColorLabel` da 15 colores, y OJO que el índice 2 NO
 * EXISTE en el enum: va 0, 1, 3, 4… aunque Premiere muestre 16 slots. Pasar 2 a
 * mano es pasar un valor que la API no declara.
 *
 * Sin `color` sólo LEE, que es el modo seguro por defecto: dice qué tiene puesto
 * cada medio en vez de cambiar nada.
 *
 * Los cambios van en UNA transacción, no una por medio: una ráfaga de
 * transacciones tira Premiere (ver CLAUDE.md). Y se relee cada uno al final,
 * porque que `executeTransaction` devuelva true no prueba que el valor entró.
 */
async function etiquetar(params) {
  const project = await getProyecto();

  const COLORES = {
    violeta: "VIOLET", iris: "IRIS", lavanda: "LAVENDER", ceruleo: "CERULEAN",
    bosque: "FOREST", rosa: "ROSE", mango: "MANGO", purpura: "PURPLE",
    azul: "BLUE", verdeagua: "TEAL", magenta: "MAGENTA", tostado: "TAN",
    verde: "GREEN", marron: "BROWN", amarillo: "YELLOW"
  };
  const ENUM = ppro.Constants.ProjectItemColorLabel;
  const sinTilde = (s) => String(s).toLowerCase()
    .replace(/[áà]/g, "a").replace(/[éè]/g, "e").replace(/[íì]/g, "i")
    .replace(/[óò]/g, "o").replace(/[úù]/g, "u");

  let indice = null, comoSeLlama = null;
  if (params.color !== undefined && params.color !== null) {
    if (typeof params.color === "number") {
      indice = params.color;
      comoSeLlama = Object.keys(ENUM).find((k) => ENUM[k] === indice) || String(indice);
      if (comoSeLlama === String(indice)) {
        throw new Error(
          `El color ${indice} no existe en Constants.ProjectItemColorLabel. ` +
          `Los válidos son: ${Object.entries(ENUM).map(([k, v]) => k + "=" + v).join(", ")}.`
        );
      }
    } else {
      const pedido = sinTilde(params.color);
      const clave = COLORES[pedido] || (ENUM[String(params.color).toUpperCase()] !== undefined ? String(params.color).toUpperCase() : null);
      if (!clave) {
        throw new Error(
          `Color "${params.color}" desconocido. En castellano: ${Object.keys(COLORES).join(", ")}. ` +
          `O el nombre de la API: ${Object.keys(ENUM).join(", ")}.`
        );
      }
      indice = ENUM[clave];
      comoSeLlama = clave;
    }
  }

  const pedidos = Array.isArray(params.medios) ? params.medios.map(String)
    : params.medio ? [String(params.medio)] : null;

  /*
   * ESCRIBIR EXIGE OBJETIVO. Sin `medios`, el recorrido junta TODO el panel de
   * proyecto —secuencias y capas de ajuste incluidas, que también tienen etiqueta—
   * así que un `{color: "verde"}` suelto repinta el proyecto entero de un saque y
   * borra el código de colores que el usuario venía usando a mano. Leer sin
   * objetivo sí es útil y sigue permitido.
   */
  if (params.color !== undefined && params.color !== null && !pedidos) {
    throw new Error(
      "Para ESCRIBIR hace falta `medios` (o `medio`): sin objetivo se etiquetaría " +
      "todo el panel de proyecto, secuencias incluidas. Sin `color` el verbo sólo lee, " +
      "y ahí sí vale pedirlo sobre todo."
    );
  }

  /*
   * UNA SOLA PASADA por el proyecto, no una por nombre pedido. Con 137 medios y
   * 30 suplentes, una pasada por nombre son 4000 lecturas en ráfaga, que es el
   * patrón que ya crasheó Premiere con el proyecto real del usuario.
   *
   * Y se cuenta por MULTIPLICIDAD: los nombres no son únicos —`importFiles` no
   * deduplica— así que un Set haría entrar cuatro copias como una y el informe
   * diría "4 de 4" con tres afuera. Eso ya pasó en `moverABin`.
   */
  const encontrados = [];
  const todos = [];
  const recorrer = async (carpeta, prof) => {
    if (prof > 8) return;
    const hijos = await hijosDe(carpeta);
    if (!hijos) return;
    for (let i = 0; i < hijos.length; i++) {
      const sub = await hijosDe(hijos[i]);
      if (sub === null) {
        const n = String(hijos[i].name);
        todos.push(n);
        if (!pedidos) { encontrados.push({ nombre: n, item: hijos[i], pedido: null }); continue; }
        // Exacto primero: un parcial puede agarrar de más y etiquetar lo que no era.
        const exacto = pedidos.find((p) => p === n);
        const parcial = exacto ? null : pedidos.find((p) => n.toLowerCase().indexOf(p.toLowerCase()) !== -1);
        if (exacto || parcial) encontrados.push({ nombre: n, item: hijos[i], pedido: exacto || parcial, porParcial: !exacto });
      } else await recorrer(hijos[i], prof + 1);
    }
  };
  await recorrer(await project.getRootItem(), 0);

  if (pedidos && !encontrados.length) {
    throw new Error(
      `Ninguno de los ${pedidos.length} medio(s) pedidos está en el proyecto. ` +
      `Hay ${todos.length}: ${todos.slice(0, 20).join(", ")}${todos.length > 20 ? "…" : ""}.`
    );
  }

  // Lo que hay puesto AHORA, siempre: es el "antes" y también el modo de lectura.
  const leer = async (item) => {
    try {
      const ci = ppro.ClipProjectItem.cast(item);
      const v = await ci.getColorLabelIndex();
      const n = Object.keys(ENUM).find((k) => ENUM[k] === Number(v));
      return { indice: Number(v), nombre: n || null };
    } catch (e) { return { indice: null, nombre: null, error: e && e.message ? e.message : String(e) }; }
  };
  for (const e of encontrados) e.antes = await leer(e.item);

  if (indice === null) {
    const porColor = {};
    for (const e of encontrados) {
      const k = e.antes.nombre || ("índice " + e.antes.indice);
      (porColor[k] = porColor[k] || []).push(e.nombre);
    }
    return {
      resumen:
        `${encontrados.length} medio(s) · ` +
        Object.keys(porColor).map((k) => `${k}: ${porColor[k].length}`).join(" · ") +
        " · SOLO LEÍDO, pasá `color` para escribir",
      total: encontrados.length,
      porColor: porColor,
      medios: encontrados.map((e) => ({ nombre: e.nombre, color: e.antes.nombre, indice: e.antes.indice }))
    };
  }

  // UNA transacción para todos.
  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        for (const e of encontrados) {
          const ci = ppro.ClipProjectItem.cast(e.item);
          a.addAction(ci.createSetColorLabelAction(indice));
        }
      }, `etiquetar ${encontrados.length} medio(s) en ${comoSeLlama}`);
    });
  } catch (err) { error = err && err.message ? err.message : String(err); }
  if (error) throw new Error(`No se pudo etiquetar: ${error}`);

  // Y SE RELEE cada uno: el booleano de la transacción no prueba que entró.
  let quedaron = 0;
  const fallaron = [];
  for (const e of encontrados) {
    e.despues = await leer(e.item);
    if (e.despues.indice === indice) quedaron++;
    else fallaron.push(`${e.nombre} quedó en ${e.despues.nombre || e.despues.indice}`);
  }

  const porParcial = encontrados.filter((e) => e.porParcial).map((e) => `"${e.pedido}"→"${e.nombre}"`);
  return {
    resumen:
      `${quedaron} de ${encontrados.length} medio(s) en ${comoSeLlama} (índice ${indice})` +
      (ok ? "" : " · OJO: executeTransaction devolvió false") +
      (fallaron.length ? ` · NO ENTRÓ en ${fallaron.length}: ${fallaron.slice(0, 5).join(", ")}` : "") +
      (porParcial.length ? ` · ${porParcial.length} por coincidencia PARCIAL: ${porParcial.slice(0, 5).join(", ")}` : "") +
      " · un Cmd+Z lo saca (una sola transacción)",
    color: comoSeLlama, indice: indice,
    pedidos: pedidos ? pedidos.length : null,
    encontrados: encontrados.length, quedaron: quedaron,
    fallaron: fallaron,
    porCoincidenciaParcial: porParcial,
    medios: encontrados.map((e) => ({ nombre: e.nombre, antes: e.antes.nombre, despues: e.despues.nombre }))
  };
}

/**
 * Interpretación de material: los fps con que Premiere LEE un medio.
 *
 * Para lo que hace falta ahora mismo: los clips generados de Kling vienen a 24fps
 * y la secuencia va a 25, así que Premiere los conforma y hay que corregirlos a
 * mano uno por uno en Modify > Interpret Footage.
 *
 * OJO que esto NO es la velocidad del clip ni los fps de la secuencia: cambia con
 * qué cadencia se lee el ARCHIVO, así que un medio de 24fps interpretado a 25 dura
 * menos y va un 4% más rápido.
 *
 * MEDIDO el 2026-08-19, y es más específico de lo que se suponía: sobre un clip ya
 * puesto en el timeline, la DURACIÓN no se mueve —siguió midiendo 55,20s— pero el
 * CONTENIDO sí. Comparando el cuadro del segundo 30 de la secuencia con 24 y con 25
 * fps, los md5 son distintos. Así que reinterpretar **desincroniza una edición ya
 * hecha**: el clip mide lo mismo y muestra otra cosa, y los cortes que se hicieron
 * contra ese material quedan corridos.
 *
 * La lección de proceso: el verbo informaba "afecta a todas las secuencias que lo
 * usen", que sonaba bien y no decía nada útil. Lo que hacía falta era mirar el
 * cuadro.
 *
 * Sin `fps` sólo LEE, y de paso informa la FORMA de lo que devuelve cada getter.
 * Eso es a propósito: la lección de `setVideoFrameRate` fue que cuando un getter y
 * un setter son de la misma propiedad, la forma que devuelve el getter es la
 * primera que hay que probar en el setter — y ahí se perdió una vuelta entera
 * porque el lector estaba roto y se culpó al escritor.
 */
async function interpretar(params) {
  const project = await getProyecto();
  if (!params.medio) throw new Error("Falta `medio`: el nombre del medio del panel de proyecto.");

  const encontrado = await buscarMedio(project, params.medio);
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(encontrado); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${String(encontrado.name)}" a ClipProjectItem.`);

  const describir = (v) => {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v !== "object") return `${typeof v} ${String(v)}`;
    let claves = [];
    try { claves = Object.getOwnPropertyNames(v).slice(0, 10); } catch (e) { claves = []; }
    return `objeto {${claves.join(", ")}} → ${String(v)}`;
  };

  const leer = async () => {
    let fi = null, err = null;
    try { fi = await clipItem.getFootageInterpretation(); }
    catch (e) { err = e && e.message ? e.message : String(e); }
    if (!fi) return { error: err || "getFootageInterpretation devolvió vacío" };
    const out = { formas: {} };
    for (const [nombre, fn] of [
      ["fps", () => fi.getFrameRate()],
      ["par", () => fi.getPixelAspectRatio()],
      ["campos", () => fi.getFieldType()],
      ["alpha", () => fi.getAlphaUsage()]
    ]) {
      try {
        const v = await fn();
        out[nombre] = typeof v === "object" && v !== null && v.value !== undefined ? v.value : v;
        out.formas[nombre] = describir(v);
      } catch (e) { out[nombre] = null; out.formas[nombre] = "tiró: " + (e && e.message ? e.message : e); }
    }
    out.fi = fi;
    return out;
  };

  const antes = await leer();
  if (antes.error) throw new Error(`No se pudo leer la interpretación de "${String(encontrado.name)}": ${antes.error}`);

  if (params.fps === undefined || params.fps === null) {
    return {
      resumen:
        `"${String(encontrado.name)}" · ${antes.fps} fps · PAR ${antes.par} · campos ${antes.campos} · alpha ${antes.alpha}` +
        " · SOLO LEÍDO, pasá `fps` para cambiarlo" +
        ` · formas: ${JSON.stringify(antes.formas)}`,
      medio: String(encontrado.name),
      fps: antes.fps, par: antes.par, campos: antes.campos, alpha: antes.alpha,
      formas: antes.formas
    };
  }

  const pedido = Number(params.fps);
  if (!(pedido > 0)) throw new Error(`Los fps pedidos no son un número válido: ${params.fps}`);

  /*
   * DOS RUTAS y se prueban las dos, mirando el efecto y no si tiró.
   *
   * La corta es `createSetOverrideFrameRateAction`, que declara aridad 1. La larga
   * es modificar el FootageInterpretation y commitearlo con
   * `createSetFootageInterpretationAction`. Cuál anda no está documentado.
   *
   * El valor se prueba en el orden que sugiere el getter: si devolvió {value},
   * primero el número pelado igual —porque `.value` es el desempaquetado— y después
   * las envolturas.
   */
  const formas = [];
  formas.push(["createSetOverrideFrameRateAction(número)", () => {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(clipItem.createSetOverrideFrameRateAction(pedido));
      }, "interpretar fps");
    });
    return ok;
  }]);
  formas.push(["setFrameRate + createSetFootageInterpretationAction", () => {
    antes.fi.setFrameRate(pedido);
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(clipItem.createSetFootageInterpretationAction(antes.fi));
      }, "interpretar fps");
    });
    return ok;
  }]);

  const intentos = [];
  const devoluciones = [];
  let via = null, despues = null;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  let primera = true;
  for (const [etiqueta, fn] of formas) {
    if (!primera) await esperar(1200);   // no encadenar transacciones
    primera = false;
    let dev;
    try { dev = await fn(); }
    catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); continue; }
    devoluciones.push(etiqueta + " → " + JSON.stringify(dev));
    if (dev === false) { intentos.push(etiqueta + ": executeTransaction devolvió false"); continue; }
    // SE RELEE: el booleano no prueba que el valor entró.
    const d = await leer();
    if (d.fps !== null && Math.abs(Number(d.fps) - pedido) < 0.001) { via = etiqueta; despues = d; break; }
    intentos.push(`${etiqueta}: no tiró pero quedó en ${d.fps} y se pidió ${pedido}`);
  }

  if (!via) {
    throw new Error(
      `No se pudo interpretar "${String(encontrado.name)}" a ${pedido} fps. Estaba en ${antes.fps}. ` +
      `Intentos: ${intentos.join(" | ")}.` +
      (devoluciones.length ? ` DEVOLVIERON: ${devoluciones.join(" | ")}.` : "") +
      ` La forma del getter era: ${antes.formas.fps}.`
    );
  }

  return {
    resumen:
      `"${String(encontrado.name)}" · ${antes.fps} → ${despues.fps} fps · vía ${via}` +
      (intentos.length ? ` · descartadas: ${intentos.length} forma(s)` : "") +
      " · CAMBIA EL MEDIO: la duración de los clips ya puestos NO se mueve, pero el" +
      " CONTENIDO adentro sí, así que DESINCRONIZA cualquier corte hecho contra este material" +
      " (medido comparando el cuadro del mismo instante: md5 distinto)" +
      " · un Cmd+Z lo saca",
    medio: String(encontrado.name),
    fpsAntes: antes.fps, fpsDespues: despues.fps, via: via,
    par: despues.par, campos: despues.campos, alpha: despues.alpha,
    intentos: intentos, devoluciones: devoluciones
  };
}

/**
 * Proxies: adjuntar una versión liviana de un medio para editar fluido.
 *
 * `ClipProjectItem` da `canProxy`, `hasProxy`, `getProxyPath` y `attachProxy`.
 * Sirve con material pesado —4K vertical, por ejemplo— donde el timeline se
 * arrastra: se edita con el proxy y se exporta con el original, sin tocar la
 * edición.
 *
 * Sin `archivo` sólo LEE: si el medio admite proxy, si ya tiene uno y cuál.
 *
 * `attachProxy` declara aridad 0 y miente, como el resto de esta API. El
 * antecedente de ExtendScript es `attachProxy(rutaMedia, isHiRes)` con isHiRes en
 * 0/1, así que se enumeran esas formas y la prueba NO es que no tire: es que
 * `hasProxy` pase de false a true y que `getProxyPath` devuelva la ruta pedida.
 *
 * El proxy tiene que EXISTIR en disco antes de adjuntarlo. Premiere no lo genera
 * desde acá: eso es Media Encoder, o se hace con ffmpeg y se adjunta.
 */
async function proxy(params) {
  const project = await getProyecto();
  if (!params.medio) throw new Error("Falta `medio`: el nombre del medio del panel de proyecto.");

  const encontrado = await buscarMedio(project, params.medio);
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(encontrado); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${String(encontrado.name)}" a ClipProjectItem.`);

  const estado = async () => {
    const o = {};
    for (const [k, fn] of [
      ["puede", () => clipItem.canProxy()],
      ["tiene", () => clipItem.hasProxy()],
      ["ruta", () => clipItem.getProxyPath()],
      ["original", () => clipItem.getMediaFilePath()]
    ]) {
      try { const v = await fn(); o[k] = typeof v === "object" && v !== null ? String(v) : v; }
      catch (e) { o[k] = null; o[k + "Error"] = e && e.message ? e.message : String(e); }
    }
    return o;
  };

  const antes = await estado();

  if (!params.archivo) {
    return {
      resumen:
        `"${String(encontrado.name)}" · admite proxy: ${antes.puede} · tiene: ${antes.tiene}` +
        (antes.tiene && antes.ruta ? ` · proxy en ${antes.ruta}` : "") +
        (antes.original ? ` · original en ${antes.original}` : "") +
        " · SOLO LEÍDO, pasá `archivo` para adjuntar uno",
      medio: String(encontrado.name), ...antes
    };
  }

  const ruta = String(params.archivo);
  if (antes.puede === false) {
    throw new Error(`"${String(encontrado.name)}" dice canProxy() = false: este medio no admite proxy.`);
  }

  /*
   * Se comprueba que el archivo EXISTA antes de adjuntarlo. Adjuntar una ruta que
   * no está deja un proxy roto que Premiere marca offline recién al reproducir, y
   * eso se lee como un problema del medio original.
   */
  let existe = false;
  try { existe = !!(await uxp.storage.localFileSystem.getEntryWithUrl("file:" + ruta)); }
  catch (e) { existe = false; }
  if (!existe) throw new Error(`El proxy "${ruta}" no está en disco. Generalo primero (Media Encoder o ffmpeg).`);

  const formas = [
    ["attachProxy(ruta, 0)", () => clipItem.attachProxy(ruta, 0)],
    ["attachProxy(ruta, false)", () => clipItem.attachProxy(ruta, false)],
    ["attachProxy(ruta)", () => clipItem.attachProxy(ruta)],
    ["attachProxy(ruta, 1)", () => clipItem.attachProxy(ruta, 1)],
    ["attachProxy(ruta, 0) dentro de lockedAccess", () => {
      let r = null;
      project.lockedAccess(() => { r = clipItem.attachProxy(ruta, 0); });
      return r;
    }]
  ];

  const intentos = [];
  const devoluciones = [];
  let via = null, despues = null;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  let primera = true;
  for (const [etiqueta, fn] of formas) {
    if (!primera) await esperar(1200);
    primera = false;
    let dev;
    try { dev = await fn(); }
    catch (e) { intentos.push(etiqueta + ": " + (e && e.message ? e.message : e)); continue; }
    devoluciones.push(etiqueta + " → " + JSON.stringify(dev === undefined ? "undefined" : dev));
    if (dev === false) { intentos.push(etiqueta + ": devolvió false"); continue; }
    const d = await estado();
    /*
     * La prueba es hasProxy Y LA RUTA COMPLETA. `hasProxy` solo podría venir de un
     * intento anterior, y comparar sólo el nombre de archivo da falso positivo con
     * dos proxies homónimos en carpetas distintas — que es lo normal si se guarda
     * un "X_PROXY.mp4" al lado de cada medio.
     */
    const norm = (s) => String(s || "").replace(/\/+$/, "");
    const mismaRuta = d.ruta && norm(d.ruta) === norm(ruta);
    if (d.tiene === true && mismaRuta) { via = etiqueta; despues = d; break; }
    intentos.push(`${etiqueta}: no tiró pero quedó tiene=${d.tiene} ruta=${d.ruta}`);
  }

  if (!via) {
    throw new Error(
      `No se pudo adjuntar el proxy a "${String(encontrado.name)}". ` +
      `Antes: tiene=${antes.tiene}, ruta=${antes.ruta}. Intentos: ${intentos.join(" | ")}.` +
      (devoluciones.length ? ` DEVOLVIERON: ${devoluciones.join(" | ")}.` : "")
    );
  }

  return {
    resumen:
      `"${String(encontrado.name)}" · proxy adjuntado vía ${via} · tiene: ${antes.tiene} → ${despues.tiene}` +
      ` · ruta ${despues.ruta}` +
      (intentos.length ? ` · descartadas: ${intentos.length} forma(s)` : "") +
      " · el proxy es del MEDIO: vale en toda secuencia que lo tenga, y el export sigue" +
      " saliendo del ORIGINAL" +
      " · ADJUNTAR NO ES USAR: Premiere reproduce el proxy sólo con Toggle Proxies activado" +
      " en el monitor de programa" +
      " · y NO hay detachProxy en la API: para sacarlo hay que hacerlo a mano en Premiere",
    medio: String(encontrado.name), via: via,
    antes: antes, despues: despues,
    intentos: intentos, devoluciones: devoluciones
  };
}

/**
 * Un subclip: un pedazo con nombre de un medio, en el panel de proyecto.
 *
 * Sirve para partir una toma larga en selects nombrados sin cortar nada en el
 * timeline: el subclip apunta al mismo archivo con otro in/out.
 *
 * `createSubClipAction` declara aridad 0 y miente. El antecedente de ExtendScript
 * es `createSubClip(nombre, inicio, fin, límitesDuros, tomarVideo, tomarAudio)`, así
 * que se enumeran esas formas y sus recortes.
 *
 * La prueba NO es que la transacción devuelva true: es que aparezca un ProjectItem
 * NUEVO con el nombre pedido. Se cuenta antes y después.
 */
async function subclip(params) {
  const project = await getProyecto();
  if (!params.medio) throw new Error("Falta `medio`: el nombre del medio a recortar.");
  if (!params.nombre) throw new Error("Falta `nombre`: cómo se va a llamar el subclip.");
  const desde = Number(params.desde);
  const hasta = Number(params.hasta);
  if (!(hasta > desde) || !(desde >= 0)) {
    throw new Error(`El rango no avanza: desde ${params.desde} hasta ${params.hasta}.`);
  }

  const encontrado = await buscarMedio(project, params.medio);
  let clipItem = null;
  try { clipItem = ppro.ClipProjectItem.cast(encontrado); } catch (e) { clipItem = null; }
  if (!clipItem) throw new Error(`No se pudo castear "${String(encontrado.name)}" a ClipProjectItem.`);

  /* Recorrido único del panel: se listan los nombres para saber si el subclip
   * apareció y para no chocar con uno que ya exista. */
  const nombres = async () => {
    const out = [];
    const ver = async (item, prof) => {
      if (prof > 8) return;
      const hijos = await hijosDe(item);
      if (!hijos) return;
      for (let i = 0; i < hijos.length; i++) {
        const sub = await hijosDe(hijos[i]);
        if (sub === null) out.push(String(hijos[i].name));
        else await ver(hijos[i], prof + 1);
      }
    };
    await ver(await project.getRootItem(), 0);
    return out;
  };
  const antes = await nombres();
  if (antes.indexOf(params.nombre) !== -1) {
    throw new Error(`Ya hay un item llamado "${params.nombre}" en el proyecto. Elegí otro nombre.`);
  }

  const dur = params.duros === undefined ? true : !!params.duros;
  const formas = [
    ["(nombre, desde, hasta, duros, video, audio)",
      () => clipItem.createSubClipAction(params.nombre, aTick(desde), aTick(hasta), dur, true, true)],
    ["(nombre, desde, hasta, duros)",
      () => clipItem.createSubClipAction(params.nombre, aTick(desde), aTick(hasta), dur)],
    ["(nombre, desde, hasta)",
      () => clipItem.createSubClipAction(params.nombre, aTick(desde), aTick(hasta))],
    ["(nombre, desde, hasta, duros, video, audio) con segundos",
      () => clipItem.createSubClipAction(params.nombre, desde, hasta, dur, true, true)],
    ["(nombre, desde, hasta) con segundos",
      () => clipItem.createSubClipAction(params.nombre, desde, hasta)]
  ];

  const intentos = [];
  let via = null, despues = null;
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  let primera = true;
  for (const [etiqueta, hacer] of formas) {
    if (!primera) await esperar(1200);
    primera = false;
    let ok = false, error = null;
    try {
      project.lockedAccess(() => {
        ok = project.executeTransaction((a) => { a.addAction(hacer()); }, "crear el subclip");
      });
    } catch (e) { error = e && e.message ? e.message : String(e); }
    if (error) { intentos.push(etiqueta + ": " + error); continue; }
    if (!ok) { intentos.push(etiqueta + ": executeTransaction devolvió false"); continue; }
    const ahora = await nombres();
    if (ahora.indexOf(params.nombre) !== -1) { via = etiqueta; despues = ahora; break; }
    intentos.push(`${etiqueta}: committeó pero NO apareció "${params.nombre}"`);
  }

  if (!via) {
    throw new Error(
      `No se pudo crear el subclip "${params.nombre}" de "${String(encontrado.name)}". ` +
      `El proyecto tenía ${antes.length} item(s). Intentos: ${intentos.join(" | ")}.`
    );
  }

  return {
    resumen:
      `Subclip "${params.nombre}" de "${String(encontrado.name)}" · ${desde.toFixed(2)}–${hasta.toFixed(2)}s ` +
      `(${(hasta - desde).toFixed(2)}s) · vía ${via} · el panel pasó de ${antes.length} a ${despues.length} item(s)` +
      (dur ? " · con límites duros" : " · sin límites duros: se puede extender más allá del rango") +
      (intentos.length ? ` · descartadas: ${intentos.length} forma(s)` : "") +
      " · un Cmd+Z lo saca",
    subclip: params.nombre, medio: String(encontrado.name),
    desde: desde, hasta: hasta, dura: Number((hasta - desde).toFixed(3)),
    itemsAntes: antes.length, itemsDespues: despues.length,
    via: via, intentos: intentos
  };
}

/**
 * Renombrar una PISTA de la secuencia.
 *
 * Verbo aparte y no un modo de `renombrar` a propósito: ahí `pista` sirve para
 * UBICAR un clip, y darle un segundo significado en el mismo verbo haría que
 * `{pista: "V2", nuevo: "X"}` fuera ambiguo entre renombrar el clip de V2 y
 * renombrar la pista V2. Dos cosas distintas, dos verbos.
 *
 * `createSetNameAction` está tanto en VideoTrack como en AudioTrack.
 *
 * MEDIDO: un string VACÍO no devuelve la pista al default, le pone el nombre literal
 * "". Estuvo escrito acá que sí —sin probarlo— y es falso. **No se conoce forma de
 * restaurar el nombre dinámico** ("Video 2", que Premiere deriva del índice): sólo se
 * puede escribir un literal que se vea igual. Por eso el verbo AVISA cuando se le
 * pasa vacío, en vez de prometer un reset que no hace.
 */
async function renombrarPista(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  if (typeof params.nuevo !== "string") {
    throw new Error("Falta `nuevo`: el nombre que va a tener la pista.");
  }
  const etiqueta = String(params.pista || "").trim().toUpperCase();
  const m = /^([VA])(\d+)$/.exec(etiqueta);
  if (!m) throw new Error(`Falta \`pista\` con formato "V2" o "A1". Vino: "${params.pista}".`);
  const esAudio = m[1] === "A";
  const idx = Number(m[2]) - 1;   // en el timeline V1 es la primera

  const cuantas = esAudio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount();
  if (idx < 0 || idx >= cuantas) {
    throw new Error(`La secuencia tiene ${cuantas} pista(s) de ${esAudio ? "audio" : "video"}, y se pidió ${etiqueta}.`);
  }
  const track = esAudio ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
  if (!track) throw new Error(`No se pudo tomar la pista ${etiqueta}.`);

  const antes = String(track.name);
  // El vacío se acepta pero se avisa: no es un reset, es un nombre vacío.
  const esVacio = params.nuevo === "";

  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        a.addAction(track.createSetNameAction(params.nuevo));
      }, "renombrar la pista");
    });
  } catch (e) { error = e && e.message ? e.message : String(e); }

  /* SE RELEE. El booleano no prueba que el nombre entró, y acá además hay que volver
   * a PEDIR la pista: el objeto viejo puede tener el nombre cacheado. */
  const track2 = esAudio ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
  const despues = String(track2 ? track2.name : "");
  const quedo = despues === params.nuevo;

  return {
    resumen:
      `${etiqueta}: "${antes}" → "${despues}"` +
      (esVacio ? " · OJO: vacío NO es volver al default, es un nombre VACÍO; el default dinámico no se puede restaurar por API" : "") +
      (quedo ? " · un Cmd+Z lo saca"
             : ` · NO QUEDÓ COMO SE PIDIÓ ("${params.nuevo}"), transacción ${ok}` + (error ? ` · ${error}` : "")),
    pista: etiqueta, antes: antes, despues: despues, quedo: quedo, transaccion: ok
  };
}


/*
 * Desactiva o reactiva clips: el ojito del clip, no el de la pista.
 *
 * Existe por los SUPLENTES. Poniendo alternativas en las pistas de arriba, tapan al corte
 * —en Premiere gana la de arriba—, así que la secuencia no se puede ver. Desactivadas
 * quedan a la vista en el timeline como opciones y no interfieren con la reproducción.
 *
 * `createSetDisabledAction` e `isDisabled` viven en `VideoClipTrackItem`, los dos
 * reflejados el 2026-08-20 antes de escribir esto.
 *
 * SIN `indice` NI `nombre` opera sobre LA PISTA ENTERA, y eso es a propósito: el caso real
 * son sesenta suplentes, y sesenta transacciones en ráfaga tiran Premiere con SIGSEGV. Van
 * todas en UNA.
 *
 * Y exige objetivo: un `{}` suelto desactivaría la secuencia entera, que es la clase de
 * sorpresa que este repo ya pagó con `etiquetar`.
 */
async function desactivar(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const activar = params.activar === true;      // por default DESACTIVA
  const etiqueta = typeof params.pista === "number" ? "V" + params.pista
    : typeof params.pista === "string" ? params.pista.toUpperCase() : null;
  const unoSolo = typeof params.indice === "number" || typeof params.nombre === "string";

  if (!etiqueta && !unoSolo) {
    throw new Error(
      "Falta objetivo: `pista` (\"V2\") para toda la pista, o `pista`+`indice`, o `nombre`. " +
      "Sin objetivo esto desactivaría la secuencia entera."
    );
  }

  /* Los clips a tocar. */
  let items = [], donde = "";
  if (unoSolo) {
    const e = await ubicarClip(sequence, params);
    items = [{ clip: e.clip, nombre: e.nombre, pista: e.pista, indice: e.indice }];
    donde = `${e.pista}[${e.indice}] "${e.nombre}"`;
  } else {
    const m = /^([VA])(\d+)$/.exec(etiqueta);
    if (!m) throw new Error(`\`pista\` tiene que ser "V2" o "A1". Vino: "${params.pista}".`);
    const esAudio = m[1] === "A";
    const idx = Number(m[2]) - 1;
    const cuantas = esAudio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount();
    if (idx < 0 || idx >= cuantas) {
      throw new Error(`La secuencia tiene ${cuantas} pista(s) de ${esAudio ? "audio" : "video"}, y se pidió ${etiqueta}.`);
    }
    const track = esAudio ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
    const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (let i = 0; i < its.length; i++) {
      items.push({ clip: its[i], nombre: String(await its[i].getName()), pista: etiqueta, indice: i });
    }
    donde = `${etiqueta} entera (${items.length} clip(s))`;
  }
  if (!items.length) return { resumen: `${donde}: no hay clips, NO CAMBIÓ NADA.`, tocados: 0 };

  /*
   * LOS VINCULADOS, con UNA sola pasada sobre las pistas del otro tipo.
   *
   * `buscarVinculados` recorre TODAS las pistas por CADA clip. Este verbo existe
   * para tandas de sesenta suplentes, asi que llamarlo por clip serian sesenta
   * recorridos — el patron de ~139.000 llamadas que la revision del 2026-08-20
   * puso primero en la lista de lo que puede destruir trabajo. Aca se indexa el
   * otro tipo UNA vez y se empareja por (origen, inicioTicks, finTicks), que es
   * exactamente la regla de `buscarVinculados`, pagada una vez y no N.
   *
   * Por que hace falta: sin esto, apagar V2 dejaba SONANDO A2. Ya mordio — el
   * paliativo fue mutear A2/A3/A4 a mano en VIAJE.
   */
  const traerSocios = params.vinculados !== false;
  const socios = [];
  if (traerSocios) {
    const hayVideo = items.some((it) => it.pista[0] === "V");
    const hayAudio = items.some((it) => it.pista[0] === "A");
    const indice = new Map();
    const grupos = [];
    if (hayVideo) grupos.push({ cuantas: await sequence.getAudioTrackCount(), traer: (i) => sequence.getAudioTrack(i), et: "A" });
    if (hayAudio) grupos.push({ cuantas: await sequence.getVideoTrackCount(), traer: (i) => sequence.getVideoTrack(i), et: "V" });
    for (const g of grupos) {
      for (let t = 0; t < g.cuantas; t++) {
        const track = await g.traer(t);
        if (!track) continue;
        const its = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
        for (let i = 0; i < its.length; i++) {
          let nom = null;
          try { nom = String((await its[i].getProjectItem()).name); } catch (e) { nom = null; }
          const k = `${g.et}|${nom}|${String((await its[i].getStartTime()).ticks)}|${String((await its[i].getEndTime()).ticks)}`;
          if (!indice.has(k)) indice.set(k, { clip: its[i], pista: g.et + (t + 1), indice: i });
        }
      }
    }
    for (const it of items) {
      const otro = it.pista[0] === "V" ? "A" : "V";
      let nom = null;
      try { nom = String((await it.clip.getProjectItem()).name); } catch (e) { nom = null; }
      const k = `${otro}|${nom}|${String((await it.clip.getStartTime()).ticks)}|${String((await it.clip.getEndTime()).ticks)}`;
      socios.push(nom ? (indice.get(k) || null) : null);
    }
  }
  const conSocio = socios.filter(Boolean).length;

  /* El ANTES, leído clip por clip: `isDisabled` puede no existir en clips de audio. */
  const antes = [];
  let sinLeer = 0;
  for (const it of items) {
    let v = null;
    try { v = await it.clip.isDisabled(); } catch (e) { sinLeer++; }
    antes.push(v);
  }
  const yaEstaban = antes.filter((x) => x === !activar).length;

  let ok = false, error = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        for (const it of items) a.addAction(it.clip.createSetDisabledAction(!activar));
        /* En la MISMA transaccion: un solo Cmd+Z saca el video y su audio juntos. */
        for (const s of socios) if (s) a.addAction(s.clip.createSetDisabledAction(!activar));
      }, activar ? "reactivar clips" : "desactivar clips");
    });
  } catch (e) { error = e && e.message ? e.message : String(e); }

  /* SE RELEE, y volviendo a PEDIR los items: el objeto viejo puede tener el estado
   * cacheado, que es lo que ya pasó con el nombre de pista en `renombrarPista`. */
  let quedaron = 0, noSeSabe = 0;
  const grupos = {};
  for (const it of items) (grupos[it.pista] = grupos[it.pista] || []).push(it);
  for (const pista of Object.keys(grupos)) {
    const m2 = /^([VA])(\d+)$/.exec(pista);
    const esA = m2[1] === "A", ix = Number(m2[2]) - 1;
    const track2 = esA ? await sequence.getAudioTrack(ix) : await sequence.getVideoTrack(ix);
    const its2 = await track2.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const it of grupos[pista]) {
      const c = its2[it.indice];
      if (!c) { noSeSabe++; continue; }
      try { if ((await c.isDisabled()) === !activar) quedaron++; } catch (e) { noSeSabe++; }
    }
  }

  /* Los socios tambien se releen: que la accion entrara no prueba que el estado quedo. */
  let sociosOk = 0;
  for (const so of socios) {
    if (!so) continue;
    try { if ((await so.clip.isDisabled()) === !activar) sociosOk++; } catch (e) { /* audio sin getter */ }
  }

  /*
   * EL VEREDICTO MIRA EL CAMBIO, NO EL ESTADO.
   *
   * `quedaron` cuenta cuantos ESTAN como se pidio, y eso incluye a los que YA
   * estaban. La version vieja elegia la rama de exito con `quedaron === total`
   * ignorando `ok`, asi que sobre una pista ya desactivada afirmaba "UN Cmd+Z los
   * saca todos" aunque la transaccion no hubiera corrido — y ese Cmd+Z deshace la
   * operacion ANTERIOR. Es el modo de fallar nº1 de CLAUDE.md escondido en un mensaje.
   */
  const pedido = activar ? "reactivar" : "desactivar";
  const cambiaron = Math.max(0, quedaron - yaEstaban);
  let veredicto;
  if (!ok) {
    veredicto = ` · LA TRANSACCIÓN NO CORRIÓ (ok=false): NADA de esto se aplicó` + (error ? ` · ${error}` : "");
  } else if (cambiaron === 0) {
    veredicto = ` · NO CAMBIÓ NADA: ya estaban así. NO hay Cmd+Z que deshacer acá`;
  } else if (quedaron === items.length) {
    veredicto = ` · UN Cmd+Z los saca todos, van en una sola transacción`;
  } else {
    veredicto = ` · NO QUEDÓ COMO SE PIDIÓ, transacción ${ok}` + (error ? ` · ${error}` : "");
  }

  return {
    resumen:
      `${donde}: ${pedido} · ${quedaron} de ${items.length} quedaron ${activar ? "activos" : "desactivados"}` +
      (cambiaron !== quedaron ? ` (${cambiaron} cambiaron, ${yaEstaban} ya estaban así)` : "") +
      (conSocio ? ` · ${sociosOk} de ${conSocio} vinculado(s) también` : "") +
      (traerSocios && !conSocio ? ` · sin vinculados que arrastrar` : "") +
      (!traerSocios ? ` · vinculados NO tocados (se pidió vinculados:false)` : "") +
      (noSeSabe ? ` · ${noSeSabe} no se pudo releer` : "") +
      (sinLeer ? ` · ${sinLeer} sin isDisabled (¿audio?)` : "") +
      veredicto,
    donde: donde, pedido: pedido, total: items.length, quedaron: quedaron,
    cambiaron: cambiaron, yaEstaban: yaEstaban,
    vinculados: conSocio, vinculadosOk: sociosOk, transaccion: ok
  };
}

/**
 * Todo lo que hay que saber de una pista para poder RECONSTRUIRLA sin perder nada.
 *
 * ## Para qué existe
 *
 * El flujo de armado es GENERATIVO: se barre la pista y se rehace desde un JSON. Eso pisa
 * cualquier cosa que el usuario haya hecho a mano — una exposición corregida con Lumetri, una
 * rotación, un clip deshabilitado, un plano corrido un frame, un cambio de velocidad.
 *
 * Hasta ahora eso se compensaba REAPLICANDO DE MEMORIA lo que yo recordaba haberle visto
 * hacer. Es el peor modo de fallar posible: si me olvido uno, no hay error, no hay aviso, y el
 * trabajo del usuario desaparece. El 2026-08-21 casi se perdieron tres correcciones de
 * exposición porque el efecto se llama "Lumetri Color" y yo buscaba "Lumetri": el verbo no
 * encontró nada, un `catch` vacío se comió el error, y yo informé "nada distinto del default"
 * habiendo leído cero.
 *
 * Este verbo cambia la pregunta. No informa "salió bien": informa **qué se perdería si
 * reconstruyo**, clip por clip, leído de la secuencia y no de mis notas.
 *
 * ## El triage, que es lo que lo hace barato
 *
 * Leer 130 params de Lumetri en 88 clips es la clase de ráfaga que tira Premiere. No hace
 * falta: un clip de video INTACTO trae exactamente **2 componentes** (Opacity y Motion),
 * medido el 2026-08-21 sobre cuatro clips —tres intactos con 2, y el que el usuario había
 * tocado con 3—. Así que `getComponentCount()` sola, que es UNA llamada, dice si hay algo
 * agregado; los params completos se leen sólo ahí.
 *
 * De Motion no se lee todo: se leen CINCO params por nombre (Scale, Scale Height, Position,
 * Rotation, Anchor Point). Es una lista fija y corta, y cubre lo que el usuario toca.
 *
 ## SEGUNDA CORRECCIÓN: por defecto NO se lee NINGÚN param (2026-08-21, tras el segundo crash)

 El verbo tiró Premiere DOS veces, con el mismo stack las dos, y la segunda ya con los topes
 puestos (`limite` 12, `maxParams` 40) y sin nada más ocupando la máquina. Los topes bajaron
 las lecturas de ~830 a ~560: un 30%, así que esa corrida NO distinguió volumen de mecanismo.

 Lo que sí distingue es comparar contra `clips`, que hace ~530 awaits sobre los mismos 88
 clips —getName, tres tiempos, velocidad, capa de ajuste— y **nunca crasheó**. La diferencia
 no es la cantidad de llamadas: es que `radiografia` además pedía valores sobre OBJETOS DE
 PARAM sacados de un `lockedAccess` ya cerrado. La promesa que revienta lleva justamente un
 `IntrusivePtr<AnonObject>`, y este archivo ya tenía anotado que "una referencia sacada de un
 lock no sirve afuera".

 Así que el default ahora es **cero lecturas de param**: el barrido usa sólo getters simples
 —los mismos que `clips`— más `getComponentCount()` y los nombres de los componentes. Con eso
 alcanza para el triage, que es la pregunta del verbo:

   - 2 componentes y velocidad 1 y ojito prendido  ->  intacto, se puede rehacer
   - cualquier otra cosa                            ->  hay trabajo manual acá

 Los VALORES se leen después, con el verbo `param`, **de a uno y con pausa** — que es el camino
 que usan `fijar` y `param` desde siempre y no crasheó nunca. Para el caso real son 6 clips y
 ~22 llamadas: media pausa de reloj, y a cambio no se cae.

 ## TERCER CRASH: `conParams` SE ELIMINÓ, no se acotó (2026-08-21)

 Se probaron cuatro mitigaciones —topes de params, tandas más chicas, cero lecturas por
 defecto, un clip por llamada— y **se cayó igual**. La última corrida leyó 120 params en 3
 llamadas, cuando `leerEscalas` hace 176 en UNA y nunca se cayó: o sea que el modelo del
 umbral tampoco explica esto.

 Tres crashes, el mismo stack las tres veces, y este verbo en el medio siempre. Así que la
 opción no se acota: **se saca**. `radiografia` es TRIAGE y nada más — dice si un clip tiene
 algo agregado, no cuánto vale.

 Los valores se leen con verbos que ya existían y tienen años de uso:

     escala y posición  ->  `leerEscalas`   (una llamada por pista, medido)
     rotación           ->  `leerParam`     (25 por llamada, mismo patrón que leerEscalas)
     valores de efectos ->  `efectos` para los nombres y `param` de a uno para cada valor

 Es más lento —~55 llamadas contra 20— y es el intercambio correcto: la versión rápida se
 consiguió a costa de estabilidad, y eso no era un buen negocio.

 ## PRIMERA CORRECCIÓN: los valores NO se leen dentro del lock, y esto tiró Premiere
 *
 * Acá estaba escrito que "los params se leen sincrónicamente adentro de un `lockedAccess`, así
 * que N params no son N viajes: son uno". **Era falso y describía la intención, no el código.**
 * El nombre del param sí sale del lock, pero el VALOR se pedía con `await valorEnTiempo(...)`
 * afuera, uno por param: para Lumetri Color son ~130 promesas por clip, cada una sobre una
 * referencia sacada de un lock — que es el peligro que este repo ya tenía anotado ("una
 * referencia sacada de un lock no sirve afuera").
 *
 * Premiere se cayó durante un barrido, y el reporte de Sentry apunta justo ahí:
 *
 *     level        fatal
 *     threadName   dvascripting::Transient1
 *     sourceFile   NAPIContextAdapter.cpp
 *     sourceFunc   NAPIContextAdapter::CallCallback(...)
 *     category     PromiseFulfillment / resolve
 *     ValueType    IntrusivePtr<dvascripting::AnonObject>
 *
 * O sea el motor de scripting resolviendo un callback de promesa de este plugin. No es el
 * SIGBUS del `getKeyframePtr` (main thread) ni el crash de la recarga (JsTaskQueue durante la
 * descarga) ni el SIGSEGV de la ráfaga de transacciones: es un cuarto sitio.
 *
 * **Y la causa exacta NO está identificada.** El mismo barrido de 130 params corrió limpio dos
 * veces antes; la diferencia la tercera fue un `fijar` 1,2 s antes. Anotarlo como "fue el
 * volumen" sería el "medir un caso y generalizar" de este repo otra vez.
 *
 * Lo que sí se hizo es BAJAR LA EXPOSICIÓN, que no depende de acertar la causa:
 *
 * - **`maxParams`, por defecto 40.** Los params se leen en orden de índice y se informa
 *   cuántos quedaron sin leer. En Lumetri eso cubre el bloque de Basic Correction completo
 *   —donde están Exposure (19), Saturation (16) y Shadows (22), que es lo que el usuario
 *   mueve— y baja de 130 a 40 por clip.
 * - **`limite` por defecto 12** en vez de la pista entera.
 *
 * No se leen los 130 "por si acaso": un verbo de lectura que puede tirar la aplicación no es
 * un verbo de lectura seguro, y lo que no se lee se INFORMA en vez de darse por completo.
 *
 * ## El veredicto `intacto`
 *
 * Un clip es `intacto` si no tiene efectos agregados, su Motion está en los defaults, no está
 * deshabilitado y corre a 1x. Ésos son los que se pueden rehacer desde el JSON sin perder
 * nada. **Todos los demás cargan trabajo manual**, y reconstruir su pista sin restaurarlos lo
 * destruye.
 *
 * Los defaults se comparan contra los valores de fábrica de Premiere (escala 100, posición y
 * anchor 0.5/0.5, rotación 0, opacidad 100). Van declarados acá porque la API no los expone:
 * si alguno estuviera mal, el verbo diría "tocado" sobre un clip intacto — un falso positivo,
 * que en este verbo es el error barato: hace restaurar algo que ya estaba bien. El caro sería
 * el otro, y por eso la comparación es EXACTA y no con tolerancia.
 */
/*
 * ¿Se puede leer el VALOR de un param sincrónicamente adentro del `lockedAccess`?
 *
 * Es la pregunta que decide si `radiografia` cuesta 12 llamadas o 136. Si adentro del lock el
 * getter devuelve el valor, un solo lock lee los 130 params sin un await y sin que ninguna
 * referencia se escape — que es la causa señalada de los dos crashes. Si devuelve una Promise,
 * no sirve: awaitearla afuera es exactamente lo que se está tratando de evitar.
 *
 * Se prueban VARIOS getters y se informa el `typeof` de cada uno, sin dar ninguno por bueno.
 * El repo ya tiene el antecedente contrario: `getInPoint` adentro de un lock devuelve una
 * Promise que es truthy y pasa cualquier guarda `if (x)`.
 */
/*
 * UN param, para un RANGO de clips, en una llamada.
 *
 * Existe por eficiencia y con un límite que sale de una medición, no de una intuición.
 *
 * No hay forma de leer el valor de un param sincrónicamente: se probaron `getValueAtTime`,
 * `getValue`, `value` y `getStartValue` adentro de un `lockedAccess` sobre Motion y sobre
 * Lumetri, y todos devuelven Promise o no existen. Así que N valores son N promesas, siempre.
 *
 * Lo que decide si eso crashea es CUÁNTAS entran en una sola tarea de script:
 *
 *     param / fijar        1 lectura por llamada     nunca falló
 *     leerEscalas        ~176 por llamada            medido: 6 vueltas, sin caerse
 *     radiografia        ~560 por llamada            se cayó 2 de 2
 *
 * El umbral exacto NO está medido; lo que está medido son esos tres puntos. Este verbo se
 * queda del lado seguro: `limite` por defecto **25**, o sea 25 lecturas por llamada, siete
 * veces menos que lo probado bueno. Para 88 clips son 4 llamadas en vez de 88.
 *
 * `indiceParam` gana sobre `param`, porque en Lumetri los nombres se repiten y resolver por
 * nombre agarra el primero.
 */
async function leerParam(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const etiqueta = typeof params.pista === "number" ? "V" + params.pista
    : typeof params.pista === "string" ? String(params.pista).toUpperCase() : null;
  if (!etiqueta) throw new Error('Falta `pista` ("V1").');
  const m = /^([VA])(\d+)$/.exec(etiqueta);
  if (!m) throw new Error(`\`pista\` tiene que ser "V1" o "A1". Vino: "${params.pista}".`);
  const esAudio = m[1] === "A";
  const idx = Number(m[2]) - 1;
  const cuantas = esAudio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount();
  if (idx < 0 || idx >= cuantas) throw new Error(`No existe ${etiqueta}: hay ${cuantas} pista(s).`);
  const track = esAudio ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const efecto = params.efecto || "Motion";
  const nombreParam = typeof params.param === "string" ? params.param : null;
  const iParam = typeof params.indiceParam === "number" ? params.indiceParam : null;
  if (nombreParam === null && iParam === null) throw new Error("Falta `param` o `indiceParam`.");

  const desdeI = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  /* 25 por defecto: ver el encabezado. Subirlo se acerca al régimen que tiró Premiere. */
  const TOPE = typeof params.limite === "number" ? Math.min(params.limite, 60) : 25;
  const hastaI = Math.min(items.length, desdeI + TOPE);

  const salida = [];
  for (let i = desdeI; i < hastaI; i++) {
    const fila = { indice: i, nombre: null, valor: null, keyframes: null, param: null };
    try {
      fila.nombre = String(await items[i].getName());
      const comp = await getComponente(items[i], efecto);
      if (!comp) { fila.sinEfecto = true; salida.push(fila); continue; }
      let p = null;
      if (iParam !== null) {
        project.lockedAccess(() => {
          const n = comp.getParamCount();
          if (iParam < n) { const q = comp.getParam(iParam); fila.param = String(q.displayName); p = q; }
        });
        /* El nombre se COMPRUEBA si vino: que el índice apunte a otro param significa que la
         * cadena de efectos de ESTE clip no es la del que se leyó antes, y devolver su valor
         * como si fuera el pedido sería el peor resultado posible. */
        if (p && nombreParam && fila.param !== nombreParam) {
          fila.error = `el índice ${iParam} acá es "${fila.param}", no "${nombreParam}"`;
          salida.push(fila); continue;
        }
      } else {
        p = getParametro(project, comp, nombreParam);
        fila.param = nombreParam;
      }
      if (!p) { fila.error = "no expuso el param"; salida.push(fila); continue; }
      const v = await valorEnTiempo(project, p, (await relojDelClip(items[i])).aMaterial(aTick((await tiemposDe(items[i])).desde)));
      const num = aNumero(v), pt = aPunto(v);
      fila.valor = num !== null && num !== undefined ? Number(Number(num).toFixed(4))
        : pt ? [Number(pt.x.toFixed(4)), Number(pt.y.toFixed(4))] : null;
      fila.keyframes = contarKeyframes(project, p);
    } catch (e) { fila.error = e && e.message ? e.message : String(e); }
    salida.push(fila);
  }

  const conError = salida.filter((f) => f.error);
  return {
    resumen: `${etiqueta} · ${efecto} > ${nombreParam || "#" + iParam} · leídos ${salida.length} de ${items.length}` +
      (conError.length ? ` · ${conError.length} CON ERROR: ` + conError.slice(0, 3).map((f) => `[${f.indice}] ${f.error}`).join("; ") : "") +
      ` · ` + salida.filter((f) => f.valor !== null).map((f) => `[${f.indice}]=${JSON.stringify(f.valor)}${f.keyframes ? "/" + f.keyframes + "kf" : ""}`).join(" ") +
      (hastaI < items.length ? ` · FALTAN desde ${hastaI}` : ""),
    pista: etiqueta, efecto: efecto, clips: salida, total: items.length,
    siguiente: hastaI < items.length ? hastaI : null
  };
}

async function sondaParam(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const enc = await ubicarClip(sequence, params);
  const efecto = params.efecto || "Motion";
  const comp = await getComponente(enc.clip, efecto);
  if (!comp) throw new Error(`"${enc.nombre}" no tiene "${efecto}".`);
  const reloj = await relojDelClip(enc.clip);
  const t = await tiemposDe(enc.clip);
  const tick = reloj.aMaterial(aTick(t.desde));

  const filas = [];
  let reflejo = null;
  project.lockedAccess(() => {
    const n = comp.getParamCount();
    const idx = typeof params.indiceParam === "number" ? params.indiceParam : 0;
    const p = comp.getParam(Math.min(idx, n - 1));
    const nom = String(p.displayName);
    for (const via of ["getValueAtTime", "getValue", "value", "getStartValue"]) {
      let tipo = "no existe", muestra = null;
      try {
        if (via === "value") {
          const v = p.value;
          tipo = v === undefined ? "undefined" : (v && typeof v.then === "function") ? "PROMISE" : typeof v;
          muestra = tipo === "object" || tipo === "number" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 40);
        } else if (typeof p[via] === "function") {
          const v = via === "getValueAtTime" ? p[via](tick) : p[via]();
          tipo = (v && typeof v.then === "function") ? "PROMISE" : typeof v;
          muestra = JSON.stringify(v) ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 40);
        }
      } catch (e) { tipo = "TIRÓ"; muestra = String(e && e.message ? e.message : e).slice(0, 70); }
      filas.push({ via: via, tipo: tipo, muestra: muestra });
    }
    filas.push({ via: "(param)", tipo: "info", muestra: `"${nom}" índice ${Math.min(idx, n - 1)} de ${n}` });

    /*
     * `metodos: true` REFLEJA el param vivo: la clase no está a nivel de módulo, así que
     * `api` no llega. Lee NOMBRES recorriendo la cadena de prototipos y no llama a ninguno
     * —una sonda que enumeró llamando getters crasheó Premiere en MZH—. Hace falta para
     * diseñar `borrarKeyframe` sobre la firma real en vez de adivinarla.
     */
    if (params.metodos) {
      const vistos = [];
      let o = p;
      for (let d = 0; o && d < 5; d++) {
        const propios = Object.getOwnPropertyNames(o);
        for (let i = 0; i < propios.length; i++) if (vistos.indexOf(propios[i]) === -1) vistos.push(propios[i]);
        o = Object.getPrototypeOf(o);
      }
      reflejo = vistos.sort();
    }
  });

  return {
    resumen: `"${enc.nombre}" · ${efecto} · ` +
      filas.map((f) => `${f.via}: ${f.tipo}${f.muestra ? " = " + f.muestra : ""}`).join(" · ") +
      " · SIRVE si algún typeof NO es PROMISE" +
      (reflejo ? ` · ${reflejo.length} miembros reflejados` : ""),
    metodos: reflejo,
    vias: filas
  };
}

async function radiografia(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const etiqueta = typeof params.pista === "number" ? "V" + params.pista
    : typeof params.pista === "string" ? String(params.pista).toUpperCase() : null;
  /* Objetivo obligatorio: sin pista esto barrería 30 pistas y sería justo la ráfaga que se
   * está tratando de evitar. */
  if (!etiqueta) throw new Error('Falta `pista` ("V1", "A1"). Sin objetivo esto recorrería la secuencia entera.');
  const m = /^([VA])(\d+)$/.exec(etiqueta);
  if (!m) throw new Error(`\`pista\` tiene que ser "V1" o "A1". Vino: "${params.pista}".`);
  const esAudio = m[1] === "A";
  const idx = Number(m[2]) - 1;
  const cuantas = esAudio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount();
  if (idx < 0 || idx >= cuantas) {
    throw new Error(`La secuencia tiene ${cuantas} pista(s) de ${esAudio ? "audio" : "video"}, y se pidió ${etiqueta}.`);
  }
  const track = esAudio ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

  const desdeI = typeof params.desdeIndice === "number" ? params.desdeIndice : 0;
  /* `limite` por defecto 12 y no "todos": ver el encabezado. Un barrido de la pista entera es
   * una sola llamada de la que no se vuelve si se cae. */
  const hastaI = Math.min(items.length, desdeI + (typeof params.limite === "number" ? params.limite : 12));
  const MAXP = typeof params.maxParams === "number" ? params.maxParams : 40;
  /* CERO lecturas de param, sin excepción. Ver el encabezado: la opción existió, crasheó tres
   * veces, y se eliminó. Si llega `conParams` se rechaza en vez de ignorarlo en silencio —un
   * parámetro que no hace nada es peor que un error, porque el llamador cree que lo aplicó. */
  if (params.conParams !== undefined) {
    throw new Error(
      "`conParams` ya no existe: leer params acá tiró Premiere tres veces (PromiseFulfillment). " +
      "Usá `leerEscalas` para escala/posición, `leerParam` para un param por tandas, y `param` " +
      "de a uno para los valores de un efecto."
    );
  }
  const CON_PARAMS = false;

  /* Los componentes que trae CUALQUIER clip sin que nadie lo toque. Todo lo que no esté acá
   * es algo que el usuario agregó, y se lee completo. */
  const BASE_VIDEO = ["Opacity", "Motion"];
  const BASE_AUDIO = ["Volume", "Channel Volume", "Panner"];
  const base = esAudio ? BASE_AUDIO : BASE_VIDEO;
  const MOTION = ["Scale", "Scale Height", "Position", "Rotation", "Anchor Point"];
  /* Defaults de fábrica. Ver el encabezado: la comparación es exacta a propósito. */
  const DEF = { "Scale": 100, "Scale Height": 100, "Rotation": 0, "Opacity": 100 };
  const DEF_PUNTO = { "Position": [0.5, 0.5], "Anchor Point": [0.5, 0.5] };

  const salida = [];
  let conTrabajo = 0, sinVerificar = 0;
  for (let i = desdeI; i < hastaI; i++) {
    const it = items[i];
    const t = await tiemposDe(it);
    const vel = await velocidadDe(it);
    const fila = {
      pista: etiqueta, indice: i, nombre: String(await it.getName()),
      desde: t.desde, hasta: t.hasta, dura: Number((t.hasta - t.desde).toFixed(3)),
      entrada: t.entrada,
      /* `salida` es el punto DE FUENTE donde termina, que es lo que pide `editar salida`.
       * Se calcula con la velocidad porque a 2x el clip consume el doble de material. */
      salida: Number((t.entrada + (t.hasta - t.desde) * (vel || 1)).toFixed(3)),
      velocidad: vel, desactivado: null, esCapaDeAjuste: await esCapaDeAjuste(it),
      motion: null, efectos: [], tocado: [], intacto: true
    };
    try { fila.desactivado = await it.isDisabled(); } catch (e) { /* los de audio no lo tienen */ }
    if (fila.desactivado === true) fila.tocado.push("DESHABILITADO");
    if (vel !== null && vel !== 1) fila.tocado.push("velocidad " + vel);

    try {
      const chain = await it.getComponentChain();
      const n = await chain.getComponentCount();
      const reloj = await relojDelClip(it);
      const enMaterial = reloj.aMaterial(aTick(t.desde));
      for (let c = 0; c < n; c++) {
        const comp = await chain.getComponentAtIndex(c);
        const nombre = String(await comp.getDisplayName());
        /* TRIAGE Y NADA MÁS: se registra QUÉ hay, nunca cuánto vale.
         *
         * Leer valores acá tiró Premiere tres veces con el mismo stack. No queda ni el código
         * para hacerlo: dejarlo apagado detrás de un flag es una invitación a prenderlo. Los
         * valores se piden con `leerEscalas`, `leerParam` o `param`. */
        if (base.indexOf(nombre) === -1) {
          fila.efectos.push({ nombre: nombre, params: [], valoresSinLeer: true });
          fila.tocado.push("efecto " + nombre + " (valores SIN LEER: pedilos con `param`)");
        } else if (nombre === "Motion") {
          /* Que Motion esté en su default NO se puede saber sin leerlo, así que el clip queda
           * marcado como no verificado en vez de como limpio. Ver el veredicto de tres estados
           * más abajo: `null` no es `true`. */
          fila.motionSinLeer = true;
        }
      }
    } catch (e) {
      /* Se INFORMA. Un catch vacío acá es exactamente el bug que hizo escribir este verbo. */
      fila.error = e && e.message ? e.message : String(e);
      fila.tocado.push("NO SE PUDO LEER: " + fila.error);
    }
    /* `intacto` es TRES estados, no dos.
     *
     * Sin leer los params de Motion no se puede saber si un clip está rotado o escalado, y
     * declararlo `intacto` sería decir "se puede rehacer sin perder nada" sobre un clip que
     * SÍ tiene trabajo — que es exactamente el fallo que este verbo existe para evitar. Cuatro
     * de los seis clips con trabajo del proyecto real son sólo una rotación.
     *
     * Así que: true = verificado y limpio, false = tiene trabajo, **null = NO SE SABE**. Un
     * null se trata como "tiene trabajo" para cualquier decisión destructiva. */
    if (fila.tocado.length) fila.intacto = false;
    else if (fila.motionSinLeer) fila.intacto = null;
    else fila.intacto = true;
    if (fila.intacto === false) conTrabajo++;
    if (fila.intacto === null) sinVerificar++;
    salida.push(fila);
  }

  /*
   * LAS DOS POBLACIONES SE INFORMAN APARTE, y la política no cambia.
   *
   * Esto era `salida.filter((c) => !c.intacto)`, y `!null` es true igual que
   * `!false`, así que metía en la misma bolsa los clips con trabajo DETECTADO y
   * los que sólo NO SE PUDIERON VERIFICAR. Como `BASE_VIDEO` es
   * ["Opacity", "Motion"] y un clip de video intacto trae exactamente esos dos,
   * el `motionSinLeer` se prende en TODO clip de video: la bolsa quedaba llena de
   * nulls.
   *
   * Tres cosas salían mal de ahí, y las tres son del INFORME —que es lo único que
   * se lee, por la regla de este archivo—:
   *   · los nulls se listaban con la flecha VACÍA (`→ ` y nada), porque su
   *     `tocado` está vacío por definición;
   *   · se contaban OTRA VEZ en la cláusula del `SIN VERIFICAR`, o sea el mismo
   *     clip dos veces en dos cláusulas que se leen distinto;
   *   · y el resumen decía `conT.length` mientras el payload decía `conTrabajo`,
   *     que sólo cuenta los `=== false`: dos números para lo mismo en la misma
   *     respuesta.
   *
   * Lo que NO se toca es que un null cuente como "no destruir": está declarado
   * arriba y es el lado seguro. Lo que se arregla es decir CUÁL de las dos cosas
   * es cada uno.
   */
  const conT = salida.filter((c) => c.intacto === false);
  const sinV = salida.filter((c) => c.intacto === null);
  return {
    resumen:
      `${etiqueta}: radiografiados ${salida.length} de ${items.length} clips` +
      " (triage: sin leer params; los valores se piden con `leerParam` o `param`) · " +
      (conT.length
        ? `${conT.length} CON TRABAJO DETECTADO que una reconstrucción destruiría: ` +
          conT.map((c) => `${c.pista}[${c.indice}] "${c.nombre}" → ${c.tocado.join("; ")}`).join(" · ")
        : "ninguno con trabajo DETECTADO") +
      (sinV.length
        ? ` · y ${sinV.length} SIN VERIFICAR, que NO es lo mismo que intacto: no se leyeron sus params, ` +
          `así que una rotación o una escala ahí no se detecta. Para cualquier decisión destructiva ` +
          `cuentan como tocados. Leelos con \`param\` antes de rehacer la pista: ` +
          sinV.map((c) => `${c.pista}[${c.indice}]`).join(", ")
        : "") +
      (hastaI < items.length ? ` · FALTAN desde ${hastaI}` : ""),
    pista: etiqueta, clips: salida, total: items.length, conParams: CON_PARAMS,
    conTrabajo: conTrabajo, sinVerificar: sinVerificar, siguiente: hastaI < items.length ? hastaI : null
  };
}

/**
 * Colocar N fragmentos agrupando las escrituras en pocas transacciones.
 *
 * POR QUE EXISTE: `colocar_fragmentos.js` hace tres transacciones por fragmento
 * —insertar en un limbo, recortar ahi, mover a su lugar— porque el overwrite PISA
 * y recortar la entrada MUEVE el clip, asi que recortar en el lugar final se
 * comeria al vecino. Sobre 88 planos son ~264 transacciones espaciadas.
 *
 * Y EL LIMBO NO HACE FALTA: `armarSecuencia` ya resuelve esto poniendo los in/out
 * en el ProjectItem ANTES del overwrite, con lo cual el clip entra ya recortado y
 * directo en su posicion. Una escritura por fragmento en vez de tres.
 *
 * MEDIDO EL 2026-09-05, Y LA PRIMERA VERSION NO ANDABA: los pares intercalados
 * (setInOut, overwrite, setInOut, overwrite…) en UNA transaccion NO respetan el
 * orden. Cuatro fragmentos del mismo medio con recortes de 2/3/4/5s entraron los
 * cuatro con `entrada 0` y el largo COMPLETO del material: el overwrite NO ve el
 * in/out puesto en su misma transaccion.
 *
 * Asi que van DOS transacciones por lote —todos los in/out, y despues todos los
 * pegados— que es como `armarSecuencia` lo hace de a uno y funciona. Y como el
 * in/out vive en el MEDIO, que es compartido, un lote NO PUEDE tener dos
 * fragmentos del mismo material: el segundo pisaria el recorte del primero antes
 * de que se pegue ninguno. Los lotes se arman respetando eso; no se le pide al
 * que llama que lo sepa.
 *
 * El veredicto sale de RELEER la pista, no de que la transaccion no haya tirado.
 */
async function colocarLote(params) {
  const { project, sequence } = await getProyectoYSecuencia();
  const frags = Array.isArray(params.fragmentos) ? params.fragmentos : [];
  if (!frags.length) {
    throw new Error("Falta `fragmentos`: [{medio, desde, hasta, en}] — `desde`/`hasta` son puntos " +
      "de FUENTE y `en` es la posicion en el timeline, los tres en segundos.");
  }
  const { pista, pistaIndex } = pistaDeVideo(params.pista, "colocarLote");
  /*
   * 1-BASED, igual que `insertar`. Hasta el 2026-09-10 este verbo tomaba el valor CRUDO
   * como indice mientras `insertar` restaba 1, asi que el MISMO `pistaAudio` mandaba el
   * audio a pistas distintas segun el verbo. Medido: con `pistaAudio: 2`, `insertar` lo
   * puso en A2 y `colocarLote` en A3.
   *
   * No es teorico: `colocar_fragmentos.js` tiene DOS caminos —lote para los fragmentos
   * con `entrada`, tres pasos para los que no— y le pasa el MISMO `PISTA_AUDIO` a los dos.
   * En el armado real de un videoclip eso fueron 29 por lote y 59 por pasos, con el audio repartido
   * entre dos pistas. Un mismo nombre de parametro no puede significar dos cosas.
   */
  if (typeof params.pistaAudio === "number" && params.pistaAudio < 1) {
    throw new Error(
      `\`pistaAudio\` se cuenta desde 1 (A1 es 1), y vino ${params.pistaAudio}. ` +
      `Con 0 o menos el indice queda negativo y el audio cae en A1 PISANDO lo que haya.`
    );
  }
  const pistaAudio = typeof params.pistaAudio === "number" ? params.pistaAudio - 1 : pistaIndex;
  const porTx = Math.max(1, Math.min(TOPE_LOTE, typeof params.porTransaccion === "number" ? params.porTransaccion : 1));

  /* Se resuelven TODOS antes de escribir: un nombre mal deja media pista puesta. */
  const cache = {};
  for (const f of frags) {
    const nombre = f.medio;
    if (cache[nombre]) continue;
    const medio = await buscarMedio(project, nombre);
    let clipItem = null;
    try { clipItem = ppro.ClipProjectItem.cast(medio); } catch (e) { clipItem = null; }
    if (!clipItem) throw new Error(`No se pudo castear "${String(medio.name)}" a ClipProjectItem.`);
    cache[nombre] = { medio: medio, clipItem: clipItem, nombre: String(medio.name) };
  }

  const editor = ppro.SequenceEditor.getEditor(sequence);
  let transacciones = 0, fallosTx = 0;

  /* LOTES SIN MEDIO REPETIDO, armados aca y no pedidos al que llama. Greedy: el
   * fragmento entra al lote actual si su medio no esta ya ahi y todavia hay lugar;
   * si no, abre uno nuevo. Un medio repetido adentro del mismo lote haria que el
   * segundo in/out pise al primero antes de que se pegue ninguno de los dos. */
  const lotes = [];
  let actual = [], enActual = {};
  for (const f of frags) {
    if (actual.length >= porTx || enActual[f.medio]) { lotes.push(actual); actual = []; enActual = {}; }
    actual.push(f); enActual[f.medio] = true;
  }
  if (actual.length) lotes.push(actual);

  for (let li = 0; li < lotes.length; li++) {
    const lote = lotes[li];
    /* EL ESPACIADO VA ACA Y NO EN LA HERRAMIENTA. El `dormir(PAUSA)` de los colocadores
     * separa LLAMADAS; estas transacciones corren todas adentro de UNA, asi que sin esto
     * el espaciado real es cero. Ver `MS_ENTRE_TX`: 27 seguidas tiraron Premiere. */
    if (li > 0) await esperarEntreTx();
    let okIO = false, okPegar = false;
    project.lockedAccess(() => {
      okIO = project.executeTransaction((a) => {
        for (const f of lote) a.addAction(cache[f.medio].clipItem.createSetInOutPointsAction(aTick(f.desde), aTick(f.hasta)));
      }, `in/out de ${lote.length} fragmento(s)`);
    });
    project.lockedAccess(() => {
      okPegar = project.executeTransaction((a) => {
        for (const f of lote) a.addAction(editor.createOverwriteItemAction(cache[f.medio].medio, aTick(f.en), pistaIndex, pistaAudio));
      }, `pegar ${lote.length} fragmento(s)`);
    });
    transacciones += 2;
    if (!okIO || !okPegar) fallosTx++;
  }

  /* LOS IN/OUT SE LIMPIAN: son del PROYECTO, no de este corte. Dejarlos deja cada
   * medio recortado en el panel para siempre, y cualquier cosa que despues cree una
   * secuencia desde el arranca en el in-point viejo. Ya se pago en `cortar`. */
  let inOutLimpiados = "no se intento";
  if (lotes.length) await esperarEntreTx();   /* tambien se separa del ultimo lote */
  try {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((a) => {
        for (const k of Object.keys(cache)) a.addAction(cache[k].clipItem.createClearInOutPointsAction());
      }, "limpiar in/out de los medios");
    });
    transacciones++;
    inOutLimpiados = ok ? `limpiados (${Object.keys(cache).length} medios)` : "LA TRANSACCION NO CORRIO";
  } catch (e) { inOutLimpiados = "NO SE PUDO: " + (e && e.message ? e.message : e); }

  /* EL VEREDICTO: releer la pista. Que la transaccion no haya tirado no dice que los
   * N hayan entrado, y con el in/out compartido el modo de fallo esperable es que
   * entren TODOS con el recorte del ULTIMO. */
  const track = await sequence.getVideoTrack(pistaIndex);
  const items = track ? await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
  /* `tiemposDe` NO devuelve `dura` —la primera version la leyo igual e informo
   * "dura undefined" sobre cuatro clips que si tenian largo—, asi que se calcula. */
  const puestos = [];
  for (let k = 0; k < items.length; k++) {
    const t = await tiemposDe(items[k]);
    puestos.push({ desde: t.desde, hasta: t.hasta, entrada: t.entrada, dura: t.hasta - t.desde });
  }

  const bien = [], mal = [];
  for (const f of frags) {
    const dura = Number(f.hasta) - Number(f.desde);
    const c = puestos.find((x) => Math.abs(x.desde - Number(f.en)) < 0.05);
    if (!c) { mal.push(`${f.medio} en ${f.en}s: NO HAY CLIP ahi`); continue; }
    const okDur = Math.abs(c.dura - dura) < 0.05;
    const okEnt = Math.abs((c.entrada === null || c.entrada === undefined ? Number(f.desde) : c.entrada) - Number(f.desde)) < 0.05;
    if (okDur && okEnt) bien.push(f.en);
    else mal.push(`${f.medio} en ${f.en}s: dura ${c.dura} (queria ${dura.toFixed(3)}), entrada ${c.entrada} (queria ${f.desde})`);
  }

  return {
    resumen:
      `${pista}: ${bien.length} de ${frags.length} fragmentos COLOCADOS Y RELEIDOS` +
      ` en ${transacciones} transacción(es) · ${lotes.length} lote(s)` +
      ` espaciadas ${MS_ENTRE_TX}ms` +
      (porTx > 1 ? ` de hasta ${porTx}, sin repetir medio` : "") +
      (fallosTx ? ` · ${fallosTx} transacción(es) NO corrieron` : "") +
      (mal.length ? ` · MAL ${mal.length}: ${mal.slice(0, 3).join(" | ")}` : "") +
      ` · in/out de los medios: ${inOutLimpiados}`,
    pista: pista, colocados: bien.length, total: frags.length,
    transacciones: transacciones, mal: mal, inOutLimpiados: inOutLimpiados
  };
}

const VERBOS = { colocarLote, abrirProyecto, crearProyecto, copiarEfecto, quitarEfecto, borrarKeyframe, moverKeyframe, curvaKeyframe, leerParam, sondaParam, radiografia, desactivar, estado, guardar, bins, exportar, cortesDeEscena, etiquetar, interpretar, proxy, subclip, renombrarPista, renombrar, revisar, importar, importarTranscripcion, motion, keyframe, frame, playhead, clips, seleccionar, efectos, param, editar, catalogo, agregarEfecto, medios, insertar, secuencias, borrar, transcripcion, armarSecuencia, borrarSecuencia, vistazo, mirarMedio, analizar, marcadores, marcar, desmarcar, cortar, sacarRangos, cerrarHuecos, resolucion, ajustarAlCuadro, escalaFija, fijar, unirAudio, aplicarEscalas, aplicarZooms, leerEscalas, aplicarAnim, unirVideo, duplicarSecuencia, api };


/*
 * QUE PARAMETRO ACEPTA CADA VERBO. Existe para que una clave que no existe REBOTE en vez de
 * descartarse en silencio, que es la causa raiz de cuatro bugs distintos y ninguno evidente:
 *
 *   proyecto  en las 45 herramientas MCP  -> una guarda de seguridad que no protegia nada
 *   segundos  en premiere_frame           -> diagnostico hecho sobre un cuadro de otro momento
 *   activar   en secuencias               -> el verbo declarado roto durante horas
 *   filtro    en medios                   -> el parametro real es `buscar`
 *
 * Los tres primeros comparten la trampa: la rama por DEFECTO se parece al exito. `secuencias` sin
 * `nombre` lista y contesta "activa: X", que se lee igual que "la activé".
 *
 * LA TABLA SE DERIVA DEL CODIGO, no se escribe a mano: `test.js` la vuelve a extraer de los
 * `params.X` de cada verbo —siguiendo los helpers a los que se les pasa `params` entero, porque si
 * no queda corta y rechazaria llamadas CORRECTAS— y falla si no coincide. Una tabla a mano se
 * desactualiza, y ahi la guarda pasa de proteger a estorbar.
 *
 * Verificada antes de encenderla contra 96 llamadas reales: las 74 del repo y las 22 de los
 * scripts que viven al lado del material. Ninguna pasaba una clave de mas.
 */
const PARAMS_DE = {
  abrirProyecto: ["ruta"],
  crearProyecto: ["ruta"],
  copiarEfecto: ["efecto", "indiceDestino", "indiceEfecto", "indiceOrigen", "param", "pistaDestino", "pistaOrigen", "secuenciaOrigen"],
  quitarEfecto: ["efecto", "indice", "nombre", "pista"],
  borrarKeyframe: ["efecto", "indice", "indiceParam", "nombre", "param", "pista", "segundos", "tolerancia"],
  moverKeyframe: ["a", "de", "efecto", "indice", "indiceParam", "nombre", "param", "pista", "tolerancia"],
  curvaKeyframe: ["efecto", "indice", "indiceParam", "modo", "nombre", "param", "pista", "segundos", "tolerancia"],
  leerParam: ["desdeIndice", "efecto", "indiceParam", "limite", "param", "pista"],
  sondaParam: ["efecto", "indice", "indiceParam", "metodos", "nombre", "pista"],
  radiografia: ["conParams", "desdeIndice", "limite", "maxParams", "pista"],
  desactivar: ["activar", "indice", "nombre", "pista", "vinculados"],
  estado: [],
  guardar: [],
  bins: ["aunqueTengaCosas", "bin", "borrar", "medios"],
  exportar: ["desde", "hasta", "modo", "preset", "salida"],
  cortesDeEscena: ["indice", "modo", "nombre", "pista"],
  etiquetar: ["color", "medio", "medios"],
  interpretar: ["fps", "medio"],
  proxy: ["archivo", "medio"],
  subclip: ["desde", "duros", "hasta", "medio", "nombre"],
  renombrarPista: ["nuevo", "pista"],
  renombrar: ["indice", "nombre", "nuevo", "pista"],
  revisar: ["pista", "topeFrames"],
  importar: ["archivos", "bin"],
  importarTranscripcion: ["desdeMedio", "json", "medio", "ruta", "todasLasFormas"],
  motion: [],
  keyframe: ["efecto", "lista", "param", "valor", "x", "y"],
  frame: ["ancho"],
  playhead: ["segundos"],
  clips: ["pista"],
  seleccionar: ["indice", "nombre", "pista"],
  efectos: ["indice", "nombre", "pista"],
  param: ["efecto", "indice", "nombre", "param", "pista", "valor", "x", "y"],
  editar: ["apagado", "desde", "entrada", "indice", "nombre", "pista", "salida", "vinculados"],
  catalogo: ["buscar", "transiciones"],
  agregarEfecto: ["efecto"],
  medios: ["buscar"],
  insertar: ["medio", "pista", "pistaAudio", "segundos"],
  secuencias: ["nombre"],
  borrar: ["dejarHueco", "indice", "nombre", "pista", "vinculados"],
  transcripcion: ["buscar", "crudo", "indice", "medio", "nombre", "palabras", "pista"],
  armarSecuencia: ["alto", "ancho", "capas", "fps", "fragmentos", "medio", "nombre", "preset"],
  borrarSecuencia: ["nombre"],
  vistazo: ["ancho", "cuantos", "desde", "hasta"],
  mirarMedio: ["ancho", "cuantos", "medio", "tiempos"],
  analizar: ["ancho", "cuantos", "medio"],
  marcadores: [],
  marcar: ["color", "comentario", "duracion", "nombre", "segundos"],
  desmarcar: ["clip", "indice", "nombre", "pista", "todos"],
  cortar: ["indice", "nombre", "pista", "segundos", "soloVideo"],
  sacarRangos: ["pista", "rangos"],
  cerrarHuecos: ["pista", "tope"],
  resolucion: ["alto", "ancho", "fps"],
  ajustarAlCuadro: ["solo"],
  escalaFija: ["pista", "valor"],
  fijar: ["efecto", "indice", "indiceParam", "nombre", "param", "pista", "valor", "x", "y"],
  unirAudio: [],
  aplicarEscalas: ["desdeIndice", "limite", "pista", "plan", "porTransaccion"],
  colocarLote: ["fragmentos", "pista", "pistaAudio", "porTransaccion"],
  aplicarZooms: ["desdeIndice", "limite", "pista", "porTransaccion", "ratioY", "tope", "velocidad"],
  leerEscalas: ["desdeIndice", "limite", "pista"],
  aplicarAnim: ["desdeIndice", "limite", "pista", "plan", "porTransaccion"],
  unirVideo: ["pista", "rangos"],
  duplicarSecuencia: ["nombre", "nuevoNombre"],
  api: ["objeto"],
};

/* Distancia de edicion, sólo para sugerir. Un error que dice "no conozco `filtro`" ayuda; uno que
   dice "¿querias decir `buscar`?" cierra el problema. */
function distancia(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1]
              : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
  return m[b.length][a.length];
}

/*
 * Se cuelga del global y no de module.exports: los scripts se cargan con
 * <script src> y comparten scope, que es el patrón que ya está probado en este
 * host. No hay que averiguar si UXP resuelve require() de archivos locales.
 */
/*
 * `secuencia` es una GUARDA, no un selector: si la activa no es esa, se rechaza.
 *
 * Casi todos los verbos operan sobre "la secuencia activa" y no reciben cuál. Eso
 * está bien mientras el usuario mira la pantalla, y es una trampa en un script:
 * el 2026-08-17 un `armarSecuencia` falló a mitad, la activa volvió a ser la que
 * el usuario tenía montada aparte, y los tres verbos siguientes del script
 * —`escalaFija`, `fijar`, `revisar`— le pegaron a ESA. Escaló los 11 clips de un
 * corte ajeno y guardó el proyecto encima. Esa vez no hubo daño real porque no
 * había nada escalado a mano, pero el verbo no tenía forma de saberlo.
 *
 * Va acá, en el despachador, y no verbo por verbo: son 45 y el que se olvide de
 * pedirla es justo el que va a doler. NO cambia la secuencia activa a propósito
 * —eso movería la interfaz del usuario sin que lo pida—: sólo se niega a
 * trabajar sobre la equivocada.
 *
 * La comparación es por coincidencia parcial, igual que `secuencias`, para poder
 * escribir "esbozo" en vez del nombre completo.
 */
async function ejecutar(cmd, params) {
  const fn = VERBOS[cmd];
  if (!fn) {
    throw new Error(`Comando desconocido "${cmd}". Los que hay: ${Object.keys(VERBOS).join(", ")}.`);
  }
  const p = params || {};

  /*
   * CLAVES DESCONOCIDAS: REBOTAN. Va PRIMERO, antes que las guardas de proyecto y secuencia,
   * porque una llamada mal escrita no tiene que ejecutar nada, ni siquiera las comprobaciones.
   *
   * La razón es medida y se cobró cuatro veces: un parámetro que no existe no fallaba, se
   * DESCARTABA, y la llamada corría por su rama por defecto — que casi siempre se parece al éxito.
   * `secuencias` sin `nombre` lista y contesta "activa: X", que se lee igual que "la activé", así
   * que un verbo que hacía siempre lo mismo produjo las lecturas "funcionó" y "se rompió" en la
   * misma sesión.
   *
   * `proyecto` y `secuencia` se aceptan en todos los verbos: son las guardas del despachador.
   */
  /*
   * Y LO MISMO ADENTRO DE LOS OBJETOS, que es donde la guarda seguia abierta.
   *
   * `armarSecuencia` toma `fragmentos: [{desde, hasta}]` en segundos de la FUENTE. Se le
   * paso `{desde: 0, hasta: 77, entrada: 1855}` y el `entrada` se DESCARTO en silencio: la
   * secuencia quedo con el clip en el segundo 0 del material en vez de en el minuto 31.
   * Costo rearmar 14 secuencias.
   *
   * Es el mismo modo de fallo que el de arriba —un parametro que no existe se descarta y la
   * llamada corre por su rama por defecto, que se parece al exito— un nivel mas adentro. La
   * guarda de 2026-08-28 cerro las claves de primer nivel y dejo estas afuera.
   *
   * La tabla se DERIVA del codigo igual que la otra: `test.js` vuelve a extraer las claves
   * que cada verbo lee de esos objetos y falla si no coinciden.
   */
  const CLAVES_DE_OBJETO = {
    armarSecuencia: {
      fragmentos: ["desde", "hasta", "medio"],
      capas: ["apagado", "desde", "dura", "en", "medio", "nombre", "pista", "pistaAudio"],
    },
    keyframe: { lista: ["segundos", "valor", "x", "y"] },
    aplicarEscalas: { plan: ["desde", "escala", "x", "y"] },
    sacarRangos: { rangos: ["desde", "hasta"] },
  };
  const dentro = CLAVES_DE_OBJETO[cmd];
  if (dentro) {
    for (const campo of Object.keys(dentro)) {
      const arr = p[campo];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i] || typeof arr[i] !== "object") continue;
        const mal = Object.keys(arr[i]).filter((k) => dentro[campo].indexOf(k) === -1);
        if (mal.length) {
          const sug = mal.map((k) => {
            const cerca = dentro[campo].filter(
              (a) => distancia(k.toLowerCase(), a.toLowerCase()) <= Math.max(2, Math.floor(a.length / 3)));
            return `\`${k}\`` + (cerca.length ? ` (¿querías \`${cerca[0]}\`?)` : "");
          });
          throw new Error(
            `"${cmd}": el elemento ${i} de \`${campo}\` trae ${mal.length > 1 ? "claves" : "una clave"} ` +
            `que no se lee${mal.length > 1 ? "n" : ""}: ${sug.join(", ")}. ` +
            `Acepta: ${dentro[campo].join(", ")}. NO se ejecutó nada.`
          );
        }
      }
    }
  }
  const aceptadas = PARAMS_DE[cmd];
  if (aceptadas) {
    const sobra = Object.keys(p).filter((k) => k !== "proyecto" && k !== "secuencia" && aceptadas.indexOf(k) === -1);
    if (sobra.length) {
      const sug = sobra.map((k) => {
        const cerca = aceptadas.filter((a) => distancia(k.toLowerCase(), a.toLowerCase()) <= Math.max(2, Math.floor(a.length / 3)));
        return `\`${k}\`` + (cerca.length ? ` (¿querías \`${cerca[0]}\`?)` : "");
      });
      throw new Error(
        `"${cmd}" no conoce ${sobra.length > 1 ? "los parámetros" : "el parámetro"} ${sug.join(", ")}. ` +
        `Acepta: ${aceptadas.length ? aceptadas.join(", ") : "ninguno"}` +
        `${aceptadas.length ? ", más" : ", sólo"} las guardas proyecto y secuencia. NO se ejecutó nada.`
      );
    }
  }

  /*
   * `proyecto` es una GUARDA, igual que `secuencia`, y hace falta por una razón medida.
   *
   * Premiere puede tener varios proyectos abiertos y el bridge opera sobre EL QUE TIENE FOCO.
   * Nada en el nombre de un verbo dice cuál es. El 2026-08-22 el foco cambió al proyecto de
   * prueba y se interrogaron `medios` y `bins` creyendo que contestaban sobre otro: fueron
   * lecturas y no hubo daño, pero un `borrar` con la misma confusión habría barrido el timeline
   * del proyecto equivocado, y NADA lo habría avisado.
   *
   * Va antes de la guarda de secuencia a propósito: dos proyectos pueden tener una secuencia
   * con el mismo nombre, así que preguntar primero por la secuencia no alcanza.
   */
  if (typeof p.proyecto === "string" && p.proyecto.trim()) {
    const proj = await getProyecto();
    const ruta = proj && proj.path ? String(proj.path) : "";
    const nom = ruta ? ruta.split("/").pop().replace(/\.prproj$/i, "") : (proj && proj.name ? String(proj.name) : "");
    if (!nom) {
      throw new Error(`"${cmd}" se pidió sobre el proyecto "${p.proyecto}" y no se pudo leer cuál está abierto.`);
    }
    if (nom.toLowerCase().indexOf(p.proyecto.toLowerCase()) === -1) {
      throw new Error(
        `"${cmd}" se pidió sobre el proyecto "${p.proyecto}" y el que tiene foco es "${nom}". ` +
        "NO se ejecutó nada. Traelo al frente en Premiere y volvé a intentar."
      );
    }
  }
  if (typeof p.secuencia === "string" && p.secuencia.trim()) {
    const project = await getProyecto();
    const activa = await project.getActiveSequence();
    const nombre = activa ? String(activa.name) : null;
    if (!nombre) {
      throw new Error(`"${cmd}" se pidió sobre la secuencia "${p.secuencia}" y no hay ninguna activa.`);
    }
    if (nombre.toLowerCase().indexOf(p.secuencia.toLowerCase()) === -1) {
      throw new Error(
        `"${cmd}" se pidió sobre "${p.secuencia}" y la secuencia activa es "${nombre}". ` +
        "No se ejecutó nada. Activala con `secuencias` si es la que querés tocar."
      );
    }
  }
  return await fn(p);
}
