#!/usr/bin/env node
/* Coloca en la secuencia los TRAMOS que detectó `sincro.py --segmentos`.
 *
 * Un clip puede contener varias pasadas del tema —la cámara siguió grabando mientras
 * se reiniciaba el playback— y entonces no tiene un offset sino uno por tramo. Cada
 * tramo va como una inserción propia con su in-point, su out-point y su posición: NO
 * hay que cortar el material.
 *
 * ## Todo a la grilla de la SECUENCIA, in-point incluido
 *
 * Por qué cuantizar en vez de dejar el valor exacto, que la API acepta: EN CUANTO EL
 * USUARIO TOCA UN CLIP, PREMIERE LO RECUANTIZA. Se comprobó arrastrando un clip de una
 * pista a otra: la posición sub-frame que había puesto la API volvió al frame y
 * reapareció el hueco que se había corregido. Una posición exacta que se destruye en
 * el primer arrastre es peor que una aproximada que se queda quieta, y además el
 * usuario no puede trabajar sub-frame en el timeline.
 *
 * ## Y el in-point va en la MISMA grilla, aunque el material tenga una más fina
 *
 * Acá estuvo el error, y estaba escrito en este encabezado como si fuera la gracia de
 * la herramienta: se ponía la posición en frames de secuencia (25fps, 40 ms) y el
 * in-point en frames del MATERIAL (50fps, 20 ms), para que el resto se absorbiera ahí
 * y el paso efectivo fuera de 20 ms en vez de 40.
 *
 * Funciona hasta que el usuario toca el clip. **Premiere recuantiza el in-point a la
 * grilla de la SECUENCIA, no a la del material.** Medido: FX3_3561 tenía in-point 3,10
 * —frame exacto a 50fps, medio frame a 25— y al arrastrarlo quedó en 3,12, con lo que
 * el error salió de -9 ms a -29 ms. FX3_3562 se arrastró igual y no se movió: su
 * in-point es 0, que cae en las dos grillas. De 14 tramos, 8 tenían el in-point en el
 * medio frame y estaban esperando el primer arrastre.
 *
 * Así que ahora `pos` y `ent` van los dos en frames de secuencia. Como el offset queda
 * obligado a ser múltiplo de 40 ms, **el error crece de ≤10 ms a ≤20 ms** — el peor
 * medido en este proyecto es 19 ms. Se paga a propósito: un error de 19 ms que no se
 * mueve es mejor que uno de 9 ms que se convierte en 29 al primer arrastre.
 *
 * Si algún plano necesitara los 10 ms, la salida EXACTA es meterlo en una NEST: adentro
 * el residuo de 20 ms sobrevive porque nadie arrastra ahí, y la nest se coloca en la
 * grilla de la madre. No está descartada —es la única forma de sincronía sub-frame que
 * aguanta— pero no es el default porque son tantas anidadas como planos y complica el
 * rough cut. Se construye POR PLANO el día que uno suene mal. Sin construir.
 *
 * ## El orden de las cuatro operaciones no es negociable
 *
 * insertar -> entrada -> salida -> desde.
 *
 * `createSetInPointAction` MUEVE el clip, así que la posición se fija AL FINAL. Con
 * `entrada` y `desde` en la misma llamada, el in-point entra y el clip queda corrido:
 * medido, se fue a 22,43 cuando se pidió que quedara en 0.
 *
 * ## Espaciado 1,2s
 *
 * Una ráfaga de transacciones tira Premiere con SIGSEGV —200 ms lo tira, 1200 no— y
 * acá son hasta cuatro por tramo. Se guarda antes y después, y se relee todo al final:
 * que las llamadas no tiren no prueba que el clip quedó donde debía.
 *
 * Uso:
 *   node colocar_sincro.js --datos <sincro_tramos.json> --secuencia SINCRO
 *        [--desde-pista 1] [--fps-secuencia 25] [--limpiar] [--simular]
 *
 *   --reparar   no coloca nada: busca los clips que YA están y les corrige la fase,
 *               respetando la pista donde estén y los recortes que se les hayan hecho.
 */
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

