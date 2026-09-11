# Bridge Claude ↔ Premiere Pro — lo que costó medir

Le da a un agente control de Premiere Pro: leer la secuencia, **mirar el frame**, navegar,
animar, editar y armar timeline. **51 herramientas MCP sobre 65 verbos del panel** — la
diferencia importa, ver *Al escribir un verbo nuevo*.

Esos dos números los chequea `test.js` contra el código. Escritos a mano envejecen: decían
33 sobre 43 cuando eran 35 sobre 46, y alguien los cruzó con la realidad y concluyó que
había verbos huérfanos donde no los había.

---

## Qué es este archivo

Cuatro semanas de mediciones contra la API de UXP de Premiere —del 14 de agosto al 11 de
septiembre de 2026, 233 commits— ordenadas por lo que enseñan. **Casi todo lo que está acá
se pagó con un crash, con material roto o con horas perdidas diagnosticando en el lugar
equivocado.**

Es una destilación de la bitácora privada con la que se construyó el bridge. Lo que se sacó
son los nombres de clientes y de personas, y las narraciones de trabajos sin estrenar. Lo
que quedó son las mediciones, que es lo único que le sirve a otro.

Cuando este archivo dice *"medido"*, hubo un experimento. Cuando dice *"no está
establecido"*, es literal — y esa distinción es la parte más importante del documento.

---

## Por qué está armado así

Un panel UXP **no puede abrir sockets**. Así que el servidor MCP y el panel se hablan por
una carpeta que el panel poletea:

```
agente  ->  servidor MCP (node)  ->  intercambio/  <-  panel UXP (dentro de Premiere)
```

Eso tiene una consecuencia que gobierna todo el resto: **cada llamada cuesta un latido del
poll**. Ver *El espaciado real es la SUMA*.

---

## Cómo se verifica acá

El bridge se verifica **con el bridge**, que es cómodo y peligroso a la vez.

- `node test.js` cubre lo que se rompe en silencio: dos scripts del panel declarando el
  mismo global (es SyntaxError y mata el archivo entero), verbos del servidor que el panel
  no conoce, las dos rutas de `intercambio/` apuntando a lados distintos, el `id` del
  manifest colisionando con otro plugin UXP instalado.
- **El panel tiene que estar abierto en Premiere**, si no las herramientas fallan al
  instante con "el panel nunca latió".
- **Cada cambio en `plugin/` necesita recargar.** Y si el plugin está INSTALADO —no cargado
  por UDT— la copia instalada es una COPIA, no un symlink: hay que reinstalar y reiniciar
  Premiere. `test.js` compara las dos copias y falla nombrando el archivo.
- Sin las herramientas MCP cargadas, el transporte directo sirve igual:
  `node -e "require('./server/bridge.js').enviar('estado').then(r=>console.log(r.resumen))"`

**`premiere_frame` es la verificación de último recurso y la mejor.** Devuelve el cuadro
como imagen. Cuando algo importa, mirá en vez de deducir.

---

## Los tres modos de fallar, todos ya pagados

**1. La API falla en silencio.** Devuelve éxito y no hace nada, o hace otra cosa. Por eso
**cada verbo devuelve qué encontró, no si salió bien**: "keyframes 0 → 1", no "ok". Y los
errores dicen qué había, no qué faltaba.

**2. La verificación simétrica se confirma sola.** Que el bridge lea 25 después de escribir
25 **no prueba nada** si leer y escribir usan la misma conversión. Pasó dos veces con el
reloj de material, y las dos veces la mentira era consistente. La verdad tiene que venir de
afuera: un frame, o una persona mirando Effect Controls.

**3. Medir un caso y generalizar.** Todos los bugs grandes salieron de acá. `Position` no
era `{x,y}` sino indexado por número. El param de escala SÍ cambia de nombre con Uniform
Scale (se midió un clip, se concluyó que no). El reloj de material ignoraba la velocidad, y
pasó todas las pruebas porque los clips corrían a 1x. **Antes de escribir una regla, medí
dos casos distintos.**

**Corolario: una guarda contra el error imaginado deja pasar el real.** El chequeo de que
las dos listas del catálogo midieran lo mismo no agarró que fueran promesas, porque
`undefined !== undefined` es falso.

### Y el inverso, que es menos obvio

No alcanza con desconfiar del mensaje de éxito: tampoco hay que creerle al de fracaso.
`editar` contesta **"NO CAMBIÓ NADA"** cuando lo que se le pide es lo que ya hay, y eso es
la respuesta correcta. Tratarla como fallo dejó dos clips en el limbo con la herramienta
informando "0 de 2".

**La lección común no es desconfiar del mensaje: es no usarlo como veredicto. El veredicto
sale de releer el estado.**

---

## El timeline no es solo video

Fue el punto ciego más caro y estaba metido hasta en el código de verificación. Antes de
tocar cualquier verbo nuevo, preguntate qué hace con el audio:

- `clips` lista `V2` y `A1`, y los verbos que apuntan a un clip aceptan esa etiqueta.
- **El vínculo la API no lo expone**: no hay `getLinkedItems` y el segundo argumento de
  `addItem` no los trae. Se deducen por medio de origen y rango de tiempo iguales. `borrar`
  y `editar` los arrastran; sin eso, borrar deja el audio huérfano y mover lo desincroniza.
- Contar solo pistas de video da por bueno un cambio a medias.

---

# Los regímenes que tiran Premiere

Son **cinco distintos**, con firmas distintas, y confundirlos costó días. La regla general:
leer el `__sentry-event` o el `.dmp` **antes** de teorizar. Tres crashes se atribuyeron mal
durante dos días; los dos reportes que se leyeron contestaron en un minuto y dijeron cosas
distintas.

