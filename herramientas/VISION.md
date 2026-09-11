# Leer video: qué se instaló, qué suma y qué NO suma

Escrito el 2026-08-20, después de instalar las herramientas y **medirlas**, no antes.

El repo ya tiene un documento sobre un análisis que salió mal (`MOVIMIENTO_ROTO.md`) y
un encabezado que dice *"ESTO NO FUNCIONA"* (`nitidez.py`). Este es el complementario:
qué de esto sí sirve, para qué exactamente, y dónde está la línea.

---

## La instalación, y el obstáculo que la define

**PyTorch dejó de compilar para Intel Mac después de 2.2.2.** No es una elección: es el
techo de esta máquina (iMac 2019, i7-9700, x86_64). Y torch 2.2.2 se compiló contra
numpy 1.x, así que **choca con el numpy 2.0.2 del sistema** — que es el que usan
`sincro.py` y `nitidez.py`.

Instalarlo al sistema bajaría numpy a 1.x y rompería la herramienta de sincro. Por eso va
en un **entorno virtual aislado**:

    ~/.venvs/vision     torch 2.2.2 · torchvision 0.17.2 · transformers 4.44.2
                        numpy 1.26.4 · sentencepiece · pillow
                        778 MB · 8 hilos de CPU

    python3 del sistema  numpy 2.0.2 INTACTO

Es la misma decisión que el día anterior había terminado en descartar
`audio-offset-finder` por su pin de `numpy<2`. La salida buena era aislar, no descartar.

`sentencepiece` no es opcional: sin él el tokenizador de SigLIP tira `ImportError` y el
modelo no carga.

Velocidad medida sobre cuadros reales: **~490–510 ms por imagen** con los modelos base.
Unos 700 cuadros salen en ~6 minutos. No es el cuello de botella.

---

## Lo que se probó, con números

### DINOv2 para agrupar tomas — ANDA, y verificado mirando

Embeddings del token CLS, promediados por clip, similitud coseno. Sobre 23 clips del
material de un videoclip:

| par | similitud | qué es de verdad |
|---|---|---|
| 3581 / 3582 | **0,976** | el mismo plano general del otro interprete pescando, misma cámara |
| 3583 / 3585 | **0,963** | el mismo plano cerrado, con el sauce |
| 3573 / 3577 | 0,826 | mismo armado con la guitarra, distinto tamaño |
| 3572 / 3574 | 0,548 | mismo lugar, encuadres completamente distintos |

**Los cuatro coinciden con lo que se ve en la plancha.** Esa comprobación no es un detalle
de estilo: es la que faltó en `nitidez.py`, cuyo test a ciegas del temblor dio 2 de 6.

**El umbral elige el NIVEL, y hay que saberlo:** a 0,85 agrupa *"mismo armado"* y junta el
general con el cerrado; los pares de 0,96–0,98 son *"mismo plano"*. Los dos niveles sirven
para cosas distintas y conviene calcular los dos.

### SigLIP para etiquetar contenido — DÉBIL, no confiar en la etiqueta

Zero-shot con frases candidatas, sigmoide sobre `logits_per_image`. Sobre 14 cuadros
repartidos:

- La misma frase gana en 8 de 14, varias con puntajes de **0,003 a 0,04** — o sea
  *"ninguna de estas frases"* devuelto como si fuera una respuesta.
- **4 de 14 cuadros tienen su ganador por debajo de 0,10.**
- En inglés calibra mejor (mediana 0,408 contra 0,179) pero **el orden es el mismo en 13
  de 14**: no cambia ninguna decisión. El idioma mueve el número, no el juicio.

Sirve como **ordenador de candidatos** —"mostrame los 40 cuadros más parecidos a *velero*
de los 800"— y no como etiquetador. Tomar la etiqueta en vez de mirar es repetir el
fracaso de `nitidez.py`.

---

## La asimetría que decide en qué confiar

**Una distancia entre dos imágenes TUYAS está anclada en tu material. Una etiqueta compara
tu imagen contra texto que el modelo aprendió en otro lado.**

De ahí sale el reparto, y no es una preferencia estética:

- embeddings → **agrupar, deduplicar, ordenar candidatos**
- yo mirando → **qué significa y si está bueno**

