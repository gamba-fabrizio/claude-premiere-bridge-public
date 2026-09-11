#!/usr/bin/env node
/* Proxies con marca de agua, a 1920x1080.
 *
 * LA RESOLUCION ES 1920 SIEMPRE, decidido por el editor el 2026-09-06. Este encabezado decia
 * "a la MISMA resolución que el original", que venia de una cautela mia del 2026-08-19: que
 * cambiar las dimensiones hiciera comportarse distinto a Motion, los escalados o las mascaras
 * entre editar y exportar. Nunca se materializo — un videoclip y un institucional se editaron enteros con
 * proxies a 1920 sobre material 4K y el unico defecto que aparecio fue de CROMA, jamas de
 * geometria— y en cambio si esta medido que su monitor de preview es FHD, o sea que un proxy
 * a 4K son pixeles que nunca va a ver.
 *
 * `--ancho 0` sigue existiendo y conserva la del original, para el caso que lo pida.
 *
 * Por qué no lo hace Premiere: `IngestSettings` sólo expone un booleano
 * (`setIngestEnabled`), sin forma de elegir el preset ni de disparar la creación
 * para material ya importado. La otra vía sería `encodeProjectItem` con un `.epr`,
 * que pasa por Media Encoder y entonces el archivo lo escribe otro proceso y no se
 * puede confirmar. Con ffmpeg se controla todo y se verifica en disco.
 *
 * ## OJO: LA TABLA DE ABAJO MIDE LO QUE NO IMPORTA (corregido el 2026-08-21)
 *
 * Todos esos números son de decodificación SECUENCIAL —`ffmpeg -f null` leyendo el archivo
 * de punta a punta—, que es la métrica de REPRODUCIR. Un editor no reproduce: **scrubbea**,
 * o sea acceso aleatorio.
 *
 * Con esa medición equivocada se eligió `-preset medium`, que optimiza compresión, y los 115
 * proxies salieron con el GOP por defecto de x264 —250 cuadros, o sea un keyframe cada 5
 * segundos a 50fps— más B-pyramids. Premiere no pudo saltar a cuadros arbitrarios y tiró
 * "Error retrieving frame N, substituting frame N-1" hasta meter negro. Los archivos NO
 * estaban dañados: decodificaban limpios y con la cantidad exacta de cuadros.
 *
 * Y la señal estaba a la vista: que crf 30 y crf 40 dieran EL MISMO número de decodificación
 * no significaba "el bitrate no afecta la fluidez", significaba **que la medición no
 * distinguía nada** porque medía la variable equivocada. Dos ajustes muy distintos con el
 * mismo resultado es una señal de que el instrumento no sirve.
 *
 * Lo que hay que medir es **milisegundos por salto**: codificar, y después pedir un cuadro
 * suelto en N puntos aleatorios. MEDIDO ASÍ el 2026-08-21, FHD crf 18 medium, 12 saltos:
 *
 *     gop 250 + B=2 (el que fallaba)   8,7 MB/10s   385 ms por salto
 *     gop 50, sin B                   11,2          186 ms   2,1x
 *     gop 25, sin B                   12,6          159 ms   2,4x
 *     gop 12, sin B                   15,6          152 ms   2,5x   ← elegido
 *     todo intra                      44,8          137 ms   2,8x
 *
 * Casi toda la ganancia viene de sacar los B-frames y acortar el GOP una vez; después son
 * rendimientos decrecientes. **Todo intra cuesta 5x el tamaño para ganar 10% sobre gop 25.**
 *
 * Se eligió **gop 12** y no gop 25 por el PEOR CASO, no por el promedio: la diferencia media
 * son 7 ms, ruido, pero con gop 25 un salto puede exigir decodificar 25 cuadros y con gop 12
 * nunca más de 12. Los errores de Premiere aparecían en cuadros puntuales, no en el promedio.
 *
 * ### Y ESA TABLA TAMBIÉN ESTÁ INFLADA: el instrumento tiene un piso propio
 *
 * Los números de arriba miden `ffmpeg -ss` lanzado UNA VEZ POR SALTO, así que cada medición
 * incluye arrancar el proceso y abrir el archivo. Eso es un costo FIJO que no baja con el GOP
 * — y que **Premiere no paga**, porque tiene el archivo abierto de antes.
 *
 * Aislado el 2026-08-21 midiendo saltos al segundo 0, que no exigen decodificar nada:
 *
 *     viejo (gop 250, B=2)   arranque 148 ms   con salto 301 ms   ->  DECODIFICAR 154 ms
 *     nuevo (gop 12, sin B)  arranque 249 ms   con salto 277 ms   ->  DECODIFICAR  28 ms
 *
 * O sea **5,5x**, no 2,5x. La mejora real era el doble de lo medido y estaba tapada por el
 * arranque del proceso.
 *
 * Es la SEGUNDA vez que el instrumento miente en este mismo tema —la primera fue medir
 * decodificación secuencial cuando un editor salta— y las dos veces la señal estaba a la
 * vista: allá, que crf 30 y crf 40 dieran idéntico; acá, que los números absolutos fueran
 * el doble de lo que un salto puede costar. **Antes de creerle a una medición, medir el
 * piso del instrumento restándole el caso que no hace trabajo.**
 *
 * MEDIDO el 2026-08-19 sobre un 4K de 24 Mbps, 10s (SECUENCIAL, ver arriba):
 *
 *   original H.264     —        decodifica a 4,8x tiempo real
 *   H.264 crf 30    1,9 MB      9,1x
 *   H.264 crf 40    0,6 MB      9,1x
 *   ProRes Proxy  178,5 MB      6,7x
 *
 * Tres conclusiones que cambian la receta:
 *
 * 1. ProRes NO sirve acá: 94 veces más grande y MÁS LENTO de decodificar, porque
 *    macOS decodifica H.264 por hardware y ProRes 422 a 4K pega en el disco.
 * 2. Subir el CRF no da fluidez, sólo disco: de 30 a 40 el archivo cae a un tercio
 *    y el costo de decodificar es idéntico.
 * 3. A la misma resolución el proxy sólo compra ~1,9x en decodificación. El salto
 *    grande viene de BAJAR LA RESOLUCIÓN.
 *
 * ## Y EL 2026-08-20 SE CAMBIÓ A FHD, contra lo que decía el punto 3
 *
 * Mantener la resolución estaba puesto "a propósito", para que nada que dependa de las
 * dimensiones en píxeles —Motion, escalados, máscaras— se comportara distinto entre
 * editar y exportar. **Eso nunca se midió: era una precaución.** Y el costo era alto:
 * con proxies a 4K el usuario seguía sin playback fluido.
 *
 * Medido sobre un 4K50 de cielo y agua —el peor caso del codec— a crf 24 medium:
 *
 *     original 4K a 24 Mbps                     decodifica a  1,0x   ← sin margen
 *     proxy 4K   3840x2160    35,2 MB/10s                     2,1x
 *     proxy FHD  1920x1080    10,7 MB/10s                     7,2x   ← 3,4x mejor
 *     proxy      960x540       3,1 MB/10s                    39,4x
 *
 * El original decodifica a 1,0x: va justo, y con dos pistas encima no llega. Ahí estaba
 * el playback pesado, y el proxy a 4K compraba apenas el doble.
 *
 * **FHD es mejor en las tres dimensiones a la vez**: 3,4x más fluido, 3 veces más chico y
 * 2,4 veces más rápido de codificar. No hay canje.
 *
 * Y el argumento que lo cierra es del usuario: **su monitor de preview es FHD**, así que
 * un proxy a 4K son píxeles que nunca va a ver. A 1920x1080 el proxy es 1:1 con lo que
 * mira, y la resolución deja de ser un canje.
 *
 * El miedo por Motion no aplica acá porque **ningún plano está escalado**: todo el
 * material es 3840x2160 entrando a una secuencia 3840x2160, o sea Scale 100 y píxeles
 * 1:1. Si algún día hay clips escalados, medirlo antes: se compara el rectángulo que
 * ocupa el contenido con proxy y sin proxy, NO por md5 —el proxy tiene otra resolución y
 * otra compresión, así que los píxeles difieren siempre—.
 *
 * ## El CRF: 18, y `medium` en vez de `slow`
 *
 * Con FHD hay 4 veces menos píxeles, así que alcanza para un CRF mucho más bajo por el
 * mismo peso. Medido sobre 132 minutos de material:
 *
 *     crf 24 medium   10,7 MB/10s   9,2x   0,8 GB   4,6 h
 *     crf 20 medium   19,0 MB/10s   8,2x   1,5 GB   4,9 h
 *     crf 18 medium   25,1 MB/10s   8,3x   1,9 GB   5,2 h   ← elegido
 *     crf 18 slow     25,4 MB/10s   8,0x   2,0 GB   7,2 h
 *
 * **`slow` no compra nada a crf 18**: mismo peso, misma decodificación, dos horas más. El
 * preset lento sirve a bitrates bajos, y a crf 18 la calidad ya es casi transparente.
 *
 * La MARCA va quemada, y es deliberado: con la misma resolución no hay forma de
 * saber mirando el cuadro si estás en el proxy o en el original. No puede filtrarse
 * a una entrega porque Premiere exporta siempre del original; el riesgo real es
 * relinkear el medio al proxy por error, y ahí la marca avisa.
 *
 * Se dibuja con ImageMagick y se pega con `overlay`, NO con `drawtext`: este ffmpeg
 * no lo tiene compilado —falta libfreetype— y falla en silencio si se come el
 * stderr. Ya se pagó tres veces.
 *
 * Uso:
 *   node proxies.js --origen <carpeta> [--destino <carpeta>] [--crf 18]
 *                   [--ancho 1920] [--preset medium] [--marca PROXY]
 *                   [--rehacer] [--adjuntar] [--proyecto <nombre>]
 *                   [--proxies <carpeta>]
 *
 *   --proxies <carpeta>   NO genera nada: adjunta proxies YA HECHOS que estan en esa carpeta,
 *                         con la nomenclatura que sea. Empareja por prefijo del nombre y
 *                         despues EXIGE que la duracion coincida. Ver el bloque de abajo.
 *   --proyecto <nombre>   guarda. Si no se pasa, se LEE del foco y se manda igual en cada
 *                         llamada, asi un cambio de foco a mitad de tanda rebota.
 *
 *   --ancho 0             mantiene la resolución del original (el comportamiento viejo).
 *   --opacidad-marca 0.35 cuánto se nota el label "PROXY". 0.35 es el default y sale de
 *                         mirarlo: a 0,92 competía con la imagen.
 *   --gop 12              cuadros entre keyframes. NO subirlo sin leer el encabezado.
 *   --rehacer   vuelve a codificar los que ya existen. HACE FALTA para reemplazar una
 *               tanda anterior: sin esto se saltean y la corrida informa "0 de 0".
 *
 * `--adjuntar` los engancha en Premiere por el bridge. Requiere el panel abierto y
 * que los medios estén en el proyecto con el mismo nombre de archivo.
 *
 * ## Los clips con FLAG DE ROTACIÓN salen verticales, y ESTÁ BIEN (2026-08-21)
 *
 * Cinco clips de este proyecto traen `rotation=-90` con el contenido horizontal. ffmpeg
 * obedece el flag, así que sus proxies salen **1920x3414 en vez de 1920x1080**.
 *
 * Parece un error y no lo es: **Premiere también aplica el flag al original**, así que ve el
 * original como vertical. El proxy, con la rotación ya horneada y `rotation=0`, coincide
 * exactamente con lo que Premiere muestra. Verificado extrayendo el mismo instante de los dos
 * y comparándolos: idénticos en orientación y encuadre.
 *
 * Por eso la corrección de `Motion > Rotation -90` que se aplica en la SECUENCIA funciona
 * igual leyendo del original o del proxy: es una transformación de secuencia sobre una
 * geometría que en los dos casos es la misma.
 *
 * **LA TRAMPA ES EL CHEQUEO.** Una verificación que compare el aspecto del proxy contra las
 * dimensiones ALMACENADAS del original (3840x2160) marca estos cinco como discrepancia. Hay
 * que compararlo contra las MOSTRADAS —las de después del flag— o no compararlo. La primera
 * versión del chequeo dio cinco falsos positivos y se leyeron como material roto.
 *
 * ## Adjuntar proxies HECHOS AFUERA: se empareja por DURACION (2026-09-01)
 *
 * Los 127 de un institucional estaban generados afuera, en ProRes `.mov`, y esta herramienta no los podia
 * tocar: `--adjuntar` sólo encontraba los suyos, con la extensión `.mp4` clavada.
 *
 * Y el nombre no alcanza. 26 de esos 127 traen un `_1` de más —`FX3_3080_1_Proxy.mov` para
 * `FX3_3080.MP4`—, seguramente de una segunda pasada que evitó pisar el archivo. Emparejar por
 * nombre deducido los deja afuera; peor, con una busqueda por prefijo los engancharia al clip
 * VECINO, sin error y **sin forma de sacarlo: no hay `detachProxy` en la API**.
 *
 * Por eso el prefijo sólo propone candidatos —y exige que el carácter siguiente sea `_` o `.`,
 * para que `FX3_308` no matchee `FX3_3080`— y **el que decide es la DURACION**, con la misma
 * tolerancia de 0,2s que usa el generador. Medido sobre los 26: diferencia 0,0 con largos de
 * 7,20 a 56,16s, todos distintos entre si. Deducir un nombre es una hipotesis; una duracion que
 * coincide al centesimo sobre 26 archivos distintos es una prueba.
 *
 * Si un original tiene varios candidatos que ademas coinciden en duracion, **NO se adjunta
 * ninguno**: es ambiguo y la operacion no tiene vuelta.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf("--" + n); return i === -1 ? def : args[i + 1]; };
const flag = (n) => args.indexOf("--" + n) !== -1;

const ORIGEN = opt("origen", null);
if (!ORIGEN) {
  console.error("Falta --origen <carpeta con el material>.");
  process.exit(1);
}
const DESTINO = opt("destino", path.join(ORIGEN, "Proxies"));
const CRF = String(opt("crf", "18"));
/* FHD por default: ver el encabezado. Con `--ancho 0` se mantiene la resolución original. */
const ANCHO = String(opt("ancho", "1920"));
const PRESET = String(opt("preset", "medium"));
/* GOP CORTO Y SIN B-FRAMES, y no es negociable para un proxy: ver el encabezado. Con el gop
 * por defecto de x264 (250) Premiere no puede saltar a cuadros arbitrarios y tira
 * "Error retrieving frame, substituting" hasta meter negro. */
