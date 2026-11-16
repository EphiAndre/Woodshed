# -*- mode: python ; coding: utf-8 -*-
# Build:  pyinstaller --noconfirm Woodshed.spec
import sys
from PyInstaller.utils.hooks import collect_data_files

datas = [("gui", "gui")]
datas += collect_data_files("demucs")          # file .yaml dei modelli
datas += collect_data_files("imageio_ffmpeg")  # ffmpeg incluso nell'app

hiddenimports = [
    "demucs.api", "demucs.apply", "demucs.audio", "demucs.demucs", "demucs.hdemucs",
    "demucs.htdemucs", "demucs.hf", "demucs.pretrained", "demucs.repo", "demucs.spec",
    "demucs.states", "demucs.transformer", "demucs.utils", "demucs.wiener",
]

a = Analysis(
    ["app.py"],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pandas", "torchvision", "tensorboard"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Woodshed",
    console=False,
    icon="icon.icns" if sys.platform == "darwin" else "icon.ico",
)
coll = COLLECT(exe, a.binaries, a.datas, name="Woodshed")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Woodshed.app",
        icon="icon.icns",
        bundle_identifier="it.andrea.woodshed",
        info_plist={"NSHighResolutionCapable": True, "LSMinimumSystemVersion": "12.3"},
    )
