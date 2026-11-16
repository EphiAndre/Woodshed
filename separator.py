"""Motore di separazione: decodifica l'audio con ffmpeg e lo separa con Demucs."""

import subprocess
import sys
import threading

import numpy as np

MODEL_NAME = "htdemucs_6s"  # 6 tracce: voce, batteria, basso, chitarra, piano, altro


class SeparationCancelled(Exception):
    pass


def _ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode_audio(path, samplerate):
    """Legge qualsiasi formato supportato da ffmpeg e restituisce un array float32 (2, n)."""
    cmd = [
        _ffmpeg_exe(), "-nostdin", "-v", "error", "-i", str(path),
        "-vn", "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "2", "-ar", str(samplerate), "-",
    ]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.run(cmd, capture_output=True, creationflags=flags)
    if proc.returncode != 0 or not proc.stdout:
        msg = proc.stderr.decode(errors="ignore").strip().splitlines()
        raise RuntimeError("Impossibile leggere il file audio. " + (msg[-1] if msg else ""))
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    return data.reshape(-1, 2).T.copy()


class StemSeparator:
    """Carica il modello una sola volta e lo riusa per tutti i brani."""

    def __init__(self):
        self._sep = None
        self._lock = threading.Lock()
        self.device = None

    @staticmethod
    def _pick_device():
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def _ensure_loaded(self):
        if self._sep is None:
            from demucs.api import Separator
            self.device = self._pick_device()
            self._sep = Separator(model=MODEL_NAME, device=self.device,
                                  shifts=1, overlap=0.25, split=True, progress=False)
        return self._sep

    @property
    def samplerate(self):
        return self._ensure_loaded().samplerate

    def separate(self, wav, progress_cb, cancel_event):
        """wav: np.ndarray (2, n). Restituisce {nome_traccia: np.ndarray (2, n)}."""
        import torch

        with self._lock:
            sep = self._ensure_loaded()
            best = [0.0]

            def callback(info):
                if cancel_event.is_set():
                    raise KeyboardInterrupt  # modo previsto da Demucs per interrompere
                if info.get("state") != "end":
                    return
                models = max(1, info.get("models", 1))
                length = max(1, info.get("audio_length", 1))
                frac = (info.get("model_idx_in_bag", 0)
                        + min(1.0, info.get("segment_offset", 0) / length)) / models
                if frac > best[0]:
                    best[0] = frac
                    progress_cb(frac)

            sep.update_parameter(callback=callback)
            tensor = torch.from_numpy(wav)
            try:
                _, stems = sep.separate_tensor(tensor)
            except KeyboardInterrupt:
                raise SeparationCancelled()
            except RuntimeError:
                # Alcune operazioni non sono supportate su GPU Apple: si riprova su CPU.
                if self.device == "cpu":
                    raise
                self.device = "cpu"
                sep.update_parameter(device="cpu")
                best[0] = 0.0
                try:
                    _, stems = sep.separate_tensor(tensor)
                except KeyboardInterrupt:
                    raise SeparationCancelled()

            return {name: s.detach().cpu().numpy() for name, s in stems.items()}