const GOP = String(opt("gop", "12"));
const MARCA = opt("marca", "PROXY");

/*
 * EL PERFIL SE ELIGE POR PROYECTO Y NO TIENE UN DEFAULT BUENO PARA TODOS.
 *
 * Regla del editor, 2026-09-04, después de encontrar el problema graduando un videoclip:
 *
 *     el color del proyecto IMPORTA   ->  prores   (fiel, pesado)
 *     redes o trabajo chico y rápido  ->  h264     (liviano, alcanza de sobra)
 *
 * Lo que lo destapó: el material de la FX3 es **log** —el croma del cuadro entero se mueve
 * dentro de ±2 unidades de 128— y el proxy h264 sale en **8 bits 4:2:0** contra el 10 bits
 * 4:2:2 del original. Sobre una señal de tres unidades el paso de cuantización es casi la
 * señal, y graduar la estira treinta veces. El editor lo vio en el verde-magenta de una mano
 * antes de que ninguna medición mía lo mirara: yo había comparado promedios RGB y percentiles
 * de LUMA, que es justo donde una diferencia de CROMA no aparece.
 *
 * Medido sobre dos clips de un videoclip, mismo cuadro, contra el original 4:2:2 de 10 bits:
 *
 *     perfil                error de croma |dV|   decodificar 3s   disco (132 min)
 *     original HEVC 4K              —                4,14 s              —
 *     h264 420 8 bits             0,433              0,14 s           10 GB
 *     h264 4:2:2 10 bits          0,272              0,30 s          ~11 GB
 *     ProRes 422 Proxy            0,204              0,18 s           25 GB
 *
 * **ProRes gana en las dos cosas** —menos error y decodifica MÁS RÁPIDO que el h264 de 10
 * bits— a cambio de 2,5x de disco. Y eso corrige un número viejo del CLAUDE.md que decía que
 * ProRes era "94 veces más grande y MÁS LENTO": aquello se midió **a 4K**; a 1080 se da vuelta.
 * Es la tercera vez que una medición de este repo no sobrevive al cambio de régimen.
 *
 * Ninguno de los dos es el default correcto siempre, así que el perfil se INFORMA en cada
 * corrida: una tanda de dos horas con el perfil equivocado tiene que ser visible en el log.
 */