const DATOS = opt("datos", null);
if (!DATOS) { console.error("Falta --datos <sincro_tramos.json>"); process.exit(1); }
const SEC = opt("secuencia", null);
const DESDE = Number(opt("desde-pista", "1"));
/*
 * PISO. El encabezado afirmaba "la herramienta nunca escribe en A1 --con --desde-pista 1
 * el audio arranca en A2--", pero eso es una condicion sobre el FLAG y no se chequeaba en
 * ningun lado. Con `--desde-pista 0` el primer tramo manda su audio a A1 y el overwrite
 * PISA el tema, que es lo unico irremplazable de la secuencia. Y el `--limpiar` de esa
 * misma corrida deja de proteger: barre A2..hayA dejando A1 "intacta", y despues le
 * escriben encima.
 */
if (!Number.isFinite(DESDE) || DESDE < 1) {
  console.error("`--desde-pista` se cuenta desde 1 y vino \"" + opt("desde-pista", "1") + "\".");
  console.error("Con 0 el audio del primer tramo cae en A1 y PISA el tema. No se ejecuto nada.");
  process.exit(1);
}
const FPS_SEC = Number(opt("fps-secuencia", "25"));
const LIMPIAR = flag("limpiar");
const SIMULAR = flag("simular");
const REPARAR = flag("reparar");

const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
/*
 * 300 + los ~205ms del piso del transporte = ~505ms de espaciado REAL, que es lo
 * unico que importa: lo que tira Premiere es la separacion entre transacciones,
 * no este numero suelto.
 *
 * Medido el 2026-09-05 en un proyecto pesado (216 clips, 1284 medios, 68 secuencias):
 * a ~205ms falla 2 de 2 —una vez EXC_BAD_ACCESS en 0x18, otra colgado a 0% de
 * CPU sin dump— y a ~355 y ~505 aguanta 150 transacciones. El borde esta entre
 * 205 y 355; 505 deja 2,4x de margen. Antes esto era 1200, que con el MS_POLL
 * viejo de 700 daba ~1442ms: casi 3x mas lento por nada.
 *
 * NO se baja sin mirar `MS_POLL` en plugin/index.js. `test.js` exige que la SUMA
 * de los dos sea >= 500ms, porque bajar uno sin subir el otro es el error que ya
 * casi se comete: en el proyecto de PRUEBA los ~205ms aguantaban 200.
 */
const PAUSA = 300;
const redondear = (s, fps) => Math.round(s * fps) / fps;
/* La guarda de secuencia va en TODAS las llamadas que escriben: el despachador rechaza
 * si la activa no es la pedida. Sin esto, una secuencia equivocada abierta en Premiere
 * se lleva el trabajo, y eso ya pasó una vez en otro proyecto. */
const g = (o) => (SEC ? Object.assign({}, o, { secuencia: SEC }) : o);

/* Lleva un tramo a la grilla de la secuencia: posición, in-point y out-point los tres.
 * Se trabaja en FRAMES ENTEROS y no en segundos, porque lo que importa no es que cada
 * número quede lindo sino que la DIFERENCIA `pos - ent` sea un múltiplo exacto de un
 * frame: es esa diferencia la que decide si suena sincronizado.
 *
 * `durClip` es para no pedir un out-point más allá del final del material. */
function cuadricular(offset, desde, hasta, durClip) {
  const F = 1 / FPS_SEC;
  const k = Math.round(offset / F);            // el offset, medido en frames enteros
  let ent = Math.round(desde / F);
  let pos = ent + k;
  /* Una posición negativa no existe. Se suben los DOS por igual: eso deja `pos - ent`
   * intacto —o sea la sincronía— y sólo se pierden esos frames de cabeza. Aplastar la
   * posición a cero sin tocar el in-point era el bug viejo: perdía la compensación. */
  if (pos < 0) { const n = -pos; pos += n; ent += n; }
  let sal = Math.round(hasta / F);
  if (durClip) sal = Math.min(sal, Math.floor(durClip / F));
  if (sal <= ent) sal = ent + 1;
  return { pos: redondear(pos * F, FPS_SEC), ent: redondear(ent * F, FPS_SEC),
           sal: redondear(sal * F, FPS_SEC) };
}

