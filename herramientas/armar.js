/* Arma el texto de cada video de la jornada con timecodes reales, a partir SOLO
 * de las transcripciones — el proyecto terminado no se mira.
 *
 * La selección de tomas la decidí leyendo el texto; acá lo único automático es
 * resolver cada beat a los bordes EXACTOS de palabra, que es lo que no se puede
 * hacer a ojo: un beat se pide por el segundo en que arranca la frase y el
 * script devuelve el in del primer word y el out del último.
 *
 * Si un beat no matchea, GRITA en vez de saltearlo en silencio: un beat que
 * desaparece deja el guion con un agujero y el número de al lado sigue estando,
 * así que no se nota. Es el modo de fallar nº1 del CLAUDE.md del bridge.
 */
const fs = require("fs");
const path = require("path");
const D = process.env.PROYECTO_DIR || process.cwd();

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
const COLA = 0.25; // aire al final, para que no corte la última sílaba

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

const cache = {};
function clip(n) {
  if (!cache[n]) {
    const d = JSON.parse(fs.readFileSync(path.join(D, `${PREFIJO}${n}.audio.json`), "utf8"));
    cache[n] = { frases: frases(d.palabras), palabras: d.palabras, tramos: d.tramos, archivo: path.basename(d.archivo) };
  }
  return cache[n];
}

let fallos = 0;
/** Resuelve un beat: clip + tiempos de arranque de las frases que lo componen.
 *
 * `op.hasta` corta ANTES del final de la frase, para las que terminan
 * arrastrando un murmullo. Hace falta porque el borde de frase de Whisper no es
 * el borde editorial: en el clip 9 la frase sigue con "que es lo que está
 * haciendo" en 0,95s para cinco palabras —"haciendo" recibe 0,02s—, que es ruido
 * comprimido, no habla. El texto se recorta también, así que lo que dice el
 * guion es lo que se va a oír.
 */
