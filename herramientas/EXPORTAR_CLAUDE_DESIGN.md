# Exportar una animación de Claude Design a ProRes

Claude Design exporta video, pero comprimido. Teniendo el HTML se puede hacer mejor: **barrer la
animación cuadro por cuadro, guardar cada uno como PNG y armar un ProRes**. Sin compresión
intermedia, sin grabar pantalla, sin jitter de temporizado.

La herramienta es `herramientas/exportar_dc.js`. Validado el 2026-08-23 con los tres artboards de
un estudio —Intro, Outro y Fondo v2— exportados a 1920x1080, ProRes 4444, 25 fps.

## El flujo completo

```bash
# 1. descomprimir el zip de Claude Design donde sea
unzip "Animación de introducción y outro.zip" -d ~/Desktop/anim

# 2. VERIFICAR antes de rendear: qué artboards hay, cuánto duran, si el seek cumple el contrato
node herramientas/exportar_dc.js --dir ~/Desktop/anim --verificar

# 3. exportar uno, con sus textos
node herramientas/exportar_dc.js --dir ~/Desktop/anim \
  --html "Intro.dc.html" --salida "~/Desktop/Intro.mov" \
  --props '{"brandLine":"cliente 2026","eyebrow":"Nombre del estudio","titleLine1":"Video 1","titleLine2":""}'

# 4. o todos, sin --html (usa el nombre del artboard para cada salida)
node herramientas/exportar_dc.js --dir ~/Desktop/anim --salida ~/Desktop/salida.mov
```

Opciones: `--fps 25` · `--prores 4444|422` · `--alfa` · `--escala 1` · `--puerto 8791`

**Correr el paso 2 siempre.** Cuesta segundos y dice si el artboard se puede exportar así antes de
gastar quince minutos.

## Por qué funciona: el contrato de seek

Los `.dc.html` traen un transporte de seek que el propio `animations-v3.jsx` documenta:

```
data-om-exportable-video-with-duration-secs   el atributo de la RAÍZ exportable (un <svg>)
'data-om-seek-to-time-frame'                  el evento, detail {time, sync, playing}
```

Y su encabezado dice, textual: *"RENDER FROM T ONLY: the exporter seeks each frame with a
synchronous commit... A seeked frame is a deterministic render at that time."*

**Eso no se da por bueno: se comprueba.** `--verificar` barre a t=1, a t=6 y vuelve a t=1, y compara
una firma del render (transform + opacity + texto de cada elemento). Exige **las dos cosas**: que
cambie al barrer y que volver al mismo tiempo dé la misma firma. Sin determinismo, dos exports del
mismo archivo saldrían distintos y no se notaría hasta compararlos.

Si un artboard no cumple —porque anima con un loop propio en vez de renderizar desde T— la
herramienta **no exporta** y lo dice.

## Las cinco trampas, todas pagadas

**1. El SVG viene con un transform de encaje.** Mide 1920x1080 intrínsecos y el runtime le aplica
un `transform: matrix(s,0,0,s,0,0)` para que entre en el viewport. La primera corrida capturó
**1842x1036** y escalar eso en Premiere ablanda todo, que es justo lo que este export viene a
evitar. Se neutraliza con una regla `!important` —que le gana al estilo inline que pone el
runtime— y después la herramienta **mide el primer PNG** y aborta si no salió al tamaño intrínseco.

**2. Los textos NO vienen en el export.** El `data-props` declara `"default": ""` y el componente
cae al fallback con `p.titleLine1 ?? 'La fragancia'`. Pero `??` sólo dispara con `null` o
`undefined`: **una cadena vacía no es null**, así que el fallback nunca corre y el título sale
vacío. Lo que se tipeó en el panel de Claude Design vive en el canvas, no en el HTML.

Se inyectan con `--props`, reescribiendo los `default` del `data-props` antes de servir el HTML. Y
eso resulta **mejor** que si vinieran: un artboard, N videos, los textos por parámetro. Para los
tres videos de un corporativo es un comando cada uno.

Un texto vacío se pasa como `""` y se respeta: la línea simplemente no aparece.

**3. El chrome del host se hornea en el video.** `element.screenshot()` de Puppeteer **recorta la
captura de PÁGINA** al rectángulo del elemento; no dibuja el elemento aislado. Así que todo lo que
se superponga entra, aunque no sea hijo del SVG. El runtime pinta sus controles de reproducción en
un `[data-omelette-chrome]` dentro de `.sc-host`, abajo al centro, y **los tres primeros exports
salieron con una barra de progreso con un punto encima**.

Se ocultan por CSS, y después se comprueba estructuralmente que **ningún elemento visible de
afuera del SVG se solape con su rectángulo**. Esa guarda es más general que ocultar una clase: si
mañana el runtime pinta otra cosa, la lista igual.

**4. Se sirve por HTTP, no por `file://`.** El `.dc.html` carga `support.js`, el bundle del sistema
de diseño y las fuentes por ruta relativa; con `file://` el navegador bloquea parte y el render
sale sin tipografía, que es un fallo silencioso. La herramienta levanta su propio servidor.

**5. Se espera `document.fonts.ready` antes del primer cuadro**, o los primeros salen con la fuente
de fallback.

## ProRes 4444 aunque no haya alfa

Es una decisión de calidad, no un descuido. ProRes 422 submuestrea el croma horizontalmente
(4:2:2), y estas placas son **texto blanco sobre rojo saturado** — justo donde el submuestreo se ve
como borde sucio en las letras. 4444 es 4:4:4: un valor de color por píxel. Con `--prores 422` se
pide el liviano, y con `--alfa` el 4444 con canal alfa real (`yuva444p10le`) para overlays.

