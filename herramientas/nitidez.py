#!/usr/bin/env python3
"""Foco y temblor por clip.

=============================================================================
ESTO NO FUNCIONA. NO USARLO PARA DECIDIR NADA. Queda para que no se reconstruya.
=============================================================================

Las dos métricas fallaron contra el juicio del usuario, y las dos por la MISMA
razón de fondo: **miden una propiedad del CUADRO, no la propiedad de la CÁMARA.**

TEMBLOR — prueba a ciegas del 2026-08-20, seis clips sin etiquetar:

    clip                 medido    veredicto del usuario
    FX3_3125 (Jardín)     0,48     agua corriendo, cámara quieta
    FX3_3093 (Cava)       0,00     de los mejores          ✓
    FX3_3059 (Depto)      0,45     de los mejores          ✗
    FX3_3094 (Cava)       0,00     EL ÚNICO MALO           ✗
    FX3_3124 (Jardín)     0,20     agua corriendo          ✗
    FX3_3095 (Cava)       0,00     de los mejores          ✓

Acertó 2 de 6 y el caso que más importa al revés: el único plano tembloroso mide
CERO. Dos mecanismos de falla, los dos estructurales:

  1. FALSO POSITIVO por movimiento del sujeto. El agua arrastra el ajuste global y
     produce residuo. La métrica no distingue cámara de sujeto, y para hacerlo
     habría que estimar el movimiento dominante del FONDO rechazando la región que
     se mueve, que es otro problema entero.
  2. FALSO NEGATIVO con el temblor BRUSCO Y BREVE, que es EL QUE LE MOLESTA al
     usuario --lo corrigió explícitamente: "el temblor que me molesta es el rápido y
     brusco"--. La causa no es la banda de frecuencia, que estaba bien: es el
     MUESTREO Y LA AGREGACIÓN. Se miden tres ventanas de 1,5s en posiciones fijas y
     se PROMEDIA. Un golpe es un evento único: si cae fuera de esos 4,5s se pierde
     entero, y si cae dentro, el promedio con las otras dos lo diluye.

     La ironía completa: el agua corre todo el tiempo y aparece en las tres
     ventanas; el golpe pasa una vez y se promedia hasta desaparecer. La métrica
     está sesgada exactamente al revés de lo que importa.

     ESTO SÍ ES ARREGLABLE, y es lo primero que habría que hacer si se retoma:
     recorrer el clip COMPLETO y reportar el MÁXIMO, no el promedio de tres
     muestras.

**Y LA LECCIÓN QUE VALE MÁS QUE EL CÓDIGO: la validación controlada era demasiado
fácil.** Se inyectó una sinusoide de 12-17 Hz sobre un cuadro FIJO —sin sujeto en
movimiento y a alta frecuencia—, que es el único caso que este método maneja bien.
Pasó con 0,00 → 3,34 y dio confianza falsa. Un test controlado cuyas condiciones no
se parecen al problema real no valida nada: valida el test.

FOCO — falló antes, y también por medir el cuadro y no la cámara. El clip peor
puntuado del informe (FX3_3039, 3% de su propio pico) es un TILT AL CIELO: foco
perfecto, sin detalle que medir. De 130 clips marcó 59 con "tramos blandos" y son
mayormente eso. Se probaron tres métricas: la cruda separa el desenfoque artificial
9,4x pero depende del contenido; la normalizada por contraste es robusta al
contenido y también al desenfoque (1,12x, inútil); la autorreferencial falló al
revés, puntuando MÁS ALTO lo desenfocado.

El foco no es una propiedad óptica del cuadro sino un juicio sobre la intención: un
plano con poca profundidad de campo y el fondo blando está BIEN. Los dos casos dan
el mismo número porque la métrica no sabe qué es el sujeto.

REHABILITACIÓN PARCIAL, del 2026-08-20. El usuario señaló un clip como fuera de foco
--FX3_3085, "arranca en foco y se va en el medio del plano"-- y dentro de la ventana
que él vio (6,1 a 10,1s) la serie DENTRO DEL CLIP marca la caída que describe:
96% → 82% → 61% → 55%. La señal existe.

Lo que la arruina es la variación de CONTENIDO, no el método: el mínimo absoluto del
clip está a los 4s con 28%, y ese cuadro es una pared gris sin detalle, no
desenfoque. El momento genuinamente blando marca 55%, en el medio del rango.

Así que el arreglo sigue siendo el que se describió y NO se construyó: **exigir que
el contenido no haya cambiado antes de comparar nitidez** --marcar un tramo blando
sólo si la nitidez baja MIENTRAS la diferencia entre cuadros se mantiene chica--. Sin
esa guarda, una pared lisa puntúa igual que un desenfoque.

Y el corolario para el temblor: entre cuadros CONSECUTIVOS el contenido es casi
idéntico, así que a esa escala de tiempo el problema desaparece solo. Una caída de
nitidez de uno a tres cuadros con el contenido igual sólo puede ser MOTION BLUR, que
es la firma directa de un golpe. Es la hipótesis que explicaría por qué la métrica
simple de diferencia entre cuadros le gana al seguimiento de rasgos: el blur rompe a
un tracker justo en el evento que importa, y una diferencia de píxeles lo ve.

LO QUE SÍ QUEDÓ ÚTIL de todo esto, y por eso el archivo no se borra:

  - El flag `rotation=90` está MAL en 6 de los 130 clips de un institucional (FX3_3066,
    3121, 3124, 3125, 3127, 3129). El material es horizontal. Cualquier
    herramienta que respete el flag los toma verticales, así que va
    `-noautorotate` en la entrada y `-display_rotation 0` si además se reencoda:
    `-noautorotate` evita APLICAR la rotación pero la CONSERVA en los metadatos de
    salida, y el concat de ffmpeg después le impone esa geometría a todo el resto.
  - Al leer cuadros crudos, el alto se PIDE a ffprobe, no se adivina buscando un
    divisor del tamaño del buffer: adivinándolo se leen las filas corridas y un
    clip FIJO mide 272 px de paneo.
  - El Lucas-Kanade de un solo nivel es ciego por debajo de ~0,2 px y satura a los
    ~8 px. Para movimiento entre cuadros separados hay que hacerlo piramidal.

Lo que haría falta para medir temblor de verdad, en orden de rendimiento:

  1. Recorrer el clip ENTERO y quedarse con el máximo. Es el arreglo barato y
     ataca la falla que de verdad importa.
  2. Usar los VECTORES DE MOVIMIENTO DEL CÓDEC en vez de estimar. H.264 y HEVC ya
     los calcularon al comprimir y están en el archivo; ffmpeg los exporta con
     `-flags2 +export_mvs`. Da movimiento por cuadro en todo el clip casi gratis,
     sin decodificar y estimar a mano.
  3. Separar cámara de sujeto (RANSAC sobre rasgos del fondo) para dejar de contar
     el agua.

Y un VLM NO ayuda acá: ve cuadros sueltos, y el temblor es una relación entre
consecutivos a 25-50 fps. Con tres o cinco cuadros por clip tiene el mismo problema
de muestreo, y encima sin precisión numérica sobre el desplazamiento.

---- documentación del intento, a partir de acá ----

FOCO: varianza del Laplaciano. Es la medida estándar de nitidez — un cuadro
enfocado tiene bordes duros, o sea mucha energía en frecuencias altas.

Dos cuidados que cambian el resultado:

1. **Se mide en PÍXELES NATIVOS.** Escalar el cuadro destruye exactamente las
   frecuencias que distinguen nítido de blando.

2. **Y se mide DONDE HAY DETALLE, no en el centro geométrico.** La primera versión
   usaba una ventana central de 720x720 y con eso un `gblur sigma=4` --desenfoque
   brutal-- sólo movía el número 1,7x. La causa no era la métrica: en un interior el
   centro cae sobre una pared lisa, la varianza daba 11,6 donde un 4K con detalle da
   cientos, y ese 1,7x era el suavizado del RUIDO. Tomando una banda del ancho
   completo, partiéndola en ventanas y usando el percentil 90, la misma prueba
   separa **9,4x**. Un cuadro está enfocado si lo más detallado que tiene está
   nítido.

3. **Se normaliza por el contraste.** La varianza del Laplaciano crece con el
   contraste al cuadrado, así que una pared lisa enfocada puntúa más bajo que un
   arbusto desenfocado. Se informan la cruda y la normalizada, porque ninguna es
   perfecta: comparar entre clips de contenido muy distinto sigue siendo débil, y eso
   hay que decirlo en vez de fingir un ranking absoluto.

VALIDACIÓN CONTROLADA, que es lo que hace confiable a esto: se tomó un clip, se le
aplicó desenfoque y temblor A PROPÓSITO y se midieron las tres versiones. Foco
0,0536 → 0,0066 con el blur (8,1x). Temblor 0,00 → 3,34 por mil con el shake. Sin
esa prueba, los ceros de temblor del material real eran indistinguibles de una
métrica muerta.

CALIBRACIÓN DEL TEMBLOR, medida inyectando amplitudes decrecientes sobre un cuadro
FIJO --así todo el movimiento es el que se puso:

    inyectado    medido a escala 480    reportado
      10 px           2,86 px             5,89
       5 px           1,43 px             3,79
       2 px           0,57 px             1,54
       1 px           0,29 px             0,48
     0,5 px           0,14 px             0,00   ← PISO

**El piso está en ~0,2 px a escala de medición.** Por encima, la respuesta es
monótona y casi proporcional; se comprime arriba por el suavizado. Un temblor de 1 px
a escala HD SÍ se detecta.

Eso importa porque el material de un institucional midió entre 0,00 y 0,13, y sin el piso ese
cero era ambiguo entre "está estable" y "no lo veo". Con la calibración se puede
afirmar lo primero: tiene menos de 1 px de temblor a escala HD.

Y el límite que explica el piso: el estimador es Lucas-Kanade de UN SOLO NIVEL, así
que es ciego a lo sub-píxel --un paneo de 0,46 px por cuadro mide 0,000-- y satura
con desplazamientos grandes, ~8 px. Lo primero fija el piso; lo segundo no molesta
porque siempre se comparan cuadros CONSECUTIVOS. Si algún día hace falta medir
movimiento entre cuadros separados, hay que hacerlo piramidal.

TEMBLOR: se separa el movimiento intencional del jitter.

El movimiento de cámara ya estaba medido en `broll.json`, pero a 2 muestras por
segundo — y ahí el temblor no existe: vive cuadro a cuadro. Acá se miden ventanas
cortas a FPS NATIVOS, se estima el desplazamiento entre consecutivos con
Lucas-Kanade, se le resta la tendencia suave (que es el movimiento deliberado) y lo
que queda es temblor. Se informa en por mil del ancho del cuadro, para que un 4K y
un HD sean comparables.

OJO CON LOS SIGNOS del jacobiano si se toca la estimación: ∂px/∂tx = -1/Z, con
MENOS. Con el signo al revés el ajuste camina para el lado contrario y el residuo no
baja nunca — ya costó una vuelta entera.

Va en Python y no en Node como el resto de `herramientas/` porque necesita numpy:
ffmpeg tiene filtro `convolution`, pero satura los negativos del Laplaciano y eso
falsea la varianza justo en los bordes fuertes, que son los que importan.

Uso:
  python3 nitidez.py --lista <broll.json> [--salida <archivo.json>] [--limite N]
  python3 nitidez.py --clip <archivo> ...
"""
import subprocess, sys, json, os, argparse
import numpy as np

