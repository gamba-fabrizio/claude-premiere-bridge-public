/* Rearma las cuatro secuencias con los titulares en V1 y los SUPLENTES en V3,
 * apagados y arrancando en el mismo punto que su titular.
 *
 * Las posiciones de V1 no se calculan: se LEEN de la secuencia ya armada. El
 * cursor calculado se desfasa del real porque los cortes snapean al frame, y un
 * suplente medio segundo corrido de su titular es exactamente la clase de error
 * que después nadie mira.
 */
const fs = require("fs");
const path = require("path");
const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
const D = process.env.PROYECTO_CN || process.cwd();

/* El prefijo del nombre sale de los propios archivos, no escrito a mano: la
 * jornada anterior era `CerroNegro_19-12-25_` y ésta `CerroNegro_18-11-25_`.
 * Fijarlo hace que el script explote en el proyecto siguiente. */
const PREFIJO = (() => {
  for (const f of fs.readdirSync(D)) {
    const m = f.match(/^(.*_)[0-9]+\.audio\.json$/);
    if (m) return m[1];
  }
  throw new Error(`No hay ningun .audio.json en ${D}.`);
})();
const PRESET = path.join(D, "vertical_1080x1920_25fps.sqpreset");
const PAUSA = 1400;
/* La etiqueta sale del prefijo de los archivos: `CerroNegro_18-11-25_` → `CN 18-11`.
 * Escribirla a mano hace que la jornada siguiente pise las secuencias de la anterior. */
const ETIQUETA = (() => {
  const m = PREFIJO.match(/_(\d{2})-(\d{2})-\d{2}_$/);
  return m ? `CN ${m[1]}-${m[2]}` : "Corte";
})();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const EXCLUIR = {}; // nada que excluir en esta jornada

const V = JSON.parse(fs.readFileSync(path.join(D, "VIDEOS.json"), "utf8"));
const S = JSON.parse(fs.readFileSync(path.join(D, "SUPLENTES.json"), "utf8"));

function fusionar(frags) {
  const out = [];
  for (const f of frags) {
    const u = out[out.length - 1];
    if (u && u.medio === f.medio && Math.abs(u.hasta - f.desde) < 0.05) { u.hasta = f.hasta; u.beats.push(f.beats[0]); continue; }
    out.push({ ...f, beats: [...f.beats] });
  }
  return out;
}

async function paso(cmd, args, tope) {
  try {
    const r = await enviar(cmd, args, tope || 300000);
    console.log("    ▸ " + cmd + ": " + String(r.resumen || JSON.stringify(r)).replace(/\n/g, "\n      "));
    return r;
  } catch (e) { console.log("    ▸ " + cmd + " ERROR: " + e.message); return null; }
}

(async () => {
  for (let i = 0; i < V.length; i++) {
    const nombre = `${ETIQUETA} · ${i + 1} ${V[i].titulo}`;
    const sup = (S[i] || { suplentes: [] }).suplentes;
    console.log(`\n════ ${nombre}  (${sup.length} suplentes)`);

    const usados = V[i].beats.filter((b) => !EXCLUIR[b.clip]);
    const rutasTitulares = [...new Set(usados.map((b) => JSON.parse(
      fs.readFileSync(path.join(D, `${PREFIJO}${b.clip}.audio.json`), "utf8")).archivo))];
    const frags = fusionar(usados.map((b) => ({
      medio: b.archivo, desde: Number(b.desde.toFixed(2)), hasta: Number(b.hasta.toFixed(2)), beats: [b],
    })));

    /* 1) Las posiciones de V1 se LEEN de una pasada previa, no se calculan: el
     * cursor calculado se desfasa del real porque los cortes snapean al frame, y
     * un suplente medio segundo corrido de su titular es un error que nadie mira.
     *
     * Se arma primero SIN capas y se usan los `puestos` que devuelve el verbo.
     * Antes esto leía una secuencia que ya existía, y en un proyecto vacío no
     * había nada que leer: las seis se saltearon. */
    await paso("guardar");                                                   await esperar(PAUSA);
    await paso("importar", { archivos: rutasTitulares, bin: `${ETIQUETA}/${i + 1} ${V[i].titulo}` });
    await esperar(PAUSA);
    await paso("borrarSecuencia", { nombre }).catch(() => null);             await esperar(PAUSA);
    const pre = await paso("armarSecuencia", {
      nombre, preset: PRESET,
      fragmentos: frags.map((f) => ({ medio: f.medio, desde: f.desde, hasta: f.hasta })),
    });
    if (!pre || !pre.puestos || pre.puestos.length !== frags.length) {
      console.log(`    ✗ la pasada previa puso ${pre && pre.puestos ? pre.puestos.length : "?"} de ${frags.length}: salteo`);
      continue;
    }
    const posicion = pre.puestos.map((p) => p.enLaSecuencia);
    await esperar(PAUSA);

    // 2) cada suplente arranca donde arranca el fragmento que contiene a su beat
    const capas = [];
    for (const s of sup) {
      const idx = frags.findIndex((f) => f.medio === `${PREFIJO}${s.deBeat.clip}.MP4`
        && s.deBeat.desde >= f.desde - 0.05 && s.deBeat.desde <= f.hasta + 0.05);
      if (idx === -1) { console.log(`    ✗ el suplente _${s.clip} no encuentra su titular _${s.deBeat.clip} @${s.deBeat.desde}`); continue; }
      /*
       * UNA PISTA POR SUPLENTE, sin optimizar. Empaquetarlos en V3 hizo que dos
       * suplentes del mismo titular —el _58 y el _60, los dos sobre el _59—
       * cayeran en la misma posición y se pisaran: el overwrite dejó 1,64s del
       * primero. Con una pista cada uno el caso no existe, y limpiar las pistas
       * vacías es trivial al hacer el recorte fino.
       */
      const pista = 3 + capas.length;
      capas.push({ medio: s.archivo, pista, en: posicion[idx], desde: s.desde, dura: s.dura, apagado: true });
      console.log(`    · V${pista}  _${s.clip} en ${posicion[idx].toFixed(2)}s sobre el titular _${s.deBeat.clip}  (${s.dura}s vs ${s.duraTitular}s)`);
    }

    // 3) importar lo que falte, borrar y rearmar
    const rutas = [...new Set(sup.map((s) => JSON.parse(
      fs.readFileSync(path.join(D, `${PREFIJO}${s.clip}.audio.json`), "utf8")).archivo))];
    if (rutas.length) { await paso("importar", { archivos: rutas, bin: `${ETIQUETA}/${i + 1} ${V[i].titulo}` }); await esperar(PAUSA); }
    await paso("borrarSecuencia", { nombre });                               await esperar(PAUSA);
    const r = await paso("armarSecuencia", {
      nombre, preset: PRESET,
      fragmentos: frags.map((f) => ({ medio: f.medio, desde: f.desde, hasta: f.hasta })),
      capas,
    });
    if (r) console.log(`      ${r.duracionTotal}s · fallidos ${r.fallidos.length} · capas ${(r.capasPuestas || []).length}/${capas.length}`);
    await esperar(PAUSA);
    await paso("escalaFija", { valor: 50 });                                 await esperar(PAUSA);
    await paso("revisar");                                                   await esperar(PAUSA);
    await paso("guardar");                                                   await esperar(PAUSA);
  }
  console.log("\nlisto");
})();
