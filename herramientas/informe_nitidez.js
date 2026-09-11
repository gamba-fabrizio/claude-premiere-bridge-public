#!/usr/bin/env node
/* Informe legible de lo que midió `nitidez.py`, para cotejar mirando los planos.
 *
 * Existe porque una tabla de 130 filas con números crudos no se puede auditar: hay
 * que poder ver EL CUADRO que la métrica llama blando. Si el número dice una cosa y
 * el frame dice otra, gana el frame.
 *
 * DOS COMPARACIONES, y sólo estas dos son válidas:
 *
 * 1. DENTRO de un clip: qué tramos son blandos respecto del propio pico del clip.
 *    Es la más confiable, porque el contenido es el mismo.
 * 2. DENTRO de un grupo: qué tomas del mismo espacio son más blandas que sus
 *    hermanas. Válida en la medida en que el grupo filme cosas parecidas.
 *
 * Lo que NO se hace es un ranking global: la varianza del Laplaciano depende del
 * contenido, y un drone puntúa 1389 contra 35 de un interior sin que eso signifique
 * nada sobre el foco. Ver el encabezado de `nitidez.py`.
 *
 * Uso: node informe_nitidez.js --datos <nitidez.json> [--destino <dir>]
 *                              [--umbral-tramo 0.5] [--umbral-toma 0.6] [--cuadros]
 *
 * `--cuadros` extrae el frame del peor momento de cada clip señalado y arma planchas
 * de contacto por grupo. Es lo que permite cotejar en un minuto en vez de abrir 130
 * archivos.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

const DATOS = opt("datos", null);
if (!DATOS) { console.error("Falta --datos <nitidez.json>"); process.exit(1); }
const DESTINO = opt("destino", path.dirname(DATOS));
const UMBRAL_TRAMO = Number(opt("umbral-tramo", "0.5"));
const UMBRAL_TOMA = Number(opt("umbral-toma", "0.6"));
const FUENTE = "/System/Library/Fonts/Supplemental/Arial.ttf";

const datos = JSON.parse(fs.readFileSync(DATOS, "utf8")).filter((c) => c.foco);
if (!datos.length) { console.error("No hay clips con datos de foco."); process.exit(1); }

const mediana = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* 1) Tramos blandos DENTRO de cada clip. `serie_rel` ya viene normalizada al pico del
 *    propio clip, así que un valor de 0,3 significa "acá hay un tercio del detalle
 *    que este mismo clip alcanza en su mejor momento". */
for (const c of datos) {
  const s = c.foco.serie_rel || [];
  const fps = 1;   // nitidez.py muestrea el foco a 1 fps
  const flojos = [];
  for (let i = 0; i < s.length; i++) if (s[i] < UMBRAL_TRAMO) flojos.push({ t: i / fps, v: s[i] });
  // Se agrupan en rangos contiguos: doce segundos seguidos son UN problema, no doce.
  const rangos = [];
  for (const f of flojos) {
    const ult = rangos[rangos.length - 1];
    if (ult && f.t - ult.hasta <= 1.5) { ult.hasta = f.t; ult.peor = Math.min(ult.peor, f.v); }
    else rangos.push({ desde: f.t, hasta: f.t, peor: f.v });
  }
  c.tramos = rangos;
  c.peorT = s.length ? s.indexOf(Math.min(...s)) / fps : null;
  c.peorV = s.length ? Math.min(...s) : null;
}

/* 2) Tomas blandas DENTRO de su grupo. */
const grupos = {};
for (const c of datos) (grupos[c.grupo || "(sin grupo)"] = grupos[c.grupo || "(sin grupo)"] || []).push(c);
for (const g of Object.keys(grupos)) {
  const lista = grupos[g];
  const med = mediana(lista.map((c) => c.foco.crudo_medio));
  for (const c of lista) c.vsGrupo = med > 0 ? c.foco.crudo_medio / med : 1;
}

/* ---------- informe ---------- */
const lineas = [];
lineas.push("# Nitidez y temblor — informe para cotejar\n");
lineas.push(`${datos.length} clips medidos. **El número no es un ranking global de calidad**: la`);
lineas.push("varianza del Laplaciano depende del contenido. Sólo valen las comparaciones dentro");
lineas.push("de un clip y dentro de un grupo.\n");

const temblores = datos.map((c) => (c.temblor ? c.temblor.por_mil_ancho : 0));
lineas.push(`## Temblor\n`);
lineas.push(`Máximo medido: **${Math.max(...temblores).toFixed(2)}** por mil del ancho.`);
lineas.push(`Mediana: ${mediana(temblores).toFixed(2)}. La referencia: un temblor inyectado a`);
lineas.push(`propósito en la validación dio **3,34**.\n`);
const temblones = datos.filter((c) => c.temblor && c.temblor.por_mil_ancho > 0.5)
  .sort((a, b) => b.temblor.por_mil_ancho - a.temblor.por_mil_ancho);
if (!temblones.length) {
  lineas.push("**Ningún clip pasa de 0,5.** El material está estable; el temblor no discrimina nada acá.\n");
} else {
  lineas.push("Clips por encima de 0,5:\n");
  for (const c of temblones) lineas.push(`- \`${c.nombre}\` (${c.grupo}) — ${c.temblor.por_mil_ancho.toFixed(2)}`);
  lineas.push("");
}

