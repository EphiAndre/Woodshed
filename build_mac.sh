#!/bin/bash
# Crea Woodshed.app in dist/  (da eseguire su Mac, con l'ambiente virtuale attivo)
set -e
cd "$(dirname "$0")"
pyinstaller --noconfirm Woodshed.spec
echo "Fatto: dist/Woodshed.app"
