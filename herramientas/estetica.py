#!/usr/bin/env python3
"""PERDIO. Registro de un resultado negativo — para foco y exposicion usar `foco.py` (TOPIQ).

*** SUS PESOS Y SU MODELO FUERON BORRADOS A PROPOSITO (2026-08-23). ***

Este archivo NO corre tal como esta: usa CLIP ViT-L/14 (1,6 GB) y el MLP del predictor LAION
(3,5 MB), y los dos se borraron despues de medir que pierden. Para rehacer la medicion hay que
volver a bajarlos; `from_pretrained` lo hace solo, y el MLP esta en el repo de
improved-aesthetic-predictor.

Se conserva porque es la unica forma de reproducir la comparacion contra la que se valido TOPIQ,
y porque este repo guarda los resultados negativos —ver el encabezado de `nitidez.py`— en vez de
borrarlos y volver a proponer la misma idea el mes que viene.

QUE SE MIDIO, y esta completo en VISION.md:
  - el predictor estetico se mueve 0,66 entre un cuadro perfecto y uno completamente fuera de
    foco. No mide calidad;
  - y lo poco que mide es un TIPO DE PLANO: puntuo el plano general de la estacion como el peor
    de 8 y un primer plano con bokeh como el mejor;
  - el CLIP-IQA a mano SATURA en 2px de desenfoque, asi que dice "blando o no" y no ordena grados.

Lo que sigue es el codigo tal como corrio, sin tocar.

--- encabezado original ---

Le pone un numero a un cuadro. DOS scorers, y no miden lo mismo.

  laion   MLP entrenado con ~176k valoraciones humanas, arriba de embeddings de CLIP ViT-L/14.
          Es lo que se uso para filtrar LAION y entrenar Stable Diffusion. Escala ~1 a 10.
          SESGO DOCUMENTADO: premia degradados suaves, bokeh y cielos saturados —arte digital—
          y castiga grano y realismo documental. O sea que su prior NO es el de este material.

  iqa     CLIP-IQA: sin entrenar nada, se le pregunta a CLIP con pares de opuestos
          ("Good photo." contra "Bad photo.") y se toma el softmax. Mide DETERIORO, no gusto.

ANTES de usar cualquiera de los dos para ordenar planos hay que pasar el test del PISO:
si el score se mueve mas ADENTRO de un plano que ENTRE planos, el numero no mide planos y no
sirve para rankearlos, no importa cuanto correlacione con nadie. Ver `--variancia`.

Uso:
  python estetica.py --cuadros a.png b.png ...
  python estetica.py --variancia plan.json     # el test del piso
"""
import os, sys, json, argparse, warnings
warnings.filterwarnings("ignore")
import torch, torch.nn as nn
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODELO = "openai/clip-vit-large-patch14"
PESOS = os.path.expanduser("~/.venvs/vision/pesos/laion-ava-l14.pth")

class MLP(nn.Module):
    """La cabecita del predictor LAION. La forma no se elige: tiene que coincidir con los pesos."""
    def __init__(self, d=768):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(d, 1024), nn.Dropout(0.2),
            nn.Linear(1024, 128), nn.Dropout(0.2),
            nn.Linear(128, 64), nn.Dropout(0.1),
            nn.Linear(64, 16),
            nn.Linear(16, 1),
        )
    def forward(self, x): return self.layers(x)

class Scorer:
    def __init__(self):
        self.dev = "cpu"   # MPS en Intel+AMD da resultados inconsistentes; el volumen es chico
        self.clip = CLIPModel.from_pretrained(MODELO).to(self.dev).eval()
        self.proc = CLIPProcessor.from_pretrained(MODELO)
        self.mlp = MLP(768)
        self.mlp.load_state_dict(torch.load(PESOS, map_location="cpu"))
        self.mlp.to(self.dev).eval()
        # CLIP-IQA: el par de opuestos. El score es el softmax entre los dos.
        self.pares = [("Good photo.", "Bad photo."), ("Sharp photo.", "Blurry photo."),
                      ("Bright photo.", "Dark photo.")]
        txt = [t for par in self.pares for t in par]
        with torch.no_grad():
            ti = self.proc(text=txt, return_tensors="pt", padding=True).to(self.dev)
            te = self.clip.get_text_features(**ti)
            self.te = te / te.norm(dim=-1, keepdim=True)

    @torch.no_grad()
    def __call__(self, rutas):
        ims = [Image.open(r).convert("RGB") for r in rutas]
        ii = self.proc(images=ims, return_tensors="pt").to(self.dev)
        ie = self.clip.get_image_features(**ii)
        ien = ie / ie.norm(dim=-1, keepdim=True)
        laion = self.mlp(ien.float()).squeeze(-1).tolist()
        if not isinstance(laion, list): laion = [laion]
        sim = (100.0 * ien @ self.te.T)          # (n, 2*pares)
        out = []
        for k in range(len(rutas)):
            iqa = {}
            for j, (bueno, malo) in enumerate(self.pares):
                a, b = sim[k, 2 * j], sim[k, 2 * j + 1]
                p = torch.softmax(torch.stack([a, b]), 0)[0].item()
                iqa[bueno.split()[0].lower()] = round(p, 4)
            out.append({"ruta": rutas[k], "laion": round(laion[k], 3), "iqa": iqa})
        return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cuadros", nargs="*")
    ap.add_argument("--variancia")
    ap.add_argument("--salida")
    a = ap.parse_args()
    s = Scorer()
    if a.cuadros:
        r = s(a.cuadros)
        for x in r: print(json.dumps(x))
        if a.salida: json.dump(r, open(a.salida, "w"), indent=2)
        return
    if a.variancia:
        plan = json.load(open(a.variancia))
        res = {}
        for plano, rutas in plan.items():
            res[plano] = s(rutas)
            print(f"  {plano}: {len(rutas)} cuadros", flush=True)
        json.dump(res, open(a.salida or "variancia.json", "w"), indent=2)
        return
    ap.error("falta --cuadros o --variancia")

if __name__ == "__main__":
    main()