## Qué me suman a mí, concretamente

Pregunta del usuario, 2026-08-20: *"si vos sos mejor que estas herramientas, te suman algo
a tu proceso?"*. Sí, tres cosas, y ninguna es "ver mejor":

1. **Comparación de a pares a escala.** Para *"cuáles de estos 67 son suplentes del mismo
   plano"* hay **2.211 pares**. Eso no se sostiene mirando: se miran planchas, cada cuadro
   chico, y a la décima el criterio ya se corrió.
2. **Consistencia.** Mi criterio deriva en una sesión larga — pasó el 2026-08-19, escribí
   que el temblor que le molestaba era el lento cuando había dicho lo contrario. Una
   métrica no deriva.
3. **Un índice que queda.** Embebido el material, buscar no cuesta nada y no requiere
   volver a mirar. Se acumula entre proyectos.

Y **dan dónde mirar**, que es el patrón que sí funcionó en `informe_nitidez.js`: la métrica
reduce 800 cuadros a 40 y el juicio se hace sobre esos 40. La atención es el recurso
escaso.

Lo que **no** suman: etiquetar y juzgar. Medido arriba.

**Y para un trabajo de 67 clips, mirar alcanza.** Estas herramientas se ganan el lugar en
el problema de a pares y a escala de 130+ clips.

---

## El reencuadre que vale más que todo lo anterior

Es del usuario, 2026-08-20, y cambió qué había que construir:

> *"para los planos de los musicos no necesitas saber QUE hay, eso ya esta; a lo sumo
> tendras que decidir QUE sucede en el momento en el que queres usar ese clip"*

En material multicámara **sincronizado** no hay nada que averiguar sobre el contenido. La
pregunta es **temporal**: qué pasa en cada ángulo en el instante en que querés cortar. Si
mira a cámara, si está cantando esa línea, si la guitarra le tapa la cara.

Ningún modelo de visión contesta eso mejor que la aritmética: **como los planos están
alineados con el tema, un segundo de la canción cae en un cuadro conocido de cada clip.**
Así que se ponen los N ángulos lado a lado en el mismo instante. Eso es `grilla_angulos.js`
y es lo que mira un editor para elegir un corte.

Queda entonces un reparto por tipo de material, no por herramienta:

| material | qué falta saber | con qué |
|---|---|---|
| multicámara sincronizado | qué pasa en cada instante | `grilla_angulos.js` — lo habilita la sincro |
| inserts sueltos | qué hay, y qué es suplente de qué | DINOv2 para familias + mirar |

**La sincro no era sólo para que suene bien: es lo que hace computable la pregunta del
montaje.**

---

## Lo que sigue sin investigar

De la lista que se propuso el 2026-08-19, quedan sin probar: **PySceneDetect** (cortes,
mejor que el filtro `scene` de ffmpeg), **Depth Anything** (profundidad, la forma correcta
de medir "la cámara se acerca"), **YOLO / RT-DETR** (personas y objetos en cuadro),
**pyannote** (diarización), **scoring estético** y **VLMs locales** (Qwen-VL, InternVL).

Sobre los VLMs locales, una nota que ahorra tiempo: **para describir qué hay en un clip,
mirar los cuadros directamente es mejor que un 7B corriendo en esta CPU.** El VLM local
tiene sentido para volumen desatendido, no para calidad de descripción.

### Qwen2.5-VL-7B MEDIDO en esta máquina — NO CONVIENE (2026-09-06)

Probado de verdad, no estimado: `llama.cpp` + GGUF Q4_K_M (4,4 GB) con su proyector f16
(1,3 GB), sobre cuadros reales. **Lo que lo mata es el ENCODING de la imagen, que se paga
entero en CADA cuadro y no se amortiza aunque el modelo quede cargado:**

```
                  encoding    descripcion                 OCR (5 textos en cuadro)
768 px             155 s      "guitarra electrica"        3 de 5, y el nombre propio
                              (es un BAJO)                 que habia en pantalla leido
                                                           MAL, y distinto cada vez
448 px              57 s      "bajo electrico"  CORRECTO   "NINGUNO"   <- ciego total
```

**Los dos hallazgos que decidieron:**

