import { SoundTouch, SimpleFilter } from './vendor/soundtouch.js';

const $ = (id) => document.getElementById(id);
const STEM_COLORS = {
  guitar: '#e8a24a', bass: '#7fa3c9', drums: '#c97a6b',
  vocals: '#d68fb0', piano: '#9fbf8a', other: '#a98fc4',
};
const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M4 19h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

// ---------------- ponte verso Python ----------------

const apiReady = new Promise((resolve) => {
  if (window.pywebview && window.pywebview.api) resolve(window.pywebview.api);
  else window.addEventListener('pywebviewready', () => resolve(window.pywebview.api));
});
async function api(method, ...args) {
  const a = await apiReady;
  return a[method](...args);
}

// ---------------- utilità ----------------

function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (b >= 1e9) return `${(b / 1e9).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(b / 1e6).toLocaleString('it-IT')} MB`;
}
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}
let toastTimer;
function toast(text, folder) {
  $('toastText').textContent = text;
  const btn = $('toastAction');
  btn.hidden = !folder;
  btn.onclick = () => api('open_folder', folder);
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), folder ? 8000 : 3500);
}

// ---------------- motore audio ----------------
// Le tracce vengono mixate in tempo reale (volume, mute, solo) e poi passano
// in SoundTouch, che cambia velocità e tonalità in modo indipendente.
// Il click del metronomo si aggiunge DOPO SoundTouch: resta secco e non cambia di tono.

class Engine {
  constructor() {
    this.ctx = null;
    this.tracks = [];
    this.length = 0;
    this.readPos = 0;
    this.playing = false;
    this.loopA = null;
    this.loopB = null;
    this.loopOn = false;
    this.BUF = 4096;
    this.onEnded = () => {};
    // metronomo
    this.metroOn = false;
    this.metroGain = 0.49;
    this.beatFrames = null;   // posizione di ogni battito, in frame del brano
    this.beatAccent = null;   // 1 sul primo tempo della battuta
    this.clickPos = 0;        // punto del brano che sta uscendo ora da SoundTouch
    this.activeClicks = [];
  }

  _ensureContext() {
    if (this.ctx) return;
    try { this.ctx = new AudioContext({ sampleRate: 44100 }); }
    catch { this.ctx = new AudioContext(); }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.st = new SoundTouch();
    const source = { extract: (target, n) => this._mix(target, n) };
    this.filter = new SimpleFilter(source, this.st);
    this.samples = new Float32Array(this.BUF * 2);
    this.node = this.ctx.createScriptProcessor(this.BUF, 2, 2);
    this.node.onaudioprocess = (e) => this._process(e);
    this.clicks = { accent: this._makeClick(1760, 0.9), beat: this._makeClick(1175, 0.6) };
  }

  _makeClick(freq, amp) {
    const sr = this.ctx.sampleRate;
    const len = Math.round(sr * 0.035);
    const b = new Float32Array(len);
    for (let i = 0; i < len; i++) b[i] = Math.sin(2 * Math.PI * freq * i / sr) * Math.exp(-i / (sr * 0.006)) * amp;
    return b;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }
  get duration() { return this.length / this.sampleRate; }

  async load(songId, stems, onProgress) {
    this._ensureContext();
    this.pause();
    this.tracks = [];
    this.length = 0;
    this.beatFrames = null;
    let done = 0;
    const decoded = await Promise.all(stems.map(async (s) => {
      const res = await fetch(`/stems/${songId}/${s.name}.flac`);
      if (!res.ok) throw new Error(`Traccia ${s.label} non trovata`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      onProgress(++done / stems.length);
      return buf;
    }));
    this.tracks = stems.map((s, i) => {
      const b = decoded[i];
      return {
        name: s.name, label: s.label,
        L: b.getChannelData(0),
        R: b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0),
        volume: 1, mute: false, solo: false, lastGain: 1,
      };
    });
    this.length = Math.min(...decoded.map((b) => b.length));
    this.clearLoop();
    this.seek(0);
  }

  unload() {
    this.pause();
    this.tracks = [];
    this.length = 0;
    this.beatFrames = null;
  }

  _targetGain(t, anySolo) {
    if (t.mute) return 0;
    if (anySolo && !t.solo) return 0;
    return t.volume * t.volume; // curva più naturale per l'orecchio
  }

