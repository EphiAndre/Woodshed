"""Rilevamento dei battiti (beat tracking) senza dipendenze pesanti.

Algoritmo di D. Ellis (2007), lo stesso alla base di librosa.beat:
1. curva di "attacco" (spectral flux su bande logaritmiche);
2. tempo medio con l'autocorrelazione di quella curva;
3. programmazione dinamica che sceglie i battiti: segue anche un tempo che varia,
   cosa essenziale per i brani registrati senza click.
"""

import numpy as np

N_FFT = 2048
HOP = 512


def _onset_envelope(y, sr, fmin=30.0, fmax=8000.0, n_bands=40):
    """Curva di attacco: aumento di energia, banda per banda, da un frame al successivo."""
    window = np.hanning(N_FFT).astype(np.float32)
    n_frames = 1 + max(0, (len(y) - N_FFT) // HOP)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    edges = np.geomspace(fmin, min(fmax, sr / 2 - 1), n_bands + 1)
    band_of = np.digitize(freqs, edges) - 1
    valid = (band_of >= 0) & (band_of < n_bands)

    bands = np.empty((n_frames, n_bands), dtype=np.float32)
    chunk = 2048
    for start in range(0, n_frames, chunk):
        idx = np.arange(start, min(n_frames, start + chunk))
        frames = np.lib.stride_tricks.sliding_window_view(y, N_FFT)[idx * HOP] * window
        power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
        acc = np.zeros((len(idx), n_bands), dtype=np.float32)
        for b in range(n_bands):
            cols = valid & (band_of == b)
            if cols.any():
                acc[:, b] = power[:, cols].sum(axis=1)
        bands[idx] = acc

    db = 10.0 * np.log10(bands + 1e-10)
    db = np.maximum(db, db.max() - 80.0)
    flux = np.maximum(0.0, np.diff(db, axis=0, prepend=db[:1])).mean(axis=1)
    # toglie l'andamento lento e normalizza
    k = int(round(sr / HOP))  # circa 1 secondo
    local_mean = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0.0, flux - local_mean)
    std = env.std()
    return env / std if std > 0 else env


def _estimate_period(env, frame_rate, start_bpm=120.0, std_octaves=1.0):
    """Periodo del battito in frame, pesando i tempi plausibili attorno a 120 BPM."""
    min_lag = int(frame_rate * 60.0 / 240.0)
    max_lag = int(frame_rate * 60.0 / 40.0)
    n = len(env)
    spec = np.fft.rfft(env, 2 * n)
    ac = np.fft.irfft(np.abs(spec) ** 2)[: max_lag + 2]
    lags = np.arange(len(ac), dtype=np.float64)
    bpm = np.where(lags > 0, 60.0 * frame_rate / np.maximum(lags, 1e-9), 0)
    weight = np.exp(-0.5 * (np.log2(np.maximum(bpm, 1e-9) / start_bpm) / std_octaves) ** 2)
    score = ac * weight
    score[:min_lag] = -np.inf
    score[max_lag + 1:] = -np.inf
    best = int(np.argmax(score))
    # rifinitura sub-frame (interpolazione parabolica)
    if 0 < best < len(score) - 1 and np.isfinite(score[best - 1]) and np.isfinite(score[best + 1]):
        a, b, c = score[best - 1], score[best], score[best + 1]
        denom = a - 2 * b + c
        if denom != 0:
            return best + 0.5 * (a - c) / denom
    return float(best)


def _track(env, period, tightness=100.0):
    """Sceglie la sequenza di battiti che massimizza attacchi + regolarità."""
    n = len(env)
    # attacchi smussati con una finestra gaussiana larga quanto il battito
    win = np.exp(-0.5 * (np.arange(-period, period + 1) * 32.0 / period) ** 2)
    local = np.convolve(env, win, mode="same")

    window = np.arange(-int(round(2 * period)), -int(round(period / 2)) + 1)
    txcost = -tightness * np.log(-window / period) ** 2

    score = np.zeros(n)
    back = np.full(n, -1, dtype=np.int64)
    first = True
    for i in range(n):
        z = i + window
        ok = z >= 0
        if not ok.any():
            score[i] = local[i]
            continue
        cand = score[z[ok]] + txcost[ok]
        j = int(np.argmax(cand))
        if first and local[i] < 0.01 * local.max():
            score[i] = local[i]  # all'inizio, nel silenzio, non si concatena
            continue
        first = False
        score[i] = local[i] + cand[j]
        back[i] = z[ok][j]

    # ultimo battito: il massimo locale più tardo con punteggio alto
    is_peak = np.r_[False, (score[1:-1] > score[:-2]) & (score[1:-1] >= score[2:]), False]
    peaks = np.flatnonzero(is_peak)
    if peaks.size == 0:
        return np.array([], dtype=np.int64), local
    thresh = 0.5 * np.median(score[peaks])
    last = peaks[score[peaks] >= thresh][-1]

    beats = [last]
    while back[beats[-1]] >= 0:
        beats.append(back[beats[-1]])
    beats = np.array(beats[::-1], dtype=np.int64)

    # toglie i battiti nel silenzio iniziale e finale
    strength = local[beats]
    rms = np.sqrt(np.mean(strength ** 2)) if strength.size else 0
    keep = np.flatnonzero(strength >= 0.5 * rms)
    if keep.size:
        beats = beats[keep[0]: keep[-1] + 1]
    return beats, local


def analyze(mix, low, sr, beats_per_bar=4):
    """mix e low: array mono float32. low = basso + batteria, usato per trovare il primo tempo.

    Restituisce {"bpm", "times" (secondi), "phase" (indice del primo battito accentato)}.
    """
    mix = np.asarray(mix, dtype=np.float32)
    frame_rate = sr / HOP
    env = _onset_envelope(mix, sr)
    if env.size < 4 or not np.any(env):
        return {"bpm": None, "times": [], "phase": 0}
    # Il tempo si stima su basso e batteria quando ci sono: i charleston in levare
    # tendono a far raddoppiare il BPM, mentre cassa e basso marcano i battiti veri.
    low = np.asarray(low, dtype=np.float32)
    low_env = None
    if low.size and np.any(low):
        low_env = _onset_envelope(low, sr, fmin=30.0, fmax=250.0, n_bands=12)
        n = min(len(env), len(low_env))
        low_env = low_env[:n]
        env = env[:n]
    period = _estimate_period(low_env if low_env is not None else env, frame_rate)
    beats, _ = _track(env + (low_env if low_env is not None else 0), period)
    if beats.size < 2:
        return {"bpm": None, "times": [], "phase": 0}

    # +12 ms: compensa il ritardo medio tra attacco reale e picco della curva (misurato)
    times = (beats * HOP + N_FFT / 2) / sr + 0.012
    bpm = 60.0 / float(np.median(np.diff(times)))

    # primo tempo della battuta: dove basso e cassa colpiscono più forte
    phase = 0
    if low_env is not None:
        idx = np.clip(beats, 0, len(low_env) - 1)
        strengths = [low_env[idx[k::beats_per_bar]].mean() for k in range(beats_per_bar)]
        phase = int(np.argmax(strengths))

    return {"bpm": round(bpm, 1), "times": [round(float(t), 4) for t in times], "phase": phase}