- **La imagen chica describe MEJOR y 2,7x mas rapido.** Contraintuitivo, y con n=1 no se
  generaliza — pero la direccion basta para descartar la idea de "mas resolucion, mejor".
- **A 448 el OCR no duda: AFIRMA que no hay texto** sobre una imagen con cuatro. Es el peor
  modo de fallo posible; un barrido asi concluiria que el material no tiene texto. O sea que
  los usos NO comparten configuracion: descripcion quiere 448, OCR quiere 768, y a 768 igual
  se come un apellido.

Extrapolado a 800 cuadros: **17-23 h a 448 · 40-47 h a 768.** Y el ahorro que justificaria
todo eso es de **1,4%** — ver la memoria del proyecto, medido el mismo dia sobre 92
transcripts reales. Valoracion del usuario: *"por ahora no me conviene ni un poco"*.

Notas de infraestructura que valen aunque esto se descarte:

- **Homebrew dejo de soportar Intel x86_64 en septiembre de 2026.** Instala igual pero
  COMPILA DESDE FUENTE (llama.cpp tardo 2m20 + openssl 3m12). Sugieren MacPorts.
- **`llama.cpp` NO necesita torch**, asi que esquiva el techo de torch 2.2.2 por completo.
- El modelo conviene en el SSD interno: desde el HDD SATA mecanico la carga son 52 s contra
  18 s cacheado.

### Scoring de foco y calidad — MEDIDO, con tres correcciones a mí mismo (2026-08-23)

Se probaron **cinco**: el predictor estético LAION, NIMA, MUSIQ, CLIP-IQA+ y un CLIP-IQA a mano
con prompts. Escalera de desenfoque sobre el mismo cuadro, normalizada a 0px = 1,00:

```
             0px   0,5px    1px    2px    4px    8px   12px
musiq      1,000  0,928  0,746  0,358  0,278  0,239  0,225
topiq_nr   1,000  0,746  0,526  0,310  0,191  0,224  0,313
nima       1,000  0,941  0,849  0,808  0,955  1,017  0,919   <- SUBE
clipiqa+   1,000  0,949  0,834  0,581  0,304  0,223  0,205
clipiqa    1,000  0,856  0,506  0,027  0,005  0,016  0,012   <- satura en 2px
```

El código de los cinco que se probaron quedó en **`herramientas/estetica.py`**, que ya no corre
—sus pesos se borraron a propósito— y lo dice en su primera línea. Se conserva como registro del
resultado negativo, igual que `nitidez.py`.

**GANA `topiq_nr`.** Es el más sensible a la blandura leve y sigue bajando hasta 4px, así que
ordena grados. Y hay dos descartes que importan:

- **NIMA está roto para esto:** a 8px de desenfoque puntúa **1,017**, o sea MEJOR que el original.
  No es monótono. Es el scorer estético siendo ciego al defecto, en el modelo que yo había
  nombrado como "tiene cabeza técnica" — el que trae pyiqa por defecto es el estético.
- **El predictor estético LAION se mueve 0,66** entre un cuadro perfecto y uno arruinado, y lo
  poco que mide es un TIPO DE PLANO: el peor de 8 fue el plano general de la estación y el mejor
  un primer plano con fondo desenfocado. En un videoclip de viaje eso hunde los planos que llevan
  la geografía.

**Primera corrección a mí mismo.** La contaminación por composición la medí primero con UN par
—un general contra un primer plano— y dio 16,4%. Midiéndola sobre **8 planos nítidos** de clases
distintas, 10 cuadros cada uno, da **34,6%** (medianas de 0,378 a 0,577). El par único la
subestimaba a la mitad. Es el "medí dos casos distintos" de siempre, cobrado sobre un número mío.

Con la medición buena, la escalera en las mismas unidades:

```
   0px   0,504   dentro del rango de los nítidos
 0,5px   0,376   justo por debajo del mínimo (0,378) — al límite
   1px   0,265   detectable
   2px   0,156   detectable
```

Y el desvío DENTRO de un plano es **0,011**, con razón entre/dentro 5,60. O sea que la mediana de
cinco cuadros es un número confiable del plano y no del cuadro — que era la objeción de fondo.

