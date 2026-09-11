# Detectar movimiento de cámara roto — receta validada, NO construida

Estado al 2026-08-20: **la receta pasó una prueba fuera de muestra (8 de 10) y se
decidió NO construir la herramienta todavía.** Esto queda para armarla en una hora
el día que el volumen lo justifique, sin repetir el camino.

## EL TECHO: 83%, y la métrica está en 80%

Medido el 2026-08-20 con una prueba de consistencia: seis clips que el usuario ya
había juzgado, con la ventana corrida un segundo, mezclados entre cuatro nuevos y
con letras nuevas, sin decirle cuáles eran repetidos.

    exacto en tres niveles (roto/medio/ok) : 4 de 6   (67%)
    binario (ok / no-ok)                   : 5 de 6   (83%)
    vuelcos ok ↔ roto                      : 0 de 6

**La métrica saca 8 de 10 = 80% contra un techo de 83%.** No hay lugar donde
mejorar: cualquier ganancia medida sobre 25 clips sería ajuste a la variabilidad de
las etiquetas, no señal. Eso convierte el "8 de 10" de un número ambiguo en "está en
el máximo alcanzable".

**Los dos que corrieron son el mismo caso, y no es inconsistencia del usuario:**
describió lo mismo y movió la etiqueta.

    FX3_3063  "empieza con varios golpes y luego fluido y bueno"  → ok
              "duda al principio, después sirve"                  → medio
    FX3_3148  "no está tan mal, un mínimo movimiento de más"      → roto
              "a mitad de plano cambia el movimiento"             → medio

**Cero vuelcos** en seis: su percepción es estable, lo que se mueve es dónde cae la
línea. La escala de TRES niveles es demasiado fina; hay que trabajar en dos.

**Y la lección de método, que es la más cara del día:** se iteró cinco veces sobre
métricas de foco y temblor ANTES de medir el techo. La prueba de consistencia costó
un minuto del usuario y habría ahorrado media jornada. **Medir el techo va PRIMERO**,
antes de perseguir la métrica: sin él no se puede distinguir "falla" de "ya llegó".

## Y la salida útil no es "descartá", es "ESTABILIZÁ"

El usuario usa el Warp Stabilizer como parte de su flujo — lo dijo sin que se le
preguntara, en dos de diez clips: *"con el estabilizador de premiere queda perfecto"*,
*"seguro usé el estabilizador"*.

Entonces un plano "roto" no es descartable: es un plano **que necesita estabilizador**.
Eso cambia el producto: la lista ordenada no sirve para tirar material, sirve para no
tener que buscar a mano cuáles estabilizar. Es una acción concreta, y ahí un falso
positivo cuesta cuatro segundos de mirar en vez de un plano perdido.

## Por qué no se construyó

No por la métrica. Por lo que ahorra:

- El usuario juzgó 10 clips en **41 segundos** de video. Los 130 son nueve minutos
  de mirar, y va a ver cada clip que use igual mientras edita.
- Hay **solapamiento en la frontera** (un falso positivo dio 0,508 y un roto real
  0,526), así que como sí/no va a fallar siempre. Sirve como ranking de triage.
- Sus categorías son más ricas que el escalar: *"el drone reencuadra brusco"*, *"es
  el viento"*, *"hace un tilt down y frena"*. La métrica da un número y un timecode;
  para decidir entre recortar, descartar o estabilizar, sus categorías sirven y el
  número no.

**Qué cambiaría la decisión: VOLUMEN.** Con 130 clips se puede mirar todo. Con mil,
o con diez horas de drone, no — y ahí el ranking con timecode pasa de comodidad a
necesidad.

## El criterio del usuario, que es lo que la métrica tiene que predecir

- Le molesta el temblor **rápido y brusco**, no el lento. (Corrigió esto
  explícitamente: la primera conclusión escrita decía lo contrario.)
- Un golpe **en el borde** del clip es recortable; uno **en el medio** arruina el
  plano.