  // Chiamata da SoundTouch quando ha bisogno di audio sorgente
  _mix(target, numFrames) {
    const anySolo = this.tracks.some((t) => t.solo);
    let pos = this.readPos;
    let written = 0;
    target.fill(0, 0, numFrames * 2);
    while (written < numFrames) {
      const end = this.loopOn ? this.loopB : this.length;
      if (pos >= end) {
        if (this.loopOn) pos = this.loopA; else break;
      }
      const n = Math.min(numFrames - written, end - pos);
      for (const t of this.tracks) {
        const g1 = this._targetGain(t, anySolo);
        const g0 = t.lastGain;
        if (g0 === 0 && g1 === 0) continue;
        const { L, R } = t;
        for (let i = 0; i < n; i++) {
          const g = g0 + (g1 - g0) * (i / n); // rampa breve: niente click
          const o = (written + i) * 2;
          target[o] += L[pos + i] * g;
          target[o + 1] += R[pos + i] * g;
        }
        t.lastGain = g1;
      }
      written += n;
      pos += n;
    }
    this.readPos = pos;
    return written;
  }

  _process(e) {
    const left = e.outputBuffer.getChannelData(0);
    const right = e.outputBuffer.getChannelData(1);
    const n = this.filter.extract(this.samples, this.BUF);
    for (let i = 0; i < n; i++) {
      left[i] = this.samples[i * 2];
      right[i] = this.samples[i * 2 + 1];
    }
    left.fill(0, n);
    right.fill(0, n);
    if (n > 0) this._renderClicks(left, right, n);
    if (n === 0 && !this.loopOn && this.readPos >= this.length) {
      setTimeout(() => { this.pause(); this.seek(0); this.onEnded(); }, 0);
    }
  }

  // ---------- metronomo ----------

  setBeats(times, phase, offsetMs) {
    if (!times || !times.length) { this.beatFrames = null; return; }
    const sr = this.sampleRate;
    const off = (offsetMs || 0) / 1000;
    this.beatFrames = Float64Array.from(times, (t) => (t + off) * sr);
    this.beatAccent = Uint8Array.from(times, (_, i) => (((i - phase) % 4) + 4) % 4 === 0 ? 1 : 0);
  }

  _firstBeatFrom(f) {
    const b = this.beatFrames;
    let lo = 0, hi = b.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] < f) lo = m + 1; else hi = m; }
    return lo;
  }

  // Ogni blocco d'uscita copre (frame × velocità) frame del brano: lì cadono i click.
  _renderClicks(left, right, n) {
    const tempo = this.st.virtualTempo || 1;
    let s = this.clickPos;
    let remaining = n * tempo;
    let out = 0;
    while (remaining > 1e-6) {
      let segEnd = s + remaining;
      if (this.loopOn && segEnd > this.loopB) segEnd = Math.max(this.loopB, s);
      if (this.metroOn && this.beatFrames) {
        const bf = this.beatFrames;
        for (let i = this._firstBeatFrom(s); i < bf.length && bf[i] < segEnd; i++) {
          this.activeClicks.push({
            buf: this.beatAccent[i] ? this.clicks.accent : this.clicks.beat,
            at: Math.round(out + (bf[i] - s) / tempo), pos: 0,
          });
        }
      }
      const used = segEnd - s;
      out += used / tempo;
      remaining -= used;
      s = segEnd;
      if (this.loopOn && s >= this.loopB) s = this.loopA;
      else if (used <= 0) break;
    }
    this.clickPos = s;

    const g = this.metroGain;
    this.activeClicks = this.activeClicks.filter((c) => {
      for (let k = Math.max(0, c.at); k < n && c.pos < c.buf.length; k++, c.pos++) {
        const v = c.buf[c.pos] * g;
        left[k] += v;
        right[k] += v;
      }
      c.at = Math.max(0, c.at - n);
      return c.pos < c.buf.length;
    });
  }

  // Posizione che si sta ascoltando ora (tiene conto dell'audio ancora nei buffer)
  get position() {
    if (!this.ctx || !this.length) return 0;
    const tempo = this.st.virtualTempo || 1;
    const pendingOut = Math.max(0, this.filter.outputBuffer.frameCount - this.filter.outputBufferPosition);
    const lag = this.filter.inputBuffer.frameCount + (pendingOut + (this.playing ? this.BUF : 0)) * tempo;
    let p = this.readPos - lag;
    if (this.loopOn && p < this.loopA) p += (this.loopB - this.loopA);
    return Math.min(this.length, Math.max(0, p)) / this.sampleRate;
  }

  async play() {
    if (!this.length) return;
    this._ensureContext();
    await this.ctx.resume();
    if (this.loopOn && (this.readPos < this.loopA || this.readPos >= this.loopB)) this.seek(this.loopA / this.sampleRate);
    if (!this.playing) {
      this.node.connect(this.master);
      this.playing = true;
    }
  }

  pause() {
    if (this.playing) {
      const p = this.position;
      this.node.disconnect();
      this.playing = false;
      this.seek(p);
    }
  }

  seek(sec) {
    if (!this.filter) return;
    this.readPos = Math.max(0, Math.min(this.length - 1, Math.round(sec * this.sampleRate)));
    this.filter.clear();
    this.clickPos = this.readPos;
    this.activeClicks = [];
  }

  setTempo(ratio) { this._ensureContext(); this.st.tempo = ratio; }
  setPitch(semitones) {
    this._ensureContext();
    this.st.pitchSemitones = semitones;
    this.seek(this.position);
  }
  setMaster(v) { this._ensureContext(); this.master.gain.value = v * v; }

  setLoop(aSec, bSec) {
    let a = Math.round(aSec * this.sampleRate);
    let b = Math.round(bSec * this.sampleRate);
    if (a > b) [a, b] = [b, a];
    if (b - a < this.sampleRate * 0.25) return false; // loop troppo corto
    this.loopA = Math.max(0, a);
    this.loopB = Math.min(this.length, b);
    return true;
  }
  clearLoop() { this.loopA = this.loopB = null; this.loopOn = false; }
}

