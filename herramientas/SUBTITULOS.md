# Subtítulos: el proceso completo, con las cinco trampas que costaron

Hecho para un videoclip el 2026-08-21. **Ninguna parte de esto es obvia** y cada
paso tiene un modo de fallar en silencio.

## Lo que NO se puede hacer, medido

**Crear captions o gráficos de Essential Graphics por API: NO.** `Transcript.importFromJSON`
devuelve un cascarón con el puntero interno en null, probado con el JSON que Premiere mismo
exportó. Y el MCP de terceros que dice tenerlo hace una transacción que committea sobre la
nada. Ver la sección correspondiente del `CLAUDE.md`.

Así que la vía es **PNG transparentes colocados como clips**. Tiene una ventaja que no es
menor: cada subtítulo queda como un clip suelto que el usuario puede correr o recortar.

## 1. El timing es el trabajo real, y hay DOS métodos: uno falla y otro anda

**Lo que NO funciona: compuerta de energía sobre el stem de voces.** Se probó midiendo la
envolvente del stem de Demucs y buscando huecos entre frases. Resultado: **una región de 21
segundos como "una frase"** donde había cinco líneas. La causa es que el canto es *legato* —
las pausas entre versos son de dos o tres décimas y la reverberación del stem las rellena.
De 23 líneas dio 9 "medidas" (mal) y 14 repartidas por igual, que es inventar.

**Lo que SÍ funciona: Whisper sobre el stem de voces, POR SECCIÓN y con segmentos cortos.**

    whisper-cli -m <modelo> -f <trozo>.wav -l es -oj -ml 28 --split-on-word

Tres detalles, los tres necesarios:

- **Sobre el stem de voces aislado**, no sobre la mezcla. En la mezcla la transcripción sale
  ilegible; en el stem las líneas se reconocen.
- **Sección por sección, sin darle nunca los instrumentales.** Corriéndolo sobre el tema
  entero, después del segundo 166 entra en **bucle de alucinación**: repitió *"Bajo un sauzio
  orillero"* veinte veces. Es la falla clásica de Whisper sobre música.
- **`-ml 28 --split-on-word`** fuerza segmentos de dos a seis segundos. Sin eso los segmentos
  abarcan estrofas enteras y no sirven para líneas.

**Y después hay que ALINEAR**, porque `-ml` corta por caracteres y parte los versos al medio.
Se arma un stream de palabras con tiempo —repartiendo cada segmento linealmente entre sus
palabras— y se camina la letra buscando cada palabra en orden. Normalizando acentos y
puntuación. Resultado: **23 de 23 líneas alineadas, 0 problemas de orden.**

La validación de que la alineación es real vino de afuera: *"extiende sus alas"* cayó en
160,95–166,94 y el plano del cantante levantando los brazos está en 162. El usuario había marcado
esa coincidencia como algo que le gustaba **antes** de que existieran los subtítulos.

## 1.b Las PRIMERAS líneas de cada sección no estaban medidas (2026-08-21)

Y el JSON decía `medido: true` en las cinco. Es el modo de fallar nº1 del repo escrito en un
campo de datos: **una afirmación de medición que no ocurrió.**

La causa es que Whisper **pega su primer segmento al arranque del audio que se le da**. Como
el pipeline corre sección por sección, el primer segmento de cada trozo empieza en el offset 0
del trozo, o sea exactamente en el borde de la sección. Así que la primera línea de cada
sección hereda el borde en vez de medirse.

Se ve a simple vista y nadie lo miró: los cinco valores son `24.00`, `47.00`, `72.00`,
`125.00`, `150.00`. **Cinco números redondos entre veintitrés que tienen dos decimales.**

Medido contra el stem de voces, leyendo el perfil de energía a mano:

| línea | decía | la voz entra en | error |
|---|---|---|---|
| "Si la estrella…" | 24,00 | **24,48** | 12 frames temprano |
| "Y en alguna estación…" | 47,00 | 47,00 | correcto |
| "Primera parada…" | 72,00 | **72,56** | 14 frames temprano |
| "Y en alguna estación…" (2) | 125,00 | **125,56** | 14 frames temprano |
| "Será la palabra…" | 150,00 | *no medible* | canto continuo antes |