## 1. `getKeyframePtr` en ráfaga (SIGBUS, señal 10)

```
message "Unhandled signal!"   signal 10   threadName main
```

El método devuelve un **puntero** a la estructura interna del keyframe. **El crash es
DIFERIDO**: las llamadas contestan bien y Premiere se muere unos segundos después, que es
por qué costó tanto atribuirlo.

Reproducción: 30 clips con keyframes, tres barridos seguidos → 90 punteros en ~2s → SIGBUS.

**Arreglo:** leer el valor con `getValueAtTime` sobre el tick del último keyframe.
`getKeyframeListAsTickTimes` se sigue usando: devuelve tiempos, no punteros. Medido lado a
lado sobre un clip animado de 100 a 110:

```
frac    getKeyframePtr   getValueAtTime
0       100              100
0.25    100              102.5
0.5     100              105
0.75    100              107.5
```

O sea que el puntero **ni siquiera interpolaba**. No había nada que justificara usarlo
primero.

## 2. Ráfaga de TRANSACCIONES (SIGSEGV, señal 11)

```
message "Unhandled signal!"   signal 11   threadName dvascripting::Transient1
sourceFile   dvauxphost/queue/src/JsTaskQueue.cpp
```

No hace falta un puntero: alcanza con encadenar transacciones. Ver *El espaciado* abajo
para los números.

## 3. Lecturas de VALOR de params en volumen (`PromiseFulfillment`)

```
category   PromiseFulfillment / resolve
sourceFunc NAPIContextAdapter::CallCallback(...)
```

Tres crashes, y **la causa NO está identificada**. Lo que se probó y NO lo evitó:

| intento | qué se hizo | resultado |
|---|---|---|
| 1 | 130 params por clip, 88 clips | crash |
| 2 | tope de 40 params, 12 clips (~560 lecturas) | crash |
| 3 | 3 clips con 40 params cada uno (~120 lecturas) | crash |

El intento 3 mata la teoría del umbral: **120 lecturas en 3 llamadas se cayó, y otro verbo
hace ~176 en UNA sola y nunca se cayó.** Si el umbral explicara algo sería al revés.

**La capacidad se ELIMINÓ, no se acotó.** Un flag apagado es una invitación a prenderlo. El
verbo ahora es triage —dice si un clip tiene algo agregado, no cuánto vale— y si le llega
el parámetro viejo **rechaza**, porque un parámetro que no hace nada es peor que un error.

**Y lo que sí se midió: batchear es lo que lo dispara.** La versión que pide los valores de
a uno funciona; la que los pide de a 25 crashea. El batcheo se había hecho para ahorrar
llamadas, y esa eficiencia se pagaba con estabilidad.

**Corolario para verbos de LECTURA: que un verbo no escriba no lo hace seguro.** Éste sólo
lee y tiró la aplicación.

## 4. `borrar` sobre una pista con SOLAPES

176 clips con 119 solapes, barridos de atrás para adelante y espaciados 1,2s. **Las seis
primeras salieron; la séptima se colgó 300 segundos y ahí Premiere murió.** Siete
transacciones no son una ráfaga, así que el umbral de espaciado no explica nada acá.

Los `__sentry-event` traen **sólo tags, sin señal ni stack**, así que la causa **no está
identificada**.

**La regla operativa no depende de acertar la causa:** no barrer una pista con solapes desde
el bridge, y no barrer una pista larga aunque esté sana. En Premiere, seleccionar la pista y
apretar Delete es una operación nativa, instantánea y sin riesgo. **El bridge sirve para lo
preciso —colocar 88 clips en su frame— no para lo masivo.**

## 5. Recargar el plugin mientras su `setInterval` sigue disparando

```
sourceFile   dvauxphost/queue/src/JsTaskQueue.cpp
threadName   dvascripting::Transient2
```

El host de UXP ejecutando una tarea JS **encolada por el plugin** mientras lo desmontaba. Se
arregla desarmando el panel en `beforeunload`/`unload` —`clearInterval` más una bandera que
corta la vuelta—, las dos cosas a propósito: si el evento algún día no se dispara, la
bandera igual evita el trabajo.

**Detalle al probarlo:** la recarga que instala el arreglo todavía corre el código VIEJO, así
que ésa puede crashear igual. Recién la siguiente queda protegida.

---

# El espaciado, que es el número que más importa

## El espaciado real es la SUMA, no la pausa

Esto estuvo escrito en la unidad equivocada durante semanas. El panel tiene un `MS_POLL`, así
que **cada llamada cuesta un latido**, y la pausa de las herramientas se suma encima. El
espaciado REAL entre dos transacciones es `PAUSA + MS_POLL`.

Con eso el costo queda **cuantizado**. Medido con `MS_POLL = 700`:

```
PAUSA    0ms  ->   710ms/op   1 latido
PAUSA  600ms  ->   740ms/op   1
PAUSA  700ms  ->  1334ms/op   2
PAUSA 1200ms  ->  1442ms/op   2      <- lo que usaban las herramientas
PAUSA 1500ms  ->  2058ms/op   3
```

O sea que `PAUSA=1200` costaba **exactamente lo mismo** que `PAUSA=700`: 500 ms que no
compraban ni velocidad ni separación. Bajar `MS_POLL` no es sólo velocidad: **descuantiza el
espaciado** y recién ahí se puede buscar el mínimo.

## El umbral depende del PESO DEL PROYECTO

```
espaciado real   proyecto                      resultado
   ~205 ms       chico (15 clips)              aguantó 200 transacciones
   ~710 ms       chico                         aguantó 305
   ~205 ms       pesado (216 clips, 1284       MURIÓ en la 22 · EXC_BAD_ACCESS en 0x18
                 medios, 68 secuencias)
   ~205 ms       pesado                        SE COLGÓ en la 34 · 0% de CPU, sin dump
   ~355 ms       pesado                        aguantó 150
   ~505 ms       pesado                        aguantó 150
```