const PERFIL = String(opt("perfil", "h264")).toLowerCase();
if (PERFIL !== "h264" && PERFIL !== "prores") {
  console.error(`--perfil "${PERFIL}" no existe. Son:\n` +
    "  h264     liviano, 8 bits 4:2:0. Para redes y trabajos chicos.\n" +
    "  prores   422 Proxy, 10 bits 4:2:2. Para proyectos donde importa el color:\n" +
    "           la mitad de error de croma sobre material LOG, a 2,5x de disco.");
  process.exit(1);
}
const EXT = PERFIL === "prores" ? "mov" : "mp4";
/* OPACIDAD DE LA MARCA, por defecto 0,35.
 *
 * Estaba en 0,92 sobre una caja al 0,55 y tapaba demasiado: la marca existe para que no se
 * confunda un proxy con el original, no para competir con la imagen. Pedido del usuario el
 * 2026-08-21 mirando el corte: "le bajaría la opacidad al label PROXY para que no se note
 * taaaaanto". Se aplica al PNG entero —texto y caja— así que un solo número la gobierna. */
const OPACIDAD = Number(opt("opacidad-marca", "0.35"));
const FUENTE = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const VIDEO = /\.(mp4|mov|m4v|mxf|avi|mts|m2ts|braw|r3d)$/i;