const engine = new Engine();

// ---------------- stato dell'app ----------------

let library = { songs: [], jobs: [], total_bytes: 0 };
let current = null;      // brano aperto
let peaks = null;        // forma d'onda
let pendingA = null;     // inizio loop segnato, in attesa della fine
let pollTimer = null;
let beatInfo = null;     // { bpm, times, phase, offset_ms } del brano aperto

async function refresh() {
  try { library = await api('get_state'); } catch (err) { console.error(err); return; }
  renderJobs();
  renderSongs();
  $('diskTotal').textContent = fmtBytes(library.total_bytes);
  const active = library.jobs.some((j) => j.state === 'queued' || j.state === 'running');
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(refresh, 700);
  if (current && !library.songs.some((s) => s.id === current.id)) closeSong();
}

function renderJobs() {
  const box = $('jobs');
  box.replaceChildren(...library.jobs.map((j) => {
    const finished = ['done', 'error', 'cancelled'].includes(j.state);
    const action = finished
      ? el('button', { class: 'link', text: 'Chiudi', onclick: async () => { await api('dismiss_job', j.id); refresh(); } })
      : el('button', { class: 'link', text: 'Annulla', onclick: async () => { await api('cancel_job', j.id); refresh(); } });
    return el('div', { class: `job ${j.state}` }, [
      el('div', { class: 'row' }, [el('span', { class: 'title', text: j.title }), action]),
      el('div', { class: 'msg', text: j.message }),
      finished ? null : el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(j.progress * 100)}%` })]),
    ]);
  }));
}

function renderSongs() {
  const ul = $('songs');
  if (!library.songs.length) {
    ul.replaceChildren(el('li', { class: 'empty-lib', text: 'La libreria è vuota.' }));
    return;
  }
  ul.replaceChildren(...library.songs.map((s) => el('li', {
    class: `song${current && current.id === s.id ? ' active' : ''}`,
    tabindex: '0',
    onclick: () => openSong(s),
    onkeydown: (e) => { if (e.key === 'Enter') openSong(s); },
  }, [
    el('span', { class: 't', text: s.title, title: s.title }),
    el('span', { class: 'm num', text: `${fmtTime(s.duration)}, ${fmtBytes(s.bytes)}` }),
    el('span', { class: 'acts' }, [
      el('button', { class: 'icon', 'aria-label': `Esporta ${s.title}`, title: 'Esporta per la DAW', html: ICONS.export,
        onclick: (e) => { e.stopPropagation(); openExport(s); } }),
      el('button', { class: 'icon del', 'aria-label': `Elimina ${s.title}`, title: 'Elimina', html: ICONS.trash,
        onclick: (e) => { e.stopPropagation(); openDelete(s); } }),
    ]),
  ])));
}

// ---------------- apertura brano ----------------

async function openSong(song) {
  if (current && current.id === song.id) return;
  current = song;
  renderSongs();
  $('welcome').hidden = true;
  $('player').hidden = false;
  $('songTitle').textContent = song.title;
  $('songMeta').textContent = `${fmtTime(song.duration)} min, ${song.stems.length} tracce, ${fmtBytes(song.bytes)} su disco`;
  $('loading').hidden = false;
  $('loading').textContent = 'Caricamento delle tracce…';
  peaks = null;
  pendingA = null;
  beatInfo = null;
  setMetroControls(false);
  updateBpm();
  drawWave();
  buildMixer(song.stems);
  try {
    await engine.load(song.id, song.stems, (p) => { $('loading').textContent = `Caricamento delle tracce ${Math.round(p * 100)}%`; });
    if (current !== song) return;
    computePeaks();
    $('loading').hidden = true;
    applyPracticeSettings();
    updateLoopUi();
    updateTransport();
  } catch (err) {
    $('loading').textContent = `Impossibile caricare il brano: ${err.message}`;
    return;
  }
  loadBeats(song);
}

function closeSong() {
  engine.unload();
  current = null;
  peaks = null;
  beatInfo = null;
  $('player').hidden = true;
  $('welcome').hidden = false;
  renderSongs();
}

// ---------------- forma d'onda ----------------

function computePeaks() {
  const bins = 1200;
  const step = Math.max(1, Math.floor(engine.length / bins));
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let max = 0;
    const start = b * step;
    for (let i = start; i < start + step && i < engine.length; i += 8) {
      let v = 0;
      for (const t of engine.tracks) v += t.L[i] + t.R[i];
      v = Math.abs(v) / 2;
      if (v > max) max = v;
    }
    out[b] = max;
  }
  const top = Math.max(...out, 0.01);
  peaks = out.map((v) => v / top);
}

function drawWave() {
  const c = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!peaks || !engine.length) return;
  const css = getComputedStyle(document.documentElement);
  const cream = css.getPropertyValue('--cream').trim();
  const muted = css.getPropertyValue('--line').trim();
  const jewel = css.getPropertyValue('--jewel').trim();
  const dur = engine.duration;

  if (engine.loopA !== null) {
    const x0 = (engine.loopA / engine.length) * w;
    const x1 = (engine.loopB / engine.length) * w;
    g.fillStyle = engine.loopOn ? 'rgba(240,166,58,.22)' : 'rgba(240,166,58,.10)';
    g.fillRect(x0, 0, x1 - x0, h);
    g.fillStyle = jewel;
    g.fillRect(x0, 0, 2, h);
    g.fillRect(x1 - 2, 0, 2, h);
  }
  if (pendingA !== null) {
    g.fillStyle = jewel;
    g.fillRect((pendingA / dur) * w, 0, 2, h);
  }

  const pos = engine.position;
  const px = (pos / dur) * w;
  const mid = h / 2;
  const barW = 2;
  for (let x = 0; x < w; x += barW + 1) {
    const v = peaks[Math.floor((x / w) * peaks.length)] || 0;
    const bh = Math.max(1, v * (h * 0.42));
    g.fillStyle = x < px ? cream : muted;
    g.fillRect(x, mid - bh, barW, bh * 2);
  }
  g.fillStyle = cream;
  g.fillRect(px - 1, 0, 2, h);
}

// clic = spostati, trascinamento = crea un loop
(function setupWaveInput() {
  const wrap = $('waveWrap');
  let downX = null;
  const toSec = (x) => (x / wrap.clientWidth) * engine.duration;
  wrap.addEventListener('pointerdown', (e) => {
    if (!engine.length) return;
    downX = e.offsetX;
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (downX === null || Math.abs(e.offsetX - downX) < 5) return;
    if (engine.setLoop(toSec(downX), toSec(Math.max(0, Math.min(wrap.clientWidth, e.offsetX))))) {
      engine.loopOn = true;
      pendingA = null;
      updateLoopUi();
    }
  });
  wrap.addEventListener('pointerup', (e) => {
    if (downX === null) return;
    if (Math.abs(e.offsetX - downX) < 5) engine.seek(toSec(downX));
    else if (engine.loopOn) engine.seek(engine.loopA / engine.sampleRate);
    downX = null;
    updateTransport();
  });
})();

// ---------------- trasporto e loop ----------------

function updateTransport() {
  const btn = $('playBtn');
  btn.innerHTML = engine.playing ? ICONS.pause : ICONS.play;
  btn.setAttribute('aria-label', engine.playing ? 'Pausa' : 'Riproduci');
  $('time').innerHTML = `${fmtTime(engine.position)} <span>/ ${fmtTime(engine.duration)}</span>`;
  drawWave();
}

function updateLoopUi() {
  const has = engine.loopA !== null;
  $('loopBtn').disabled = !has;
  $('clearLoop').disabled = !has && pendingA === null;
  $('loopBtn').setAttribute('aria-pressed', String(engine.loopOn));
  if (has) {
    const sr = engine.sampleRate;
    $('loopInfo').textContent = `Loop da ${fmtTime(engine.loopA / sr)} a ${fmtTime(engine.loopB / sr)}`;
  } else if (pendingA !== null) {
    $('loopInfo').textContent = `Inizio a ${fmtTime(pendingA)}, ora segna la fine`;
  } else {
    $('loopInfo').textContent = '';
  }
  drawWave();
}

async function togglePlay() {
  if (!engine.length) return;
  if (engine.playing) engine.pause(); else await engine.play();
  updateTransport();
}

function markA() {
  if (!engine.length) return;
  pendingA = engine.position;
  engine.clearLoop();
  updateLoopUi();
}
function markB() {
  if (!engine.length) return;
  const a = pendingA !== null ? pendingA : (engine.loopA !== null ? engine.loopA / engine.sampleRate : 0);
  if (engine.setLoop(a, engine.position)) {
    engine.loopOn = true;
    pendingA = null;
    updateLoopUi();
  } else {
    toast('Il loop deve durare almeno un quarto di secondo');
  }
}
function toggleLoop() {
  if (engine.loopA === null) return;
  engine.loopOn = !engine.loopOn;
  updateLoopUi();
}
function clearLoop() {
  engine.clearLoop();
  pendingA = null;
  updateLoopUi();
}

engine.onEnded = updateTransport;
$('playBtn').addEventListener('click', togglePlay);
$('setA').addEventListener('click', markA);
$('setB').addEventListener('click', markB);
$('loopBtn').addEventListener('click', toggleLoop);
$('clearLoop').addEventListener('click', clearLoop);

(function tick() {
  if (engine.playing) updateTransport();
  requestAnimationFrame(tick);
})();
window.addEventListener('resize', drawWave);

// ---------------- velocità e tonalità ----------------

function applyPracticeSettings() {
  const speed = Number($('speed').value);
  const pitch = Number($('pitch').value);
  $('speedVal').textContent = `${speed}%`;
  $('pitchVal').textContent = pitch === 0 ? '0 semitoni'
    : `${pitch > 0 ? '+' : '−'}${Math.abs(pitch)} ${Math.abs(pitch) === 1 ? 'semitono' : 'semitoni'}`;
  engine.setTempo(speed / 100);
  if (engine._lastPitch !== pitch) { engine.setPitch(pitch); engine._lastPitch = pitch; }
  updateBpm();
}
$('speed').addEventListener('input', applyPracticeSettings);
$('pitch').addEventListener('input', applyPracticeSettings);
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
  $('speed').value = Number($('speed').value) + Number(b.dataset.speed);
  applyPracticeSettings();
}));
document.querySelectorAll('[data-pitch]').forEach((b) => b.addEventListener('click', () => {
  $('pitch').value = Number($('pitch').value) + Number(b.dataset.pitch);
  applyPracticeSettings();
}));
$('speedVal').addEventListener('dblclick', () => { $('speed').value = 100; applyPracticeSettings(); });
$('pitchVal').addEventListener('dblclick', () => { $('pitch').value = 0; applyPracticeSettings(); });

// ---------------- metronomo e BPM ----------------

function setMetroControls(enabled) {
  $('metroBtn').disabled = !enabled;
  $('accentBtn').disabled = !enabled;
  document.querySelectorAll('[data-offset]').forEach((b) => { b.disabled = !enabled; });
}

function metroMessage(text) {
  $('metroMsg').textContent = text || '';
  $('metroMsg').hidden = !text;
}

// BPM mostrato = BPM del brano × velocità, perché è il tempo che stai suonando
function updateBpm() {
  if (!beatInfo || !beatInfo.bpm) { $('bpmVal').textContent = '– BPM'; return; }
  const speed = Number($('speed').value) / 100;
  $('bpmVal').textContent = `${Math.round(beatInfo.bpm * speed)} BPM`;
  metroMessage(speed === 1 ? '' : `Originale ${Math.round(beatInfo.bpm)} BPM, il click segue la velocità.`);
}

function applyBeats() {
  engine.setBeats(beatInfo.times, beatInfo.phase, beatInfo.offset_ms);
  const ms = beatInfo.offset_ms;
  $('offsetVal').textContent = `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;
}

async function loadBeats(song) {
  metroMessage('Rilevo il tempo del brano…');
  let info = null;
  try { info = await api('get_beats', song.id); } catch (err) { console.error(err); }
  if (current !== song) return;
  if (!info || !info.times || !info.times.length) {
    metroMessage('Tempo non rilevato: il metronomo non è disponibile per questo brano.');
    return;
  }
  beatInfo = { ...info, offset_ms: info.offset_ms || 0, phase: info.phase || 0 };
  applyBeats();
  setMetroControls(true);
  updateBpm();
}

function saveBeatSettings() {
  if (current && beatInfo) api('save_beat_settings', current.id, beatInfo.phase, beatInfo.offset_ms);
}

$('metroBtn').addEventListener('click', () => {
  engine.metroOn = !engine.metroOn;
  $('metroBtn').setAttribute('aria-pressed', String(engine.metroOn));
  $('metroBtn').textContent = engine.metroOn ? 'Acceso' : 'Spento';
});
$('metroVol').addEventListener('input', () => {
  const v = Number($('metroVol').value) / 100;
  engine.metroGain = v * v;
});
$('accentBtn').addEventListener('click', () => {
  if (!beatInfo) return;
  beatInfo.phase = (beatInfo.phase + 1) % 4;
  applyBeats();
  saveBeatSettings();
});
document.querySelectorAll('[data-offset]').forEach((b) => b.addEventListener('click', () => {
  if (!beatInfo) return;
  beatInfo.offset_ms = Math.max(-200, Math.min(200, beatInfo.offset_ms + Number(b.dataset.offset)));
  applyBeats();
  saveBeatSettings();
}));

// ---------------- mixer ----------------

function makeFader(initial, color, onChange) {
  const f = el('div', { class: 'fader', tabindex: '0', role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  if (color) f.style.setProperty('--c', color);
  const fill = el('div', { class: 'fill' });
  const cap = el('div', { class: 'cap' });
  f.append(fill, cap);
  let value = initial;
  const set = (v) => {
    value = Math.max(0, Math.min(1, v));
    const pad = 6;
    const span = f.clientHeight - pad * 2 || 178;
    cap.style.top = `${pad + (1 - value) * span}px`;
    fill.style.height = `${value * span}px`;
    f.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    onChange(value);
  };
  const fromY = (y) => 1 - (y - 6) / (f.clientHeight - 12);
  f.addEventListener('pointerdown', (e) => { f.setPointerCapture(e.pointerId); set(fromY(e.offsetY)); });
  f.addEventListener('pointermove', (e) => { if (f.hasPointerCapture(e.pointerId)) set(fromY(e.offsetY)); });
  f.addEventListener('dblclick', () => set(initial));
  f.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(value + 0.05); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(value - 0.05); e.preventDefault(); e.stopPropagation(); }
  });
  requestAnimationFrame(() => set(value));
  return f;
}

function buildMixer(stems) {
  const mixer = $('mixer');
  const strips = stems.map((s) => {
    const color = STEM_COLORS[s.name] || '#ede3cf';
    const jewel = el('div', { class: 'jewel', title: 'Acceso quando la traccia è in solo' });
    const pct = el('div', { class: 'pct num', text: '100%' });
    const strip = el('div', { class: 'strip' });
    strip.style.setProperty('--c', color);
    const trackOf = () => engine.tracks.find((t) => t.name === s.name);
    const fader = makeFader(1, color, (v) => {
      pct.textContent = `${Math.round(v * 100)}%`;
      const t = trackOf(); if (t) t.volume = v;
    });
    const mute = el('button', { class: 'mute', 'aria-pressed': 'false', title: 'Silenzia', text: 'M' });
    const solo = el('button', { class: 'solo', 'aria-pressed': 'false', title: 'Ascolta solo questa', text: 'S' });
    mute.addEventListener('click', () => {
      const t = trackOf(); if (!t) return;
      t.mute = !t.mute; refreshStrips();
    });
    solo.addEventListener('click', () => {
      const t = trackOf(); if (!t) return;
      t.solo = !t.solo; refreshStrips();
    });
    strip.append(jewel, el('div', { class: 'name', text: s.label }), fader, pct, el('div', { class: 'ms' }, [mute, solo]));
    strip._refs = { name: s.name, jewel, mute, solo };
    return strip;
  });
  const mpct = el('div', { class: 'pct num', text: '90%' });
  const master = el('div', { class: 'strip master' }, [
    el('div', { class: 'jewel on', title: 'Volume generale' }),
    el('div', { class: 'name', text: 'Generale' }),
    makeFader(0.9, null, (v) => { mpct.textContent = `${Math.round(v * 100)}%`; engine.setMaster(v); }),
    mpct,
  ]);
  mixer.replaceChildren(...strips, master);
}

function refreshStrips() {
  const anySolo = engine.tracks.some((t) => t.solo);
  document.querySelectorAll('.strip:not(.master)').forEach((strip) => {
    const r = strip._refs;
    const t = engine.tracks.find((x) => x.name === r.name);
    if (!t) return;
    r.mute.setAttribute('aria-pressed', String(t.mute));
    r.solo.setAttribute('aria-pressed', String(t.solo));
    r.jewel.classList.toggle('on', t.solo);
    strip.classList.toggle('silent', t.mute || (anySolo && !t.solo));
  });
}

// ---------------- esporta ed elimina ----------------

let exportSong = null;
let exportBits = 24;
let exportClick = false;
function openExport(song) {
  exportSong = song;
  $('exportDlg').showModal();
}
document.querySelectorAll('[data-bits]').forEach((b) => b.addEventListener('click', () => {
  exportBits = Number(b.dataset.bits);
  document.querySelectorAll('[data-bits]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
$('exportClick').addEventListener('click', () => {
  exportClick = !exportClick;
  $('exportClick').setAttribute('aria-pressed', String(exportClick));
});
$('exportCancel').addEventListener('click', () => $('exportDlg').close());
$('exportGo').addEventListener('click', async () => {
  $('exportDlg').close();
  toast('Esportazione in corso…');
  const res = await api('export_song', exportSong.id, exportBits, exportClick);
  const folderName = res.ok ? res.path.split(/[\\/]/).pop() : '';
  if (res.ok && exportClick && !res.click) toast(`Tracce esportate in "${folderName}", senza click: tempo non rilevato`, res.path);
  else if (res.ok) toast(`Tracce esportate in "${folderName}"`, res.path);
  else if (res.error) toast(`Esportazione non riuscita: ${res.error}`);
  else $('toast').classList.remove('show');
});

let deleteSong = null;
function openDelete(song) {
  deleteSong = song;
  $('deleteText').textContent = `"${song.title}" e le sue ${song.stems.length} tracce verranno cancellati dal disco, liberando ${fmtBytes(song.bytes)}. Le tracce già esportate non vengono toccate.`;
  $('deleteDlg').showModal();
}
$('deleteCancel').addEventListener('click', () => $('deleteDlg').close());
$('deleteGo').addEventListener('click', async () => {
  $('deleteDlg').close();
  if (current && current.id === deleteSong.id) closeSong();
  await api('delete_song', deleteSong.id);
  toast(`Brano eliminato, liberati ${fmtBytes(deleteSong.bytes)}`);
  refresh();
});

// ---------------- libreria e scorciatoie ----------------

$('addBtn').addEventListener('click', async () => {
  const n = await api('add_songs');
  if (n) refresh();
});
$('openLib').addEventListener('click', () => api('open_library_folder'));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, dialog') || e.metaKey || e.ctrlKey || !current) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') {
    e.preventDefault();
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    togglePlay();
  }
  else if (k === 'arrowleft') { engine.seek(engine.position - 5); updateTransport(); }
  else if (k === 'arrowright') { engine.seek(engine.position + 5); updateTransport(); }
  else if (k === 'a') markA();
  else if (k === 'b') markB();
  else if (k === 'l') toggleLoop();
});

refresh();
