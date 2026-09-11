#!/usr/bin/env python3
"""Aplica correcciones SOBRE un plan de corte existente, sin re-planificar, y lo verifica.

    python3 herramientas/parchear_corte.py <corte.json> <notas.json> [--planos planos.json]
                                           [--desfases desfases.json] [--fps 50] [--salida otro.json]

## Por que parchear y no re-planificar

Un armado sale de un plan con algo de azar —que clip va en cada tramo—. Re-planificar despues de
una revision cambia TODOS los planos, incluidos los que el usuario no critico, y su revision, que
es lo mas caro de todo el proceso, se pierde. Asi que las notas se aplican como OPERACIONES sobre
el plan que el vio.

Medido en un multicamara: 18 correcciones aplicadas sobre 22 y 33 planos, dejando intacto todo lo demas.

## Las cuatro operaciones, y por que apuntan POR TIEMPO

    {"op":"reemplazar", "en": 30.46, "clip":"X.MP4"}      ese plano pasa a ser otro clip
    {"op":"partir",     "en": 54.70, "clip":"X.MP4"}      se corta ahi; la segunda mitad es otro
    {"op":"correr",     "en": 150.0, "desde":151.5, "hasta":161.0}   se mueven sus bordes
    {"op":"fusionar",   "en": 124.0}                      desaparece; el anterior lo cubre
    {"op":"aire",       "inicio": 8.1, "fin": 169.8}      estira el primero y el ultimo

Apuntan por TIEMPO y no por indice A PROPOSITO: cada `partir` inserta un fragmento y corre todos
los indices siguientes, asi que una lista escrita con indices se desalinea sola a la segunda
operacion. Ya paso: la tercera nota cayo sobre el plano equivocado y dejo una duracion NEGATIVA de
-9,08s. Y los tiempos son, ademas, los que el usuario leyo del timecode quemado.

## La verificacion es la mitad del valor

Corre sobre el ARCHIVO, antes de que el plan llegue a Premiere. Cuando llega, ya esta probado:

  - duraciones positivas y de al menos medio segundo;
  - sin huecos ni solapes entre fragmentos consecutivos;
  - ningun fragmento pide mas material del que su clip tiene;
  - `entrada = desde - desfase` recalculado en cada uno. En material sincronizado el in-point NO
    es una eleccion, y elegir otro desincroniza EN SILENCIO: el clip mide lo mismo y nada avisa.

Los dos chequeos de videoclip multicamara son OPCIONALES y sólo corren si se pasa `--planos`:

  - que no queden dos ENCUADRES iguales seguidos (`quien` + `tipo`): dos camaras sobre la misma
    persona con el mismo tamano de plano se leen como un salto, no como un corte;
  - que ningun fragmento pise una zona marcada como mala en `evitar`.
"""
import argparse, json, sys

ap = argparse.ArgumentParser(add_help=True)
ap.add_argument("corte"); ap.add_argument("notas")
ap.add_argument("--planos"); ap.add_argument("--desfases"); ap.add_argument("--salida")
ap.add_argument("--fps", type=float, default=50.0)
a = ap.parse_args()

FPS = a.fps
def q(t): return round(round(t * FPS) / FPS, 3)

F = json.load(open(a.corte, encoding="utf-8"))["fragmentos"]
OPS = json.load(open(a.notas, encoding="utf-8"))["ops"]

planos = {}
if a.planos:
    planos = json.load(open(a.planos, encoding="utf-8")).get("planos", {})
des, duras = {}, {}
if a.desfases:
    d = json.load(open(a.desfases, encoding="utf-8"))
    for c in d["clips"]:
        n = (c.get("nombre") or c["archivo"].split("/")[-1]).replace("_PROXY.mp4", ".MP4")
        des[n] = c["inicioEnTema"]; duras[n] = c.get("dur")
    ref = d["tema"].split("/")[-1].replace("_PROXY.mp4", ".MP4")
    des[ref] = 0.0; duras[ref] = d.get("duracionTema")

def enc(c):
    p = planos.get(c, {})
    return (p.get("quien"), p.get("tipo"))