function beat(n, tiempos, nota, op) {
  op = op || {};
  const c = clip(n);
  const elegidas = [];
  for (const t of [].concat(tiempos)) {
    // Todas las que caen dentro de la tolerancia, no sólo la más cercana: en el
    // clip 68 el hook y un "Dale." arrancan LOS DOS en 7.4s, y quedarse con la
    // primera trajo el "Dale.". Una guarda por distancia no ve la ambigüedad
    // porque la distancia es cero. Ante empate gana la más larga —el "Dale." de
    // un asistente nunca es el beat— y se informa que hubo empate.
    const cerca = c.frases.filter((f) => Math.abs(f.desde - t) <= 1.0)
      .sort((a, b) => b.palabras.length - a.palabras.length);
    if (!cerca.length) {
      let mejor = null;
      for (const f of c.frases) if (!mejor || Math.abs(f.desde - t) < Math.abs(mejor.desde - t)) mejor = f;
      console.log(`\n   ⚠️  BEAT SIN RESOLVER: clip ${n} @ ${t}s — la más cercana está a ${mejor ? (mejor.desde - t).toFixed(1) : "?"}s`);
      fallos++; continue;
    }
    if (cerca.length > 1) {
      console.log(`   · clip ${n} @ ${t}s: ${cerca.length} frases empatadas, tomo la más larga (${cerca[0].palabras.length} palabras) — descartadas: ${cerca.slice(1).map((f) => `"${f.texto}"`).join(", ")}`);
    }
    elegidas.push(cerca[0]);
  }
  if (!elegidas.length) return null;
  let desde = Math.min(...elegidas.map((f) => f.desde));
  let fin = Math.max(...elegidas.map((f) => f.hasta));

  /* CRUCE CONTRA EL VAD. Los tiempos de palabra de Whisper mienten cuando hay un
   * arranque en falso: en el clip 68 pegó el "¿Sabías" del intento anterior
   * (7.44s) al principio de la toma buena, dejando un hueco de 5.8s adentro de la
   * misma frase. El in salía 7 segundos antes de que empiece a hablar.
   *
   * El VAD no depende de Whisper —mide dB sobre la onda—, así que sirve de
   * verificación de AFUERA: si adentro del beat hay un hueco largo, la parte útil
   * es la de después, y el in se pega al arranque del tramo de VOZ que la
   * contiene. Y si el in no cae en ningún tramo de VOZ, se avisa en vez de
   * entregar un número plausible. */
  const dentro = c.palabras.filter((p) => p.desde >= desde - 0.01 && p.desde <= fin + 0.01);
  let hueco = null;
  for (let i = 1; i < dentro.length; i++) {
    const g = dentro[i].desde - (dentro[i - 1].desde + dentro[i - 1].dura);
    if (g > 1.5 && (!hueco || g > hueco.g)) hueco = { g, tras: dentro[i].desde, palabra: dentro[i].texto };
  }
  const voz = (t) => c.tramos.find((x) => x.que === "VOZ" && t >= x.desde - 0.01 && t <= x.hasta + 0.01);
  let aviso = null;
  if (hueco) {
    const v = voz(hueco.tras);
    if (v) {
      aviso = `in corregido de ${desde.toFixed(2)}s a ${v.desde.toFixed(2)}s — hueco de ${hueco.g.toFixed(1)}s adentro de la frase (arranque en falso); el VAD pone la voz en ${v.desde.toFixed(2)}–${v.hasta.toFixed(2)}s`;
      desde = v.desde;
    } else {
      aviso = `⚠️ hueco de ${hueco.g.toFixed(1)}s adentro de la frase antes de "${hueco.palabra}" y el VAD no da un tramo de VOZ — REVISAR A MANO`;
      fallos++;
    }
  } else if (!voz(desde)) {
    aviso = `⚠️ el in ${desde.toFixed(2)}s no cae en ningún tramo de VOZ — REVISAR A MANO`;
    fallos++;
  }

  /* Y el otro modo, que el chequeo del hueco NO ve: las palabras APIÑADAS.
   *
   * En el clip 69 la frase de 17 palabras salió con los tiempos metidos en 2,1
   * segundos —"al", "de", "la" con 0,04s cada una— o sea 8 palabras por segundo,
   * que no es habla humana. No hay hueco interno que delatarlo: están pegadas. El
   * in quedaba 3,8s TARDE y el recorte devolvía sólo el final de la frase.
   *
   * Lo que sí se ve es la densidad. Y para corregirlo hay que caminar los tramos
   * del VAD hacia atrás, pero NO sólo los `VOZ`: la primera mitad de esa frase
   * vivía en un tramo marcado `SUENA` a −23,2 dB, más fuerte que el `VOZ` de al
   * lado. Lo que separa habla de silencio acá es el `SIL`, no la etiqueta. */
  const dur = fin - desde; // el tramo de habla, sin la cola: es lo que se mide
  const ws = dentro.length / Math.max(dur, 0.01);
  /* El piso de 8 palabras no es cosmético: una interjección corta se dice de
   * verdad muy rápido. "Esta parte es mentira" son 4 palabras en 0,7s = 5,7 pal/s
   * y es habla real; el apiñado del clip 69 eran 17 palabras a 8,1. Sin el piso,
   * el chequeo marca los apartes y se lo empieza a ignorar. */
  if (!hueco && ws > 4.5 && dentro.length >= 8) {
    let ini = desde;
    for (let i = c.tramos.length - 1; i >= 0; i--) {
      const t = c.tramos[i];
      if (t.hasta <= ini + 0.05 && t.hasta >= ini - 0.6) { // el tramo que pega por atrás
        if (t.que === "SIL") break;
        ini = t.desde; i++; // seguimos hacia atrás desde este
      }
    }
    if (ini < desde - 0.1) {
      aviso = `in corregido de ${desde.toFixed(2)}s a ${ini.toFixed(2)}s — ${dentro.length} palabras en ${dur.toFixed(1)}s son ${ws.toFixed(1)} pal/s, imposible; el VAD tiene sonido continuo desde ${ini.toFixed(2)}s`;
      desde = ini;
    } else {
      aviso = `⚠️ ${ws.toFixed(1)} pal/s en clip ${n} y el VAD no da por dónde extender — REVISAR A MANO`;
      fallos++;
    }
  }
  /*
   * LA CORRECCIÓN SE VERIFICA: tiene que seguir cubriendo la frase.
   *
   * La regla del VAD asume que lo útil está DESPUÉS del hueco, que es cierto en
   * un arranque en falso. Pero un hueco también puede ser una PAUSA en medio de
   * la frase —esta locutora lee el guion y pausa— y ahí mover el in se come el
   * principio. Medido: sin este chequeo, 16 de 51 beats se "corrigieron", y en
   * varios el tramo de VOZ elegido duraba 0,8s para una frase de 10.
   *
   * El chequeo es el mismo que ya se le había puesto a la detección de
   * suplentes; no haberlo traído acá al escribirlo es lo que costó esta vuelta.
   */
  if (aviso && desde !== fin && /in corregido/.test(aviso)) {
    const quedan = dentro.filter((p) => p.desde >= desde - 0.01).length;
    if (quedan / Math.max(dentro.length, 1) < 0.7) {
      aviso = `corrección DESCARTADA (dejaba ${quedan} de ${dentro.length} palabras): el hueco era una pausa, no un arranque en falso`;
      desde = Math.min(...elegidas.map((f) => f.desde));
    }
  }
  if (aviso) console.log(`   · clip ${n}: ${aviso}`);
  // La cola no se puede comer la palabra siguiente: si la hay, el out se pega a
  // su arranque. Sin esto, dos beats consecutivos del mismo clip se solapan y el
  // segundo arranca ANTES de que termine el primero.
  /* ---------- cuánto del beat es VOZ ----------
   *
   * El chequeo de densidad mira si las palabras están APIÑADAS —demasiadas por
   * segundo, señal de tiempos corrompidos— y no miraba lo inverso: un beat
   * demasiado RALO, que es casi todo silencio. Medido el 2026-08-17 sobre una
   * jornada con guion leído: 11 de 58 beats tenían huecos internos de más de un
   * segundo, y el peor —el CTA del clip 92— eran 26,2 segundos para 23 palabras,
   * 0,88 pal/s contra las 2,08 del montaje real. Casi 30 segundos de material
   * muerto repartidos, que nadie había medido.
   *
   * El "hueco mayor" NO sirve como medida: el del 92 era de sólo 2,1s y el beat
   * igual era 88% silencio, porque estaba repartido. Lo que sirve es la fracción
   * cubierta por tramos VOZ, que además viene del VAD y no de Whisper.
   *
   * Lo que se corrige solo es el silencio de las PUNTAS, que es inequívoco. El
   * de adentro se informa con los números y se decide a mano: sacarlo parte el
   * beat en dos cortes, y eso es montaje, no limpieza. */
  const vozEntre = (a, b) => c.tramos
    .filter((t) => t.que === "VOZ" && t.hasta > a && t.desde < b)
    .reduce((s, t) => s + (Math.min(t.hasta, b) - Math.max(t.desde, a)), 0);

  {
    const primeraVoz = c.tramos.find((t) => t.que === "VOZ" && t.hasta > desde + 0.05);
    const ultimaVoz = [...c.tramos].reverse().find((t) => t.que === "VOZ" && t.desde < fin - 0.05);
    const recortes = [];
    if (primeraVoz && primeraVoz.desde > desde + 0.4) { recortes.push(`${(primeraVoz.desde - desde).toFixed(1)}s de silencio al principio`); desde = primeraVoz.desde - 0.1; }
    if (ultimaVoz && ultimaVoz.hasta < fin - 0.4) { recortes.push(`${(fin - ultimaVoz.hasta).toFixed(1)}s al final`); fin = ultimaVoz.hasta + 0.1; }
    if (recortes.length) console.log(`   · clip ${n}: recortado ${recortes.join(" y ")}`);
  }

  const sig = c.palabras.find((p) => p.desde > fin - 0.001);
  let hasta = sig ? Math.min(fin + COLA, sig.desde) : fin + COLA;
  let texto = elegidas.map((f) => f.texto).join(" ");
  /*
   * `op.desde` fuerza el in. Hace falta cuando los tiempos de palabra están
   * apiñados por debajo del piso del chequeo de densidad: en el clip 51 las seis
   * palabras de "¿Ya lo usaste en algún proyecto?" tienen duración CERO en 9,83
   * y el VAD pone la voz en 9,40–12,30. Con 6 palabras el chequeo automático no
   * se dispara —pide 8— y el recorte perdía la primera mitad y la última palabra.
   */
  if (op.desde !== undefined) desde = op.desde;
  if (op.hasta) {
    // Extender más allá del fin natural sólo es un error si los tiempos de
    // palabra son confiables. Si se forzó el `desde` es porque NO lo son, y ahí
    // extender es justamente el arreglo.
    if (op.hasta > hasta && op.desde === undefined) { console.log(`   ⚠️ clip ${n}: op.hasta ${op.hasta} es POSTERIOR al fin natural ${hasta.toFixed(2)} — no recorta nada`); fallos++; }
    hasta = op.hasta;
    // el texto se recorta con el rango: las palabras que ya no suenan no van en el guion
    const dejadas = c.palabras.filter((p) => p.desde >= desde - 0.01 && p.desde + p.dura <= hasta + 0.01);
    texto = dejadas.map((p) => p.texto).join(" ");
  }
  /* El aviso va acá, con el rango DEFINITIVO: puesto antes, medía el tramo
   * natural y no el que queda tras `op.desde`/`op.hasta`, e informaba 45,6s para
   * un beat que mide 10,8. Un chequeo que mira el valor equivocado es peor que no
   * tenerlo: enseña a ignorar los avisos. */
  {
    const vozDelBeat = vozEntre(desde, hasta), largo = hasta - desde;
    if (largo > 3 && vozDelBeat / largo < 0.6) {
      console.log(`   ⚠️ clip ${n} @${desde.toFixed(1)}s: sólo ${(100 * vozDelBeat / largo).toFixed(0)}% del beat es voz ` +
        `(${(largo - vozDelBeat).toFixed(1)}s muertos en ${largo.toFixed(1)}s) — sacarlos parte el beat en dos cortes, es decisión de montaje`);
    }
  }
  return { n, desde, hasta, dura: hasta - desde, texto, nota };
}
/* La lista de beats NO vive acá: es criterio editorial de cada jornada y va con el
 * material, igual que el glosario. Este script sólo la resuelve a rangos exactos. */
