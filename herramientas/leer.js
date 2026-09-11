/* Lee las transcripciones de la tanda y prepara lo que hace falta para armar los
 * videos a ciegas: el texto de cada clip de locución, y las TOMAS REPETIDAS
 * dentro de cada uno — que según el editor se resuelven quedándose con la última. */
const fs = require("fs");
const path = require("path");
const D = process.env.PROYECTO_DIR || process.cwd();

const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();

// frases por eos, con su rango de tiempo
function frases(palabras) {
  const out = []; let cur = null;
  for (const p of palabras) {
    if (!cur) cur = { desde: p.desde, hasta: p.desde + p.dura, palabras: [] };
    cur.palabras.push(p.texto); cur.hasta = p.desde + p.dura;
    if (p.eos) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((f) => ({ ...f, texto: f.palabras.join(" ") }));
}

// dos frases son la misma toma si comparten la mayoría de sus palabras largas
function similar(a, b) {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 3));
  const B = new Set(norm(b).split(" ").filter((w) => w.length > 3));
  if (!A.size || !B.size) return 0;
  let comunes = 0; for (const w of A) if (B.has(w)) comunes++;
  return comunes / Math.min(A.size, B.size);
}

const archivos = fs.readdirSync(D).filter((f) => f.endsWith(".audio.json")).sort((a, b) => {
  const n = (s) => Number((s.match(/_(\d+)\.audio/) || [])[1] || 0);
  return n(a) - n(b);
});

const conVoz = [];
for (const f of archivos) {
  const d = JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
  if (!d.palabras.length) continue;
  const dur = d.tramos.length ? d.tramos[d.tramos.length - 1].hasta : 0;
  // La CARPETA del material es información del proyecto: acá son los productos,
  // o sea la hipótesis de agrupación servida en bandeja. Se muestra, no se
  // obedece: la vez pasada la carpeta se equivocó en 4 de 147 clips.
  const carpeta = String(d.archivo).split("/").slice(-2)[0];
  conVoz.push({ archivo: f.replace(".audio.json", ""), carpeta, dur, frases: frases(d.palabras), palSeg: d.palabras.length / dur });
}

/* Sólo los de LOCUCIÓN. Por debajo de 0,4 palabras/segundo son inserts con algo
 * de ruido o charla suelta de rodaje: leerlos cuesta tokens y no aportan al
 * corte. El umbral está medido sobre los 147 clips de otra jornada, donde separó
 * 140 — y los 7 que erró eran, en su mayoría, habla real captada en b-roll. */
const MIN = Number(process.argv[2] || 0.4);
const conVozTotal = conVoz.length;
const locucion = conVoz.filter((c) => c.palSeg > MIN);

console.log(`${locucion.length} clips de locución (de ${conVozTotal} con voz), en orden de rodaje\n`);
for (const c of locucion) {
  console.log(`──── ${c.archivo}  [${c.carpeta}]  (${c.dur.toFixed(0)}s, ${c.palSeg.toFixed(2)} pal/s, ${c.frases.length} frases)`);
  // agrupar frases similares = tomas de lo mismo
  const grupos = [];
  for (const f of c.frases) {
    const g = grupos.find((g) => similar(g[0].texto, f.texto) > 0.6);
    if (g) g.push(f); else grupos.push([f]);
  }
  for (const g of grupos) {
    if (g.length === 1) console.log(`   ${g[0].desde.toFixed(1)}s  ${g[0].texto}`);
    else {
      console.log(`   ${g.length} TOMAS de lo mismo — la última es la buena:`);
      g.forEach((f, i) => console.log(`      ${i === g.length - 1 ? "✓" : " "} ${f.desde.toFixed(1)}s  ${f.texto}`));
    }
  }
  console.log();
}
