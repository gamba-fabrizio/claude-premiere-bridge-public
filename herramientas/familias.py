#!/usr/bin/env python3
"""Agrupa clips en FAMILIAS de tomas parecidas, para proponer suplentes.

CORRE CON EL PYTHON DEL VENV AISLADO, no con el del sistema:

    ~/.venvs/vision/bin/python herramientas/familias.py --origen <carpeta> --destino <dir>

Por qué aislado: PyTorch dejó de compilar para Intel Mac después de 2.2.2, y esa versión
se compiló contra numpy 1.x, así que instalarla al sistema bajaría el numpy 2.0.2 que usan
`sincro.py` y `nitidez.py`. Ver `VISION.md`.

## Por qué DINOv2 y no un etiquetador

Medido el 2026-08-20 sobre este material. SigLIP zero-shot puesto a decir QUÉ hay devolvió
ganadores con puntajes de 0,003 a 0,04 en 4 de 14 cuadros — o sea "ninguna de estas frases"
disfrazado de respuesta. DINOv2 puesto a decir QUÉ SE PARECE A QUÉ acertó los cuatro casos
que se verificaron mirando.

La razón no es que un modelo sea mejor: **una distancia entre dos imágenes del material
está anclada en el material, y una etiqueta lo compara contra texto aprendido en otro
lado.** Así que acá se calculan distancias y NADA de etiquetas.

## El umbral elige el NIVEL, y por eso se calculan dos

Medido sobre el material de un videoclip:

    3581 / 3582   0,976   el mismo plano general, misma cámara
    3583 / 3585   0,963   el mismo plano cerrado
    3573 / 3577   0,826   el mismo armado, distinto tamaño de plano
    3572 / 3574   0,548   mismo lugar, encuadres distintos — NO es familia

O sea que ~0,95 es "el mismo plano" y ~0,85 es "el mismo armado". Los dos sirven para
cosas distintas: el primero para elegir entre tomas repetidas, el segundo para saber qué
escenas hay. Se informan los dos.

## Dos formas de comparar dos clips, y las dos se guardan

- **promedio**: el centroide de los cuadros del clip. Bueno cuando el clip es homogéneo.
- **mejor par**: el par de cuadros más parecido entre los dos clips. Encuentra clips que
  comparten sólo una parte — un plano que arranca igual y después panea a otro lado.

El promedio solo se pierde esos casos, y el mejor par solo agrupa de más. Con los dos a la
vista se decide.

## Y LO IMPORTANTE: esto no se entrega sin planchas

El número propone, el ojo decide. Por cada familia se arma una plancha de contacto, porque
una lista de nombres agrupados no se puede auditar. Es el patrón que funcionó en
`informe_nitidez.js` y el que le faltó a `nitidez.py`, cuyo test a ciegas dio 2 de 6.

## La rotación se IGNORA

Cinco de los trece clips de los cantantes traen `rotation=-90` con el contenido horizontal.
ffmpeg obedece el flag y los cuadros salen acostados. `-noautorotate` va ANTES de `-i`
porque es opción de demuxer; puesta después no hace nada y no avisa.
"""
import argparse, glob, itertools, json, os, subprocess, sys, time, collections

ap = argparse.ArgumentParser()
ap.add_argument("--origen", required=True, help="carpeta con los clips de video")
ap.add_argument("--destino", required=True)
ap.add_argument("--cada", type=float, default=2.0, help="segundos entre cuadros")
ap.add_argument("--ancho", type=int, default=512)
ap.add_argument("--cuadros", default=None,
                help="carpeta con cuadros ya extraídos; si se pasa, no se extrae nada")
ap.add_argument("--umbral-plano", type=float, default=0.95)
ap.add_argument("--umbral-armado", type=float, default=0.85)
ap.add_argument("--rotacion", choices=["ignorar", "respetar"], default="ignorar")
a = ap.parse_args()

FUENTE = "/System/Library/Fonts/Supplemental/Arial.ttf"
os.makedirs(a.destino, exist_ok=True)

# ---------- cuadros ----------
if a.cuadros:
    dirC = a.cuadros
else:
    dirC = os.path.join(a.destino, "cuadros")
    os.makedirs(dirC, exist_ok=True)
    vids = sorted(sum([glob.glob(os.path.join(a.origen, "*." + e))
                       for e in ("MP4", "mp4", "MOV", "mov")], []))
    print(f"extrayendo cuadros de {len(vids)} clip(s) cada {a.cada}s...", flush=True)
    for f in vids:
        b = os.path.splitext(os.path.basename(f))[0]
        if glob.glob(os.path.join(dirC, b + "_*.jpg")):
            continue
        cmd = ["ffmpeg", "-v", "error", "-y"]
        if a.rotacion == "ignorar":
            cmd.append("-noautorotate")
        cmd += ["-i", f, "-vf", f"fps=1/{a.cada},scale={a.ancho}:-2", "-q:v", "4",
                os.path.join(dirC, b + "_%03d.jpg")]
        subprocess.run(cmd, check=False)

fs = sorted(glob.glob(os.path.join(dirC, "*.jpg")))
if not fs:
    sys.exit("No hay cuadros.")
clip = [os.path.basename(f).rsplit("_", 1)[0] for f in fs]
nombres = sorted(set(clip))
print(f"{len(fs)} cuadro(s) de {len(nombres)} clip(s)\n", flush=True)

# ---------- embeddings ----------
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
torch.set_num_threads(os.cpu_count() or 8)
proc = AutoImageProcessor.from_pretrained("facebook/dinov2-base")
mod = AutoModel.from_pretrained("facebook/dinov2-base"); mod.eval()