**El borde está entre 205 y 355 ms, y el fallo se reprodujo 2 de 2** — con dos desenlaces
distintos, y eso importa al detectarlo: una vez murió con `EXC_BAD_ACCESS` en la dirección
**0x18** —un puntero NULO desreferenciado a 24 bytes, no uno salvaje— y otra quedó **vivo a
0% de CPU con el panel sin latir**, que desde afuera se parece a "está tardando".

**El mismo espaciado que mató un timeline de 216 clips aguantó 200 transacciones con 15.** La
variable es el PESO, no el ritmo solo. Medir en el proyecto chico y concluir para el real es
el *"medir un caso y generalizar"* de este archivo, y casi se entrega.

**Lo que NO está probado:** n=1 en cada punto que sobrevivió, dos pesos de proyecto nada más,
y un solo verbo. Si aparece un proyecto más pesado, 505 ms puede no alcanzar.

**Y la conclusión de diseño vale más que el número: si el borde se mueve con el peso, una
constante fija es la forma equivocada.** El peso se lee barato; lo correcto sería que la
herramienta lo mire y escale sola. Con dos muestras no alcanza para escribir esa fórmula.

## El borde también depende de la ACCIÓN

```
editar salida   ·  ~355 ms  ·  proyecto pesado  ->  aguantó 150 transacciones
setValue Motion ·  ~503 ms  ·  proyecto pesado  ->  CRASH a las ~60 escrituras
```

O sea que un piso medido para un verbo **no es universal**. Es el error de este archivo
cometido en la regla que el propio archivo acababa de establecer.

**Y el síntoma previo vale anotarlo**: 30 segundos antes del crash,
`executeTransaction` empezó a contestar *"n.executeUndoableTransaction is not a function"*.
El objeto nativo **ya estaba inválido** y Premiere siguió contestando lecturas un rato más.
Si aparece eso, no es un bug del verbo: es Premiere ya enfermo, y lo que corresponde es
guardar y salir, no reintentar.

## Agrupar por transacción gana MÁS que apretar el espaciado

El espaciado se paga **por transacción**, no por clip. Medido sobre 30 clips:

```
porTransaccion  1    35,6s ·  30 transacciones ·  releído 30 de 30   ✓
porTransaccion 10     3,7s ·   3 transacciones ·  releído 30 de 30   ✓   9,6x
```

**Y la segunda razón vale más que la velocidad:** menos transacciones es menos exposición al
régimen que crashea. Va en la dirección correcta por las dos puntas.

**El tope es 10, medido a los golpes.** Arrancó en 50 porque sonaba prudente:

```
porTransaccion 10   ->  6 transacciones · 0,3s · releído 53 de 53 · Premiere vivo
porTransaccion 50   ->  2 transacciones · Premiere SE COLGÓ
```

Entre 10 y 50 **no hay ningún dato**, así que el tope quedó en el número comprobado y no en
uno interpolado. Es **una sola constante** compartida: tres topes sueltos se suben en uno y
no en los otros.

La ironía vale tenerla: agrupar existe para bajar la exposición al régimen que crashea, y
**agrupar DE MÁS lo vuelve a producir por otro camino**. La palanca tiene un óptimo, no una
dirección.

## Y un verbo que hace su PROPIO bucle de lotes no lo alcanza la pausa

El espaciado de las herramientas separa **LLAMADAS**. Un verbo que recorre sus lotes adentro
de una sola llamada corre todas sus transacciones **sin una pausa en el medio**: el
espaciado real es **CERO**.

```
29 fragmentos  ->  ~15 transacciones seguidas  ->  sobrevivió
88 fragmentos  ->   27 transacciones seguidas  ->  COLGÓ Premiere
```

Reproducido a pedido con el código viejo: **1 de 3**. Esa tasa es lo que hace que una
corrida limpia no pruebe nada — tiene 67% de salir bien por suerte.

**Y la trampa al bisecar: pedir MENOS acciones por transacción es lo PEOR, no lo
conservador.** Sobre esos 88 fragmentos, `porTransaccion: 1` da **177** transacciones en vez
de 27. Se descubrió calculándolo, no corriéndolo.

Arreglado con una espera entre lotes **dentro del verbo**, porque el bucle lo hace el verbo:
una pausa en quien llama no puede meterse en el medio de una llamada que ya empezó.

## El espaciado protege ESCRITURAS: antes de una lectura no compra nada

Una pausa antes de un `clips` o un `medios` no defiende de nada: no transaccionan. Se
sacaron **después de medirlo**, no por deducción, porque la duda era razonable —esa pausa
podía estar dándole a Premiere tiempo de que el estado quedara legible—:

```
fijar -> param INMEDIATO          8 de 8 lecturas vieron el valor recién escrito
insertar -> clips INMEDIATO       6 de 6 lecturas vieron el clip recién insertado
```

`test.js` mira las dos direcciones, y **la segunda importa más**: que no vuelva a aparecer
una pausa antes de una lectura (desperdicio), y que **no desaparezcan las que están antes de
las escrituras** (daño). La guarda del espaciado exige que la suma sea suficiente pero **no
que las pausas existan**: borrarlas todas la dejaba pasar.

---

# Firmas de la API, medidas y no deducidas

**Antes de adivinar una firma, reflejala.** El verbo `api` lee los nombres de métodos sin
llamar a ninguno. La aridad que reporta `fn.length` **sirve a veces**:
`createOverwriteItemAction` dice 4 y es correcto, `createRemoveItemsAction` dice 0 y son 3.

