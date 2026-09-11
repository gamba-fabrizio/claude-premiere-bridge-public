/* Calcula los SUPLENTES de cada beat: otras tomas de la misma línea que quedaron
 * afuera del corte.
 *
 * La detección naive —cualquier frase parecida del proyecto— da basura: el clip
 * 72, que son 3,5s de "Sí, la casa, la casa", salía como suplente de 13 beats
 * distintos porque comparte palabras cortas con todo, y aparecían "suplentes" de
 * 3,5s para beats de 25,9s.
 *
 * Lo que lo arregla son tres filtros, y el primero es el que importa:
 *   1. VECINDAD — una regrabación es siempre un clip cercano en orden de rodaje,
 *      porque vuelve a decir la línea enseguida. Ventana de ±3.
 *   2. DURACIÓN parecida (entre la mitad y el doble).
 *   3. Similitud sobre palabras de más de 4 letras, que saca los "que", "para".
 *
 * Y a cada suplente se le aplica el MISMO cruce contra el VAD que a los
 * titulares: una toma alternativa puede tener los tiempos corrompidos por un
 * arranque en falso igual que cualquier otra. El _67 es vecino del _68, que los
 * tenía mal por 5,8s.
 */
const fs = require("fs");
const path = require("path");
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
const COLA = 0.25, VENTANA = 3;

const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
const sim = (a, b) => {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 4));
  const B = new Set(norm(b).split(" ").filter((w) => w.length > 4));
  if (A.size < 3 || B.size < 3) return 0;
  let c = 0; for (const w of A) if (B.has(w)) c++;
  return c / Math.min(A.size, B.size);
};
function frases(p) {
  const o = []; let c = null;
  for (const w of p) { if (!c) c = { desde: w.desde, hasta: 0, pal: [] }; c.pal.push(w.texto); c.hasta = w.desde + w.dura; if (w.eos) { o.push(c); c = null; } }
  if (c) o.push(c);
  return o.map((f) => ({ ...f, texto: f.pal.join(" ") }));
}

const datos = {};
for (const f of fs.readdirSync(D).filter((f) => f.endsWith(".audio.json"))) {
  const d = JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
  /* Se filtra por PALABRAS POR SEGUNDO, no por el nombre de la carpeta.
   * Filtrar por "/Entrevistas/" era una suposición de la primera jornada: en la
   * segunda las carpetas son los productos, la lista quedó vacía y el verbo
   * informó "0 suplentes" —que se lee como un resultado y era un error—. */
  const durc = d.tramos.length ? d.tramos[d.tramos.length - 1].hasta : 0;
  if (!durc || d.palabras.length / durc <= 0.4) continue;
  datos[Number(f.match(/_(\d+)\.audio/)[1])] = d;
}

/** El mismo ajuste de in que se le hace a un titular. */
function ajustar(clip, fr) {
  const d = datos[clip];
  let desde = fr.desde;
  const dentro = d.palabras.filter((p) => p.desde >= fr.desde - 0.01 && p.desde <= fr.hasta + 0.01);
  let hueco = null;
  for (let i = 1; i < dentro.length; i++) {
    const g = dentro[i].desde - (dentro[i - 1].desde + dentro[i - 1].dura);
    if (g > 1.5 && (!hueco || g > hueco.g)) hueco = { g, tras: dentro[i].desde };
  }
  const voz = (t) => d.tramos.find((x) => x.que === "VOZ" && t >= x.desde - 0.01 && t <= x.hasta + 0.01);
  let nota = null;
  if (hueco) {
    const v = voz(hueco.tras);
    if (v) { nota = `in corregido ${desde.toFixed(2)}→${v.desde.toFixed(2)} (hueco de ${hueco.g.toFixed(1)}s)`; desde = v.desde; }
    else nota = `⚠️ hueco de ${hueco.g.toFixed(1)}s sin tramo VOZ`;
  } else {
    const ws = dentro.length / Math.max(fr.hasta - desde, 0.01);
    if (ws > 4.5 && dentro.length >= 8) {
      let ini = desde;
      for (let i = d.tramos.length - 1; i >= 0; i--) {
        const t = d.tramos[i];
        if (t.hasta <= ini + 0.05 && t.hasta >= ini - 0.6) { if (t.que === "SIL") break; ini = t.desde; i++; }
      }
      if (ini < desde - 0.1) { nota = `in corregido ${desde.toFixed(2)}→${ini.toFixed(2)} (${ws.toFixed(1)} pal/s, apiñado)`; desde = ini; }
      else nota = `⚠️ ${ws.toFixed(1)} pal/s sin por dónde extender`;
    }
  }
  const sig = d.palabras.find((p) => p.desde > fr.hasta - 0.001);
  const hasta = sig ? Math.min(fr.hasta + COLA, sig.desde) : fr.hasta + COLA;
  return { desde, hasta, nota };
}

