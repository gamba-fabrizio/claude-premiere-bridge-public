#!/usr/bin/env node
/* Planchas de contacto a partir del `broll.json` que escribe `broll.js`.
 *
 * Existe porque mirar los cuadros de a uno cuesta ~3 veces más tokens que
 * mirarlos en grilla, y encima en la grilla se ve el CONJUNTO: qué planos se
 * repiten, cuáles son del mismo ángulo, dónde hay un salto de luz.
 *
 * Una plancha por CARPETA, que es como está catalogado el material: así cada
 * lote es un espacio del edificio y se puede decidir sobre él sin mezclar.
 *
 * La etiqueta la pone `montage` de ImageMagick, NO `drawtext` de ffmpeg:
 * drawtext no siempre está compilado —falta libfreetype— y falla en silencio si
 * se come el stderr. Sin etiqueta habría que deducir el clip contando casillas, y
 * eso se equivoca en cuanto falta un cuadro.
 *
 * Y la fuente va EXPLÍCITA: ImageMagick puede no tener ninguna configurada y
 * `-label` contesta "unable to read font".
 *
 * Uso: node planchas.js [--destino <dir>] [--por <n>] [--grupo <nombre>]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const D = opt("destino", process.cwd());
const POR = Number(opt("por", 12));
const soloGrupo = opt("grupo", null);
const FUENTE = "/System/Library/Fonts/Supplemental/Arial.ttf";

const datos = JSON.parse(fs.readFileSync(path.join(D, "broll.json"), "utf8"));
const salida = path.join(D, "planchas");
/* Con `--grupo` NO se borra todo: sólo se rehacen las de ese grupo. Borrar la
 * carpeta entera al filtrar por uno se llevó las otras diecisiete, y el script
 * informó "1 plancha" como si hubiera salido bien. */
if (!soloGrupo) fs.rmSync(salida, { recursive: true, force: true });
fs.mkdirSync(salida, { recursive: true });

const porGrupo = {};
for (const c of datos) {
  if (soloGrupo && c.grupo !== soloGrupo) continue;
  (porGrupo[c.grupo] = porGrupo[c.grupo] || []).push(c);
}

let total = 0;
for (const grupo of Object.keys(porGrupo).sort()) {
  const clips = porGrupo[grupo];
  // sólo el cuadro del medio: para reconocer QUÉ es alcanza, y triplicar la
  // grilla para ver el movimiento sale caro. El movimiento ya está medido.
  const casillas = [];
  for (const c of clips) {
    const medio = c.cuadros.find((f) => /_50\.jpg$/.test(f)) || c.cuadros[0];
    if (!medio || !fs.existsSync(medio)) continue;
    const mov = c.mov ? `mov ${c.mov.medio}` : "mov ?";
    casillas.push({ f: medio, etiqueta: `${c.nombre.replace(/^FX3_|^DJI_/, "")} · ${c.dur.toFixed(0)}s · ${mov}` });
  }
  for (let i = 0; i < casillas.length; i += POR) {
    const lote = casillas.slice(i, i + POR);
    const args2 = [];
    for (const x of lote) args2.push("-label", x.etiqueta, x.f);
    const n = casillas.length > POR ? `_${Math.floor(i / POR) + 1}` : "";
    const destino = path.join(salida, `${grupo.replace(/[^\w]/g, "_")}${n}.jpg`);
    args2.push("-font", FUENTE, "-tile", "4x", "-geometry", "300x169+5+5",
      "-background", "white", "-pointsize", "15", destino);
    execFileSync("montage", args2);
    total++;
  }
}

console.log(`${total} plancha(s) en ${salida}`);
for (const f of fs.readdirSync(salida).sort()) {
  console.log(`  ${f}  ${Math.round(fs.statSync(path.join(salida, f)).size / 1024)} KB`);
}