Cuando la firma igual no se deduce, **enumerá los valores reales y probalos**. La prueba de
cuál sirvió no es que la llamada no tire, sino **el efecto observable**.

**Y no enumeres ni llames getters a lo bruto**: una sonda que lo hizo crasheó Premiere.

## Las que costaron caro

```
createOverwriteItemAction(medio, tick, pistaVideo, pistaAudio)
   El CUARTO argumento es la pista de AUDIO. Con -1 cae SIEMPRE en A1.
   Y el overwrite PISA: quince capas con -1 le comieron 2,4s cada una a A1.

createRemoveItemsAction(..., ..., Constants.MediaType.ANY)
   El tercero es un MediaType. No se dedujo: se enumeraron los valores y se probó.

exportSequence(secuencia, ExportType, salida, preset)
   El TIPO va SEGUNDO. Con (secuencia, salida, preset, tipo) NO TIRA y devuelve
   `false` sin escribir nada. La primera versión cortaba en la forma que no tiraba
   e informaba éxito sobre un export que no existió.

createSetInterpolationAtKeyframeAction(tick, modo)
   Vive en el PARAM, no en el keyframe, así que el tipo de keyframe no la limita.

performSceneEditDetectionOnSelection(operacionString, TrackItemSelection)
   La operación va PRIMERO. Con el objetivo primero, las 20 formas probadas
   contestan "Illegal Parameter type".

createSubClipAction(nombre, inicioTick, finTick, limitesDuros)
   CUATRO argumentos, no seis. Los tiempos van como TickTime, no en segundos.
```

## Tipos de retorno que NO son uniformes

Suponer que esta API es uniforme costó una vuelta entera:

```
getFrameRate()        devuelve un NÚMERO pelado
getVideoFrameRate()   devuelve {value: fps}
getValueAtTime()      devuelve {value: n} envuelto, y createKeyframe lo RECHAZA
```

**Cuando un getter y un setter son de la misma propiedad, la forma que devuelve el getter es
la primera que hay que probar en el setter.**

## El sentinel de los in/out

Sin marca, los getters de in/out de una secuencia **no devuelven 0 y el final**: devuelven
**−400000**, un sentinel. Se había escrito lo contrario sin medirlo.

Y el sentinel **se puede reescribir**, así que el estado "sin marca" vuelve, siempre que se
lea ANTES y se reponga el valor leído.

**`exportSequence` respeta los in/out de la secuencia**, y esto se entrega solo: un out viejo
—puesto a mano hace días— fija el largo del archivo sin que nada lo mencione. Medido: un
export salió **94 segundos más largo que el contenido**, clavado en el out point. Y
**respetó el OUT e ignoró el IN**, así que un in suelto no recorta la cabeza pero un out
suelto sí estira la cola. Es la asimetría que hace que el defecto se entregue: un export más
corto se nota, uno más largo con negro al final no.

**El rango va en DOS transacciones, y el IN primero.** Con las dos acciones en una sola, el
in **no se aplica**: si Premiere aplica el out primero queda un rango invertido y descarta el
in **en silencio**.

## `editar salida` es punto de FUENTE, no una duración

Un Transparent Video entra con `entrada ≈ 3600` —los sintéticos son generadores de una hora
y el clip nace por el medio—, así que para dejarlo de 10s hay que pedir `salida: 3610`.
Pedir `salida: 10` cae **antes** del in-point: no recorta, no tira error, y el clip se queda
en su duración por defecto.

**No es sólo el Transparent Video: un PNG fijo hace lo mismo.** Nueve placas quedaron de 5
segundos —la duración por defecto de una imagen— porque el colocador pedía `entrada: 0`.

La forma correcta es **leer la `entrada` real del clip recién insertado** y sumarle la
duración. No se puede asumir 3600 para cualquier medio.

## `createSetInPointAction` además MUEVE el clip

Medido: pidiendo `entrada` y `desde` en la misma llamada, el in-point entró y el clip se fue
a donde decía la entrada. Van en DOS llamadas, primero la entrada y después la posición — el
mismo patrón que los in/out del export.

## Los vinculados: el delta, no el valor

`entrada` y `salida` son puntos adentro del MATERIAL, y el material de cada clip arranca
donde arranca. Copiarle al vinculado el mismo número absoluto le da una duración que no es
la suya. En el peor caso, cero:

```
V4  300–305s  entrada 5      ← se le pide salida 8  → 300–303s, 3s ✓
A1  300–305s  entrada 8      ← le llegaba salida 8  → 300–300s, CERO ✗
```

Y **Premiere acepta un clip de largo cero**. Ojo con la diferencia: si el pedido diera
duración **negativa**, Premiere lo ignora y el clip queda intacto. Exactamente **cero** sí lo
aplica.

Lo que comparten dos vinculados es **dónde terminan en el timeline**, no dónde terminan
adentro de su material. Así que se pasa el **delta**.

## Deducir el vínculo: exigí que el socio sea del OTRO tipo

La deducción era "mismo medio + mismo rango", sin mirar el tipo. Dos clips de VIDEO del
mismo medio en pistas distintas, con el mismo rango, eran un par vinculado — y eso no
existe: un grupo vinculado es siempre video + audio.

**El tipo se decide por la PISTA, no por `getMediaType()`**: los valores de
`Constants.MediaType` **no son primitivos** y comparados como texto dan `[object Object]`.

---

# Unicode, cuadros y otras trampas del mundo real

## Los nombres vienen en DOS normalizaciones distintas

macOS entrega los nombres de archivo en **NFD** —"á" es `a` más una tilde combinante— y
Premiere los devuelve en **NFC**. Se ven idénticos y no son la misma cadena:

```
del disco  : 61 cc81 6c696461     ("a" + U+0301)
de Premiere: c3a1   6c696461      (U+00E1)
```