BANDA_FOCO = 480        # alto de la banda central, en píxeles NATIVOS
FPS_FOCO = 1            # el foco cambia despacio: alcanza
ANCHO_TEMBLOR = 480     # el movimiento es señal de escala grande, acá sí se escala
VENTANAS_TEMBLOR = 3
DUR_VENTANA = 1.5


def ficha(f):
    """Dimensiones, fps y duración, con las dimensiones TAL COMO ESTÁN GUARDADAS.

    LA ROTACIÓN DE LOS METADATOS SE IGNORA, y por eso todas las llamadas a ffmpeg
    llevan `-noautorotate`.

    6 de los 130 clips de un institucional traen `rotation=90` y el flag está MAL: el material
    es horizontal y ese flag lo hace mostrar vertical. Confirmado por el usuario, que
    lo filmó, y por la geometría: sin autorotate el cuadro sale 16:9 y con autorotate
    9:16.

    Importa porque ffmpeg aplica la rotación por defecto en el filtro, así que sin
    `-noautorotate` el cuadro que entra a `crop` no tiene las dimensiones que informa
    `stream=width,height`: el crop de la banda se recorta en silencio y el scale del
    temblor DEFORMA la imagen, con lo cual los desplazamientos horizontal y vertical
    se escalan distinto. Lo encontró el usuario mirando un reel deformado, y uno de
    esos 6 clips era justo el que medía MÁS temblor de los 130.
    """
    try:
        s = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height,r_frame_rate",
                            "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", f],
                           capture_output=True, text=True, check=True).stdout.split()
        w, h = int(s[0]), int(s[1])
        num, den = s[2].split("/")
        fps = float(num) / float(den)
        dur = float(s[3])
        return w, h, fps, dur
    except Exception:
        return None


