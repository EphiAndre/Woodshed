@echo off
REM Crea dist\Woodshed\Woodshed.exe  (da eseguire su Windows, con l'ambiente virtuale attivo)
cd /d %~dp0
pyinstaller --noconfirm Woodshed.spec
echo Fatto: dist\Woodshed\Woodshed.exe