fs.mkdirSync(DESTINO, { recursive: true });

/* La etiqueta se dibuja UNA vez y se escala por clip: así el texto sale nítido a
 * cualquier resolución en vez de estirar un PNG chico. */
const etiqueta = path.join(DESTINO, ".etiqueta.png");
execFileSync("magick", [
  "-size", "640x150", "xc:none",
  "-fill", "rgba(0,0,0,0.55)", "-draw", "roundrectangle 0,0 639,149 24,24",
  "-font", FUENTE, "-pointsize", "82",
  "-fill", "rgba(255,255,255,0.92)", "-gravity", "center", "-annotate", "0", MARCA,
  /* La opacidad se aplica acá, al PNG terminado, y no bajando cada `fill`: así el texto y la
   * caja mantienen su relación entre sí y un solo número gobierna cuánto se nota. */
  "-alpha", "set", "-channel", "A", "-evaluate", "multiply", String(OPACIDAD), "+channel",
  etiqueta
]);

const duracion = (f) => {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim());
  } catch (e) { return null; }
};
const tamano = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };

/* NO REEMPLAZAR PROXIES CON PREMIERE ABIERTO (2026-08-21)
 *
 * El `rename` atómico de más arriba evita que Premiere lea un archivo a medio escribir, pero
 * NO evita el otro problema: si Premiere ya tenía el proxy abierto e indexado, cambiárselo
 * abajo lo deja pidiendo cuadros de un archivo que ya no está. Eso es exactamente el
 * "Error retrieving frame N, substituting" que esta tanda venía a arreglar, reaparecido por
 * otra causa.
 *
 * Medido: de 115 proxies, los 11 que se reescribieron DESPUÉS de que el usuario reabriera
 * Premiere quedaron en ese estado, y uno falló al reproducir. El archivo estaba perfecto —40
 * saltos sin fallas, decodificación completa limpia, 12.576 cuadros exactos como el original—
 * así que la falla era del lado de Premiere, no del proxy.
 *
 * Se avisa y se pide confirmación explícita en vez de bloquear: rehacer proxies mientras se
 * edita es legítimo si después se reinicia. Lo que no es legítimo es hacerlo sin saberlo. */