Medio segundo en un subtítulo se ve. Las tres se corrigieron; la quinta se dejó como estaba y
se le puso `medido: false` con la razón, que es lo único honesto que se puede hacer con ella.

### Cuatro instrumentos que NO sirvieron, y por qué vale anotarlos

Antes de llegar al perfil a mano se probaron cuatro métodos automáticos. **Los cuatro dieron
números plausibles y los cuatro eran basura**, y cada uno se descartó por una prueba distinta:

1. **Máximo de la derivada de la envolvente en una ventana de ±600 ms.** Dio un corrimiento
   mediano de +340 ms, que parecía un hallazgo. Lo mató la **prueba de estabilidad**: repetido
   con ventanas de 150/300/450/600/900 ms, **21 de 23 líneas cambian de respuesta**. Un
   detector que contesta distinto según dónde lo mires no está midiendo la línea, está
   agarrando el ataque más fuerte que tiene a mano. La firma estaba a la vista antes de la
   prueba: los valores se apilaban contra el borde de la ventana (±0,48, ±0,51, ±0,58).
2. **Whisper con `-dtw large.v3.turbo`.** Corre, pero **el JSON de `-oj` no expone los tiempos
   de token**, sólo los de segmento. No hay por dónde sacarlos.
3. **Whisper con `-ml 1 --split-on-word`** (una palabra por segmento, para tener tiempos reales
   en vez de la interpolación lineal). Anda, y **empeora con más margen**: con 2 s de margen dio
   `'Si' 22.00-22.55`; con 6 s devolvió **un solo segmento `"Música"` de 28 segundos**; con 12 s
   repartió las palabras por el instrumental (`'estrella'` de 15,18 a 21,52). El modelo
   desparrama el texto sobre el silencio que se le da. Los tiempos por palabra **no son
   medición, son reparto**.
4. **Compuerta de energía con histéresis** (un umbral para "es voz", otro para "es silencio").
   El retroceso hasta el inicio de la subida camina hacia atrás por **todo el canto anterior**,
   así que las líneas de adentro reportaban el ataque de la sección: `"sin equipaje"` a los
   36,01 contestó 24,47, o sea −11,5 s. Y el conteo de líneas medibles se movió 18 → 13 → 5 al
   cambiar el umbral.

**Lo que separa el resultado bueno de los cuatro malos no es el algoritmo: es que el bueno se
NIEGA a contestar donde no puede.** Las 18 líneas de adentro caen en canto continuo, no tienen
silencio antes, y **no hay forma de medirlas con lo que hay acá**. Eso ya estaba escrito arriba
para la compuerta de energía; los cuatro intentos lo reaprendieron.

El corolario de método, que es el que se repite en todo este repo: **antes de creerle a una
medición, correrla dos veces con un parámetro distinto.** Si el resultado se mueve, el número
no era del material: era del instrumento.

## 1.c Un tiempo a MEDIO frame deja un parpadeo de un frame (2026-08-21)

`revisar` marcó un hueco de 1 frame en V3, entre `sub_11` y `sub_12`. Entre dos subtítulos
consecutivos eso no es un detalle: **el texto desaparece un frame y se ve el parpadeo.**

La causa es el mismo bug de los cortes entre frames, en otra forma. Los dos comparten el
número —`hasta` de uno es `desde` del otro— pero se colocan por caminos distintos: la cola con
`salida`, que es un punto de fuente, y el arranque con `desde`. Mientras los dos redondeen para
el mismo lado no pasa nada.

**El problema es el empate.** `88,22 / 0,04 = 2205,50`, exactamente medio frame, y ahí un
camino redondea a 2205 y el otro a 2206. De 23 tiempos fuera de grilla, los que caen en `,25`
y `,75` no hicieron daño —los dos lados redondean igual— y **el único que produjo hueco fue el
único que caía en `,50`**.