**Segunda corrección, y es la importante.** Escribí que "dentro de una familia la composición
queda fija, así que la diferencia es de foco". **Es falso, y se probó mirando.** Comparando los 3
usos de un plano de cámara en mano, la herramienta marcó uno 0,091 por debajo del mejor; al mirar
los dos cuadros, el flagueado **no estaba más blando, estaba más ABIERTO y más cargado**. El
score seguía al encuadre, porque un plano en mano reencuadra mientras corre. **Mismo medio no es
mismo encuadre.**

La señal para detectarlo ya estaba en la salida: ese plano tenía desvío interno **0,038** y el que
sí era comparable, **0,005**. Un desvío interno alto significa que el encuadre se mueve adentro
del plano, y entonces las medianas no son comparables. `foco.py` ahora sólo informa una diferencia
si supera **3x el mayor desvío interno del par**; con esa guarda el falso positivo pasa a "NO
concluyente".

**Cómo se usa, entonces:** `herramientas/foco.py`, con `~/.venvs/iqa` (separado del de visión
porque pyiqa quiere numpy 2 y torch 2.2.2 se compiló contra numpy 1.x; ahí numpy queda en <2).

```
--familia  ordena tomas del mismo setup. Vale cuando el desvío interno es bajo.
--triage   umbral global 0,378. Detecta desde 1px a 768px de ancho (~5px en 4K).
```

Sigue sin opinar sobre cuál plano es mejor, y eso no es una limitación a resolver: es el criterio.

### Tercera corrección: la RESOLUCIÓN DE ORIGEN también contamina el score (2026-08-23)

`foco.py` normaliza cada cuadro a 768 de ancho antes de puntuar, así que la resolución de origen
desaparece de la entrada del modelo… y reaparece en el score. El mismo cuadro, bajado a cada
resolución real que hay en un corporativo y devuelto a 768:

```
1920x1080  0,4630    ---
1024x576   0,4617   -0,3%
 848x478   0,4597   -0,7%
 576 ancho 0,4434   -4,2%
 478 ancho 0,4232   -8,6%
 464 ancho 0,4263   -7,9%
```

Puesto al lado de los otros números, el 8,6% cae en el peor lugar posible:

```
composición sola     34,6%   confusor dominante, ya documentado
1px de desenfoque      -47%   el defecto que se quiere detectar
resolución de origen   -8,6%  ESTO
desvío interno          2,4%  el piso de ruido
```

**Supera la guarda del desvío interno** (3 x 0,011 ≈ 7%), así que una diferencia de pura
resolución alcanza para marcar "mirarlo". Y no es un caso borde: un corporativo tiene **13 resoluciones
distintas** entre 478x850 y 1920x1080.

**El primer arreglo fue malo y el primer caso real lo tiró.** Modelé el sesgo con esa constante de
8,6% y lo probé con el mismo contenido encodeado de verdad a 478: dio **9,3%** y volvió a marcar
"mirarlo". Un video a 478 paga la compresión ADEMÁS de la resolución, así que la constante medida
sobre un JPEG reescalado subestima el caso real. Subirla hasta tapar ese caso habría sido fitearla
a un caso — el mismo error que transferir el umbral de z entre regímenes en `sincro.py`.

Así que con resoluciones distintas **no se compara**: se informa la diferencia y se dice que no es
comparable, nombrando las dos resoluciones. Verificado por las dos ramas — la familia mezclada se
niega, y una familia entera en 3840x2160 sigue comparando igual que antes.

## Y antes de mirar el contenido: el material trae defectos que Premiere obedece en silencio

Esto no es visión por computadora, y por eso casi no lo escribo acá. Pero es lo que más caro salió
en materia de imagen, así que va: **nada revisaba el material ANTES de armar.** El flag de
rotación de un videoclip se descubrió mirando el archivo exportado, con el corte entero ya hecho.

`herramientas/revisar_medios.js` es el chequeo de entrada: sólo ffprobe, sin bridge, sin Premiere
abierto. Los cuatro chequeos salieron de medir los dos proyectos reales, no de imaginar defectos.

```
                          un videoclip (140)   un corporativo (122)
flag de rotación                   5              12
r_frame_rate no creíble            0              13
VFR                                0              35
resoluciones distintas             1              13
```

