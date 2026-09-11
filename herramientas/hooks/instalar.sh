#!/bin/sh
# Instala los hooks de este repo en .git/hooks/.
#
# POR QUE HACE FALTA: git NO versiona .git/hooks/, asi que el hook vive solo en
# la maquina donde se creo y un clone nuevo llega sin el. La copia buena es la de
# acá; .git/hooks/ es la instalada, igual que pasa con el plugin (que tambien es
# una COPIA y no un symlink, ver CLAUDE.md).
#
# `test.js` compara las dos y falla si difieren, para que la instalada no quede
# vieja sin que nadie se entere.

cd "$(dirname "$0")/../.." || exit 1
[ -d .git ] || { echo "ERROR: no estoy en la raiz de un repo git" >&2; exit 1; }

for h in herramientas/hooks/*; do
    n=$(basename "$h")
    case "$n" in instalar.sh) continue ;; esac
    cp "$h" ".git/hooks/$n" && chmod +x ".git/hooks/$n" && echo "  instalado: $n"
done