def crudo(args, ancho, alto, canales=1):
    out = subprocess.run(args, capture_output=True).stdout
    n = len(out) // (ancho * alto * canales)
    if n == 0:
        return None
    return np.frombuffer(out, dtype=np.uint8)[:n * ancho * alto].reshape(n, alto, ancho).astype(np.float64)


def foco(f, w, h, dur):
    """Nitidez POR VENTANAS, y se toma el percentil alto.

    La primera versión medía UNA ventana central de 720x720 a resolución nativa, y
    con eso el desenfoque artificial de `gblur sigma=4` --brutal-- sólo movía el
    número 1,7x. La causa no era la métrica: en un interior el centro geométrico cae
    sobre una PARED LISA. La varianza del Laplaciano daba 11,6 cuando un 4K con
    detalle real da cientos, así que se estaba midiendo ruido y ese 1,7x era el
    suavizado del ruido, no la pérdida de foco.

    Un cuadro está enfocado si lo MÁS DETALLADO que tiene está nítido, así que se
    toma una banda del ancho completo, se la parte en ventanas y se usa el percentil
    90 entre ventanas. Donde no hay detalle no se opina.
    """
    banda = min(BANDA_FOCO, h)
    y = (h - banda) // 2
    V = crudo(["ffmpeg", "-v", "error", "-noautorotate", "-i", f,
               "-vf", f"fps={FPS_FOCO},crop={w}:{banda}:0:{y},format=gray",
               "-f", "rawvideo", "-"], w, banda)
    if V is None:
        return None
    # LA MÉTRICA ES LA VARIANZA DEL LAPLACIANO CRUDA, por ventanas, percentil 90.
    #
    # Se probaron tres y ésta es la única que separa. Vale dejar las tres escritas,
    # porque las dos que fallaron parecían mejores en el papel:
    #
    #   1. CRUDA (ésta): separa el gblur sigma=4 de la prueba controlada 9,4x. Su
    #      debilidad es que depende del contenido, así que un arbusto blando puntúa
    #      más que una pared enfocada.
    #   2. Dividida por el contraste de la misma ventana: robusta al contenido y
    #      TAMBIÉN al desenfoque --1,12x--, o sea inútil: al desenfocar bajan
    #      numerador y denominador juntos.
    #   3. Autorreferencial, 1 - varLap(blur(I))/varLap(I): falló AL REVÉS, la versión
    #      desenfocada puntuaba MÁS ALTO (0,976 contra 0,969) y todo se apelotonaba en
    #      0,97, porque una caja 3x3 aplasta el Laplaciano en los dos casos y satura.
    #
    # Por eso el número NO es un ranking global de calidad. Sirve para comparar el
    # MISMO contenido: tramos dentro de un clip, y tomas alternativas del mismo plano.
    # Cruzar un interior con un drone no dice nada, y el verbo lo declara.
    def _lap(A):
        return (A[:, :-2, 1:-1] + A[:, 2:, 1:-1] + A[:, 1:-1, :-2] + A[:, 1:-1, 2:]
                - 4.0 * A[:, 1:-1, 1:-1])

    lap = _lap(V)
    lado = max(64, banda // 2)
    nx = max(1, lap.shape[2] // lado)
    ny = max(1, lap.shape[1] // lado)
    varLap = np.empty(len(V))
    for k in range(len(V)):
        vs = []
        for iy in range(ny):
            for ix in range(nx):
                a = lap[k, iy * lado:(iy + 1) * lado, ix * lado:(ix + 1) * lado]
                if a.size >= 1024:
                    vs.append(a.var())
        varLap[k] = np.percentile(vs, 90) if vs else 0.0
    # Escala relativa al propio clip: dónde están los tramos blandos DE ESTE clip.
    tope = np.percentile(varLap, 90) if len(varLap) else 1.0
    norm = varLap / max(tope, 1e-6)
    return {
        "cuadros": int(len(V)),
        "banda": int(banda),
        "crudo_medio": float(np.mean(varLap)),
        "crudo_p10": float(np.percentile(varLap, 10)),
        "crudo_p90": float(np.percentile(varLap, 90)),
        "rel_medio": float(np.mean(norm)),
        "rel_p10": float(np.percentile(norm, 10)),
        "rel_p90": float(np.percentile(norm, 90)),
        "serie_rel": [round(float(x), 4) for x in norm],
        "serie_crudo": [round(float(x), 1) for x in varLap],
    }


def _muestrear(img, px, py):
    x0 = np.floor(px).astype(int); y0 = np.floor(py).astype(int)
    H, W = img.shape
    xc = np.clip(x0, 0, W - 2); yc = np.clip(y0, 0, H - 2)
    fx = px - xc; fy = py - yc
    a = img[yc, xc]; b = img[yc, xc + 1]; c = img[yc + 1, xc]; d = img[yc + 1, xc + 1]
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy


def _desplazamiento(A, B, iteraciones=20):
    """Traslación entre dos cuadros, Lucas-Kanade con repesado robusto.

    Sólo traslación: para temblor no hace falta escala, y con menos parámetros el
    ajuste es más estable en ventanas cortas. El repesado le baja el voto a lo que
    el modelo no explica —hojas moviéndose, gente— en vez de dejarlo arrastrar.
    """
    H, W = A.shape
    Y, X = np.mgrid[0:H, 0:W].astype(float)
    M = (np.abs(X - (W - 1) / 2) < W * 0.40) & (np.abs(Y - (H - 1) / 2) < H * 0.40)
    tx = ty = 0.0
    for _ in range(iteraciones):
        Aw = _muestrear(A, X - tx, Y - ty)
        gy, gx = np.gradient(Aw)
        r = (B - Aw)[M]
        mad = np.median(np.abs(r - np.median(r))) * 1.4826 + 1e-9
        u = r / (4.685 * mad)
        w = np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0.0)
        sw = np.sqrt(w)
        # SIGNO NEGATIVO: ∂px/∂tx = -1
        Am = np.stack([-gx[M], -gy[M]], axis=1) * sw[:, None]
        sol, *_ = np.linalg.lstsq(Am, r * sw, rcond=None)
        tx += sol[0]; ty += sol[1]
        if abs(sol[0]) < 1e-4 and abs(sol[1]) < 1e-4:
            break
    return tx, ty


def temblor(f, w, h, fps, dur):
    alto = int(round(ANCHO_TEMBLOR * h / w / 2)) * 2
    inicios = [dur * (i + 1) / (VENTANAS_TEMBLOR + 1) - DUR_VENTANA / 2
               for i in range(VENTANAS_TEMBLOR)]
    residuos = []
    detalle = []
    for t0 in inicios:
        t0 = max(0.0, min(t0, max(0.0, dur - DUR_VENTANA)))
        V = crudo(["ffmpeg", "-v", "error", "-noautorotate", "-ss", f"{t0:.2f}", "-t", f"{DUR_VENTANA}",
                   "-i", f, "-vf", f"scale={ANCHO_TEMBLOR}:{alto},format=gray",
                   "-f", "rawvideo", "-"], ANCHO_TEMBLOR, alto)
        if V is None or len(V) < 8:
            continue
        d = np.array([_desplazamiento(V[k], V[k + 1]) for k in range(len(V) - 1)])
        # La tendencia suave es el movimiento DELIBERADO; el residuo es temblor.
        k = np.ones(5) / 5.0
        suave = np.stack([np.convolve(d[:, 0], k, "same") / np.convolve(np.ones(len(d)), k, "same"),
                          np.convolve(d[:, 1], k, "same") / np.convolve(np.ones(len(d)), k, "same")], axis=1)
        res = d - suave
        rms = float(np.sqrt(np.mean(res ** 2)))
        residuos.append(rms)
        detalle.append({"t": round(t0, 2), "rms_px": round(rms, 3),
                        "mov_medio_px": round(float(np.mean(np.abs(d))), 3)})
    if not residuos:
        return None
    # En POR MIL del ancho medido, para que 4K y HD sean comparables.
    return {
        "rms_px": round(float(np.mean(residuos)), 3),
        "por_mil_ancho": round(float(np.mean(residuos)) / ANCHO_TEMBLOR * 1000, 2),
        "ventanas": detalle,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lista")
    ap.add_argument("--clip", nargs="*", default=[])
    ap.add_argument("--salida")
    ap.add_argument("--limite", type=int)
    a = ap.parse_args()

    objetivos = []
    if a.lista:
        for c in json.load(open(a.lista)):
            objetivos.append({"nombre": c.get("nombre"), "grupo": c.get("grupo"), "ruta": c.get("ruta")})
    for f in a.clip:
        objetivos.append({"nombre": os.path.basename(f), "grupo": None, "ruta": f})
    if a.limite:
        objetivos = objetivos[:a.limite]
    if not objetivos:
        print("Nada que medir. Pasá --lista <broll.json> o --clip <archivo>.", file=sys.stderr)
        sys.exit(1)

    print(f"{len(objetivos)} clip(s)\n")
    print(f"{'clip':34s} {'grupo':12s} {'nitidez':>9s} {'peor tramo':>11s} {'temblor':>9s}")
    salida = []
    for i, o in enumerate(objetivos):
        if not o["ruta"] or not os.path.exists(o["ruta"]):
            print(f"  {str(o['nombre'])[:33]:34s} {'—':12s}   NO ESTÁ EL ARCHIVO")
            continue
        info = ficha(o["ruta"])
        if not info:
            print(f"  {str(o['nombre'])[:33]:34s} {'—':12s}   ffprobe FALLÓ")
            continue
        w, h, fps, dur = info
        fo = foco(o["ruta"], w, h, dur)
        te = temblor(o["ruta"], w, h, fps, dur)
        fila = {"nombre": o["nombre"], "grupo": o["grupo"], "ruta": o["ruta"],
                "w": w, "h": h, "fps": round(fps, 3), "dur": round(dur, 2),
                "foco": fo, "temblor": te}
        salida.append(fila)
        print(f"  {str(o['nombre'])[:33]:34s} {str(o['grupo'] or '')[:11]:12s} "
              f"{(fo['crudo_medio'] if fo else float('nan')):9.1f} "
              f"{(fo['rel_p10'] if fo else float('nan')):11.2f} "
              f"{(te['por_mil_ancho'] if te else float('nan')):9.2f}", flush=True)

    if a.salida:
        json.dump(salida, open(a.salida, "w"), indent=1)
        print(f"\nescrito: {a.salida}")


if __name__ == "__main__":
    main()