- **Nada se filmó en trípode**: todo es handheld o gimbal, y lo más estable es el
  drone, que igual vuela. Así que "cámara quieta" no existe en este material, y
  cualquier métrica que mida cero sobre él está ciega por definición.

## La fórmula que sobrevivió

Sobre el clip COMPLETO, a fps nativos, en gris a 320 px de ancho:

```
d[k]     = media |cuadro[k+1] − cuadro[k]|          (todo el clip, no ventanas)
base[k]  = mediana de d en ±12 cuadros              (línea de base LOCAL, ~1s)
score[k] = (d[k] − base[k]) / sqrt(max(base[k], 0.05))
puntaje  = max(score) sobre el 15%–85% del clip     (se ignoran los bordes)
umbral   ≈ 0,45
```

Se informa además **dónde** está el pico, que es lo que permite decidir si es
recortable.

### Por qué cada pieza, medida

- **Clip completo y MÁXIMO, no tres ventanas y promedio.** La primera versión
  muestreaba tres ventanas de 1,5s y promediaba: el agua corre todo el tiempo y
  aparece en las tres, el golpe pasa una vez y se promedia hasta desaparecer.
  Estaba sesgada exactamente al revés de lo que importa.
- **Exceso sobre la base, no cociente.** El cociente `d/base` castiga a los clips
  que ya se mueven mucho: dos rotos con base alta (2,15 y 2,20) quedaban 14° y 11°
  de 15. Con el exceso amortiguado por `sqrt(base)`, Spearman contra el juicio
  humano sube de **+0,550 a +0,811**.
- **Sólo el 15%–85%.** Sale del criterio del usuario, no de ajustar un parámetro.

## Las dos pruebas

**Quince clips (AJUSTE, no predicción).** Se eligió la variante mirando estas
etiquetas, así que no vale como validación. Los seis rotos quedaron en los puestos
1, 2, 3, 4, 6 y 7; los cinco aceptables en 9, 11, 13, 14 y 15.

**Diez clips nuevos (PREDICCIÓN sellada antes de que mire).** 8 de 10. Los cinco
primeros del ranking son los cinco rotos. Los dos fallos:

- **Falso positivo de borde**: 0,508 contra umbral 0,45, y un roto real dio 0,526.
- **No detectado estructural**: el golpe estaba en el primer 15%, la zona que la
  métrica descarta **por pedido del usuario**. Él igual lo llamó roto. Es una
  tensión en su propio criterio, no un fallo del código: en la tanda de quince, dos
  clips con golpes al inicio los llamó aceptables. La diferencia debe ser severidad,
  y es decisión suya.

Las 31 etiquetas están en
`un institucional/analisis/VEREDICTOS_MOVIMIENTO.json`, con sus comentarios textuales. **Sin
etiquetas humanas no hay forma de saber si una métrica de calidad sirve**, y
juntarlas fue el trabajo caro de toda esta vuelta.

## Lo único que quedó sólido sin condiciones

La **línea de base** separa perfecto, en 25 clips y sin un solo error, el material
con movimiento propio en el cuadro del material quieto:

```
agua corriendo      5,33  ·  2,76
drone volando       3,13
handheld quieto     0,45 – 0,63
```

No es lo que se buscaba, pero es afirmable sin peros.

## Cuatro métricas que fallaron, para no reconstruirlas

Ver el encabezado de `nitidez.py`, que las documenta con sus números. En resumen:
las de foco miden **cuánto detalle hay en el cuadro**, no si está enfocado —el clip
peor puntuado de 130 era un tilt al cielo con foco perfecto— y la primera de temblor
medía movimiento en la imagen, no de la cámara, así que el agua corriendo puntuaba
más alto que el único plano con golpes.

**Y la lección de método que valió más que las cuatro:** la validación controlada era
demasiado fácil. Se inyectó una sinusoide de 12 Hz sobre un cuadro FIJO, que es el
único caso que ese método manejaba bien, y dio confianza falsa. Un test controlado
cuyas condiciones no se parecen al problema real no valida nada: valida el test.