**1. El flag de rotación.** Premiere lo obedece igual que ffmpeg. La firma para reconocerlo sin
abrir nada es que el contenido ocupa **2160/3840 = 56% del ancho**. La herramienta lo calcula y
lo imprime.

**2. `r_frame_rate` no creíble.** Trece archivos de un corporativo declaran **90000** o 120 fps donde hay
25 o 30. Importa porque es el número que se lee primero: una cuenta hecha con el declarado en vez
del promedio da hasta **91 segundos** de error.

**3. VFR — el riesgo que se midió y NO existe.** Ver la sección de abajo: la sospecha era
razonable, los números daban miedo, y la medición la desarmó. Se informa sin alarma.

**4. Resoluciones mezcladas.** Trece en un corporativo contra una en un videoclip. Dos planos pegados con esa
diferencia se ven distintos aunque el encuadre coincida, y es lo que rompe el `--familia` de
`foco.py`.

### Y un chequeo que se midió y NO se construyó

**Barras horneadas.** La hipótesis era razonable —si un clip trae letterbox, escalarlo al cuadro
lo agranda— y salía de la firma del 56%. Se corrió `cropdetect` sobre 28 medios de los dos
proyectos: **cero**. Todos llenan su cuadro. No se construyó, porque cuesta un decode por archivo
para contestar algo que en este material no pasa.

Queda anotada la línea por si entra material de otra fuente: `cropdetect=24:2:0` sobre 3s **desde
el segundo 5**. Desde 0 agarra el negro del arranque y da un falso positivo gigante.

### El fps distinto al de la secuencia NO es un defecto

Se informa aparte y sin alarma. **121 de los 140 medios de un videoclip no van a 25fps y el proyecto está
bien**: Premiere los conforma. Meterlo con los otros cuatro sería gritar sobre 121 archivos sanos,
y una salida que grita de más enseña a ignorarla.

## Y la conclusión que ordena todo lo anterior: verificar el EXPORT, no el timeline

Todo este documento trata de qué modelo puede decir algo útil sobre un cuadro. Pero el hallazgo
más barato de la jornada no fue un modelo: fue notar que **mirar es lo que encuentra los defectos
que las guardas numéricas no**, y que el costo de mirar estaba en el lugar equivocado.

Los dos casos ya estaban pagados y no los había leído juntos:

- el flag de rotación de un videoclip apareció **mirando el archivo exportado**, con el corte entero armado;
- los dos peores defectos de `exportar_dc.js` —cero texto y una barra de reproducción horneada—
  los encontró **una plancha de contacto**, después de que cinco chequeos numéricos dieran verde.

`premiere_frame` es la mejor verificación que tiene el bridge y da **un cuadro por llamada**: 88
planos son 88 viajes, cada uno con el riesgo que tiene tocar Premiere. El export es un archivo
suelto y muestrearlo es gratis. Y además el export es lo que ve el cliente.

`herramientas/plancha_corte.js` hace eso: un cuadro por plano, etiquetado con el corte, en hojas
de 12. Probado sobre el ROUGH CUT 5 de un videoclip —88 planos, 8 hojas— y confirmó de un vistazo tres
cosas que de otro modo son tres verificaciones separadas: que los subtítulos quedaron horneados,
que la alternancia viaje/músicos es la pedida, y que los dos clips con flag de rotación
(`FX3_3555`, `FX3_3560`) salieron derechos.

**La trampa está en la rotación, y es exactamente al revés que en las otras planchas.** Con
material de cámara hay que pasar `-noautorotate` porque el flag está mal puesto; con el export hay
que NO pasarlo, porque hay que ver lo que ve un reproductor, defecto incluido. Copiar la línea de
una herramienta a la otra —son casi la misma— esconde justo lo que se vino a buscar.

Y escribir esa guarda encontró un defecto viejo: **`broll.js` venía extrayendo cuadros de cámara
sin `-noautorotate`** mientras `grilla_angulos.js` y `familias.py` sí la tenían. Pasó desapercibido
porque la plancha la arma `planchas.js`, que no extrae nada —sólo hace el montage— así que mirar
ahí no mostraba el problema. Arreglado.