if (flag("rehacer")) {
  let premiereAbierto = false;
  try {
    const ps = require("child_process").execFileSync("pgrep", ["-f", "Adobe Premiere Pro"], { stdio: ["ignore", "pipe", "ignore"] });
    premiereAbierto = String(ps).trim().length > 0;
  } catch (e) { premiereAbierto = false; }   // pgrep devuelve 1 si no hay nada, y eso no es un error
  if (premiereAbierto && !flag("igual-con-premiere-abierto")) {
    console.error("\nPREMIERE ESTÁ ABIERTO y --rehacer va a reemplazar proxies que puede tener indexados.");
    console.error("Eso los deja tirando \"Error retrieving frame N\" aunque el archivo nuevo esté perfecto:");
    console.error("Premiere sigue pidiéndole cuadros al que tenía. Medido el 2026-08-21 sobre 11 clips.\n");
    console.error("Opciones:");
    console.error("  1. Cerrar Premiere y volver a correr esto (lo limpio).");
    console.error("  2. Correr con --igual-con-premiere-abierto y REINICIAR Premiere al terminar.\n");
    process.exit(1);
  }
  if (premiereAbierto) {
    console.log("OJO: Premiere está abierto. Al terminar, REINICIALO o los proxies reemplazados van a fallar.\n");
  }
}

const fuentes = fs.readdirSync(ORIGEN)
  .filter((n) => VIDEO.test(n))
  .map((n) => path.join(ORIGEN, n))
  .filter((f) => fs.statSync(f).isFile())
  .sort();

if (!fuentes.length) {
  console.error(`No hay video en ${ORIGEN}. Extensiones que se buscan: ${VIDEO}`);
  process.exit(1);
}
/* EL PERFIL VA PRIMERO Y EN MAYUSCULAS: ninguno de los dos es correcto siempre, asi que una
 * tanda de dos horas hecha con el equivocado tiene que verse antes de que empiece. */
