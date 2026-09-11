#!/usr/bin/env python3
"""Ordena tomas por FOCO y EXPOSICION con TOPIQ. No opina sobre cual es mejor.

    ~/.venvs/iqa/bin/python foco.py --familia tomas.json
    ~/.venvs/iqa/bin/python foco.py --triage tomas.json [--umbral 0.378]

Corre con `~/.venvs/iqa`, NO con `~/.venvs/vision`: pyiqa quiere numpy 2 y torch 2.2.2 —el techo
de esta maquina— se compilo contra numpy 1.x. Los dos entornos estan separados a proposito y en
el de iqa numpy queda clavado en <2.

## Por que TOPIQ y no los otros cinco, medido el 2026-08-23

Se probaron el predictor estetico LAION, NIMA, MUSIQ, CLIP-IQA+ y un CLIP-IQA a mano. Escalera
de desenfoque sobre el mismo cuadro, normalizada a 0px = 1,00:

                 0px   0,5px    1px    2px    4px    8px   12px
    musiq      1,000  0,928  0,746  0,358  0,278  0,239  0,225
    topiq_nr   1,000  0,746  0,526  0,310  0,191  0,224  0,313
    nima       1,000  0,941  0,849  0,808  0,955  1,017  0,919   <- SUBE
    clipiqa+   1,000  0,949  0,834  0,581  0,304  0,223  0,205
    clipiqa    1,000  0,856  0,506  0,027  0,005  0,016  0,012   <- satura en 2px

**NIMA esta roto para esto**: a 8px de desenfoque puntua 1,017, o sea MEJOR que el original. Es
el scorer estetico siendo ciego al defecto. El CLIP-IQA a mano satura en 2px, asi que dice "blando
o no" y no puede ordenar grados. TOPIQ es el mas sensible y sigue bajando hasta 4px.

## LOS DOS NUMEROS QUE MANDAN, y por que hay dos modos

Sobre 8 planos NITIDOS de clases distintas, 10 cuadros cada uno:

    medianas de los nitidos    0,378 a 0,577   -> la composicion sola mueve el score 34,6%
    desvio DENTRO de un plano  0,011           -> razon entre/dentro 5,60

O sea que **el score depende mucho de la composicion**: un plano general de luz plana puntua como
un primer plano blando. Por eso:

  --familia  compara tomas del MISMO setup.

             OJO, y esto se probo y FALLO la primera vez: "mismo medio" NO es "mismo encuadre".
             Se compararon los 3 usos de un plano de camara en mano y la herramienta marco uno
             como 0,091 por debajo del mejor. Al MIRARLO no estaba mas blando: estaba mas
             ABIERTO y mas cargado. El score seguia al encuadre, no al foco, porque un plano en
             mano reencuadra mientras corre.

             La senal para detectarlo ya estaba en la salida: ese plano tenia desvio interno
             0,038 y el que si era comparable tenia 0,005. **Un desvio interno alto significa que
             el encuadre se mueve adentro del plano, y entonces las medianas no son comparables.**
             Por eso una diferencia solo se informa si supera 3x el mayor desvio interno del par.

  --triage   umbral global 0,378 (el minimo de los nitidos medidos). Detecta desde 1px de blur a
             768px de ancho, o sea ~5px en 4K: blandura VISIBLE. A 0,5px el score da 0,376, que
             cae justo en el limite. **Un general legitimo puede quedar cerca del umbral por
             composicion, no por defecto** — el modo lo avisa en vez de esconderlo.

## El TERCER confusor: la RESOLUCION DE ORIGEN (2026-08-23)

`extraer` normaliza todo a 768 de ancho, asi que la diferencia de resolucion queda INVISIBLE en
la entrada del modelo y aparece igual en el score. El mismo cuadro, bajado a cada resolucion real
del proyecto un corporativo y devuelto a 768:

    1920x1080  0,4630    ---
    1024x576   0,4617   -0,3%
     848x478   0,4597   -0,7%
     576 ancho 0,4434   -4,2%
     478 ancho 0,4232   -8,6%
     464 ancho 0,4263   -7,9%

**8,6% SUPERA la guarda del desvio interno** (3 x 0,011 ≈ 7%), asi que una diferencia de pura
resolucion alcanza para marcar "mirarlo". Y en un corporativo hay **13 resoluciones distintas** entre
478x850 y 1920x1080, o sea que no es un caso borde.

El primer intento fue modelar el sesgo con esa constante, y el primer caso real la desbordo: el
mismo contenido encodeado de verdad a 478 dio **9,3%**, porque paga la compresion ademas de la
resolucion. Fitear la constante a ese caso seria transferir un numero entre regimenes, que es el
error que este repo ya tiene registrado con el umbral de sincro. Asi que con resoluciones distintas
**no se compara**: se informa la diferencia y se dice que no es comparable.

Verificado por las dos ramas: la familia mezclada se niega, y una familia de un videoclip entera en
3840x2160 sigue comparando igual que antes.

## Y puntua CUADROS, no planos

Por eso se toman varios cuadros por toma y se usa la MEDIANA. Un plano que entra en foco a los dos
segundos puntua mal al principio y bien despues; un solo cuadro decidiria por el peor momento.
"""
import argparse, json, os, subprocess, statistics as st, sys, warnings, tempfile
warnings.filterwarnings("ignore")

UMBRAL = 0.378   # el minimo de los 8 planos nitidos medidos
RUIDO_RESOL = 0.086   # 478 contra 1920 mueve el score 8,6% (cuadro) y 9,3% (video). Ver abajo.
CUADROS_DEF = 5