## El redondeo del frame rate

8,5 s a 25 fps son **212,5 cuadros**, así que el intro sale en 213 → **8,52 s**. Medio cuadro de
más. Es el mismo piso que el resto de este repo: a 25 fps no hay nada entre cuadro y cuadro.

## Lo que la herramienta comprueba, y lo que NO alcanza

Cinco guardas, y cada una existe por un fallo real:

```
seek cambia y es determinista     o no exporta
el PNG mide lo intrínseco         o aborta
nada de afuera se solapa          o lista los intrusos
los textos pedidos están          o los nombra
la salida se mide con ffprobe     duración, códec, perfil, nb_frames
```

**Y lo importante: ninguna de esas cinco agarró los dos peores defectos.** El primer export salió
**sin una sola línea de texto** y con **una barra de reproducción horneada**, y pasó todos los
chequeos numéricos que había en ese momento. Los dos los encontró **mirar un contact sheet**.

Las guardas 3 y 4 se agregaron *después*, cada una por su fallo. Sirven para que no vuelva a pasar
lo mismo, no para reemplazar el mirar.

**Así que el paso final del flujo es sacar cuatro o cinco cuadros del .mov y verlos.** Y una
advertencia sobre cómo hacerlo: intenté detectar la barra midiendo el contraste de la franja
inferior y **el test marcó como sospechosos los dos limpios y como limpio el que la tenía** — no
puede distinguir una barra de UI de contenido legítimo en la misma zona. Es un chequeo que no
separa lo que tiene que separar. Para eso sirve la guarda estructural; para el resto, el ojo.

## Dónde buscar cuando algo no sale

**En las mismas condiciones del export.** La barra se buscó dos veces en el panel del navegador
—otro viewport, sin el transform neutralizado— y las dos veces no apareció nada. Recién se
encontró levantando Chrome igual que lo levanta el exportador. Buscar en un régimen y concluir
sobre otro es el error más repetido de este repo.

## Requisitos

Nada que instalar: `puppeteer-core` sale de la caché de `npx` y el Chrome de
`~/.cache/hyperframes/chrome` — los dos ya están en la máquina porque los usa HyperFrames. Hace
falta `ffmpeg` y `ffprobe`.

## Separar un artboard en CAPAS con `--css` (2026-08-24)

Un artboard de Claude Design se puede partir en capas **sin rediseñarlo**, inyectando CSS. Salió de
un pedido concreto: los fondos de un estudio traen el logo abajo a la izquierda y hacía falta el fondo
sin logo por un lado y el logo por otro.

Para eso está `--css`, que se inyecta **al final** de la hoja de estilos del exportador, para que
pueda pisar lo que éste pone.

```bash
# el fondo, sin logo
--css 'img[src*="assets/logo/"]{display:none!important}'

# el logo solo (ver la trampa de abajo antes de usar --alfa)
--css 'svg:not([data-om-exportable-video-with-duration-secs]){display:none!important}
       img:not([src*="assets/logo/"]){display:none!important}
       div{background:none!important;background-color:transparent!important}'
```

El selector sale de LEER el `.jsx` del artboard, no de adivinar: ahí se ve que el logo son cinco
`<img src="assets/logo/logo-white.png">` —uno por glifo del wordmark, para escalarlos escalonados—
y que las piezas decorativas son SVG del design system.

## `--alfa` NO da transparencia acá, y el archivo dice que sí

**El export salió opaco entero y pasó todas las guardas.** `--alfa` puso `omitBackground` y el
contenedor quedó con `yuva444p12le`, o sea con canal alfa; el chequeo de solapes pasó y el PNG midió
lo intrínseco. Todo verde, y el alfa medido en 15 instantes dio **0,9998 en los quince**: opaco.

Y una sonda del DOM con el mismo CSS aplicado mostró que **ningún elemento pinta el negro** — el
`svg` exportable y su `foreignObject` tienen `backgroundColor` transparente. Lo mete la captura:
`omitBackground` no logra transparencia cuando el contenido va dentro de un `foreignObject` de SVG.

**La salida es el MATTE DE LUMINANCIA**, y para este caso es exacta: el logo es blanco puro sobre
negro puro, así que la luma ES el alfa, con el antialiasing intacto.

```bash
ffmpeg -i matte.mov -filter_complex \
  "color=c=white:s=1920x1080:r=25:d=49[c];[0:v]format=gray[m];[c][m]alphamerge,format=yuva444p10le[o]" \
  -map "[o]" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 16 -vendor apl0 salida.mov
```

Verificado: el alfa pasa de 0 a los 0,9s, sube a la meseta a 1,6s, y vuelve a 0 entre 47,0 y 48,0s
— o sea que **la animación de entrada y salida sobrevive**, que es lo que había que comprobar.

**Y el segundo color sale del MISMO matte.** La animación es idéntica entre variantes —mismo
componente, mismos parámetros, sólo cambia el `src` del PNG— así que el logo rojo se armó cambiando
el color de base a `#ff0032`, el de la paleta. Medido en el archivo: `srgb(99,7%; 0,06%; 19,5%)`.

**La lección, que es la de siempre en este repo:** cinco guardas numéricas dieron verde sobre un
archivo inservible. Lo agarró medir el CANAL ALFA, que es la propiedad que el pedido pedía y
justamente la que ninguna guarda mira.
