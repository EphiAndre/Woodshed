"""Libreria dei brani separati: coda di lavoro, spazio su disco, esportazione ed eliminazione."""

import json
import queue
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from beats import analyze as analyze_beats_audio
from separator import SeparationCancelled, StemSeparator, decode_audio

# Ordine e nomi mostrati nell'app (la chitarra per prima: è il motivo dell'app)
STEM_ORDER = ["guitar", "bass", "drums", "vocals", "piano", "other"]
STEM_LABELS = {
    "guitar": "Chitarra", "bass": "Basso", "drums": "Batteria",
    "vocals": "Voce", "piano": "Piano", "other": "Altro",
}
ID_RE = re.compile(r"^[0-9a-f]{32}$")


def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    return name[:120] or "Brano"


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.separator = StemSeparator()
        self.jobs = []  # job visibili nell'interfaccia
        self._jobs_lock = threading.Lock()
        self._queue = queue.Queue()
        self._cleanup_partials()
        threading.Thread(target=self._worker, daemon=True).start()

    # ---------- lettura ----------

    def _cleanup_partials(self):
        for p in self.root.glob("*.partial"):
            shutil.rmtree(p, ignore_errors=True)

    def song_dir(self, song_id):
        if not ID_RE.match(song_id or ""):
            raise ValueError("ID brano non valido")
        return self.root / song_id

    def stem_path(self, song_id, stem):
        if stem not in STEM_LABELS:
            raise ValueError("Traccia non valida")
        return self.song_dir(song_id) / f"{stem}.flac"

    @staticmethod
    def _dir_size(path: Path):
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())

    def list_songs(self):
        songs = []
        for d in self.root.iterdir():
            meta_file = d / "meta.json"
            if not d.is_dir() or d.suffix == ".partial" or not meta_file.exists():
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            meta.pop("beats", None)  # i battiti si chiedono a parte, solo per il brano aperto
            meta["bytes"] = self._dir_size(d)
            songs.append(meta)
        songs.sort(key=lambda m: m.get("created", 0), reverse=True)
        return songs

    def snapshot(self):
        songs = self.list_songs()
        with self._jobs_lock:
            jobs = [dict(j) for j in self.jobs]
        return {
            "songs": songs,
            "jobs": jobs,
            "total_bytes": sum(s["bytes"] for s in songs),
            "library_path": str(self.root),
        }

    # ---------- coda di separazione ----------

    def enqueue(self, path):
        job = {
            "id": uuid.uuid4().hex,
            "title": Path(path).stem,
            "state": "queued",  # queued | running | done | error | cancelled
            "progress": 0.0,
            "message": "In coda",
        }
        with self._jobs_lock:
            self.jobs.append(job)
        self._queue.put((job["id"], str(path), threading.Event()))
        return job["id"]

    def _update_job(self, job_id, **changes):
        with self._jobs_lock:
            for j in self.jobs:
                if j["id"] == job_id:
                    j.update(changes)

    def _job_state(self, job_id):
        with self._jobs_lock:
            for j in self.jobs:
                if j["id"] == job_id:
                    return j["state"]
        return None

    def cancel_job(self, job_id):
        with self._jobs_lock:
            for j in self.jobs:
                if j["id"] == job_id and j["state"] in ("queued", "running"):
                    j["cancel"] = True
                    if j["state"] == "queued":
                        j["state"] = "cancelled"
                        j["message"] = "Annullato"
        return True

    def dismiss_job(self, job_id):
        with self._jobs_lock:
            self.jobs = [j for j in self.jobs
                         if not (j["id"] == job_id and j["state"] in ("done", "error", "cancelled"))]

    def _worker(self):
        while True:
            job_id, path, cancel_event = self._queue.get()
            if self._job_state(job_id) == "cancelled":
                continue
            self._run_job(job_id, path, cancel_event)

    def _run_job(self, job_id, path, cancel_event):
        partial = self.root / f"{job_id}.partial"

        def is_cancelled():
            with self._jobs_lock:
                for j in self.jobs:
                    if j["id"] == job_id and j.get("cancel"):
                        cancel_event.set()
            return cancel_event.is_set()

        def on_progress(frac):
            is_cancelled()
            self._update_job(job_id, progress=0.05 + 0.85 * frac,
                             message=f"Separazione {int(frac * 100)}%")

        try:
            self._update_job(job_id, state="running", progress=0.0,
                             message="Caricamento del modello (al primo avvio lo scarica)")
            sr = self.separator.samplerate
            self._update_job(job_id, progress=0.02, message="Lettura del file")
            wav = decode_audio(path, sr)
            if is_cancelled():
                raise SeparationCancelled()
            self._update_job(job_id, progress=0.05, message="Separazione 0%")
            stems = self.separator.separate(wav, on_progress, cancel_event)

            self._update_job(job_id, progress=0.92, message="Salvataggio delle tracce")
            partial.mkdir(parents=True, exist_ok=True)
            for name, data in stems.items():
                audio = np.clip(data.T, -1.0, 1.0)  # (n, 2)
                sf.write(partial / f"{name}.flac", audio, sr, subtype="PCM_24")

            self._update_job(job_id, progress=0.97, message="Rilevamento del tempo")
            ordered = [s for s in STEM_ORDER if s in stems] + \
                      [s for s in stems if s not in STEM_ORDER]
            meta = {
                "id": job_id,
                "title": Path(path).stem,
                "source_name": Path(path).name,
                "created": time.time(),
                "duration": wav.shape[1] / sr,
                "samplerate": sr,
                "stems": [{"name": s, "label": STEM_LABELS.get(s, s.title())} for s in ordered],
                "device": self.separator.device,
                "beats": self._detect_beats(stems, sr),
            }
            (partial / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                               encoding="utf-8")
            partial.rename(self.root / job_id)
            self._update_job(job_id, state="done", progress=1.0, message="Pronto")
        except SeparationCancelled:
            shutil.rmtree(partial, ignore_errors=True)
            self._update_job(job_id, state="cancelled", message="Annullato")
        except Exception as exc:  # noqa: BLE001 - l'errore va mostrato all'utente
            shutil.rmtree(partial, ignore_errors=True)
            self._update_job(job_id, state="error", message=str(exc)[:300] or "Errore sconosciuto")

    # ---------- tempo e metronomo ----------

    @staticmethod
    def _detect_beats(stems, sr):
        """stems: {nome: array (2, n)}. Se qualcosa va storto restituisce None, senza bloccare nulla."""
        try:
            mix = sum(s.mean(axis=0) for s in stems.values())
            low_parts = [stems[k].mean(axis=0) for k in ("bass", "drums") if k in stems]
            low = sum(low_parts) if low_parts else np.zeros(0, dtype=np.float32)
            result = analyze_beats_audio(mix, low, sr)
            if not result["times"]:
                return None
            result["offset_ms"] = 0
            return result
        except Exception:  # noqa: BLE001
            return None

    def _read_meta(self, song_id):
        return json.loads((self.song_dir(song_id) / "meta.json").read_text(encoding="utf-8"))

    def _write_meta(self, song_id, meta):
        path = self.song_dir(song_id) / "meta.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def get_beats(self, song_id):
        """Battiti del brano. Per i brani separati prima del metronomo li calcola ora e li salva."""
        meta = self._read_meta(song_id)
        if meta.get("beats"):
            return meta["beats"]
        d = self.song_dir(song_id)
        stems, sr = {}, None
        for stem in meta["stems"]:
            data, sr = sf.read(d / f"{stem['name']}.flac", dtype="float32")
            stems[stem["name"]] = data.T
        beats = self._detect_beats(stems, sr)
        if beats:
            meta["beats"] = beats
            self._write_meta(song_id, meta)
        return beats

    def save_beat_settings(self, song_id, phase, offset_ms):
        meta = self._read_meta(song_id)
        if not meta.get("beats"):
            return False
        meta["beats"]["phase"] = int(phase) % 4
        meta["beats"]["offset_ms"] = max(-200, min(200, int(offset_ms)))
        self._write_meta(song_id, meta)
        return True

    # ---------- eliminazione ed esportazione ----------

    def delete_song(self, song_id):
        d = self.song_dir(song_id)
        if d.exists():
            shutil.rmtree(d)
        return True

    def export_song(self, song_id, dest_dir, bits=24, include_click=False):
        """Restituisce (cartella, click_esportato)."""
        d = self.song_dir(song_id)
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        subtype = "PCM_16" if int(bits) == 16 else "PCM_24"
        title = safe_filename(meta["title"])
        out_dir = Path(dest_dir) / f"{title} - tracce"
        n = 2
        while out_dir.exists():
            out_dir = Path(dest_dir) / f"{title} - tracce ({n})"
            n += 1
        out_dir.mkdir(parents=True)
        length = None
        for stem in meta["stems"]:
            data, sr = sf.read(d / f"{stem['name']}.flac", dtype="float32")
            sf.write(out_dir / f"{title} - {stem['label']}.wav", data, sr, subtype=subtype)
            length = len(data) if length is None else min(length, len(data))

        click_done = False
        if include_click:
            beats = self.get_beats(song_id)
            if beats and beats.get("times"):
                click = render_click_track(beats, length, sr)
                sf.write(out_dir / f"{title} - Click.wav", np.stack([click, click], axis=1), sr, subtype=subtype)
                click_done = True
        return str(out_dir), click_done


def _click_sound(freq, amp, sr):
    """Stesso suono del metronomo dell'app: sinusoide breve con decadimento rapido."""
    i = np.arange(int(round(sr * 0.035)))
    return (np.sin(2 * np.pi * freq * i / sr) * np.exp(-i / (sr * 0.006)) * amp).astype(np.float32)


def render_click_track(beats, length, sr):
    """Traccia click lunga quanto il brano, con accento e correzioni salvate per quel brano."""
    out = np.zeros(length, dtype=np.float32)
    accent, beat = _click_sound(1760, 0.9, sr), _click_sound(1175, 0.6, sr)
    phase = int(beats.get("phase", 0))
    offset = beats.get("offset_ms", 0) / 1000.0
    for i, t in enumerate(beats["times"]):
        start = int(round((t + offset) * sr))
        if start < 0 or start >= length:
            continue
        snd = accent if (i - phase) % 4 == 0 else beat
        end = min(length, start + len(snd))
        out[start:end] += snd[: end - start]
    return out