const rutaBeats = path.join(D, "beats.js");
if (!fs.existsSync(rutaBeats)) {
  throw new Error(
    `Falta ${rutaBeats}. Tiene que exportar una función que reciba \`beat\` y ` +
    "devuelva la lista de videos. Hay un ejemplo en herramientas/beats.ejemplo.js."
  );
}
const VIDEOS = require(rutaBeats)(beat);

const t = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
let total = 0;
const L = [];
L.push("# un cliente 19/12/25 — los videos de la jornada\n");
L.push("Armado **sólo con las transcripciones** de los 147 crudos, sin abrir ningún");
L.push("proyecto. Los tiempos son del archivo original, borde de palabra, con");
L.push(`${COLA}s de cola.\n`);

for (const v of VIDEOS) {
  const beats = v.beats.filter(Boolean);
  const dur = beats.filter((b) => !/^ALTERNATIVA|^HOOK B/.test(b.nota)).reduce((a, b) => a + b.dura, 0);
  total += dur;
  L.push(`\n## ${v.titulo}`);
  L.push(`\n*${v.puesta} · crudos ${v.clips} · locución ≈ ${Math.round(dur)}s*\n`);
  L.push("| # | clip | in | out | dura | texto |");
  L.push("|---|------|----|-----|------|-------|");
  beats.forEach((b, i) => {
    L.push(`| ${i + 1} | \`_${b.n}\` | ${t(b.desde)} | ${t(b.hasta)} | ${b.dura.toFixed(1)}s | ${b.texto} |`);
  });
  L.push("");
  beats.forEach((b, i) => L.push(`${i + 1}. ${b.nota}`));
  if (v.ojo) {
    L.push("\n**⚠️ Ojo con esto:**\n");
    for (const b of v.ojo.filter(Boolean)) L.push(`- \`_${b.n}\` ${t(b.desde)} — *"${b.texto}"* — ${b.nota}`);
  }
}
L.push(`\n---\n\n**Total de locución de la jornada: ${Math.round(total)}s** en ${VIDEOS.length} videos.`);

fs.writeFileSync(path.join(D, "VIDEOS.md"), L.join("\n") + "\n");
// El JSON no es un extra: es lo que hace verificable el .md. Sin él, comprobar
// los rangos obliga a tipearlos a mano — y tipeando un out me salió 1.1s largo,
// que es justo el error que la verificación tenía que encontrar.
fs.writeFileSync(path.join(D, "VIDEOS.json"), JSON.stringify(VIDEOS.map((v) => ({
  titulo: v.titulo, beats: v.beats.filter(Boolean).map((b) => ({ clip: b.n, desde: b.desde, hasta: b.hasta, texto: b.texto, archivo: clip(b.n).archivo })),
})), null, 1));
console.log(L.join("\n"));
if (fallos) { console.log(`\n${fallos} beat(s) sin resolver — el guion está incompleto.`); process.exit(1); }