console.log(`${fuentes.length} archivo(s) en ${ORIGEN}\ndestino: ${DESTINO}\n` +
  `perfil ${PERFIL.toUpperCase()}` +
  (PERFIL === "prores"
    ? "  (ProRes 422 Proxy · 10 bits 4:2:2 · fiel al color, ~2,5x de disco)"
    : `  (h264 8 bits 4:2:0 · crf ${CRF} · preset ${PRESET} · gop ${GOP} sin B · liviano)`) +
  `\nmarca "${MARCA}" al ${Math.round(OPACIDAD*100)}% · ${ANCHO === "0" ? "resolución sin cambiar" : "ancho " + ANCHO}\n`);

const hechos = [];      // los que se generaron en ESTA corrida
const listos = [];      // todos los que están bien en disco: generados + salteados
const saltados = [];
const fallados = [];

/* Con --proxies no se genera NADA: los proxies ya existen y sólo hay que emparejarlos.
 * Se hace acá, antes del bucle, para que el resto del flujo —incluido el adjuntado— sea el
 * mismo camino y no una rama paralela que después se pudre sin que nadie la corra. */
const PROXIES_DIR = opt("proxies", null);
const sinPareja = [];
const ambiguos = [];
if (PROXIES_DIR) {
  if (!fs.existsSync(PROXIES_DIR)) {
    console.error(`No existe la carpeta de proxies: ${PROXIES_DIR}`);
    process.exit(1);
  }
  const cands = fs.readdirSync(PROXIES_DIR).filter((n) => VIDEO.test(n))
    .map((n) => path.join(PROXIES_DIR, n)).filter((p) => fs.statSync(p).isFile());
  console.log(`modo ADJUNTAR SIN GENERAR · ${cands.length} archivo(s) en ${PROXIES_DIR}\n`);
  for (const f of fuentes) {
    const base = path.basename(f, path.extname(f));
    const durOrig = duracion(f);
    /* El prefijo sólo PROPONE. El caracter siguiente tiene que ser `_` o `.` para que
     * `FX3_308` no proponga `FX3_3080_Proxy.mov`. */
    const propuestos = cands.filter((c) => {
      const b = path.basename(c);
      if (!b.startsWith(base)) return false;
      const sig = b.charAt(base.length);
      return sig === "_" || sig === ".";
    });
    /* Y la DURACION decide. Un nombre deducido es una hipótesis; una duración que coincide
     * al centésimo es una prueba. Sin esto, los 26 con `_1` se habrían enganchado por
     * prefijo al clip vecino, y no hay detachProxy. */
    const buenos = propuestos.filter((c) => {
      const d = duracion(c);
      return d !== null && durOrig !== null && Math.abs(d - durOrig) < 0.2;
    });
    if (buenos.length === 1) {
      listos.push({ nombre: base, original: path.basename(f), archivo: buenos[0] });
      console.log(`  = ${base} — ${path.basename(buenos[0])} (${durOrig.toFixed(2)}s, coincide)`);
    } else if (buenos.length === 0) {
      sinPareja.push({ nombre: base, propuestos: propuestos.length });
      console.log(`  ✗ ${base} — ${propuestos.length} candidato(s) por nombre, NINGUNO coincide en duración`);
    } else {
      /* Ambiguo NO se resuelve eligiendo: la operación no tiene vuelta. */
      ambiguos.push({ nombre: base, cuantos: buenos.length });
      console.log(`  ✗ ${base} — ${buenos.length} candidatos coinciden en duración: AMBIGUO, no se adjunta`);
    }
  }
  console.log(`\n${listos.length} emparejado(s) · ${sinPareja.length} sin pareja · ${ambiguos.length} ambiguo(s)`);
}