t0 = time.time(); trozos = []
for i in range(0, len(fs), 16):
    lote = [Image.open(x).convert("RGB") for x in fs[i:i + 16]]
    with torch.no_grad():
        # token CLS: el resumen global del cuadro. Los tokens de parche servirían para
        # localizar, que acá no hace falta.
        o = mod(**proc(images=lote, return_tensors="pt")).last_hidden_state[:, 0]
    trozos.append(torch.nn.functional.normalize(o, dim=-1))
    print(f"  {min(i+16,len(fs))}/{len(fs)}", end="\r", flush=True)
E = torch.cat(trozos)
print(f"  embebidos en {time.time()-t0:.0f}s ({(time.time()-t0)/len(fs)*1000:.0f} ms/cuadro)\n")

idx = {n: [i for i, c in enumerate(clip) if c == n] for n in nombres}
prom = torch.stack([torch.nn.functional.normalize(E[idx[n]].mean(0), dim=-1) for n in nombres])
Sprom = prom @ prom.T
# mejor par de cuadros entre cada dos clips
Smax = torch.zeros_like(Sprom)
for i, j in itertools.combinations(range(len(nombres)), 2):
    v = float((E[idx[nombres[i]]] @ E[idx[nombres[j]]].T).max())
    Smax[i, j] = Smax[j, i] = v
Smax.fill_diagonal_(1.0)

# ---------- familias ----------
def agrupar(S, u):
    padre = {n: n for n in nombres}
    def raiz(x):
        while padre[x] != x: x = padre[x]
        return x
    for i, j in itertools.combinations(range(len(nombres)), 2):
        if float(S[i, j]) >= u:
            padre[raiz(nombres[i])] = raiz(nombres[j])
    g = collections.defaultdict(list)
    for n in nombres: g[raiz(n)].append(n)
    return [sorted(v) for v in g.values()]

fam_plano = [f for f in agrupar(Sprom, a.umbral_plano) if len(f) > 1]
fam_armado = [f for f in agrupar(Sprom, a.umbral_armado) if len(f) > 1]
print(f"mismo PLANO  (>= {a.umbral_plano}): {len(fam_plano)} familia(s)")
for f in fam_plano: print("   " + ", ".join(f))
print(f"mismo ARMADO (>= {a.umbral_armado}): {len(fam_armado)} familia(s)")
for f in fam_armado: print("   " + ", ".join(f))

# ---------- planchas, que son el punto ----------
def plancha(grupo, nombre, titulo):
    args = []
    for n in grupo:
        cs = sorted(glob.glob(os.path.join(dirC, n + "_*.jpg")))
        if not cs: continue
        f = cs[len(cs) // 2]        # el cuadro del medio: menos probable que sea un fundido
        args += ["-label", n, f]
    if not args: return None
    sal = os.path.join(a.destino, nombre + ".jpg")
    subprocess.run(["magick", "montage", *args, "-font", FUENTE, "-tile", "4x",
                    "-geometry", f"{a.ancho//2}x{int(a.ancho//2*9/16)}+4+4",
                    "-background", "white", "-pointsize", "14", "-title", titulo, sal],
                   check=False)
    return sal

md = ["# Familias de tomas — para proponer suplentes\n",
      "Agrupado con **DINOv2** por distancia entre embeddings. NO hay etiquetado de",
      "contenido: se midió que no sirve (ver `VISION.md`).\n",
      "**El número propone, el ojo decide.** Cada familia tiene su plancha: si el grupo no",
      "es de verdad el mismo plano, gana lo que se ve.\n",
      f"`{len(fs)}` cuadros de `{len(nombres)}` clips.\n",
      f"## Mismo PLANO (similitud >= {a.umbral_plano})\n",
      "Tomas repetidas del mismo encuadre: acá se elige una y las otras son suplentes.\n"]
for k, f in enumerate(fam_plano, 1):
    p = plancha(f, f"PLANO_{k:02d}", f"mismo plano {k}: " + ", ".join(f))
    md.append(f"- **{k}** — {', '.join('`'+x+'`' for x in f)}" + (f" → `{os.path.basename(p)}`" if p else ""))
if not fam_plano: md.append("Ninguna.")
md += [f"\n## Mismo ARMADO (similitud >= {a.umbral_armado})\n",
       "Misma escena y puesta, distinto tamaño de plano. Sirve para saber qué escenas hay.\n"]
for k, f in enumerate(fam_armado, 1):
    p = plancha(f, f"ARMADO_{k:02d}", f"mismo armado {k}: " + ", ".join(f))
    md.append(f"- **{k}** — {', '.join('`'+x+'`' for x in f)}" + (f" → `{os.path.basename(p)}`" if p else ""))
if not fam_armado: md.append("Ninguna.")

# los sueltos importan: un clip sin familia no tiene suplente
sueltos = [n for n in nombres if not any(n in f for f in fam_armado)]
md += ["\n## Sin familia\n",
       "Clips que no se parecen a ningún otro: **no tienen suplente**, así que si uno de",
       "estos no sirve, ese momento se queda sin ese recurso.\n",
       ", ".join("`" + x + "`" for x in sueltos) if sueltos else "Ninguno."]
plancha(sueltos[:16], "SUELTOS", "sin familia (primeros 16)") if sueltos else None

open(os.path.join(a.destino, "FAMILIAS.md"), "w").write("\n".join(md))
json.dump({"clips": nombres,
           "familias_plano": fam_plano, "familias_armado": fam_armado, "sueltos": sueltos,
           "umbrales": {"plano": a.umbral_plano, "armado": a.umbral_armado},
           "sim_promedio": Sprom.tolist(), "sim_mejor_par": Smax.tolist()},
          open(os.path.join(a.destino, "familias.json"), "w"))
print(f"\n{len(sueltos)} clip(s) sin familia · informe y planchas en {a.destino}")