Cobró dos veces al mismo tiempo y en silencio: el importador no reconoció que ya estaban y
los **duplicó**, y el insertador informó *"no hay ningún medio que coincida"* con el medio
ahí, visible en el panel.

**De 35 archivos, los dos únicos con tilde fueron los dos únicos que fallaron.** En
castellano esto no es un caso borde: es la mitad del material. Y el diagnóstico costó una
hipótesis equivocada —se culpó a la COMA del nombre— hasta mirar los bytes.

Corolario cobrado semanas después: una comparación de rutas en otra herramienta **no tenía**
aplicado el helper de normalización, y rechazaba un armado correcto imprimiendo dos líneas
idénticas en pantalla. **Una regla implementada en un lugar no se aplica sola al de al
lado.**

## Premiere recuantiza el in-point a la grilla de la SECUENCIA

Que la API escriba sub-frame es cierto; que eso sirva para ganar precisión, **no**.

Un in-point de 3,10 —frame exacto a 50fps, medio frame a 25— arrastrado por el usuario quedó
en **3,12**, y el error de sincronía pasó de −9 ms a **−29 ms**. Y **el audio NO se
recuantiza con el video**: el mismo arrastre dejó el video en 3,12 y su audio vinculado en
3,10, con lo cual el par deja de tener el mismo rango y la deducción del vínculo **no
encuentra socio**.

**La regla: posición, in-point y out-point los tres en frames de la SECUENCIA**, porque lo
que tiene que ser múltiplo exacto no es cada número sino la DIFERENCIA `pos - ent`.

El costo se acepta a propósito: el error sube de ≤10 ms a ≤20 ms. **Un error de 19 ms que no
se mueve es mejor que uno de 9 que se convierte en 29 al primer arrastre** — y sobre todo,
19 ms es mejor de lo que se puede hacer a mano.

## Sub-frame: mover NO se pega al frame, insertar SÍ

```
insertar (createOverwriteItemAction)    SE PEGA al frame
editar desde (createMoveAction)         NO se pega: aceptó 0,005 y 0,010 s
editar entrada (createSetInPointAction) NO se pega: aceptó 22,430 s
```

El toggle de *Show Audio Time Units* **no hace falta**: gobierna a qué se pega el MOUSE. La
API trabaja en TickTime —254.016.000.000 por segundo— y saltea el snapping.

## Cortar entre frames deja huecos de un frame

`createSetEndAction` guarda el **tick exacto** y no snapea; el overwrite de la cola **sí**
snapea. Cortando en 313.03 sobre una secuencia a 25fps la cabeza terminaba en 313.03 y la
cola arrancaba en 313.04.

**Pegar la cola en el tick exacto de la cabeza NO alcanza** — hay que cuantizar el punto de
corte **antes de tocar nada**. Y la cuantización no sale por la API:
`alignToNearestFrame(timebase)` contesta *"Illegal Parameter type"*. Lo que anda es
aritmética entera sobre ticks, con `getTimebase()` que **son ticks por frame**:

```js
Math.round(ticks / ticksPorFrame) * ticksPorFrame
```

**Detalle de proceso que costó una vuelta entera:** la primera versión tenía un `catch` vacío
alrededor de la cuantización. No cuantizó, la tanda dio idéntica y no había ninguna pista de
por qué. Recién al hacer que el verbo **informara** apareció el "Illegal Parameter type".

## La grilla es la de LA SECUENCIA, no una constante

Una herramienta tenía `const FPS = 25` fijo. En un proyecto a **50fps**, cuantizar a 40 ms
movió la posición un cuadro y dejó **cinco de once clips** desincronizados.

**Y es el peor tipo de defecto**: el clip mide lo mismo, no hay hueco ni solape, el revisor no
lo ve, y el colocador informa "colocado y verificado" — porque verifica contra lo que él
mismo cuantizó. Se descubre ESCUCHANDO, no mirando.

---

# Cosas que la API NO permite

Anotadas porque cada una se descubrió intentándola, y algunas tienen una vía alternativa.

**No hay razor.** Cortar es: leer el clip, achicar la cabeza con `createSetEndAction`, y
pegar la cola con un overwrite. Y **el overwrite no copia nada**, así que la cola nace con
Motion por defecto y **borra el escalado del clip original** si no se lo repone a mano.

**No se pueden agregar pistas de VIDEO.** Las de **audio** se crean solas al pedir una fuera
de rango; las de video no: `Sequence` sólo expone `getVideoTrack` y `getVideoTrackCount`.

**No hay `detachProxy`.** Se adjunta y no se suelta. Corolario: **no adjuntar nunca un proxy
que viva en una carpeta temporal.**

**No se pueden crear capas de ajuste**, ni cargar presets de Lumetri (`.prfpset`), ni aplicar
un `.cube` propio por ruta. Pero el efecto **sí se controla entero**: Lumetri expone 130
parámetros nombrados, y los looks de fábrica se aplican **por índice**.

**No se puede importar una transcripción por API.** `Transcript.importFromJSON` devuelve un
**cascarón**: un objeto sin propiedades propias y con el puntero interno en null. Probado con
el JSON que Premiere mismo exportó, así que el esquema es idéntico byte por byte. Las 16
combinaciones de segundo argumento contestan "Illegal Parameter type".

Pero **el pipeline SÍ cierra con UN import a mano**: JSON en el esquema de `Transcript` →
panel Text → Import → y el verbo de lectura devuelve los segmentos y las palabras con los
tiempos intactos. El único paso manual es **un** Import, no transcribir clip por clip.

**El modo de fusión (`Blend Mode`) SÍ se lee y se escribe**, y llega al render — 4 valores, 4
cuadros distintos, y al reponer vuelve el md5 exacto. Vive en el componente `Opacity`, cuyos
params son `["Opacity", "Blend Mode", "Blend Mode"]` —aparece dos veces— y es un índice
numérico.