for (const f of (PROXIES_DIR ? [] : fuentes)) {
  const base = path.basename(f, path.extname(f));
  const salida = path.join(DESTINO, `${base}_${MARCA}.${EXT}`);
  const durOrig = duracion(f);

  if (!flag("rehacer") && fs.existsSync(salida)) {
    // No alcanza que EXISTA: un proxy truncado de una corrida interrumpida es peor
    // que ninguno, porque desplaza todo lo que venga después.
    const d = duracion(salida);
    if (d !== null && durOrig !== null && Math.abs(d - durOrig) < 0.2) {
      /* Salteado para GENERAR, pero sigue siendo candidato a ADJUNTAR: si no, correr
       * de nuevo con --adjuntar informa "0 de 0" y no hace nada, que es el no-op
       * silencioso de siempre. Generar y adjuntar son dos pasos independientes. */
      saltados.push({ nombre: base, razon: "ya estaba y mide bien" });
      listos.push({ nombre: base, original: path.basename(f), archivo: salida });
      console.log(`  = ${base} — ya estaba (${d.toFixed(1)}s)`);
      continue;
    }
    console.log(`  ! ${base} — el que había medía ${d} y el original ${durOrig}: se rehace`);
  }

  const t0 = Date.now();
  /* SE ESCRIBE A UN TEMPORAL Y SE RENOMBRA ENCIMA, no directo sobre el destino.
   *
   * Rehacer una tanda con Premiere ABIERTO es el caso normal —los proxies se rehacen
   * justamente porque fallaron en Premiere—, y ahí el archivo de destino está adjuntado y
   * el programa lo está leyendo. `ffmpeg -y` lo abre con O_TRUNC: lo deja en cero y lo va
   * llenando, así que durante varios minutos Premiere tiene abierto un archivo truncado.
   * Eso es exactamente el "Error retrieving frame, substituting" que se está arreglando.
   *
   * El rename de POSIX es atómico y no toca el inodo viejo: el handle que Premiere ya tenía
   * sigue viendo el archivo completo de antes hasta que lo cierra, y cualquier apertura
   * nueva ve el nuevo. Nunca hay un estado intermedio visible. */
  const parcial = salida + ".parcial." + EXT;
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-i", f, "-i", etiqueta,
      /* La etiqueta se escala contra el ANCHO DE SALIDA, no del original: a 1920 un 0,6
       * de un PNG de 640 tapaba un quinto del cuadro. */
      "-filter_complex",
      (ANCHO !== "0" ? "[0:v]scale=" + ANCHO + ":-2[v];" : "[0:v]null[v];") +
      "[1:v]scale=iw*0.4:-1[et];[v][et]overlay=W*0.02:H-h-W*0.02",
      ...(PERFIL === "prores"
        /* 422 Proxy (`-profile:v 0`) y NO una calidad mayor: es la mas liviana de las que
         * conservan 10 bits y 4:2:2, que es lo unico que se esta comprando aca. Subir a LT o
         * 422 multiplica el disco sin mejorar lo que importa. El audio va PCM porque ProRes
         * en .mov no lleva aac. */
        ? ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le",
           "-c:a", "pcm_s16le"]
        : ["-c:v", "libx264", "-preset", PRESET, "-crf", CRF, "-g", GOP, "-bf", "0",
           "-c:a", "aac", "-b:a", "128k"]),
      parcial
    ]);
  } catch (e) {
    // El parcial se borra: dejarlo hace que la próxima corrida lo vea y no sepa qué es.
    try { fs.unlinkSync(parcial); } catch (_) {}
    fallados.push({ nombre: base, error: String(e.message || e).slice(0, 200) });
    console.log(`  ✗ ${base} — ffmpeg falló`);
    continue;
  }

  /* VERIFICACIÓN DE AFUERA: la duración tiene que coincidir. Que ffmpeg no tire no
   * prueba que el archivo esté completo. */
  /* Se mide el PARCIAL, y sólo se renombra encima si está bien. Así un proxy que quedó
   * corto no reemplaza al que ya había: el viejo anda mal en Premiere pero mide bien, y
   * cambiarlo por uno truncado empeora las cosas. */
  const dur = duracion(parcial);
  if (dur === null || durOrig === null || Math.abs(dur - durOrig) > 0.2) {
    try { fs.unlinkSync(parcial); } catch (_) {}
    fallados.push({ nombre: base, error: `duración ${dur} contra ${durOrig} del original` });
    console.log(`  ✗ ${base} — quedó en ${dur}s y el original mide ${durOrig}s; se dejó el anterior`);
    continue;
  }
  fs.renameSync(parcial, salida);
  const mb = (tamano(salida) / 1048576).toFixed(1);
  const orig = (tamano(f) / 1048576).toFixed(1);
  // Se guarda el NOMBRE DE ARCHIVO COMPLETO del original, con extensión: el verbo
  // busca por coincidencia parcial y devuelve el primero, así que "clip prueba"
  // engancharía el proxy de ese clip a "clip prueba 4k.mp4". Con la extensión
  // incluida el prefijo deja de matchear al otro.
  hechos.push({ nombre: base, original: path.basename(f), archivo: salida, mb: Number(mb), veces: Number((orig / mb).toFixed(1)) });
  listos.push({ nombre: base, original: path.basename(f), archivo: salida });
  console.log(`  ✓ ${base} — ${mb} MB (${(orig / mb).toFixed(1)}x más liviano) en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

if (!PROXIES_DIR) console.log(`\n${hechos.length} generado(s) · ${saltados.length} salteado(s) · ${fallados.length} fallado(s)`);
if (fallados.length) for (const x of fallados) console.log(`  ✗ ${x.nombre}: ${x.error}`);

if (!flag("adjuntar")) {
  console.log(`\nNo se adjuntó nada. Corré con --adjuntar para engancharlos en Premiere.`);
  process.exit(fallados.length ? 1 : 0);
}

/* Adjuntar, espaciado. No son transacciones, pero una ráfaga de llamadas a esta API
 * ya crasheó Premiere con el proyecto real del usuario, y acá no hay apuro. */
(async () => {
  const { enviar } = require(path.join(__dirname, "..", "server", "bridge.js"));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  /* LA GUARDA `proyecto` SE MANDA SIEMPRE, y por eso no se pide por flag a secas.
   *
   * Adjuntar no tiene vuelta —no hay detachProxy en la API— así que con el foco en otro
   * proyecto esto engancharía proxies al material equivocado y no habría forma de sacarlos.
   * Antes NO se pasaba: la guarda existía en el despachador y esta herramienta no la usaba,
   * que es el pendiente 3 de CLAUDE.md en la peor operación posible para tenerlo.
   *
   * Si no viene por flag se LEE del foco y se manda igual en las N llamadas. No es lo mismo
   * que no pasarla: una tanda de 127 tarda tres minutos, y si el foco cambia en el medio las
   * llamadas siguientes REBOTAN en vez de escribir en el proyecto nuevo. */
  let PROYECTO = opt("proyecto", null);
  if (!PROYECTO) {
    try {
      const e = await enviar("estado", {}, 120000);
      PROYECTO = e.info && e.info.proyectoNombre;
    } catch (err) {
      console.error(`No se pudo leer el estado para saber qué proyecto tiene foco: ${String(err.message || err).slice(0, 160)}`);
      process.exit(1);
    }
    if (!PROYECTO) {
      console.error("El estado no informó `info.proyectoNombre`. Pasá --proyecto <nombre> a mano.");
      process.exit(1);
    }
    console.log(`\nproyecto (leído del foco): ${PROYECTO}`);
  } else {
    console.log(`\nproyecto (por flag): ${PROYECTO}`);
  }

  console.log(`adjuntando ${listos.length}, espaciados 1,2s...`);
  let ok = 0;
  const mal = [];
  for (let i = 0; i < listos.length; i++) {
    const h = listos[i];
    if (i) await dormir(1200);
    try {
      const r = await enviar("proxy", { proyecto: PROYECTO, medio: h.original, archivo: h.archivo }, 300000);
      const s = String(r.resumen);
      /* NO se cuenta por que la llamada no haya tirado: eso es el modo de fallar nº1 de
       * CLAUDE.md, y el verbo devuelve el dato que hace falta. Se exige que el estado haya
       * QUEDADO en true y que la ruta que informa sea EXACTAMENTE la pedida —el verbo
       * compara contra la ruta completa justamente porque el nombre da falsos positivos
       * cuando hay un _PROXY al lado de cada medio. */
      if (/→ true/.test(s) && s.includes(h.archivo)) {
        ok++;
        console.log(`  ↳ ${h.nombre}: adjuntado y releído`);
      } else {
        mal.push({ nombre: h.nombre, error: "la llamada no tiró pero el estado NO quedó: " + s.slice(0, 160) });
        console.log(`  ✗ ${h.nombre}: NO QUEDÓ — ${s.slice(0, 120)}`);
      }
    } catch (e) {
      mal.push({ nombre: h.nombre, error: String(e.message || e).slice(0, 200) });
      console.log(`  ✗ ${h.nombre} no se pudo adjuntar: ${String(e.message || e).slice(0, 140)}`);
    }
  }
  console.log(`\nadjuntados: ${ok} de ${listos.length}`);
  if (mal.length) {
    console.log("OJO: los que no se adjuntaron están en disco; se enganchan a mano en Premiere.");
    for (const x of mal) console.log(`  ✗ ${x.nombre}: ${x.error}`);
  }
  if (typeof sinPareja !== "undefined" && (sinPareja.length || ambiguos.length)) {
    console.log(`y ${sinPareja.length} sin pareja + ${ambiguos.length} ambiguo(s) que NUNCA se intentaron.`);
  }
  if (mal.length || (typeof sinPareja !== "undefined" && (sinPareja.length || ambiguos.length))) process.exit(1);
})();