## Comparar cuadros SIRVE para identidad de plano y NO para exactitud de cuadro (2026-08-23)

Una métrica de imagen tan tonta como el RMSE entre dos cuadros contesta una pregunta útil que
ningún modelo de este documento contesta: **¿el plano N del export es de verdad el pedazo de
material que el corte pide?** En un corte de 88 planos armado por script, un `entrada` equivocado
es invisible — el plano mide lo que debe, se ve bien, y muestra otro momento del mismo medio.

Medido sobre 6 planos de músicos del ROUGH CUT 5 de un videoclip, comparando el export contra el material
en disco:

```
par correcto            0,76 a 10,33
+1 cuadro               3,68 a 11,51     <- NO separa
señuelo, mismo medio   13,13 a 21,05     <- separa limpio
señuelo, otro medio    26,11 a 30,41
```

Dos conclusiones opuestas de la misma tabla, y las dos importan:

**Sirve para identidad.** El par correcto siempre quedó por debajo del señuelo más parecido, 6 de
6, y siempre en menos de la mitad. Eso alcanza para cotejar un corte entero **desde afuera de
Premiere**, contra el archivo entregado, que es la única clase de confirmación que este repo
considera válida: dos fuentes independientes.

**No sirve al cuadro.** En 4 de 6 el desfase de ±1 cuadro no se separa, y en uno el desfasado
puntúa MENOS. No es un defecto del metro: un cantante quieto frente a un micrófono es casi el mismo
cuadro 40 ms después. Así que esto **no chequea sincronía** — y decir "verificado" a secas se
leería como que sí. Para sincronía, `sincro.py` sobre el audio.

### Y el número absoluto no se puede leer sin el control

El par correcto daba ~10 en cinco de los seis planos, y **eso parecía un in-point equivocado**. No
lo era: es la corrección de color del export, que corre todos los píxeles. Lo demostró el señuelo
—un instante ajeno del mismo medio— que dio 13 a 21. Sin ese control, un 10 no se puede
interpretar en ninguna dirección.

Por eso `cotejar_export.js` juzga por **rango y no por umbral**: el valor absoluto del par correcto
**varía 13 veces** entre planos (0,76 en percusión, 10,33 en un cantante con Lumetri), así que un
umbral calibrado con uno rechaza al otro. Es el mismo error que transferir el umbral de z entre
regímenes en `sincro.py`, y el mismo que casi cometí hoy con la constante de resolución de
`foco.py`. **Tres veces el mismo error en un día es una señal: cuando una medida depende del
material, la respuesta es comparar contra un control, no calibrar una constante.**

La distancia del señuelo también se midió en vez de elegirla. Empezaron a ±15s y con eso un tercio
de los planos quedaba sin cotejar, porque el material es más corto:

```
distancia      +0,5s   +1s    +2s    +3s    +5s    +8s
peor margen    x1,18  x1,19  x1,17  x1,25  x1,34  x1,55
```

El pedido gana desde **+0,5s** en 5 de 5, así que se usan ±3s como los más cercanos. Y como el
veredicto toma el señuelo MÁS PARECIDO, agregar candidatos cercanos hace la prueba más estricta.


### El VFR NO corre los in-points: Premiere respeta los PTS (2026-08-23)

Esto arranca como el hallazgo más alarmante del día y termina como un negativo medido, que es el
mejor final posible.

La sospecha: 35 de los 122 medios de un corporativo tienen cadencia variable, y 17 se usan en los cortes.
Si Premiere conformara asumiendo cadencia constante —lo que hacen muchos programas—, cada hueco de
la grilla correría el material y el error se acumularía. Los números eran serios:

```
deriva máxima sobre el archivo entero        0,02s a 6,20s
error predicho en los in-points del corte    5 planos > 0,5s, el peor 3,12s
```

Un fragmento 3,12s corrido dice otras palabras. Valía medirlo.

**La medición, en VIDEO 3 de un corporativo.** Un clip de WhatsApp, que declara 30fps y promedia 28,33, con `entrada` 100,84 leída **en vivo** del timeline. Playhead a
2,00s del clip, o sea tiempo de fuente 102,840s bajo el modelo PTS y 101,951s bajo el conform
fijo — dos momentos con RMSE 29,46 entre sí, o sea contenido completamente distinto, así que el
clip podía distinguir.

