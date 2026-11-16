"""Woodshed: separa i brani in tracce per studiare la chitarra.

Avvio in sviluppo:  python app.py
"""

import mimetypes
import multiprocessing
import os
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

APP_NAME = "Woodshed"


def data_dir():
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / APP_NAME


def resource_dir():
    # Con PyInstaller i file inclusi stanno in sys._MEIPASS
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


DATA = data_dir()
DATA.mkdir(parents=True, exist_ok=True)
# I pesi del modello finiscono accanto alla libreria invece che nella cache di sistema
os.environ.setdefault("TORCH_HOME", str(DATA / "models"))

import webview  # noqa: E402  (dopo TORCH_HOME)

from library import Library  # noqa: E402

GUI_DIR = resource_dir() / "gui"
LIBRARY = Library(DATA / "library")
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("text/javascript", ".js")


# ---------- server locale: interfaccia + file audio ----------

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path.startswith("/stems/"):
                _, _, song_id, filename = path.split("/", 3)
                file = LIBRARY.stem_path(song_id, filename.removesuffix(".flac"))
            else:
                rel = "index.html" if path in ("", "/") else path.lstrip("/")
                file = (GUI_DIR / rel).resolve()
                if GUI_DIR.resolve() not in file.parents:
                    raise ValueError
        except ValueError:
            self.send_error(404)
            return
        if not file.is_file():
            self.send_error(404)
            return
        body = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


# ---------- API chiamabile dall'interfaccia (window.pywebview.api.*) ----------

def _dialog(name):
    fd = getattr(webview, "FileDialog", None)
    if fd is not None:
        return getattr(fd, name)
    return getattr(webview, f"{name}_DIALOG")


class Api:
    def __init__(self):
        self._window = None

    def get_state(self):
        return LIBRARY.snapshot()

    def add_songs(self):
        files = self._window.create_file_dialog(
            _dialog("OPEN"),
            allow_multiple=True,
            file_types=("Audio (*.mp3;*.wav;*.flac;*.m4a;*.aac;*.ogg;*.aiff;*.aif)", "Tutti i file (*.*)"),
        )
        for f in files or []:
            LIBRARY.enqueue(f)
        return len(files or [])

    def cancel_job(self, job_id):
        return LIBRARY.cancel_job(job_id)

    def dismiss_job(self, job_id):
        LIBRARY.dismiss_job(job_id)
        return True

    def delete_song(self, song_id):
        return LIBRARY.delete_song(song_id)

    def get_beats(self, song_id):
        try:
            return LIBRARY.get_beats(song_id)
        except Exception:  # noqa: BLE001
            return None

    def save_beat_settings(self, song_id, phase, offset_ms):
        return LIBRARY.save_beat_settings(song_id, phase, offset_ms)

    def export_song(self, song_id, bits, include_click=False):
        folder = self._window.create_file_dialog(_dialog("FOLDER"))
        if not folder:
            return {"ok": False}
        dest = folder[0] if isinstance(folder, (list, tuple)) else folder
        try:
            path, click = LIBRARY.export_song(song_id, dest, bits, bool(include_click))
            return {"ok": True, "path": path, "click": click}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    def open_folder(self, path):
        if sys.platform == "darwin":
            subprocess.Popen(["open", path])
        elif sys.platform == "win32":
            os.startfile(path)  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", path])
        return True

    def open_library_folder(self):
        return self.open_folder(str(LIBRARY.root))


def main():
    port = start_server()
    api = Api()
    window = webview.create_window(
        APP_NAME, f"http://127.0.0.1:{port}/", js_api=api,
        width=1280, height=820, min_size=(980, 640), background_color="#2b2722",
    )
    api._window = window
    webview.start(debug=os.environ.get("WOODSHED_DEBUG") == "1")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
