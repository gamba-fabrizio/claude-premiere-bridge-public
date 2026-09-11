#!/usr/bin/env python3
"""Sincroniza clips con playback contra el tema, por correlación de audio.

Es lo que hacen PluralEyes y el Synchronize de Premiere. Se hace afuera por dos
razones: da el offset como NÚMERO —así los clips se pueden colocar en el timeline por
el bridge en vez de sincronizarlos de a uno— y da una MEDIDA DE CONFIANZA, que el de
Premiere no da y que es lo único que distingue "sincronizó" de "puso un número".

## Por qué envolvente y no la onda cruda

Un micrófono de cámara en una sala no se parece al máster de estudio: distinta
respuesta de frecuencia, reverb, compresión, ruido. Correlacionar las MUESTRAS falla
por eso. Lo que sobrevive a la sala son los TRANSITORIOS —la batería— y esos dominan
la envolvente de energía.

Así que se correlacionan envolventes de energía en escala log, con la media quitada:

  - log comprime la dinámica, así que un clip grabado 20 dB más bajo correlaciona
    igual que uno fuerte;
  - quitarle la media elimina la diferencia de nivel general, que si no domina la
    correlación y tapa la coincidencia real.

## Por qué NO se lee el clip entero

Con 60 segundos de un plano alcanza para ubicarlo en un tema de 4:29. Leer 60s en vez
de 306 de un archivo de 7,6 GB por USB es cuatro veces menos I/O, y el I/O es todo el
costo. El segmento se toma DESPUÉS del arranque, porque el principio suele tener la
claqueta, la charla previa o silencio.

## La confianza es el pico contra el SEGUNDO mejor

No el valor absoluto de la correlación: ese depende del material y no dice nada. Lo
que importa es cuánto se destaca el mejor candidato del siguiente, mirado FUERA de su
propio entorno. Un pico que sobresale 3x es inequívoco; uno que empata con otro
significa que el tema tiene dos partes parecidas y el offset puede estar en la
equivocada — y eso hay que decirlo, no promediarlo.

## VALIDACIÓN, y vino de un hecho físico

La mejor prueba de que esto funciona no la armó nadie: la señaló el usuario al pasar.
`FX3_3561` y `FX3_3562` son UN registro que la cámara partió en dos archivos al
cambiar de tarjeta. Si son contiguos, sus offsets tienen que diferir exactamente en la
duración del primero.

    FX3_3561   offset  -3,0900 s   dura 253,4400 s   → termina en 250,3500
    FX3_3562   offset 250,3570 s
    DIFERENCIA: 7,0 ms = 0,175 frames a 25 fps

Y los metadatos confirman la contigüidad: creados a las 20:10:33 y 20:14:46, o sea 253
segundos de diferencia, que es la duración del primero.

Eso es verdad de AFUERA: los dos offsets se midieron por separado, con contenido de
audio distinto y en corridas independientes, y coinciden en 7 ms —dentro de la
resolución del propio método—. Ninguna verificación interna prueba tanto, porque acá
el patrón de referencia lo puso la cámara, no el algoritmo.

Si algún día se toca la fórmula, ESTA es la prueba que hay que volver a correr:
buscar dos archivos partidos por la cámara y comprobar que la diferencia siga siendo
menor a un frame.

## PENDIENTE: los archivos partidos se deben ENCADENAR, no medir por separado

Los 7 ms de arriba son buenos como validación y MALOS como resultado. Puestos en el
timeline, `FX3_3561` termina en 250,350 --frame 6258,75, entre frames-- y `FX3_3562`
entró en 250,360, porque `insertar` se pega a la grilla. Queda un hueco de un cuarto
de frame en la juntura de dos archivos que la cámara grabó SIN CORTAR. El usuario lo
vio en el timeline antes de que yo lo dedujera de mi propia tabla.

Se arregló a mano con `editar desde 250.350` --que no se pega al frame-- y el hueco
quedó en 0,0 ms. Pero la herramienta debería hacerlo sola: detectar los archivos
contiguos por hora de creación más duración, medir SÓLO el primero, y encadenar los
siguientes a su fin. La continuidad física es un dato más fuerte que dos
correlaciones independientes.

## Y OJO para el armado: 7 de 13 clips TERMINAN entre frames

Por las duraciones del material, no por la sincro. Con cada clip solo en su pista no
molesta, pero al poner cortes en una sola pista eso produce los huecos de un frame que
ya costaron una tanda entera en otro proyecto (ver "Los huecos de un frame eran cortes
ENTRE frames" en CLAUDE.md). Los puntos de corte se cuantizan con aritmética entera de
ticks ANTES de tocar nada.

Va en Python porque necesita FFT y numpy, como `nitidez.py`.

Uso:
  python3 sincro.py --tema <archivo> --clips <carpeta o archivos...>
                    [--salida sincro.json] [--segundos 60] [--desde-frac 0.25]
"""
import subprocess, sys, os, json, argparse
import numpy as np