```
lo que devolvió Premiere contra el cuadro de ffmpeg en:
  102,840s  (respeta PTS)      RMSE 13,95   <- GANA, x2,1
  101,951s  (conform fijo)     RMSE 29,69
```

Y confirmado **mirando** los tres lado a lado: mismo vaso, misma mancha verde en la mesada, misma
diagonal del aparato. El candidato B es otro momento — el vaso ladeado y un objeto turquesa que en
el cuadro de Premiere no está.

**Consecuencia: los in-points de un corporativo están bien**, y un in-point calculado con ffmpeg sobre un
VFR cae donde tiene que caer. El chequeo de `revisar_medios.js` bajó de ■ a □ y salió del veredicto
final: contarlo como defecto haría "revisar lo marcado" sobre 35 archivos sanos, que es exactamente
lo que ese archivo dice que no hay que hacer.

**Lo que el VFR sigue queriendo decir**, y por eso el chequeo no se borró: cualquier cuenta hecha
por CONTEO DE CUADROS en vez de por tiempo sí se corre, hasta 6,20s en el peor archivo. Eso es un
defecto de la herramienta que haga la cuenta, no del material ni de Premiere.

**Y la lección de método.** El residuo de 13,95 en el par correcto no es ruido de medición: es el
recorte del pillarbox más el reescalado. Sin el candidato B para comparar, un 13,95 no se puede
leer en ninguna dirección — **es el mismo control que hizo falta en `cotejar_export.js`**, donde el
~10 del par correcto parecía un in-point malo y era corrección de color. Dos veces el mismo día:
un número absoluto no dice nada sin un control al lado.


## No se puede inferir una ACCIÓN de una magnitud (2026-09-02)

Medido en UN VIDEOCLIP, buscando los planos donde la protagonista **gira** para armar un match cut. Se
propusieron por `mov.medio` de `broll.js` y el editor dio los verdaderos:

```
los giros reales, 3947-3955    puestos 12, 19, 32, 40, 44, 48, 49, 52 y 53 de 89
los propuestos por la metrica  puestos  1,  2, 10 y 14
```

**Y la primera conclusión que se escribió acá era equivocada.** Decía que la métrica "mide cambio de
píxeles y no la acción", o sea culpaba a la herramienta. El editor lo corrigió en una línea: *"los
planos de giro no tienen tanto movimiento eh, ella no podía girar tan rápido por todo el vestido"*.

Medido después de eso:

```
J3 completa    mediana 10,6   rango 2,8 a 23,8
los giros      mediana 10,7   rango 9,8 a 14,4
```

**Los giros están clavados en la media de la jornada.** La métrica los describió BIEN: son planos de
movimiento moderado. Lo que estaba mal era **el supuesto de quien la usó** — que girar implica
movimiento alto. Con un vestido de cola larga, girar es lento.

Así que la lección no es que la métrica falle: es que **el mapa de acción a magnitud depende del
MATERIAL, y por lo tanto no existe como regla.** El clip número 1 de la jornada era la modista
arrastrando la cola por el piso, que mueve muchísimos píxeles y no es ninguna acción interesante.

**Para qué SÍ sirve `mov.medio`:** distinguir un plano quieto de un travelling, y encontrar el tramo
estable adentro de una toma. Eso está validado contra el juicio del editor sobre 24 planos.

**Para qué NO:** cualquier pregunta de la forma *"¿qué está haciendo?"*. No porque la métrica esté
rota, sino porque la respuesta no está en la magnitud. Eso se mira, o lo contesta un modelo de
visión — el 2026-09-01 se midió que Gemini Flash acierta 13 de 15 clasificando espacios de un
edificio, con el tope de 20 pedidos por día y por modelo del tier gratuito.

**Y la lección de método, que es la más barata de aplicar:** antes de rankear material por una
métrica para encontrar una acción, **preguntarle al editor un solo ejemplo** y ver dónde cae en el
ranking. Si cae en el medio, la métrica no sirve para eso — y eso se sabe en una consulta en vez de
en una lista equivocada.