## `copiarEfecto` NO es una copia: es la MISMA INSTANCIA

`createAppendComponentAction(comp)` con un componente de otro clip **no lo copia: lo
COMPARTE.** Medido entre dos secuencias distintas:

```
origen  Exposure      0,4
destino Exposure      0,4     (recién "copiado")
escribo 2,5 SOLO en el destino
origen  Exposure      2,5     <- cambió el ORIGEN
```

Eso **explica de golpe todo lo que parecía un éxito**: los valores "viajaron", las máscaras
internas "viajaron", los efectos de terceros "viajaron". Claro que sí — es el mismo objeto.

**Lo descubrió el usuario, no la verificación**: entró a la secuencia nueva, apagó un efecto,
y se le apagó también en la otra. **Ninguna de las pruebas lo podía encontrar**, porque todas
leían el destino después de escribir el origen, y eso da igual con una copia que con un
vínculo. La prueba que los distingue es la INVERSA —escribir en el destino y leer el
ORIGEN—.

Es una variante nueva de la verificación simétrica: no fue leer con la misma conversión con
que se escribió, fue **medir siempre en la misma dirección**. Un vínculo y una copia sólo se
distinguen mirando para el otro lado.

**Y el vínculo SOBREVIVE a cerrar y reabrir el proyecto**, así que no es un alias de sesión
sino una propiedad que Premiere guarda en el `.prproj`.

## Copiar los componentes NO es copiar el look

Ocho componentes llegaron con sus valores, el verbo informó que cada uno viajó, y el
resultado estaba **completamente roto**: naranja, borroso y oscuro.

Falta que **`Opacity` y `Blend Mode` viven en un componente que TODO clip ya tiene**, así que
no se pueden traer. Una sola capa mal compuesta destruye todo el cuadro: una capa que
funciona *al 25% y en otro modo*, copiada en Normal al 100%, simplemente tapa la imagen.

**Y la bisección es el método, no el ojo.** Apagar las cuatro y prenderlas de a una lo
encontró en una pasada, con un número por capa:

```
todas apagadas        142,6
+ base                158,8    plausible
+ la capa mala        112,5    <- -46 de un saque: es ésta
+ las otras dos       108,0
```

---

# Lo que el `.prproj` tiene y la API no expone

Es XML gzippeado. Dos cosas se leyeron de ahí porque no hay verbo:

**Los marcadores del MEDIO** (los que pone la detección de escenas) — el verbo de marcadores
lee los de la SECUENCIA e informaba "no tiene marcadores" con 145 puestos:

```xml
<Marker><DVAMarker>{"DVAMarker":{"mStartTime":{"ticks":877066444800000},...
```

Ticks divididos por 254.016.000.000 y quedan los segundos. Cotejados contra los detectados
por ffmpeg: **los mismos 145, diferencia 0 ms** — dos métodos independientes, que es la única
confirmación que vale.

**Las transiciones**, que por API se pueden ver pero no hay verbo (`clips` pide sólo
`TrackItemType.CLIP`, clavado). **Y en el XML NO cuelgan de la pista**: cuelgan de cada clip,
como `HeadTransition` / `TailTransition`. Recorrer los `TrackItems` de cada pista devuelve
**cero** en una secuencia que tiene 39. Una transición es cola de un clip y cabeza del
siguiente, así que **hay que deduplicar por `ObjectID`**.

**El punto de corte es `Start + Alignment`, y la alineación NO se puede asumir.** En una sola
secuencia aparecieron las tres: centradas, una que arranca 6 cuadros antes del corte y una
que **termina** en el corte. Suponer "centrado" habría dejado dos de seis corridas ~1,7s.

## Tres falsos negativos el mismo día, todos por adivinar el nombre del campo

Es lo que más vale de esta sección, porque el modo de fallo es el mismo las tres veces:
**escribí un lector, no encontró nada, y estuve a punto de informar que el trabajo del editor
no estaba.**

```
transiciones   busqué en TrackItems      -> "0 transiciones" con 39 puestas
clip muteado   busqué <Disabled>         -> "ninguno apagado", el campo es <IsMuted>
efectos del    resolví un nivel de menos -> "SIN EFECTOS" en los 8, con el compresor
master                                      puesto
```

Los tres se veían igual desde afuera: un lector nuevo devolviendo vacío. Y **un vacío se lee
como "no está" cuando en realidad es "no lo encontré"**.

**Lo que los separó fue un CONTROL, no mirar mejor el código.** Leer el mismo campo donde se
SABE que el efecto no está: las secuencias intactas dieron **2 componentes** y las tocadas
**3**. Recién ahí el tercero significa algo.

**La regla operativa: un lector nuevo sobre el `.prproj` no informa "no hay" hasta haber
pasado un control positivo.** El daño de equivocarse acá no es un número mal: es decirle al
editor que su trabajo no entró.

---

# Método de verificación

Esta es la parte más transferible del repo, y la que más caro salió aprender.

## Una guarda se verifica HACIÉNDOLA FALLAR

Sin excepción. Los casos que lo justifican:

**Una guarda que pasaba sobre código roto.** Su regex usaba `[^)]*?` para los argumentos, y
`[^)]` no puede atravesar el cierre de una llamada anidada:

```
createOverwriteItemAction(item, aTick(segundos), pista, -1)     INVISIBLE
createOverwriteItemAction(medio, juntaTick, pista, -1)          la veía
```

O sea que cubría un sitio y dejaba libres los dos donde el bug había mordido de verdad.
Verificado por mutación: con el `-1` puesto a mano, el test contestaba **"ok"**.

**Una guarda imposible de disparar.** Exigía un literal que aparece **CERO veces** en el
código: la condición era siempre false.