SR = 8000          # el audio se decodifica mono a 8 kHz: alcanza para transitorios
HOP = 40           # 5 ms por muestra de envolvente → 200 Hz, un cuarto de frame a 50fps
VIDEO = (".mp4", ".mov", ".m4v", ".mxf", ".avi", ".mts")


def dur(f):
    try:
        return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries",
            "format=duration", "-of", "default=nw=1:nk=1", f],
            capture_output=True, text=True, check=True).stdout.strip())
    except Exception:
        return None


def fps(f):
    try:
        s = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1", f],
            capture_output=True, text=True, check=True).stdout.strip()
        n, d = s.split("/")
        return float(n) / float(d)
    except Exception:
        return None


def envolvente(f, desde=None, cuanto=None):
    """Envolvente de energía en log, media quitada. Devuelve None si no hay audio."""
    cmd = ["ffmpeg", "-v", "error"]
    if desde is not None:
        cmd += ["-ss", f"{desde:.3f}"]
    if cuanto is not None:
        cmd += ["-t", f"{cuanto:.3f}"]
    cmd += ["-i", f, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
    crudo = subprocess.run(cmd, capture_output=True).stdout
    if len(crudo) < SR:                      # menos de un segundo de audio
        return None
    x = np.frombuffer(crudo, dtype="<i2").astype(np.float64) / 32768.0
    n = len(x) // HOP
    if n < 20:
        return None
    e = (x[:n * HOP].reshape(n, HOP) ** 2).mean(axis=1)
    # log para comprimir la dinámica; el piso evita -inf en los silencios
    piso = max(e.max() * 1e-6, 1e-12)
    le = np.log(np.maximum(e, piso))
    le -= le.mean()
    return le


def correlacionar(a, b):
    """Correlación cruzada normalizada POR DESPLAZAMIENTO. Devuelve (lag, valor, serie).

    LA NORMALIZACIÓN VA POR VENTANA, no global. La primera versión dividía por la
    energía COMPLETA de `a` cuando en cada desplazamiento sólo se solapa el largo de
    `b`: eso achicaba todos los valores --daban 0,07-- y peor, SESGABA el resultado
    hacia donde `a` es más fuerte. Con un tema de 269s y segmentos de 60s, los trece
    clips cayeron agrupados en el final del tema, donde está el clímax. Números
    implausibles: planos de 20 segundos "arrancando" a los 266s.

    Acá se hace ZNCC de verdad: en cada desplazamiento se normaliza por la desviación
    estándar de la ventana de `a` que realmente se solapa. `b` ya viene con media
    cero, así que el término cruzado se anula y alcanza con las sumas acumuladas.

    Sólo se consideran los desplazamientos con solape COMPLETO: un solape parcial
    correlaciona contra menos datos y da valores altos por casualidad.
    """
    m = len(b)
    if m > len(a):
        return None, 0.0, np.array([0.0])
    n = 1
    while n < len(a) + m:
        n *= 2
    A = np.fft.rfft(a, n)
    B = np.fft.rfft(b[::-1], n)
    cruz = np.fft.irfft(A * B, n)[m - 1:len(a)]      # sólo solape completo

    # sumas acumuladas para media y desvío de cada ventana de a
    ca = np.concatenate([[0.0], np.cumsum(a)])
    ca2 = np.concatenate([[0.0], np.cumsum(a ** 2)])
    k = np.arange(len(cruz))
    suma = ca[k + m] - ca[k]
    suma2 = ca2[k + m] - ca2[k]
    var = np.maximum(suma2 - suma * suma / m, 0.0)
    den = np.sqrt(var) * np.sqrt((b ** 2).sum())
    c = np.where(den > 0, cruz / np.maximum(den, 1e-12), 0.0)

    i = int(np.argmax(c))
    return i, float(c[i]), c


def confianza(c, i, ancho):
    """Cuánto se destaca el pico del SEGUNDO mejor, mirado fuera de su entorno.

    El valor absoluto de la correlación no sirve como confianza: depende del
    material. Lo que dice si acertó es si hay UN candidato o varios empatados.
    """
    pico = c[i]
    fuera = c.copy()
    a = max(0, i - ancho); b = min(len(c), i + ancho + 1)
    fuera[a:b] = -np.inf
    segundo = float(np.max(fuera)) if np.isfinite(np.max(fuera)) else 0.0
    if segundo <= 0:
        return float("inf"), segundo
    return float(pico / segundo), segundo


def _un_segmento(tema_env, f, desde, cuanto):
    env = envolvente(f, desde, cuanto)
    if env is None:
        return None
    lag, valor, c = correlacionar(tema_env, env)
    if lag is None:
        return None
    z = (c[lag] - c.mean()) / (c.std() or 1e-12)
    ratio, segundo = confianza(c, lag, int(0.5 * SR / HOP))
    sub = afinar_pico(c, lag, HOP / SR)      # corrección sub-bin, en segundos
    return {"desde": desde, "cuanto": cuanto, "subBinMs": round(sub * 1000, 2),
            "inicio": lag * HOP / SR + sub - desde,
            "corr": float(valor), "z": float(z),
            "vsSegundo": float(ratio) if np.isfinite(ratio) else None}


def sincronizar(tema_env, f, segundos, desde_frac):
    """DOS SEGMENTOS distintos del clip, y la confianza es que COINCIDAN.

    El "pico contra el segundo mejor" no sirve en música: los estribillos se repiten,
    así que un segmento correlaciona bien en varios lugares y el segundo candidato
    siempre está cerca. Medido acá: un clip con correlación 0,884 --altísima-- daba un
    ratio de 1,14 y quedaba marcado dudoso.

    Lo que sí prueba que el offset es correcto es que DOS ventanas distintas del mismo
    clip, correlacionadas por separado, apunten al mismo lugar del tema. Si el pico
    fuera casualidad, dos segmentos distintos caerían en lugares distintos. Es la
    regla de medir dos casos, aplicada.

    Se informa además el z-score del pico contra la distribución completa, que en
    música dice más que el segundo mejor: un estribillo repetido da dos picos altos,
    pero el grueso de la serie sigue siendo bajo.
    """
    d = dur(f)
    if d is None:
        return {"error": "ffprobe no pudo leer la duración"}
    f_ps = fps(f)
    cuanto = min(segundos, d)

    """Dos ventanas, SIEMPRE. En un clip largo se toman separadas; en uno corto se
    PARTE EN MITADES en vez de renunciar al cruce. Una mitad de 10s es menos
    distintiva que 60s, pero dos mitades que apuntan al mismo lugar siguen siendo
    evidencia, y sin eso los clips cortos quedaban sin forma de verificarse."""
    # LA ESTIMACIÓN SALE DE LA VENTANA MÁS LARGA; las cortas son sólo CONTROL.
    #
    # La versión anterior usaba las mitades como estimación en los clips cortos, y una
    # mitad de 21s es menos distintiva que el clip entero de 42s: FX3_3552 cambió de
    # respuesta entre corridas por eso. Cuanto más largo el segmento, menos lugares
    # del tema pueden coincidir por casualidad, así que la respuesta se toma de ahí y
    # las ventanas chicas sólo dicen si concuerdan.
    if d <= segundos * 1.5:
        principal = (0.0, d)                       # el clip entero
        control = [(0.0, d / 2), (d / 2, d / 2)]   # sus dos mitades
    else:
        principal = (max(0.0, min(d * desde_frac, d - cuanto)), cuanto)
        otro = max(0.0, min(d * (1 - desde_frac) - cuanto * 0.5, d - cuanto))
        control = [(otro, cuanto)] if abs(otro - principal[0]) >= 1.0 else []

    mejor = _un_segmento(tema_env, f, principal[0], principal[1])
    if mejor is None:
        return {"error": "sin audio usable", "dur": d}
    tomas = [mejor] + [t for t in (_un_segmento(tema_env, f, p, c) for p, c in control) if t]
    inicio = mejor["inicio"]
    if len(tomas) > 1:
        desacuerdo = max(abs(t["inicio"] - inicio) for t in tomas)
        # TOLERANCIA EN FRAMES, no en centésimas arbitrarias. La envolvente tiene 5 ms
        # de resolución, así que dos estimaciones independientes pueden separarse una
        # o dos muestras sin que eso signifique nada. La primera versión exigía 10 ms
        # --medio frame a 50fps-- y marcaba "NO COINCIDEN" desacuerdos de 0,01s que son
        # la MISMA respuesta dentro de la resolución del método.
        frames = desacuerdo * f_ps if f_ps else None
        coinciden = (frames is not None and frames <= 1.0)
    else:
        desacuerdo = None; frames = None; coinciden = None

    return {
        "dur": round(d, 3),
        "fps": round(f_ps, 3) if f_ps else None,
        "inicioEnTema": round(inicio, 3),
        "inicioEnFrames": int(round(inicio * f_ps)) if f_ps else None,
        "correlacion": round(mejor["corr"], 4),
        "z": round(mejor["z"], 1),
        "vsSegundo": round(mejor["vsSegundo"], 2) if mejor["vsSegundo"] else None,
        "segmentos": len(tomas),
        "ventanaPrincipal": round(principal[1], 2),
        "desacuerdoSeg": round(desacuerdo, 4) if desacuerdo is not None else None,
        "desacuerdoFrames": round(frames, 2) if frames is not None else None,
        "coinciden": coinciden,
        "tomas": [{k: round(v, 4) if isinstance(v, float) else v for k, v in t.items()} for t in tomas],
    }


def afinar_pico(c, i, paso):
    """Interpolación parabólica sobre el pico de la correlación: precisión sub-bin
    sin necesitar una grilla más fina.

    SE PROBÓ ANTES con envolvente de 1 ms y NO SIRVE: a esa escala cada bin son 48
    muestras de energía, y los transitorios que sobreviven a una sala tienen ataques
    de varios milisegundos. Las correlaciones cayeron a 0,003-0,70 y algunos offsets
    se movieron 19 y 31 ms, más de medio frame. No era afinar, era ruido.

    Acá se ajusta una parábola a los tres puntos alrededor del pico ya encontrado con
    la envolvente gruesa, que está bien estimado. Para un pico suave eso da del orden
    de un décimo de bin: con bins de 5 ms, medio milisegundo.

    Y trae su propia validación: el vértice NO PUEDE caer a más de medio bin del pico
    entero. Si cae, la parábola no describe el pico y se devuelve el entero.
    """
    if i <= 0 or i >= len(c) - 1:
        return 0.0
    y0, y1, y2 = float(c[i - 1]), float(c[i]), float(c[i + 1])
    den = y0 - 2 * y1 + y2
    if den == 0:
        return 0.0
    delta = 0.5 * (y0 - y2) / den
    if abs(delta) > 0.5:          # el vértice se fue del bin: no describe el pico
        return 0.0
    return delta * paso


def segmentar(tema_env, f, dur_clip, ventana=None, paso=None, tol=0.15, minimo=6.0,
              umbral_z=0.0, descartes=None):
    """Un clip puede tener VARIAS pasadas del tema, y entonces no tiene UN offset.

    Lo descubrió el usuario mirando FX3_3559: el medio y el final estaban
    sincronizados y el comienzo no. La cámara siguió grabando mientras se reiniciaba
    el playback, así que el archivo contiene dos tomas con offsets distintos --medido:
    +0,71s del segundo 0 al 67, y -42,37s del 87 al 305, con veinte segundos muertos
    en el medio.

    Un solo offset por clip es incorrecto para esos casos, y AMPLIAR la muestra lo
    empeora: promediaría entre dos pasadas y daría un valor que no corresponde a
    ninguna.

    Esto también corrige una interpretación equivocada. Los clips que quedaron
    marcados "ambiguos" --sus dos ventanas de control apuntaban a lugares
    distintísimos-- NO eran ambiguos por la auto-similitud de la música: tenían dos
    pasadas y cada ventana cayó en una. El desacuerdo era información, no ruido.

    Se desliza una ventana, se agrupan las corridas de offset estable, y las ventanas
    que no pertenecen a ninguna corrida se descartan: son las que cruzan un límite o
    caen en un tramo sin música.
    """
    # VENTANA ADAPTADA AL LARGO. Con una ventana fija de 20s, un clip de 20,2s entra
    # UNA sola vez y la segmentación no puede funcionar: hay que poder comparar
    # ventanas entre sí. El usuario lo vio en FX3_3551 y FX3_3552.
    if ventana is None:
        ventana = min(20.0, max(6.0, dur_clip / 3.0))
    if paso is None:
        paso = ventana / 2.0

    lecturas = []
    t0 = 0.0
    while t0 + ventana <= dur_clip + 0.01:
        r = _un_segmento(tema_env, f, t0, ventana)
        if r is not None:
            lecturas.append((t0, r["inicio"], r["corr"], r["z"]))
        t0 += paso
    if not lecturas:
        return []

    # Corridas de offset estable: al menos dos ventanas consecutivas de acuerdo.
    grupos = []
    for (ini, off, corr, z) in lecturas:
        if grupos and abs(off - grupos[-1]["off"]) <= tol:
            g = grupos[-1]
            g["hasta"] = ini + ventana
            g["offs"].append(off)
            g["zs"].append(z)
            g["n"] += 1
            g["off"] = float(np.median(g["offs"]))
            g["z"] = float(np.median(g["zs"]))
        else:
            grupos.append({"desde": ini, "hasta": ini + ventana, "off": off,
                           "offs": [off], "zs": [z], "z": float(z), "n": 1})

    # TRES ventanas mínimo, no dos: en la zona muerta entre pasadas, dos ventanas
    # consecutivas pueden coincidir en un offset falso por casualidad. Medido en
    # FX3_3559: apareció un tramo espurio de 2 ventanas en +35,9s.
    # En un clip corto no CABEN tres ventanas: FX3_3562 mide 9,6s y con ventana de 6
    # entran dos. Ahí se exige lo que quepa, con el mínimo en dos.
    caben = max(2, min(3, int((dur_clip - ventana) / paso) + 1))
    sostenidos = [g for g in grupos if g["n"] >= caben and (g["hasta"] - g["desde"]) >= minimo]

    # EL FILTRO DE CALIDAD VA APAGADO A PROPÓSITO, y eso está medido.
    #
    # `_un_segmento` nunca descarta por calidad —devuelve None sólo si no pudo construir
    # la envolvente— así que parecía que un clip SIN el tema sonando podía producir un
    # tramo inventado. En este videoclip varios planos son inserts sin playback, o sea
    # que el caso no era hipotético.
    #
    # Se probó con CUATRO controles nulos: el tema al revés y el tema en bloques de 5s
    # mezclados —misma estadística de energía, ninguna alineación correcta— más ruido
    # blanco y silencio. Los cuatro dan **CERO tramos** incluso con el umbral en 0.
    #
    # O sea que el rechazo ya existía y no es un umbral de correlación: es la exigencia
    # de que TRES VENTANAS COINCIDAN dentro de `tol`. Material sin el tema no puede
    # cumplirla porque sus picos caen al azar.
    #
    # Y un umbral haría daño: los 14 tramos buenos de este proyecto tienen z de 5,5 a
    # 8,0, así que cualquier valor que sirviera para rechazar algo rechazaría material
    # correcto. Se probó con 8,0 —el default del modo simple— y volteó los 14. El error
    # fue transferir un umbral entre regímenes distintos: el modo simple usa ventanas de
    # 60s, donde el pico es mucho más agudo y el z sube por construcción.
    #
    # El z se REPORTA igual, porque distingue un tramo holgado de uno al límite. Y el
    # flag queda, apagado, para el día que aparezca un negativo que la consistencia no
    # agarre.
    buenos = []
    for g in sostenidos:
        if g["z"] >= umbral_z:
            buenos.append(g)
        elif descartes is not None:
            descartes.append({"desde": round(g["desde"], 2), "hasta": round(g["hasta"], 2),
                              "offset": round(g["off"], 3), "ventanas": g["n"],
                              "z": round(g["z"], 1)})

    # Y SE RESUELVEN LOS SOLAPES a favor del mejor sostenido. El tramo espurio de
    # FX3_3559 caía ADENTRO del tramo real de 17 ventanas: dos pasadas verdaderas no
    # pueden ocupar el mismo tiempo del clip, así que si dos se solapan, uno es falso.
    for g in buenos:
        g["offset_"] = g["off"]
    buenos.sort(key=lambda g: -g["n"])
    # PERO EL SOLAPE DE UN GRUPO CON EL SIGUIENTE ES ESTRUCTURAL, no un conflicto.
    # Un grupo termina en `ini_ultima + ventana` y el siguiente empieza en
    # `ini_ultima + paso`, asi que DOS PASADAS CONTIGUAS SE SOLAPAN SIEMPRE en
    # `ventana - paso`. Con la version vieja eso alcanzaba para descartar la corrida
    # mas chica de las dos, y sin registrarla en `descartes`.
    #
    # Simulado con este mismo codigo el 2026-09-10 (clip 300s, ventana 20, paso 10):
    # pasada 1 en 0-160 con +0,500 y pasada 2 en 150-300 con -42,000 salian como UN
    # tramo `{0, 300, +0.5}` con `descartados` VACIO. 150 s de material colocados 42 s
    # fuera de sincro, y el resumen imprimiendo el clip como "una pasada".
    #
    # Solo cuenta como conflicto un solape MAYOR que el estructural: ahi si dos
    # mediciones se estan pisando de verdad.
    estructural = (ventana - paso) + 0.01
    firmes = []
    for g in buenos:
        conflicto = None
        for h in firmes:
            solape = min(g["hasta"], h["hasta"]) - max(g["desde"], h["desde"])
            if solape > estructural:
                conflicto = h
                break
        if conflicto is None:
            firmes.append(g)
        elif descartes is not None:
            # Y SE REGISTRA. Un tramo que desaparece sin dejar rastro es peor que uno
            # mal medido: nadie lo puede ir a mirar.
            descartes.append({"desde": round(g["desde"], 2), "hasta": round(g["hasta"], 2),
                              "offset": round(g["off"], 3), "ventanas": g["n"],
                              "z": round(g["z"], 1),
                              "porque": "se solapa con el tramo de " + str(conflicto["n"]) +
                                        " ventanas en " + str(round(conflicto["desde"], 2)) + "-" +
                                        str(round(conflicto["hasta"], 2))})
    buenos = sorted(firmes, key=lambda g: g["desde"])

    # SE FUSIONAN LOS QUE COINCIDEN. El agrupado es secuencial, así que UNA ventana
    # mala en el medio --un tramo callado, un grito encima del playback-- parte una
    # pasada en dos. Medido: FX3_3558 salió como dos tramos de +0,501 y +0,519, o sea
    # 18 ms de diferencia; FX3_3560 con 23 ms y FX3_3561 con 14. Son la misma pasada.
    #
    # Dos pasadas de verdad difieren en decenas de segundos, no en milisegundos: en
    # FX3_3559 la diferencia es de 43 SEGUNDOS. Así que fusionar con la misma
    # tolerancia no puede unir dos pasadas distintas por accidente.
    fusionados = []
    for g in buenos:
        # SOLO CON EL INMEDIATAMENTE ANTERIOR, no con cualquiera de la lista.
        # Buscar en TODOS permitia fusionar dos corridas del mismo offset con una
        # pasada DISTINTA en el medio: la fusion pone desde=min y hasta=max, asi que
        # la del medio quedaba envuelta, y el reparto por punto medio de mas abajo
        # —que asume una lista ordenada y sin solapes— le terminaba asignando el
        # offset equivocado a una parte del clip donde nunca se midio.
        #
        # Simulado el 2026-09-10: A(+0,500 en 0-60), B(-42,0 en 60-120) y C(+0,510 en
        # 120-180) daban `{0-120: +0,505}` y `{120-300: -42}` — o sea la fase cambiada
        # entre los dos tramos, y `colocar_sincro.js` lo coloca tal cual.
        #
        # El caso para el que la fusion existe —UNA ventana mala partiendo una pasada
        # en dos— no se pierde: esas dos mitades quedan contiguas en el orden.
        prev = fusionados[-1] if fusionados and abs(fusionados[-1]["offset_"] - g["offset_"]) <= tol else None
        if prev:
            prev["desde"] = min(prev["desde"], g["desde"])
            prev["hasta"] = max(prev["hasta"], g["hasta"])
            prev["n"] += g["n"]
            prev["zs"] = prev["zs"] + g["zs"]
            prev["z"] = float(np.median(prev["zs"]))
            prev["offset_"] = (prev["offset_"] + g["offset_"]) / 2
        else:
            fusionados.append(g)
    buenos = sorted(fusionados, key=lambda g: g["desde"])
    # SE EXTIENDEN LOS TRAMOS hasta donde llega la pasada, no hasta donde alcanzó a
    # medirse. Una ventana necesita entrar COMPLETA, así que la detección nunca
    # confirma los bordes: un clip de 263,5s con una sola pasada salía como 10–260 y
    # eso tiraba trece segundos de material bueno, cuando el offset es el mismo en
    # todo el tramo.
    #
    # Con una sola pasada, el tramo es el clip entero. Con varias, cada una se estira
    # hasta el punto medio del hueco que la separa de la siguiente: es el reparto
    # neutral, porque dentro del hueco no hay música y no se puede saber dónde termina
    # una y empieza la otra.
    #
    # El rango CONFIRMADO se guarda aparte: es lo que de verdad se midió, y sirve para
    # saber de qué parte del tramo hay que desconfiar.
    for g in buenos:
        g["confirmadoDesde"] = g["desde"]
        g["confirmadoHasta"] = g["hasta"]
    for i, g in enumerate(buenos):
        g["desde"] = 0.0 if i == 0 else round((buenos[i - 1]["confirmadoHasta"] + g["confirmadoDesde"]) / 2, 2)
        g["hasta"] = round(dur_clip, 2) if i == len(buenos) - 1 else \
            round((g["confirmadoHasta"] + buenos[i + 1]["confirmadoDesde"]) / 2, 2)

    for g in buenos:
        g["offset"] = round(g["offset_"], 3)
        g.pop("offset_", None)
        g["desde"] = round(g["desde"], 2)
        g["hasta"] = round(min(g["hasta"], dur_clip), 2)
        g["ventanas"] = g.pop("n")
        g["z"] = round(g["z"], 1)
        g.pop("offs"); g.pop("off"); g.pop("zs", None)
    return buenos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tema", required=True)
    ap.add_argument("--clips", nargs="+", required=True)
    ap.add_argument("--salida")
    ap.add_argument("--segundos", type=float, default=60.0)
    ap.add_argument("--desde-frac", type=float, default=0.25)
    ap.add_argument("--umbral-z", type=float, default=8.0,
                    help="z-score mínimo cuando sólo se pudo usar un segmento")
    ap.add_argument("--umbral-z-tramos", type=float, default=0.0,
                    help="piso de z en modo --segmentos. 0 = apagado, que es el default "
                         "medido: el rechazo lo hace la consistencia entre ventanas, y "
                         "un umbral acá voltea material bueno. NO usar el de --umbral-z, "
                         "que se calibró con ventanas de 60s y no transfiere.")
    ap.add_argument("--segmentos", action="store_true",
                    help="detecta VARIAS pasadas por clip y devuelve un tramo por cada una")
    ap.add_argument("--fps-secuencia", type=float, default=None,
                    help="fps de la secuencia destino: informa el residuo contra su grilla")
    a = ap.parse_args()

    if not os.path.exists(a.tema):
        print(f"No está el tema: {a.tema}", file=sys.stderr); sys.exit(1)

    archivos = []
    for c in a.clips:
        if os.path.isdir(c):
            for n in sorted(os.listdir(c)):
                if n.lower().endswith(VIDEO) and not n.startswith("."):
                    archivos.append(os.path.join(c, n))
        elif os.path.exists(c):
            archivos.append(c)
    if not archivos:
        print("No hay clips que leer.", file=sys.stderr); sys.exit(1)

    dt = dur(a.tema)
    print(f"tema: {os.path.basename(a.tema)} · {dt:.1f}s")
    print(f"{len(archivos)} clip(s) · segmento de {a.segundos:.0f}s desde el {a.desde_frac*100:.0f}% de cada uno\n")
    tema_env = envolvente(a.tema)
    if tema_env is None:
        print("El tema no tiene audio legible.", file=sys.stderr); sys.exit(1)

    if a.segmentos:
        # MODO TRAMOS: un clip puede tener varias pasadas del tema y entonces no tiene
        # UN offset. Ver el docstring de segmentar().
        print(f"  {'clip':14s} {'dur':>8s}  tramos")
        salida = []
        for f in archivos:
            d = dur(f) or 0
            desc = []
            segs = segmentar(tema_env, f, d, umbral_z=a.umbral_z_tramos, descartes=desc)
            fp = fps(f)
            r = {"archivo": f, "nombre": os.path.basename(f), "dur": round(d, 3),
                 "fps": round(fp, 3) if fp else None, "segmentos": segs,
                 "descartados": desc}
            salida.append(r)
            m = "" if len(segs) == 1 else (f"  ← {len(segs)} PASADAS" if len(segs) > 1 else "  ← NINGUNA")
            print(f"  {r['nombre'][:13]:14s} {d:7.1f}s{m}", flush=True)
            for g in segs:
                print(f"      clip {g['desde']:7.2f}–{g['hasta']:7.2f}s → offset {g['offset']:+9.3f}s"
                      f"  ({g['ventanas']} ventanas, z {g['z']})")
            for g in desc:
                print(f"      DESCARTADO {g['desde']:7.2f}–{g['hasta']:7.2f}s"
                      f" → offset {g['offset']:+9.3f}s  ({g['ventanas']} ventanas,"
                      f" z {g['z']} < {a.umbral_z_tramos})")
        varias = [r for r in salida if len(r["segmentos"]) > 1]
        vacios = [r for r in salida if not r["segmentos"]]
        print(f"\n{len(salida) - len(varias) - len(vacios)} clip(s) con una pasada · "
              f"{len(varias)} con VARIAS · {len(vacios)} sin detectar")
        if varias:
            print("Los de varias pasadas se colocan como tramos SEPARADOS, cada uno con su")
            print("in/out y su posición: no hay que cortar el material.")
        if a.salida:
            json.dump({"tema": a.tema, "duracionTema": dt, "modo": "segmentos", "clips": salida},
                      open(a.salida, "w"), indent=1)
            print(f"\nescrito: {a.salida}")
        return

    print(f"  {'clip':18s} {'dur':>7s} {'arranca en':>11s} {'frame':>7s} {'corr':>6s} {'z':>6s} {'difer':>7s}")
    salida = []
    for f in archivos:
        r = sincronizar(tema_env, f, a.segundos, a.desde_frac)
        r["archivo"] = f
        r["nombre"] = os.path.basename(f)
        salida.append(r)
        if "error" in r:
            print(f"  {r['nombre'][:17]:18s} {'':>7s} {r['error']}", flush=True)
            continue
        # DUDOSO se marca, no se esconde: un offset con dos candidatos empatados
        # puede estar en la parte equivocada de un tema con secciones parecidas.
        # BUENO = los dos segmentos coinciden. Si sólo hubo uno (clip corto), se
        # exige un z alto, que es lo único que queda para juzgarlo.
        if r["coinciden"] is True:
            marca, est = "", "ok"
        elif r["coinciden"] is False:
            marca, est = f"  ← NO COINCIDEN ({r['desacuerdoFrames']:.1f} frames)", "dudoso"
        elif (r["z"] or 0) >= a.umbral_z:
            marca, est = "  (un solo segmento)", "ok"
        else:
            marca, est = "  ← DUDOSO, un segmento y z bajo", "dudoso"
        r["estado"] = est
        dos = (f"{r['desacuerdoFrames']:.1f}f" if r["desacuerdoFrames"] is not None else "—")
        print(f"  {r['nombre'][:17]:18s} {r['dur']:6.1f}s {r['inicioEnTema']:10.3f}s "
              f"{str(r['inicioEnFrames']):>7s} {r['correlacion']:6.3f} {r['z']:6.1f} {dos:>7s}{marca}",
              flush=True)

    # RESIDUO CONTRA LA GRILLA DE LA SECUENCIA.
    #
    # El video sólo puede caer en un frame entero, así que si el offset real cae entre
    # dos, NINGUNA posición es exacta y las dos vecinas suenan igual. A 25 fps el piso
    # es ±20 ms, que no es perceptible. Informarlo evita la pregunta de si la sincro
    # falló cuando en realidad chocó contra la grilla.
    #
    # Nota de honestidad: el residuo sale cuantizado al paso de la envolvente (5 ms),
    # así que no debe leerse más fino que eso.
    if a.fps_secuencia:
        fs_ = a.fps_secuencia
        paso = 1000.0 / fs_
        print(f"\n  Residuo contra la grilla de {fs_:g} fps ({paso:.0f} ms por frame):")
        for r in salida:
            if "error" in r:
                continue
            f_ = abs(r["inicioEnTema"]) * fs_
            fr = round(f_)
            res = (f_ - fr) * paso
            r["frameSecuencia"] = int(fr)
            r["residuoMs"] = round(res, 1)
            donde = ("en la grilla" if abs(res) < paso * 0.2
                     else "ENTRE FRAMES" if abs(res) > paso * 0.35 else "cerca")
            print(f"    {r['nombre'][:16]:17s} frame {fr:6d}  residuo {res:+6.1f} ms  {donde}")
        entre = sum(1 for r in salida if abs(r.get("residuoMs") or 0) > paso * 0.35)
        if entre:
            print(f"  {entre} clip(s) caen ENTRE frames: no hay posición exacta y las dos")
            print(f"  vecinas suenan igual. El piso a {fs_:g} fps es ±{paso/2:.0f} ms.")

    buenos = [r for r in salida if r.get("estado") == "ok"]
    dudosos = [r for r in salida if r.get("estado") == "dudoso"]
    fallados = [r for r in salida if "error" in r]
    print(f"\n{len(buenos)} sincronizado(s) · {len(dudosos)} dudoso(s) · {len(fallados)} sin audio")
    if dudosos:
        print("Los dudosos hay que verificarlos MIRANDO. Que dos segmentos no coincidan")
        print("significa que al menos uno cayó en la sección equivocada de un tema que se")
        print("repite, y no hay forma de saber cuál sin ver la boca contra el audio.")
    if a.salida:
        json.dump({"tema": a.tema, "duracionTema": dt, "clips": salida},
                  open(a.salida, "w"), indent=1)
        print(f"\nescrito: {a.salida}")


if __name__ == "__main__":
    main()