lineas.push(`## Tomas blandas respecto de su grupo\n`);
lineas.push(`Por debajo del ${Math.round(UMBRAL_TOMA * 100)}% de la mediana del grupo.\n`);
const blandas = datos.filter((c) => c.vsGrupo < UMBRAL_TOMA).sort((a, b) => a.vsGrupo - b.vsGrupo);
if (!blandas.length) lineas.push("Ninguna.\n");
else {
  lineas.push("| clip | grupo | nitidez | vs mediana del grupo |");
  lineas.push("|---|---|---|---|");
  for (const c of blandas) {
    lineas.push(`| \`${c.nombre}\` | ${c.grupo} | ${c.foco.crudo_medio.toFixed(0)} | ${(c.vsGrupo * 100).toFixed(0)}% |`);
  }
  lineas.push("");
}

lineas.push(`## Tramos blandos dentro de un clip\n`);
lineas.push(`Momentos por debajo del ${Math.round(UMBRAL_TRAMO * 100)}% del pico DEL PROPIO clip.`);
lineas.push("Esto es lo más confiable del informe, porque compara el mismo contenido.\n");
const conTramos = datos.filter((c) => c.tramos.length).sort((a, b) => a.peorV - b.peorV);
if (!conTramos.length) lineas.push("Ninguno.\n");
else {
  lineas.push("| clip | grupo | tramos | peor momento |");
  lineas.push("|---|---|---|---|");
  for (const c of conTramos) {
    const t = c.tramos.map((r) => (r.desde === r.hasta ? `${r.desde}s` : `${r.desde}–${r.hasta}s`)).join(", ");
    lineas.push(`| \`${c.nombre}\` | ${c.grupo} | ${t} | ${c.peorT}s (${(c.peorV * 100).toFixed(0)}%) |`);
  }
  lineas.push("");
}

lineas.push(`## Ranking por grupo\n`);
for (const g of Object.keys(grupos).sort()) {
  const lista = [...grupos[g]].sort((a, b) => b.foco.crudo_medio - a.foco.crudo_medio);
  lineas.push(`**${g}** (${lista.length}) — de más a menos nítido:`);
  lineas.push(lista.map((c) => `\`${c.nombre}\` ${c.foco.crudo_medio.toFixed(0)}`).join(" · "));
  lineas.push("");
}

const md = path.join(DESTINO, "NITIDEZ.md");
fs.writeFileSync(md, lineas.join("\n"));
console.log(`informe: ${md}`);
console.log(`  ${temblones.length} clip(s) con temblor >0,5 · ${blandas.length} toma(s) blanda(s) · ${conTramos.length} clip(s) con tramos blandos`);

/* ---------- cuadros para cotejar ---------- */
if (!flag("cuadros")) {
  console.log("\nSin --cuadros no se extrajo ningún frame. Con la bandera se arman las planchas.");
  process.exit(0);
}
const dirC = path.join(DESTINO, "nitidez_cuadros");
fs.rmSync(dirC, { recursive: true, force: true });
fs.mkdirSync(dirC, { recursive: true });

/* Se extrae el PEOR momento de cada clip señalado, y para comparar, el MEJOR del
 * mismo clip: un cuadro blando aislado no dice nada si no se ve al lado del nítido
 * del mismo plano. */
const señalados = [...new Set([...blandas, ...conTramos])];
const porGrupo = {};
let n = 0;
for (const c of señalados) {
  if (!fs.existsSync(c.ruta)) continue;
  const s = c.foco.serie_rel || [];
  if (!s.length) continue;
  const peor = s.indexOf(Math.min(...s));
  const mejor = s.indexOf(Math.max(...s));
  const casillas = [];
  for (const [etq, t] of [["peor", peor], ["mejor", mejor]]) {
    const f = path.join(dirC, `${c.nombre}_${etq}.jpg`);
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", c.ruta,
        "-frames:v", "1", "-vf", "scale=640:-2", f]);
      casillas.push({ f, etiqueta: `${c.nombre} ${etq} ${t}s (${Math.round(s[etq === "peor" ? peor : mejor] * 100)}%)` });
    } catch (e) { /* si un cuadro no sale, se sigue */ }
  }
  if (casillas.length) { (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(...casillas); n++; }
}
let planchas = 0;
for (const g of Object.keys(porGrupo)) {
  const cs = porGrupo[g];
  for (let i = 0; i < cs.length; i += 8) {
    const lote = cs.slice(i, i + 8);
    const a = [];
    for (const x of lote) a.push("-label", x.etiqueta, x.f);
    const suf = cs.length > 8 ? `_${Math.floor(i / 8) + 1}` : "";
    a.push("-font", FUENTE, "-tile", "2x", "-geometry", "460x259+4+4",
      "-background", "white", "-pointsize", "14",
      path.join(DESTINO, `NITIDEZ_${String(g).replace(/[^\w]/g, "_")}${suf}.jpg`));
    execFileSync("magick", ["montage", ...a]);
    planchas++;
  }
}
console.log(`  ${n} clip(s) con cuadros extraídos · ${planchas} plancha(s) en ${DESTINO}`);
console.log("  Cada plancha muestra el PEOR y el MEJOR momento del mismo clip, para comparar.");