**Una guarda que matcheaba su propia prosa.** Buscaba un identificador en el cuerpo del verbo
y lo encontraba **en el comentario que explica por qué NO se usa**. Se arregla sacando los
comentarios antes de mirar, y exigiendo el **paréntesis** de la llamada y no la mención.
**Chequear presencia no es chequear uso.**

**Y el modo de fallo opuesto, que es peor: una guarda que rechaza código correcto.** El
filtro para saltear la DEFINICIÓN de una fábrica descartaba también su INVOCACIÓN, porque
las dos matcheaban el mismo patrón. Antes de encender una guarda nueva se contrastó contra
**96 llamadas reales**; sin eso habría roto lo que andaba.

## Medí el PISO DEL INSTRUMENTO

Variante del "medí dos casos" que se cobró tres vueltas en un día: no dos casos del material,
**el mismo caso con otro parámetro de la herramienta**.

Un benchmark daba 2,5x de mejora. Estaba inflado: cada medición incluía arrancar el proceso,
un costo fijo que Premiere no paga. Aislado, la mejora real era **5,5x** — el doble, tapada
por el arranque.

Y un detector de ataque de voz dio "los subtítulos están 340 ms tarde", que parecía un
hallazgo. Repetido con ventanas de 150/300/450/600/900 ms, **21 de 23 líneas cambian de
respuesta**. El número era del instrumento, no del material.

**Si el resultado se mueve al cambiar un parámetro del instrumento, no midió nada.** Y cuando
dos ajustes muy distintos dan el MISMO número, eso no es robustez: es el instrumento avisando
que no mide.

## Un test de render se hace con un valor que TENGA que verse

La primera medición puso un efecto en **3,7 sobre un default de 60** —o sea casi invisible— y
después preguntó si el cuadro cambiaba. Dio **9 milésimas, que es ruido**. Y la comparación
era `con !== sin` sobre strings, así que cualquier diferencia contaba: el test informó **"EL
EFECTO LLEGA AL RENDER"** sobre nada.

**Un test de render se hace con un valor que tenga que verse, y con un umbral, no con una
desigualdad.**

## Verificar cada paso NO verifica la tanda

Dos capas en la misma pista y la misma posición se comen: el overwrite pisa. **Y el verbo
informó "3/3 capas"**, porque cada una se verificaba a sí misma **en el momento de ponerla** y
nadie volvía a mirar después de poner la siguiente. Un clip truncado es legal: no es ni hueco
ni solape ni cero.

Para eso existe un verbo `revisar` que recorre la secuencia entera y sólo lee. Cuatro
chequeos, todos inequívocos a propósito, y cada uno corresponde a un daño que ya pasó:

- **Clips de duración cero** — Premiere los acepta y no se ven en el timeline.
- **Solapes** — `createMoveAction` **solapa, no pisa**, así que mover puede apilar dos clips
  en silencio.
- **Huecos, medidos en FRAMES.** En milisegundos no se puede decidir nada: 20 ms es un frame
  a 50fps y medio a 25.
- **Juntas removibles** — pegados, mismo medio y continuos: un corte que no corta nada.

Los cuatro se probaron **construyendo el daño a propósito**, no observando una secuencia
sana.

## El contador ciego

Un verbo corrió CUATRO veces y dejó 68 marcadores de más **mientras informaba que no había
pasado nada**. La API funcionaba desde la primera llamada correcta; el contador miraba el
sujeto equivocado —la secuencia, cuando los marcadores iban sobre el clip— y el bucle seguía
probando formas.

No fue la API la que mintió ni la verificación la que se confirmó sola: fue **un contador
mirando en el lugar equivocado**, que convierte un éxito en un falso negativo y encima lo
repite.

El mismo patrón, en otro verbo: un `try/catch` que convierte un fallo de lectura en lista
vacía, informa **"0 clips"** y sigue como si no hubiera nada que hacer. Visto en vivo con la
pista teniendo 88.

## Una pista con el OJO APAGADO no la ve NINGÚN verbo

```
clips             la lista igual, en su lugar y con su duración
revisar           "sin problemas"
el colocador      "6 de 6 colocados y verificados"
el frame          NEGRO
```

Los tres primeros informes son CORRECTOS —el clip está ahí— y ninguno contesta la pregunta
que importaba, que es si se ve.

**Se confirma MIDIENDO el cuadro, no mirándolo**: la media dio **0** en la pista apagada y
**22,8** en otra. Un número separa los dos casos; el ojo no, porque un cuadro negro y un
cuadro vacío se ven igual.

Y hay una trampa de segundo orden: **el visor muestra un PNG negro o transparente como
BLANCO**, así que el primer diagnóstico fue "sale todo blanco" y se buscó un gráfico que no
existía.

## Homónimos: el material entra al clip equivocado

El importador decide "ya está" por **NOMBRE**, no por ruta. Un archivo homónimo en otra
carpeta se saltea en silencio, y después el insertador —que **también** busca por nombre—
agarra el medio VIEJO.

```
el colocador   "42 de 42 colocados · los 42 en su lugar y con su duración"
revisar        "sin problemas"
el frame       el texto del OTRO tema
```

Los dos primeros informes son **correctos**. Ninguno contesta qué medio quedó.

**La asimetría fue la única pista, y es la parte reusable.** El tema viejo llegaba hasta el
037, así que de 42 clips **38 salieron mal y los 4 últimos salieron bien**. Un fallo total se
nota; uno que deja las últimas cuatro bien parece un problema de otra cosa. **Cuando un
resultado sale mal en parte, el corte entre lo que anduvo y lo que no suele nombrar la
causa.**

Regla operativa: **los nombres de archivo generados llevan prefijo propio.** Un contador que
arranca en cero en cada carpeta es una colisión esperando.