Arreglado estirando `sub_11` un frame, y **cuadriculando el JSON entero** para que una
reconstrucción no lo reintroduzca: 23 valores movidos, ninguno más de 20 ms. Se verificó
después que ningún par contiguo se hubiera separado al redondear — que se mantengan juntos es
obvio (comparten el número), y por eso mismo había que chequearlo en vez de suponerlo.

Regla corta: **los tiempos de subtítulo van en frames enteros de la secuencia**, igual que las
posiciones de la sincro. El medio frame no existe en el timeline y lo único que produce es esta
clase de hueco.

## 2. La tipografía: un `.ttc` NO se puede pasar como archivo

El usuario pidió **Helvetica Medium Italic**. En macOS vive dentro de
`/System/Library/Fonts/HelveticaNeue.ttc`, que es un *font collection* con **14 caras**.

- Pasarle el `.ttc` a ImageMagick **agarra la cara 0 —Regular— y no avisa**. Se ve derecha en
  vez de itálica y no hay ningún error.
- Seleccionar por `-family/-weight/-style` **falla**: en esta máquina ImageMagick no tiene
  lista de fuentes de fontconfig (`magick -list font` no devuelve Helvetica).

**La solución es extraer la cara a un `.ttf` propio**, con `fonttools`:

```python
from fontTools.ttLib import TTCollection
c = TTCollection("/System/Library/Fonts/HelveticaNeue.ttc")
c.fonts[11].save("HelveticaNeue-MediumItalic.ttf")   # 11 = Medium Italic
```

Los índices hay que **listarlos**, no adivinarlos: van Regular 0, Bold 1, Italic 2… y
**Medium Italic es el 11**, no el 3 ni el 10.

`fonttools` va en el venv aislado `~/.venvs/vision`, no al sistema — igual que torch.

## 3. Medir el ancho: `%[label:w]` devolvió CERO y el chequeo no chequeó nada

La primera versión medía cada línea con `magick -format "%[label:w]" label:texto info:` para
achicar las que se pasaran del área segura. **Devolvió 0 para las 23**, así que el `if` nunca
se cumplió y todas se renderizaron a cuerpo fijo sin verificar nada. Otra guarda que no
protegía.

**Lo que sí mide es el PNG ya generado**, recortando lo transparente:

    magick sub_00.png -trim -format "%w %h" info:

Eso no puede mentir: es el pixel más a la izquierda y el más a la derecha del texto real.
Medido así, la línea más ancha usó **2031 px de 3840, el 53%**, o sea que el cuerpo fijo de
104 estaba bien. La guarda rota no causó daño esa vez; el punto es que no lo habría detectado.

## 4. Un PNG fijo entra con `entrada 3600`, igual que los sintéticos

Verificado antes de hacer los 23, justamente porque un still no tiene in/out de material
como un video y `editar salida` podía no funcionar:

    insertar sub_00.png  → desde 24, dura 5 (el default), entrada 3600
    editar salida 3606.44 → dura 6.44 exacto

Así que **`salida` es un punto de FUENTE**, no una duración: hay que leer la `entrada` real
del clip recién puesto y sumarle la duración. Pedir `salida: 6.44` cae antes del in-point,
Premiere lo ignora en silencio y el still queda con sus 5 segundos por defecto.

## 5. El orden de las pistas

    V1  el corte
    V2  la capa de ajuste del color
    V3  los subtítulos      ← arriba de todo, o el color se los pinta

Si los subtítulos van DEBAJO de la capa de ajuste, el Lumetri les cambia el amarillo.

## Receta corta

1. Separar el stem de voces con Demucs (`htdemucs`).
2. Whisper por sección sobre el stem, con `-ml 28 --split-on-word`.
3. Alinear la letra corregida contra el stream de palabras.
4. Extraer la cara del `.ttc` con `fonttools`.
5. Un PNG transparente por línea, del tamaño de la secuencia, texto abajo con sombra suave.
6. Verificar los anchos con `-trim` sobre los PNG, no con `%[label:w]`.
7. Importar, insertar en la pista de ARRIBA, y `editar salida` = entrada real + duración.