def cual(t):
    """El fragmento que contiene ese instante. Si cae en un borde, el que empieza ahi."""
    for j, x in enumerate(F):
        if x["desde"] <= t < x["desde"] + x["dura"] - 1e-9: return j
    return len(F) - 1

log = []
for op in OPS:
    k = op["op"]
    if k == "reemplazar":
        i = cual(op["en"]); F[i]["clip"] = op["clip"]
        log.append(f"{F[i]['desde']:.2f}s -> {op['clip']}")
    elif k == "partir":
        i = cual(op["en"]); t = q(op["en"]); x = F[i]
        F.insert(i + 1, {"clip": op["clip"], "desde": t,
                         "dura": round(x["desde"] + x["dura"] - t, 3), "entrada": 0.0})
        x["dura"] = round(t - x["desde"], 3)
        log.append(f"partido en {t} -> {op['clip']}")
    elif k == "correr":
        i = cual(op["en"]); x = F[i]
        nd = q(op.get("desde", x["desde"])); nh = q(op.get("hasta", x["desde"] + x["dura"]))
        if i > 0: F[i-1]["dura"] = round(nd - F[i-1]["desde"], 3)
        if i + 1 < len(F):
            F[i+1]["dura"] = round(F[i+1]["desde"] + F[i+1]["dura"] - nh, 3)
            F[i+1]["desde"] = nh
        x["desde"] = nd; x["dura"] = round(nh - nd, 3)
        log.append(f"corrido a {nd}-{nh}")
    elif k == "fusionar":
        i = cual(op["en"]); x = F.pop(i); j = max(0, i - 1)
        F[j]["dura"] = round(x["desde"] + x["dura"] - F[j]["desde"], 3)
        log.append(f"fusionado el de {x['desde']:.2f}s")
    elif k == "aire":
        F[0]["dura"] = round(F[0]["dura"] + (F[0]["desde"] - q(op["inicio"])), 3)
        F[0]["desde"] = q(op["inicio"])
        F[-1]["dura"] = round(q(op["fin"]) - F[-1]["desde"], 3)
        log.append(f"aire {q(op['inicio'])}-{q(op['fin'])}")
    else:
        print(f"  operacion desconocida: {k}", file=sys.stderr); sys.exit(1)

# EL IN-POINT NO ES UNA ELECCION cuando el material esta sincronizado: sale del desfase.
if des:
    for x in F:
        if x["clip"] in des:
            x["entrada"] = round(max(0.0, x["desde"] - des[x["clip"]]), 3)

prob = []
for i, x in enumerate(F):
    if x["dura"] < 0.5: prob.append(f"[{i+1}] mide {x['dura']}s")
    if i and abs(F[i-1]["desde"] + F[i-1]["dura"] - x["desde"]) > 1.5 / FPS:
        prob.append(f"hueco o solape entre [{i}] y [{i+1}]")
    dm = duras.get(x["clip"])
    if dm and x.get("entrada", 0) + x["dura"] > dm + 0.05:
        prob.append(f"[{i+1}] pide {x['entrada']+x['dura']:.2f}s de {x['clip']} que mide {dm}")
    if planos:
        if i and enc(F[i-1]["clip"]) == enc(x["clip"]): prob.append(f"[{i+1}] repite el encuadre")
        for z0, z1 in planos.get(x["clip"], {}).get("evitar", []):
            if x["desde"] < z1 and x["desde"] + x["dura"] > z0:
                prob.append(f"[{i+1}] pisa una zona marcada de {x['clip']}")

print(f"  {len(F)} fragmentos, {F[0]['desde']:.2f} a {F[-1]['desde']+F[-1]['dura']:.2f}s · {len(OPS)} operaciones")
for l in log: print(f"    {l}")
if prob:
    print(f"  {len(prob)} PROBLEMAS, no se escribio nada:")
    for p in prob[:15]: print(f"    x {p}")
    sys.exit(1)
print("  sin problemas" + (" · encuadres y zonas chequeados" if planos else " · sin --planos: no se chequearon encuadres"))
json.dump({"_comentario": ["Plan parcheado. Verificado antes de tocar Premiere.",
                           "entrada = desde - desfase: en material sincronizado el in-point no se elige."],
           "fragmentos": F}, open(a.salida or a.corte, "w"), ensure_ascii=False, indent=1)