## Un parámetro no declarado se descartaba en silencio

Cuatro bugs distintos, ninguno evidente:

```
una guarda de seguridad  -> declarada pero descartada: protección que no protegía
`segundos` en el frame   -> cuadro de otro momento, diagnóstico sobre la nada
un flag en otro verbo    -> verbo declarado roto durante horas
un filtro mal nombrado   -> una llamada perdida
```

Los tres primeros comparten la trampa: **la rama por DEFECTO se parece al éxito.** Un verbo
sin su parámetro lista y contesta "activa: X", que se lee igual que "la activé".

Resuelto con una tabla de claves aceptadas por verbo, que **rechaza** lo que no está:

```
"medios" no conoce el parámetro `filtro`. Acepta: buscar, más las guardas
proyecto y secuencia. NO se ejecutó nada.
```

Va **antes** que las demás guardas: una llamada mal escrita no tiene que ejecutar nada.

**Y lo que hace que esto no se pudra es que la tabla se DERIVA del código.** `test.js` la
vuelve a extraer y falla si no coincide, así que un verbo nuevo rompe el test en vez de
romperle la llamada al usuario.

**Y hubo que seguir los helpers, o la guarda habría sido peor que el problema.** La primera
versión miraba sólo el cuerpo del verbo y habría rechazado **llamadas correctas** — el modo
de fallo más caro posible para una guarda.

**La lección de método: antes de anotar que un verbo está roto, leer su firma.** Fueron dos
minutos de `grep` contra horas de trabajarle alrededor.

## Antes de informar que algo no está, pasá un control positivo

Ya dicho arriba para el `.prproj`, pero vale como regla general y aparece en todos lados:

- Un detector de repeticiones acústicas se calibró contra casos conocidos **antes** de usarlo:
  los positivos daban −0,07 y los negativos +0,32. **Estaba invertido.** Sin la calibración
  habría informado un hallazgo con toda confianza sobre nada.
- Un filtro nuevo se probó contra los **positivos conocidos** antes que contra los negativos
  imaginados: un umbral transferido de otro régimen volteó los 14 tramos buenos.

**Un número que se mueve al cambiar un parámetro del instrumento no midió nada. Y un vacío
no es "no hay" hasta que el lector demuestre que sabe distinguir.**

---

## Al escribir un verbo nuevo

- **Chico y sobre algo que ya existe.** Nada de "ejecutá este JS": con una API que falla en
  silencio, un verbo genérico produce código plausible que no pasó.
- **Devolvé el antes y el después**, no un booleano.
- **Contá el efecto COMPLETO**, no la parte que se te ocurrió mirar.
- **Nombrá el objetivo explícitamente** en los verbos destructivos. Operar sobre "el
  seleccionado" es una sorpresa fea cuando nadie está mirando.
- **Decí cuántos Cmd+Z hacen falta**, contando las transacciones que de verdad corrieron.
  Decir "uno" cuando son dos deja al usuario con medio cambio puesto creyendo que lo sacó.
- **Y exponelo en el servidor, o no existe.** Un verbo que vive sólo en la tabla del panel es
  invisible desde las herramientas MCP: se usa el más parecido que sí está expuesto, y ese
  hace otra cosa. Ya pasó dos veces.
- **Decí lo que NO comprobaste.** "3 ESCRITOS (transacción corrida; el valor NO se releyó)"
  es honesto; "3 aplicados" no lo era.

`test.js` chequea **las dos direcciones**: que no haya verbos sin herramienta, y que los que
no la tienen estén **declarados a propósito** en una lista. El default —no hacer nada— falla.

## En un verbo de TANDA, verificar no puede costar lecturas de VALOR

Releer el valor de cada clip para confirmar mete al verbo en el régimen que tiró Premiere
tres veces. O sea: **la verificación habría convertido un informe optimista en una caída.**

Lo que sí es gratis, y alcanza:

```
contar keyframes    getKeyframeListAsTickTimes, SINCRÓNICO adentro del lock,
                    NO lee valores
el booleano de      executeTransaction ya lo devuelve; descartarlo no ahorra nada
la transacción
```

Con esas dos se detectan **los dos** fallos silenciosos sin una sola lectura de valor: el
param **animado** —donde la escritura va al valor base y los keyframes la tapan— y el
**limpió y no escribió**, que deja el clip sin animación mientras informa éxito.

**La regla: antes de agregar una verificación a un verbo que barre una pista, preguntarse
cuántas llamadas a la API agrega POR CLIP.** Si la respuesta no es cero, buscar el testigo
barato antes de aceptar el caro.

---

## Estilo

Comentarios y textos en castellano; los nombres de la API en inglés. Los comentarios explican
**por qué**, sobre todo cuando la razón es una trampa que ya se pagó — que en este repo es
casi siempre.

Un comentario que describe la intención en vez del código **es peor que ninguno**, porque el
próximo que lo lea no va a mirar. Pasó: un encabezado afirmaba que los params se leían
sincrónicamente adentro de un lock, y el código pedía cada valor con un `await` afuera. Ese
comentario tapó el régimen que después crasheó.

## Cosas que NO se tocan

- **El `id` y el `shortname` del manifest.** Premiere identifica al plugin por ahí: cambiarlos
  lo instala como uno nuevo, y si coinciden con los de otro plugin UXP instalado, uno pisa al
  otro. `test.js` lo chequea contra todos los instalados.
- **La ruta del `intercambio/` en el panel y en el servidor** tienen que apuntar al mismo
  lado. El servidor la deduce de `__dirname`; el panel la tiene escrita a mano porque corre
  adentro de Premiere. **Mover el repo obliga a editar la del panel**, y `test.js` compara
  las dos.