(async () => {
  const d = JSON.parse(fs.readFileSync(DATOS, "utf8"));
  if (d.modo !== "segmentos") {
    console.error("El JSON no es del modo segmentos. Corré sincro.py con --segmentos.");
    process.exit(1);
  }

  /* Un tramo por pista, en orden de clip y de aparición: así la pista dice de dónde
   * salió cada cosa. */
  const tramos = [];
  for (const c of d.clips.slice().sort((a, b) => a.nombre.localeCompare(b.nombre))) {
    const fpsF = c.fps || 50;
    (c.segmentos || []).forEach((s, i) => {
      const q = cuadricular(s.offset, s.desde, s.hasta, c.dur);
      tramos.push({
        nombre: c.nombre, parte: i + 1, partes: (c.segmentos || []).length,
        pos: q.pos, ent: q.ent, sal: q.sal, dura: q.sal - q.ent,
        errMs: ((q.pos - q.ent) - s.offset) * 1000, ventanas: s.ventanas, fpsF: fpsF,
      });
    });
  }

  const est = await enviar("estado");
  console.log("activa: " + est.resumen);
  if (SEC && est.resumen.indexOf(SEC) === -1) {
    console.error("\nLa secuencia activa no es \"" + SEC + "\". Activala en Premiere y volvé a correr.");
    process.exit(1);
  }
  const hayV = Number((/(\d+) pistas de video/.exec(est.resumen) || [])[1] || 0);
  const hayA = Number((/y (\d+) de audio/.exec(est.resumen) || [])[1] || 0);
  /* --reparar: arregla EN EL LUGAR lo que ya está puesto, sin rehacer la secuencia.
   *
   * Existe porque el bug del in-point apareció con el trabajo ya empezado: rehacer
   * SINCRO se llevaría las pistas que el usuario reordenó a mano y los recortes que
   * hizo revisando. Así que se busca cada clip DONDE ESTÉ —el número de pista ya no
   * dice de qué tramo salió— y se le corrige la fase.
   *
   * La duración se PRESERVA: el out-point se corre lo mismo que el in-point, así un
   * recorte que hizo el usuario no se deshace. */
  if (REPARAR) {
    const esp = [];
    for (const c of d.clips) (c.segmentos || []).forEach((s, i) => {
      esp.push({ base: c.nombre.replace(/\.[^.]+$/, ""), parte: i + 1,
                 partes: (c.segmentos || []).length, offset: s.offset, dur: c.dur });
    });
    const F = 1 / FPS_SEC;
    const hallados = [];
    for (let v = 1; v <= hayV; v++) {
      let cs = [];
      try { cs = (await enviar("clips", { pista: "V" + v })).clips || []; } catch (e) { continue; }
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        const base = c.nombre.replace(/\.[^.]+$/, "");
        /* Se elige el tramo por el offset MÁS CERCANO al que el clip tiene puesto: si
         * el usuario lo movió de pista, el índice de pista ya no identifica nada. */
        const impl = c.desde - c.entrada;
        let m = null;
        for (const e of esp) if (e.base === base) {
          const err = Math.abs(impl - e.offset);
          if (!m || err < m.err) m = { e: e, err: err };
        }
        if (!m) { console.log("  ? V" + v + " " + base + ": sin dato de sincro, se deja"); continue; }
        const k = Math.round(m.e.offset / F);
        let ent = Math.round(c.entrada / F);
        let pos = ent + k;
        if (pos < 0) { const n = -pos; pos += n; ent += n; }
        const delta = ent * F - c.entrada;
        /*
         * CLAMP AL MATERIAL. `salN` preservaba la duracion sumando el delta, sin mirar
         * nunca cuanto dura el medio —el dato estaba en `m.e.dur` y no se leia—. Cuando
         * el clip ya terminaba en el final del material, cualquier delta positivo pedia
         * un out-point que NO EXISTE, y `editar salida` con un punto fuera del material
         * es la familia de fallo silencioso ya documentada.
         *
         * Es la causa de la anomalia que el comentario de abajo registra como "sin causa
         * identificada": pedir 253,48 sobre un material de 253,44 dejaba 250,40 en vez de
         * 250,36. Ya no hay que adivinarla.
         */
        let salN = redondear(c.entrada + c.dura + delta, FPS_SEC);
        const topeMat = Math.floor((m.e.dur || Infinity) / F) * F;
        const recortado = salN > topeMat + 1e-9;
        if (recortado) salN = redondear(topeMat, FPS_SEC);
        hallados.push({ v: v, i: i, base: base, parte: m.e.parte, partes: m.e.partes,
          entVieja: c.entrada, posVieja: c.desde, errVieja: (impl - m.e.offset) * 1000,
          ent: redondear(ent * F, FPS_SEC), pos: redondear(pos * F, FPS_SEC), sal: salN,
          recortado: recortado, durMat: m.e.dur,
          errNueva: (pos * F - ent * F - m.e.offset) * 1000 });
      }
      await dormir(300);
    }

    console.log("\n" + hallados.length + " clip(s) en la secuencia:\n");
    const tocar = hallados.filter((h) =>
      Math.abs(h.ent - h.entVieja) > 1e-6 || Math.abs(h.pos - h.posVieja) > 1e-6);
    for (const h of hallados) {
      const p = h.partes > 1 ? "[" + h.parte + "/" + h.partes + "]" : "";
      const cambia = tocar.indexOf(h) !== -1;
      console.log("  " + (cambia ? "→" : " ") + " V" + String(h.v).padEnd(3) +
        (h.base + p).padEnd(16) +
        "in " + h.entVieja.toFixed(4) + (cambia ? " → " + h.ent.toFixed(4) : "        ") +
        "  pos " + h.posVieja.toFixed(4) + (cambia ? " → " + h.pos.toFixed(4) : "        ") +
        "  error " + (h.errVieja >= 0 ? "+" : "") + h.errVieja.toFixed(1) +
        (cambia ? " → " + (h.errNueva >= 0 ? "+" : "") + h.errNueva.toFixed(1) : "") + "ms");
    }
    const peor = hallados.length ? Math.max(...hallados.map((h) => Math.abs(h.errNueva))) : 0;
    console.log("\n" + tocar.length + " a corregir · peor error después: " + peor.toFixed(1) + "ms");
    if (SIMULAR) { console.log("\n(simulación: no se tocó nada)"); return; }
    if (!tocar.length) { console.log("nada que hacer."); return; }

    console.log("\nguardado antes: " + String((await enviar("guardar")).resumen).split("·")[0] + "\n");
    /* De atrás para adelante por pista y por índice: `editar entrada` MUEVE el clip, y
     * si en una pista hay dos, corregir el primero le cambia el índice al segundo. */
    let ok = 0;
    for (const h of tocar.slice().sort((a, b) => (b.v - a.v) || (b.i - a.i))) {
      const etq = "V" + h.v + "[" + h.i + "] " + h.base;
      try {
        /*
         * LAS RESPUESTAS SE MIRAN. Antes se descartaban las tres, y con ellas el dato
         * que importa: cuantos VINCULADOS arrastro `editar`.
         *
         * El vinculo se deduce por rango EXACTO, y este archivo documenta mas abajo que
         * el arrastre del usuario recuantiza el in-point del VIDEO y no el del audio. En
         * ese estado `buscarVinculados` devuelve [] y el video se corrige SOLO: el audio
         * se queda donde estaba, ahora desincronizado por el delta de la correccion y sin
         * vinculo para que un `borrar` posterior se lo lleve. Nada lo decia — el chequeo
         * miraba entrada, desde y dura del clip de VIDEO nada mas, e imprimia "✓".
         *
         * Y aca `vinculados: 0` es inequivoco: `sincro.py` sincroniza POR AUDIO, asi que
         * todo clip que este reparador toca tiene audio por construccion.
         */
        const r1 = await enviar("editar", g({ pista: "V" + h.v, indice: h.i, entrada: h.ent }), 300000);
        await dormir(PAUSA);
        const r2 = await enviar("editar", g({ pista: "V" + h.v, indice: h.i, salida: h.sal }), 300000);
        await dormir(PAUSA);
        const r3 = await enviar("editar", g({ pista: "V" + h.v, indice: h.i, desde: h.pos }), 300000);
        const nVinc = Math.max(
          ((r1 && r1.vinculados) || []).length || Number(r1 && r1.vinculados) || 0,
          ((r2 && r2.vinculados) || []).length || Number(r2 && r2.vinculados) || 0,
          ((r3 && r3.vinculados) || []).length || Number(r3 && r3.vinculados) || 0);
        const desalin = [r1, r2, r3].some((x) => x && x.desalineados && x.desalineados.length);
        /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
         * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
         * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
         * recien insertado, con solo los ~203ms del transporte en el medio. */
        const r = (await enviar("clips", { pista: "V" + h.v })).clips || [];
        const c = r[h.i];
        /* La duración se comprueba TAMBIÉN. Sin esto, un frame de más pasa sin queja:
         * pidiendo out-point 253,48 con in 3,12 —que da 250,36— FX3_3561 quedó en
         * 250,40, y el solape que eso abrió con FX3_3562 lo encontró `revisar`, no el
         * verbo. La causa sigue sin identificar; el camino de colocación desde cero no
         * la tiene (duraciones exactas, verificado), así que lo que corresponde es que
         * el reparador lo INFORME en vez de dejarlo pasar. */
        const duraEsp = h.sal - h.ent;
        const bienVideo = c && Math.abs(c.entrada - h.ent) < 0.005 && Math.abs(c.desde - h.pos) < 0.005
          && Math.abs(c.dura - duraEsp) < 0.005;
        /* El audio tiene que haber seguido. Sin esto el "✓" hablaba solo del video. */
        const bien = bienVideo && nVinc > 0 && !desalin;
        console.log("  " + (bien ? "✓" : "✗") + " " + etq +
          (c ? "  in " + c.entrada.toFixed(4) + " · pos " + c.desde.toFixed(4) +
               " · dura " + c.dura.toFixed(4) +
               (Math.abs(c.dura - duraEsp) < 0.005 ? "" : " (esperaba " + duraEsp.toFixed(4) + ")")
             : "  desapareció") +
          (h.recortado ? "  [salida recortada al final del material: " + h.durMat + "s]" : "") +
          (nVinc > 0 ? "  audio: " + nVinc + " arrastrado(s)" : "") +
          (bienVideo && nVinc === 0
            ? "\n      OJO: el video se corrigio y el AUDIO NO LO SIGUIO (0 vinculados). El vinculo se"
              + "\n      deduce por rango exacto, y un arrastre previo del usuario lo rompe. Ese audio"
              + "\n      quedo desincronizado " + ((h.pos - h.posVieja) * 1000).toFixed(0) + "ms y HUERFANO."
            : "") +
          (desalin ? "\n      OJO: `editar` informo vinculados DESALINEADOS." : ""));
        if (bien) ok++;
      } catch (e) { console.log("  ✗ " + etq + "  " + String(e.message || e).slice(0, 120)); }
      await dormir(PAUSA);
    }
    console.log("\nguardado después: " + String((await enviar("guardar")).resumen).split("·")[0]);
    console.log(ok + " de " + tocar.length + " corregido(s).");
    if (ok !== tocar.length) process.exit(1);
    return;
  }

  const necV = DESDE + tramos.length - 1, necA = necV + 1;
  console.log(tramos.length + " tramo(s) de " + d.clips.length + " clip(s) · necesita V" +
              necV + " y A" + necA + " · hay V" + hayV + " y A" + hayA + "\n");
  if (necV > hayV || necA > hayA) {
    console.error("Faltan pistas. La API NO puede crearlas: agregalas a mano");
    console.error("(click derecho en un encabezado de pista → Add Tracks).");
    process.exit(1);
  }

  if (SIMULAR) {
    let v = DESDE;
    for (const t of tramos) {
      const p = t.partes > 1 ? " (parte " + t.parte + "/" + t.partes + ")" : "";
      console.log("  " + t.nombre.replace(/\.[^.]+$/, "") + p + " → V" + v + "/A" + (v + 1) +
        "   pos " + t.pos.toFixed(3) + " · in " + t.ent.toFixed(3) + " · out " + t.sal.toFixed(3) +
        " · dura " + t.dura.toFixed(2) + "s · error " + (t.errMs >= 0 ? "+" : "") + t.errMs.toFixed(1) + "ms");
      v++;
    }
    console.log("\n(simulación: no se tocó nada)");
    return;
  }

  console.log("guardado antes: " + String((await enviar("guardar")).resumen).split("·")[0] + "\n");

  if (LIMPIAR) {
    console.log("limpiando:");
    let saco = 0;
    /* Se barren TODAS las pistas de video, no sólo las que se van a usar: una
     * corrida anterior pudo dejar clips más arriba, y rehacer a medias deja la
     * secuencia mezclando dos versiones de la lógica.
     *
     * Sólo pistas de VIDEO: `borrar` arrastra el audio vinculado de cada clip, y el
     * tema —que vive en A1 sin video— no está vinculado a nada, así que sobrevive.
     * Barrer pistas de audio se lo llevaría. */
    for (let v = 1; v <= hayV; v++) {
      let cs = [];
      try { cs = (await enviar("clips", { pista: "V" + v })).clips || []; } catch (e) { cs = []; }
      /* De atrás para adelante: sacando el índice 0 primero, los que siguen se
       * renumeran y el bucle apuntaría al clip equivocado. */
      for (let i = cs.length - 1; i >= 0; i--) {
        await dormir(PAUSA);
        try { await enviar("borrar", g({ pista: "V" + v, indice: i, dejarHueco: true }), 300000); saco++; }
        catch (e) { console.log("  ✗ V" + v + "[" + i + "]: " + String(e.message).slice(0, 90)); }
      }
      if (cs.length) console.log("  V" + v + ": " + cs.length + " fuera");
      await dormir(PAUSA);
    }
    /* Y DESPUÉS las pistas de audio, que el barrido de video NO alcanza.
     *
     * Barrer sólo video se apoya en que `borrar` arrastre el audio vinculado, y el
     * vínculo se deduce por "mismo medio y mismo rango exacto". En cuanto el usuario
     * arrastra un clip, Premiere le recuantiza el in-point AL VIDEO Y NO AL AUDIO: los
     * rangos dejan de coincidir, el socio no se encuentra y el audio sobrevive al
     * limpiado. Medido: quedaron tres huérfanos en A13/A14 —dos copias perdidas y una
     * sobra de un rearmado anterior— y `revisar` los informó como solapes.
     *
     * A1 NO SE TOCA: ahí vive el tema. La herramienta nunca escribe en A1 —con
     * --desde-pista 1 el audio de los clips arranca en A2— así que barrer de 2 en
     * adelante no puede llevárselo. */
    let orf = 0;
    for (let a = 2; a <= hayA; a++) {
      let cs = [];
      try { cs = (await enviar("clips", { pista: "A" + a })).clips || []; } catch (e) { cs = []; }
      for (let i = cs.length - 1; i >= 0; i--) {
        await dormir(PAUSA);
        try { await enviar("borrar", g({ pista: "A" + a, indice: i, dejarHueco: true }), 300000); orf++; }
        catch (e) { console.log("  ✗ A" + a + "[" + i + "]: " + String(e.message).slice(0, 90)); }
      }
      if (cs.length) console.log("  A" + a + ": " + cs.length + " fuera (huérfano/s)");
      await dormir(PAUSA);
    }
    console.log("  " + saco + " de video + " + orf + " de audio borrado(s)");
    /* Se comprueba que el tema siga ahí: es lo único irremplazable de la secuencia. */
    try {
      const t = (await enviar("clips", { pista: "A1" })).clips || [];
      console.log("  A1: " + t.length + " clip(s) — " +
        (t.length ? t.map((c) => c.nombre.slice(0, 22) + " " + c.dura.toFixed(2) + "s").join(", ") : "VACÍA, OJO"));
      if (!t.length) { console.error("\nA1 quedó vacía: se perdió el tema. Cmd+Z y avisar."); process.exit(1); }
    } catch (e) { console.log("  A1: no se pudo leer — " + String(e.message).slice(0, 60)); }
    console.log("");
  }

  const puestos = [];
  let v = DESDE;
  for (const t of tramos) {
    const V = v, A = v + 1; v++;
    const p = t.partes > 1 ? "[" + t.parte + "/" + t.partes + "]" : "";
    const etq = t.nombre.replace(/\.[^.]+$/, "") + p + " → V" + V + "/A" + A;
    try {
      const r1 = await enviar("insertar", g({ medio: t.nombre, pista: V, pistaAudio: A, segundos: 0 }), 300000);
      if (!/quedó/.test(String(r1.resumen))) throw new Error(String(r1.resumen).slice(0, 150));
      if (t.ent > 0) {
        await dormir(PAUSA);
        await enviar("editar", g({ pista: "V" + V, indice: 0, entrada: t.ent }), 300000);
      }
      await dormir(PAUSA);
      await enviar("editar", g({ pista: "V" + V, indice: 0, salida: t.sal }), 300000);
      await dormir(PAUSA);
      await enviar("editar", g({ pista: "V" + V, indice: 0, desde: t.pos }), 300000);
      console.log("  ✓ " + etq + "  pos " + t.pos.toFixed(3) + " · in " + t.ent.toFixed(3) +
        " · out " + t.sal.toFixed(3) + " · error " + (t.errMs >= 0 ? "+" : "") + t.errMs.toFixed(1) + "ms");
      puestos.push({ V: V, t: t });
    } catch (e) {
      console.log("  ✗ " + etq + "  " + String(e.message || e).slice(0, 130));
    }
    await dormir(PAUSA);
  }

  console.log("\n" + puestos.length + " de " + tramos.length + " colocado(s)\nverificando:");
  let mal = 0;
  for (const x of puestos) {
    /* SIN PAUSA: el espaciado es contra rafagas de TRANSACCIONES, y `clips` no transacciona
     * ni lee valores de param. Medido el 2026-09-05 en un proyecto pesado: la lectura inmediata
     * ve el estado recien escrito 8 de 8 veces sobre un valor y 6 de 6 sobre un clip
     * recien insertado, con solo los ~203ms del transporte en el medio. */
    try {
      const r = await enviar("clips", { pista: "V" + x.V });
      const c = (r.clips || [])[0];
      if (!c) { console.log("  ✗ V" + x.V + " vacía"); mal++; continue; }
      const okP = Math.abs(c.desde - x.t.pos) < 0.03;
      const okE = Math.abs(c.entrada - x.t.ent) < 0.03;
      const okD = Math.abs(c.dura - x.t.dura) < 0.1;
      if (!(okP && okE && okD)) mal++;
      console.log("  " + (okP && okE && okD ? "✓" : "✗") + " V" + x.V + " " + c.nombre.slice(0, 13) +
        " pos " + c.desde.toFixed(3) + (okP ? "" : " (esp " + x.t.pos.toFixed(3) + ")") +
        " · in " + c.entrada.toFixed(3) + (okE ? "" : " (esp " + x.t.ent.toFixed(3) + ")") +
        " · dura " + c.dura.toFixed(2) + (okD ? "" : " (esp " + x.t.dura.toFixed(2) + ")"));
    } catch (e) { console.log("  ? V" + x.V + ": " + String(e.message).slice(0, 70)); mal++; }
  }

  await dormir(PAUSA);
  console.log("\nguardado después: " + String((await enviar("guardar")).resumen).split("·")[0]);
  /* El bucle de verificación recorre lo COLOCADO, así que con cero colocados no encuentra
   * errores y antes informaba "todos verificados" habiendo fallado los 6. Es el falso
   * éxito que este repo persigue: la cuenta tiene que ser contra lo PEDIDO. */
  const faltaron = tramos.length - puestos.length;
  if (faltaron) console.log("OJO: " + faltaron + " tramo(s) NO se colocaron (de " + tramos.length + ").");
  if (mal) console.log("OJO: " + mal + " tramo(s) no quedaron como se pidió.");
  if (faltaron || mal) process.exit(1);
  console.log("los " + puestos.length + " verificados.");
})();