const V = JSON.parse(fs.readFileSync(path.join(D, "VIDEOS.json"), "utf8"));
const salida = [];
for (let i = 0; i < V.length; i++) {
  const titulares = new Set(V[i].beats.map((b) => b.clip));
  const delVideo = [];
  for (const b of V[i].beats) {
    const dur = b.hasta - b.desde;
    const cand = [];
    for (const clip of Object.keys(datos).map(Number)) {
      if (clip === b.clip || titulares.has(clip) || Math.abs(clip - b.clip) > VENTANA) continue;
      for (const fr of frases(datos[clip].palabras)) {
        if (fr.pal.length < 6) continue;
        const d = fr.hasta - fr.desde;
        if (d < dur * 0.5 || d > dur * 1.8) continue;
        const s = sim(fr.texto, b.texto);
        if (s > 0.5) cand.push({ clip, fr, s });
      }
    }
    cand.sort((x, y) => y.s - x.s);
    const porClip = {};
    for (const c of cand) if (!porClip[c.clip]) porClip[c.clip] = c;
    for (const c of Object.values(porClip)) {
      const a = ajustar(c.clip, c.fr);
      /*
       * El filtro de duración se REAPLICA después del ajuste, porque el ajuste lo
       * puede invalidar: el _50 pasaba con 21,6s y el cruce contra el VAD le movió
       * el in de 0,43 a 16,00, dejándolo en 6,26s contra 23,23s del titular. Ya no
       * cubre la línea, así que no es un suplente.
       *
       * Y ese caso deja ver un límite de la regla del VAD: asume que lo útil está
       * DESPUÉS del hueco —que es cierto en un arranque en falso— y en el _50 es al
       * revés, dice la línea y después charla. Como no sé distinguirlos, acá se
       * descarta en vez de ofrecer un pedazo.
       */
      const duraAjustada = a.hasta - a.desde;
      if (duraAjustada < dur * 0.5 || duraAjustada > dur * 1.8) continue;
      /*
       * Y un piso ABSOLUTO de palabras compartidas, no solo el porcentaje: con
       * frases cortas el porcentaje se dispara. "Aunque con nuestros hijos, los
       * perros, espera" compartía 3 palabras largas con un beat de tres frases y
       * pasaba; no es una toma alternativa, es un comentario suelto.
       */
      const A = new Set(norm(c.fr.texto).split(" ").filter((w) => w.length > 4));
      const B = new Set(norm(b.texto).split(" ").filter((w) => w.length > 4));
      let comunes = 0; for (const w of A) if (B.has(w)) comunes++;
      if (comunes < 4) continue;
      delVideo.push({
        deBeat: { clip: b.clip, desde: b.desde }, clip: c.clip,
        archivo: path.basename(datos[c.clip].archivo),
        desde: Number(a.desde.toFixed(2)), hasta: Number(a.hasta.toFixed(2)),
        dura: Number((a.hasta - a.desde).toFixed(2)), duraTitular: Number(dur.toFixed(2)),
        texto: c.fr.texto, parecido: Number(c.s.toFixed(2)), nota: a.nota,
      });
    }
  }
  salida.push({ video: i + 1, titulo: V[i].titulo, suplentes: delVideo });
}

fs.writeFileSync(path.join(D, "SUPLENTES.json"), JSON.stringify(salida, null, 1));
for (const v of salida) {
  console.log(`\n── video ${v.video}  ${v.titulo}  (${v.suplentes.length} suplentes)`);
  for (const s of v.suplentes) {
    const delta = s.dura - s.duraTitular;
    console.log(`   _${s.clip} @${s.desde}s  ${s.dura}s vs ${s.duraTitular}s (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}s)  ← titular _${s.deBeat.clip}`);
    console.log(`      "${s.texto.slice(0, 95)}"`);
    if (s.nota) console.log(`      ${s.nota}`);
  }
}
console.log(`\ntotal: ${salida.reduce((n, v) => n + v.suplentes.length, 0)} suplentes`);