def resolucion(ruta):
    """Ancho x alto NATIVOS. Hace falta porque el score depende de la resolucion de ORIGEN y
    `extraer` ya normaliza todo a 768 de ancho, con lo cual la diferencia queda invisible."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", ruta],
                             capture_output=True, text=True, check=True).stdout.strip().split("\n")[0]
        w, h = (int(x) for x in out.split("x")[:2])
        return w, h
    except Exception:
        return None, None

def extraer(ruta, entrada, dura, n, dest):
    """N cuadros repartidos en la toma. `-noautorotate` va ANTES de `-i`: es opcion de demuxer y
    puesta despues no hace nada y no avisa. Sin eso, los clips con el flag de rotacion mal salen
    acostados y el score mide otra cosa."""
    fuera = []
    for k in range(n):
        t = entrada + dura * (k + 0.5) / n
        out = os.path.join(dest, f"f{k:02d}.jpg")
        subprocess.run(["ffmpeg", "-v", "error", "-noautorotate", "-ss", f"{t:.3f}",
                        "-i", ruta, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "3",
                        out, "-y"], check=True)
        fuera.append(out)
    return fuera

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--familia", help='JSON: {"nombre de la familia": [{clip,ruta,entrada,dura}, ...]}')
    ap.add_argument("--triage", help="el mismo JSON, pero se aplica umbral global")
    ap.add_argument("--umbral", type=float, default=UMBRAL)
    ap.add_argument("--cuadros", type=int, default=CUADROS_DEF)
    a = ap.parse_args()
    origen = a.familia or a.triage
    if not origen:
        ap.error("falta --familia o --triage")

    import pyiqa
    m = pyiqa.create_metric("topiq_nr", device="cpu")
    datos = json.load(open(origen))

    salida = {}
    for familia, tomas in datos.items():
        print(f"\n── {familia}")
        filas = []
        for t in tomas:
            with tempfile.TemporaryDirectory() as d:
                rutas = extraer(t["ruta"], float(t.get("entrada", 0)), float(t["dura"]), a.cuadros, d)
                vals = [float(m(r).item()) for r in rutas]
            w, h = resolucion(t["ruta"])
            filas.append({"clip": t["clip"], "mediana": round(st.median(vals), 4),
                          "min": round(min(vals), 4), "max": round(max(vals), 4),
                          "desvio": round(st.pstdev(vals), 4), "ancho": w, "alto": h})
        filas.sort(key=lambda x: -x["mediana"])
        peor = filas[-1]["mediana"] if filas else 0
        mejor = filas[0]["mediana"] if filas else 0
        for i, f in enumerate(filas):
            marca = ""
            if a.triage and f["mediana"] < a.umbral:
                marca = "  <- BAJO EL UMBRAL: mirarlo"
            elif a.familia and mejor:
                # Una diferencia vale sólo si supera 3x el mayor desvío interno del par: si el
                # encuadre se mueve adentro del plano, el score sigue al encuadre y no al foco.
                # Probado: sin esta guarda marcó como blando un plano que estaba más ABIERTO.
                d = mejor - f["mediana"]
                ruido = 3 * max(f["desvio"], filas[0]["desvio"])
                # Y la RESOLUCION DE ORIGEN es el segundo confusor, medido el 2026-08-23: el mismo
                # cuadro bajado a 478 de ancho y devuelto a 768 puntua 8,6% menos. Eso SUPERA la
                # guarda de arriba (3 x 0,011 ≈ 7%), así que sin este término una diferencia de
                # pura resolución alcanza para marcar "mirarlo". En un corporativo hay 13 resoluciones.
                otra_resol = (f["ancho"], f["alto"]) != (filas[0]["ancho"], filas[0]["alto"])
                if otra_resol:
                    # NO se compara. Se intento modelar el sesgo con una constante —8,6% medido
                    # bajando un cuadro a 478 y devolviendolo a 768— y el primer caso real la
                    # desbordo: un video de verdad encodeado a 478 dio 9,3%, porque paga la
                    # compresion ADEMAS de la resolucion. Subir la constante hasta tapar ese caso
                    # seria fitearla a un caso; es el mismo error que transferir un umbral entre
                    # regimenes. Con resoluciones distintas el score NO mide foco, y punto.
                    marca = (f"  <- {d:.3f} mas bajo, pero es {f['ancho']}x{f['alto']} contra "
                             f"{filas[0]['ancho']}x{filas[0]['alto']}: NO COMPARABLE, mirar los dos")
                elif d > ruido:
                    marca = f"  <- {d:.3f} por debajo del mejor (ruido {ruido:.3f}): mirarlo"
                elif d > 0.02:
                    marca = f"  <- {d:.3f} mas bajo, pero el encuadre se mueve (±{f['desvio']:.3f}): NO concluyente"
            print(f"   {f['mediana']:.4f}  (±{f['desvio']:.4f})  {f['clip'][:46]:<46}{marca}")
        salida[familia] = filas

    if a.triage:
        print(f"\n  umbral {a.umbral}. OJO: un plano general de luz plana puede caer cerca del")
        print("  umbral por COMPOSICION y no por defecto — la composicion sola mueve el score 34,6%.")
    else:
        print("\n  comparacion DENTRO de la familia, con dos frenos. Una diferencia se informa solo")
        print("  si supera 3x el mayor desvio interno del par: con desvio alto el score sigue al")
        print("  ENCUADRE y no al foco, porque un plano en mano reencuadra mientras corre. Y si las")
        print(f"  tomas no comparten resolucion de origen no se compara: la resolucion sola baja el")
        print(f"  score {RUIDO_RESOL:.1%} o mas, asi que ahi la diferencia no mide foco. Las dos ya pasaron.")
    json.dump(salida, open(os.path.splitext(origen)[0] + ".foco.json", "w"), indent=2)

if __name__ == "__main__":
    main()
