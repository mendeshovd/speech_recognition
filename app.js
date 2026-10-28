(() => {
'use strict';

const $ = id => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const FILLER_RE = /\b(?:um+|uh+|erm?|hmm+|you know|i mean|kind of|sort of|basically|actually|literally)\b/gi;
const LT_SKIP = new Set(['TYPOGRAPHY', 'PUNCTUATION', 'CASING', 'TYPOS']);
const LT_OFF = 'UPPERCASE_SENTENCE_START,PUNCTUATION_PARAGRAPH_END,WHITESPACE_RULE,EN_QUOTES,COMMA_PARENTHESIS_WHITESPACE,SENTENCE_WHITESPACE,EN_UNPAIRED_BRACKETS';
const LEVELS = { A2: 'A2 (elementary)', B1: 'B1 (intermediate)', B2: 'B2 (upper-intermediate)', C1: 'C1 (advanced)' };
const KEY_STORE = 'speakingcheck.key';

const S = { cards: [], nextId: 1, listening: false, starting: false, startedAt: 0, activeMs: 0 };
let rec = null, want = false, tick = null, lastError = '', clearArmed = 0;
const meter = { stream: null, ctx: null, raf: 0 };

const feed = $('feed'), liveText = $('liveText'), statusEl = $('status');
const toggle = $('toggle'), toggleLabel = $('toggleLabel'), meterBar = $('meterBar');
const keyEl = $('apiKey'), rememberEl = $('remember');

/* ---------- small helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const countWords = t => t.split(/\s+/).filter(Boolean).length;
const countFillers = t => (t.match(FILLER_RE) || []).length;
const fmt = ms => {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const elapsed = () => S.activeMs + (S.listening ? Date.now() - S.startedAt : 0);
const aiOn = () => $('aiToggle').checked && keyEl.value.trim().length > 20;
const isFlagged = c => (c.lt && c.lt.length > 0) || (c.ai && (!c.ai.ok || c.ai.issues.length > 0));

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', !!isErr);
}
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- marking a sentence ---------- */
function buildMarks(c) {
  const marks = [];
  (c.lt || []).forEach(m => { if (m.length > 0) marks.push({ start: m.offset, end: m.offset + m.length, type: 'err' }); });
  for (const m of c.text.matchAll(FILLER_RE)) {
    const s = m.index, e = s + m[0].length;
    if (!marks.some(x => x.type === 'err' && s < x.end && e > x.start)) marks.push({ start: s, end: e, type: 'fill' });
  }
  marks.sort((a, b) => a.start - b.start);
  const out = [];
  let last = 0;
  for (const m of marks) { if (m.start < last) continue; out.push(m); last = m.end; }
  return out;
}
function renderMarked(p, text, marks) {
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) p.append(text.slice(pos, m.start));
    p.append(el('span', m.type === 'err' ? 'mark-err' : 'mark-fill', text.slice(m.start, m.end)));
    pos = m.end;
  }
  if (pos < text.length) p.append(text.slice(pos));
}
function applyLT(text, matches) {
  let out = text, limit = Infinity;
  [...matches].filter(m => m.length > 0 && m.replacement).sort((a, b) => b.offset - a.offset).forEach(m => {
    if (m.offset + m.length > limit) return;
    out = out.slice(0, m.offset) + m.replacement + out.slice(m.offset + m.length);
    limit = m.offset;
  });
  return out;
}
function correctedFor(c) {
  if (c.ai && c.ai.corrected) return c.ai.corrected;
  if (c.lt && c.lt.length) return applyLT(c.text, c.lt);
  return '';
}

function renderCard(c) {
  const n = c.node;
  n.replaceChildren();
  n.className = 'card' + (c.example ? ' example' : '');

  const head = el('div', 'card-head');
  head.append(el('span', null, c.example ? 'Example' : '#' + c.id));
  const spacer = el('span', 'spacer', c.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  head.append(spacer);
  if (c.cut) {
    const chip = el('span', 'chip low', 'unclear audio, end cut');
    chip.title = 'The speech model got stuck repeating sounds here, so the rest of this sentence was removed. Listen to this part yourself.';
    head.append(chip);
  }
  if (typeof c.confidence === 'number' && c.confidence > 0) {
    const pct = Math.round(c.confidence * 100);
    const low = c.confidence < 0.8;
    const chip = el('span', 'chip' + (low ? ' low' : ''), low ? 'unclear audio ' + pct + '%' : 'clarity ' + pct + '%');
    chip.title = 'How sure the speech recognizer was about this sentence. A low score can point to unclear pronunciation or background noise.';
    head.append(chip);
  }
  n.append(head);

  const p = el('p', 'said');
  renderMarked(p, c.text, buildMarks(c));
  n.append(p);

  const fixed = correctedFor(c);
  if (fixed && norm(fixed) !== norm(c.text)) n.append(el('p', 'fixed', '→ ' + fixed));

  if (c.ltStatus === 'checking') n.append(el('p', 'pending', 'Checking grammar…'));
  if (c.ltStatus === 'error') n.append(el('p', 'pending', c.ltError));
  if (c.lt && c.lt.length) {
    const ul = el('ul', 'notes');
    c.lt.forEach(m => {
      const li = el('li');
      const wrong = c.text.slice(m.offset, m.offset + m.length);
      if (wrong) {
        li.append(el('span', 'wrong', wrong));
        if (m.replacement) { li.append(' → ', el('span', 'right', m.replacement)); }
        li.append(' ');
      }
      li.append(el('span', 'why', m.message));
      ul.append(li);
    });
    n.append(ul);
  }

  if (c.aiStatus !== 'off') {
    const box = el('div', 'ai');
    box.append(el('span', 'tag', 'Claude'));
    if (c.aiStatus === 'checking') box.append(el('p', 'pending', 'Claude is reading…'));
    else if (c.aiStatus === 'error') box.append(el('p', 'pending', c.aiError));
    else if (c.ai) {
      if (c.ai.ok && !c.ai.issues.length) box.append(el('p', 'okline', 'No problems found.'));
      c.ai.issues.forEach(i => {
        const row = el('p');
        row.append(el('span', 'wrong', i.wrong), ' → ', el('span', 'right', i.right));
        if (i.why) row.append(' ', el('span', 'why', i.why));
        box.append(row);
      });
      const nat = c.ai.natural;
      if (nat && norm(nat) !== norm(c.text) && norm(nat) !== norm(c.ai.corrected)) {
        const row = el('p', 'natural');
        row.append(el('span', 'lead', 'More natural: '), nat);
        box.append(row);
      }
    }
    n.append(box);
  }
}

/* ---------- example card (shows how marking looks) ---------- */
const exText = 'Yesterday I go to the shop and buy some bread, you know.';
const example = {
  id: 0, example: true, text: exText, confidence: 0.96, at: new Date(), words: 0,
  ltStatus: 'done', aiStatus: 'off', ai: null,
  lt: [
    { offset: exText.indexOf(' go ') + 1, length: 2, message: 'Use the past tense for yesterday.', replacement: 'went' },
    { offset: exText.indexOf(' buy ') + 1, length: 3, message: 'Keep the past tense.', replacement: 'bought' }
  ]
};
example.node = el('li');
function showExample() { feed.append(example.node); renderCard(example); }

/* ---------- adding sentences ---------- */
function addSegment(raw, confidence, opts) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (example.node.isConnected) example.node.remove();
  const c = {
    id: S.nextId++, text, confidence, cut: !!(opts && opts.cut), at: new Date(), words: countWords(text),
    lt: null, ltStatus: 'checking', ltError: '', ai: null, aiStatus: aiOn() ? 'checking' : 'off', aiError: ''
  };
  c.node = el('li');
  S.cards.unshift(c);
  feed.prepend(c.node);
  renderCard(c);
  updateStats();
  checkGrammar(c);
  if (c.aiStatus === 'checking') checkWithClaude(c);
}

async function checkGrammar(c) {
  try {
    const body = new URLSearchParams({
      text: c.text,
      language: $('accent').value,
      disabledRules: LT_OFF
    });
    const res = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST', headers: { 'Accept': 'application/json' }, body
    });
    if (res.status === 429) throw new Error('busy');
    if (!res.ok) throw new Error('http');
    const data = await res.json();
    c.lt = (data.matches || [])
      .filter(m => !LT_SKIP.has(m.rule && m.rule.category && m.rule.category.id))
      .map(m => ({
        offset: m.offset, length: m.length,
        message: m.shortMessage || m.message,
        replacement: (m.replacements && m.replacements[0] && m.replacements[0].value) || ''
      }));
    c.ltStatus = 'done';
  } catch (e) {
    c.ltStatus = 'error';
    c.ltError = e.message === 'busy'
      ? 'The grammar service is busy. Wait a minute and type the sentence again.'
      : 'Grammar check unavailable. Check the internet connection.';
  }
  renderCard(c);
  updateStats();
}

function systemPrompt() {
  return 'You are an experienced English speaking tutor checking one spoken sentence from a student. ' +
    'The sentence was transcribed by speech recognition, so ignore capitalization, punctuation and spelling, and never count missing punctuation as an error. ' +
    'Focus on grammar, tense, articles, prepositions, word choice and natural phrasing. ' +
    'The student level is ' + LEVELS[$('level').value] + '. Judge by that level and only flag real problems. ' +
    'Reply with JSON only, no other text: {"ok": boolean, "corrected": string, "issues": [{"wrong": string, "right": string, "why": string}], "natural": string}. ' +
    '"ok" is true when the sentence needs no correction. "why" is under 14 words. "natural" is an optional more natural way to say it, or an empty string.';
}

async function checkWithClaude(c) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': keyEl.value.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: $('model').value,
        max_tokens: 500,
        system: systemPrompt(),
        messages: [{ role: 'user', content: c.text }]
      })
    });
    if (res.status === 401) throw new Error('key');
    if (res.status === 429) throw new Error('rate');
    if (!res.ok) throw new Error('http');
    const data = await res.json();
    const t = (data.content || []).map(b => b.text || '').join('');
    const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    c.ai = {
      ok: !!obj.ok,
      corrected: String(obj.corrected || ''),
      issues: Array.isArray(obj.issues) ? obj.issues.slice(0, 6).map(i => ({
        wrong: String(i.wrong || ''), right: String(i.right || ''), why: String(i.why || '')
      })) : [],
      natural: String(obj.natural || '')
    };
    c.aiStatus = 'done';
  } catch (e) {
    c.aiStatus = 'error';
    c.aiError = e.message === 'key' ? 'Claude rejected the API key. Check it in the settings below.'
      : e.message === 'rate' ? 'Claude is rate limited. Try again shortly.'
      : e instanceof TypeError ? 'Could not reach Claude. Check the internet connection.'
      : 'Claude could not check this sentence.';
  }
  renderCard(c);
  updateStats();
}

/* ---------- numbers ---------- */
function updateStats() {
  const words = S.cards.reduce((a, c) => a + c.words, 0);
  const ms = elapsed();
  $('sTime').textContent = fmt(ms);
  $('sWords').textContent = words;
  $('sPace').textContent = ms > 5000 ? Math.round(words / (ms / 60000)) : '–';
  $('sFill').textContent = S.cards.reduce((a, c) => a + countFillers(c.text), 0);
  $('sFlag').textContent = S.cards.filter(isFlagged).length;
  $('sTotal').textContent = ' / ' + S.cards.length;
}

/* ---------- microphone level ---------- */
const MIC_ERRORS = {
  NotAllowedError: 'The microphone is blocked. Click the icon on the left of the address bar, set Microphone to Allow, reload the page and try again.',
  NotFoundError: 'No microphone was found. Plug one in or pick it in Windows sound settings, then try again.',
  NotReadableError: 'Another app is using the microphone (Zoom, Teams, Discord?). Close it, or switch the microphone in that app, then try again.',
  SecurityError: 'The browser blocked the microphone for this page.'
};
const SHARE_ERRORS = {
  NotAllowedError: 'Sharing was cancelled. Press start again and choose the tab or screen with the call.',
  NotFoundError: 'Nothing was available to share.',
  NotReadableError: 'The browser could not capture that tab or screen. Try again, or choose Entire screen.',
  NotSupportedError: 'This browser cannot capture call audio. Use Google Chrome.'
};
async function openCall() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return 'This browser cannot capture call audio. Use Google Chrome.';
  }
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include'
    });
  } catch (e) {
    return SHARE_ERRORS[e.name] || ('Sharing failed (' + e.name + ').');
  }
  const audio = s.getAudioTracks();
  if (!audio.length) {
    s.getTracks().forEach(t => t.stop());
    return 'No sound was shared. Press start again and turn on "Share tab audio" (for a browser tab) or "Also share system audio" (for Entire screen).';
  }
  meter.display = s;
  meter.stream = new MediaStream(audio);
  const ended = () => {
    if (meter.display !== s) return;
    if (S.listening) { lastError = 'Sharing stopped. Press start to share the call again.'; stopListening(); }
  };
  audio[0].addEventListener('ended', ended);
  s.getVideoTracks().forEach(t => t.addEventListener('ended', ended));
  return '';
}
const openInput = () => ($('source').value === 'call' ? openCall() : openMic());
async function openMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'This browser cannot open the microphone here. Use Google Chrome.';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    meter.stream = stream;
    return '';
  } catch (e) {
    return MIC_ERRORS[e.name] || ('The microphone could not start (' + e.name + ').');
  }
}
async function startMeter() {
  try {
    const stream = meter.stream;
    if (!stream) return;
    meter.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = meter.ctx.createMediaStreamSource(stream);
    const an = meter.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      meterBar.style.transform = 'scaleX(' + Math.min(1, Math.sqrt(sum / buf.length) * 4) + ')';
      meter.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { /* the level bar is optional */ }
}
function stopMeter() {
  cancelAnimationFrame(meter.raf);
  if (meter.stream) meter.stream.getTracks().forEach(t => t.stop());
  if (meter.display) meter.display.getTracks().forEach(t => t.stop());
  if (meter.ctx) meter.ctx.close().catch(() => {});
  meter.stream = null; meter.ctx = null; meter.display = null;
  meterBar.style.transform = 'scaleX(0)';
}

/* ---------- shared listening state ---------- */
function resetButton() {
  toggle.setAttribute('aria-pressed', 'false');
  toggleLabel.textContent = 'Start listening';
}
function beginSession(msg) {
  S.starting = false;
  S.listening = true;
  S.startedAt = Date.now();
  clearInterval(tick);
  tick = setInterval(updateStats, 500);
  toggle.setAttribute('aria-pressed', 'true');
  toggleLabel.textContent = 'Stop';
  setStatus(msg, false);
}
function finishListening() {
  if (!S.listening) return;
  S.activeMs += Date.now() - S.startedAt;
  S.listening = false;
  clearInterval(tick);
  stopMeter();
  resetButton();
  setStatus(lastError || 'Stopped. Press start to continue the same session.', !!lastError);
  updateStats();
}
/* Microphone uses Chrome's Google speech; call audio uses the on-device model, because Google speech can only hear the microphone. */
const engine = () => ($('source').value === 'call' ? 'whisper' : 'google');

/* ---------- engine 1: Google speech (microphone) ---------- */
let heardSomething = false, silenceTimer = 0, startSeq = 0;
const stale = my => my !== startSeq || !S.starting;
async function startGoogle() {
  if (!SR) {
    setStatus('This browser has no speech recognition. Open this file in Google Chrome.', true);
    return;
  }
  lastError = '';
  const my = ++startSeq;
  S.starting = true;
  toggle.setAttribute('aria-pressed', 'true');
  toggleLabel.textContent = 'Cancel';
  setStatus('Opening the microphone…', false);
  const micErr = await openMic();
  if (stale(my)) return;
  if (micErr) { S.starting = false; resetButton(); setStatus(micErr, true); return; }
  want = true;
  heardSomething = false;
  const r = new SR();
  rec = r;
  r.lang = $('accent').value;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onaudiostart = () => { if (!lastError) setStatus('Microphone on. Waiting for speech…', false); };
  r.onspeechstart = () => { if (!lastError) setStatus('Hearing speech…', false); };
  r.onresult = e => {
    heardSomething = true;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) addSegment(res[0].transcript, res[0].confidence);
      else interim += res[0].transcript;
    }
    liveText.textContent = interim.trim();
  };
  r.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    const msg = {
      'not-allowed': 'Speech recognition was refused (not-allowed). Allow the microphone in the address bar, reload the page and try again.',
      'service-not-allowed': 'This browser does not allow speech recognition. Open this file in Google Chrome.',
      'audio-capture': 'Speech recognition could not get audio. Check that the right microphone is selected in Windows settings.',
      'network': 'The speech service could not be reached (network error). Check the internet connection and make sure this file is open in Google Chrome.',
      'language-not-supported': 'This English variety is not supported here. Pick another one in the English menu.'
    }[e.error] || ('Speech recognition stopped with an error: ' + e.error + '.');
    lastError = msg; want = false;
    setStatus(msg, true);
  };
  r.onend = () => {
    if (rec !== r) return;
    if (want) {
      setTimeout(() => { if (want && rec === r) { try { r.start(); } catch (e) { /* already running */ } } }, 250);
    } else {
      liveText.textContent = '';
      finishListening();
    }
  };
  try { r.start(); } catch (e) {
    S.starting = false;
    stopMeter();
    resetButton();
    setStatus('Speech recognition could not start (' + (e.name || e.message) + '). Reload the page or switch Recognition to On-device.', true);
    return;
  }
  beginSession('Starting speech recognition…');
  startMeter();
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if (S.listening && engine() === 'google' && !heardSomething && !lastError) {
      setStatus('No words recognized yet. If the green bar moves when you talk, the microphone works but the speech service is not answering. Check the internet connection and that you are in Google Chrome.', true);
    }
  }, 12000);
}
function stopGoogle() {
  want = false;
  try { if (rec) rec.stop(); } catch (e) { /* not running */ }
  finishListening();
}

/* ---------- engine 2: on-device Whisper (call audio) ---------- */
const MODELS = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
  small: 'onnx-community/whisper-small.en'
};
const RATE = 16000, FRAME = 480; /* 30 ms frames at 16 kHz */


const wh = {
  worker: null, ready: false, loading: false, model: '', loadingModel: '', device: '',
  loadPromise: null, loadRes: null, loadRej: null, files: {},
  ctx: null, src: null, node: null, sink: null,
  busy: 0, pendingFinals: 0, nextJob: 1, partialAt: 0, segId: 0
};
const vad = { floor: 0.004, pre: [], speechRun: 0, silenceRun: 0, active: false, buf: [], voiced: 0, carry: new Float32Array(0) };
const rs = { ratio: 1, t: 0, acc: 0, n: 0 };

function whFail(msg) {
  if (wh.worker) { try { wh.worker.terminate(); } catch (e) { /* ignore */ } }
  wh.worker = null; wh.ready = false; wh.loading = false; wh.busy = 0; wh.pendingFinals = 0;
  if (wh.loadRej) { const rej = wh.loadRej; wh.loadRej = null; rej(new Error(msg)); }
  else if (S.listening && engine() === 'whisper') { lastError = msg; stopWhisper(); }
}

function ensureWorker() {
  if (wh.worker) return;
  let w;
  try {
    w = new Worker('worker.js', { type: 'module' });
  } catch (e) {
    throw new Error('This browser cannot run the speech model for call audio. Update Google Chrome.');
  }
  w.onmessage = onWorkerMessage;
  w.onerror = e => {
    if (e && e.preventDefault) e.preventDefault();
    whFail('The speech library could not be downloaded. Check the internet connection and press start again.');
  };
  wh.worker = w;
}

function loadModel() {
  const model = MODELS[$('modelSize').value] || MODELS.base;
  if (wh.ready && wh.model === model) return Promise.resolve();
  if (wh.loading && wh.loadingModel === model) return wh.loadPromise;
  ensureWorker();
  wh.ready = false; wh.loading = true; wh.loadingModel = model; wh.files = {};
  wh.loadPromise = new Promise((res, rej) => { wh.loadRes = res; wh.loadRej = rej; });
  wh.worker.postMessage({ type: 'load', model });
  return wh.loadPromise;
}

function showLoadProgress() {
  if (!S.starting) return;
  let loaded = 0, total = 0;
  Object.values(wh.files).forEach(f => { loaded += f.loaded; total += f.total; });
  if (total > 2e6 && loaded < total) {
    const pct = Math.floor((loaded / total) * 100);
    setStatus('Downloading the speech model: ' + pct + '% of ' + Math.round(total / 1e6) + ' MB. This happens only the first time.', false);
  } else {
    setStatus('Preparing the speech model…', false);
  }
}

function onWorkerMessage(e) {
  const m = e.data || {};
  if (m.type === 'progress') {
    if (m.file) {
      const f = wh.files[m.file] || (wh.files[m.file] = { loaded: 0, total: 0 });
      if (m.total) f.total = m.total;
      f.loaded = m.status === 'done' ? f.total : (m.loaded || f.loaded);
    }
    showLoadProgress();
  } else if (m.type === 'ready') {
    wh.ready = true; wh.loading = false; wh.model = wh.loadingModel; wh.device = m.device;
    const res = wh.loadRes; wh.loadRes = null; wh.loadRej = null;
    if (res) res();
  } else if (m.type === 'loaderror') {
    wh.loading = false;
    const rej = wh.loadRej; wh.loadRes = null; wh.loadRej = null;
    if (rej) rej(new Error('The speech model could not load (' + m.message + '). Check the internet connection, or pick the Tiny model in Settings, then press start again.'));
  } else if (m.type === 'text' || m.type === 'error' || m.type === 'skipped') {
    wh.busy = Math.max(0, wh.busy - 1);
    if (m.partial) {
      if (m.type === 'text' && vad.active && m.id > wh.segId) liveText.textContent = cleanWhisper(m.text, 99).text;
      return;
    }
    wh.pendingFinals = Math.max(0, wh.pendingFinals - 1);
    if (m.type === 'text') {
      const r = cleanWhisper(m.text, m.voiced);
      if (r.text) addSegment(r.text, undefined, { cut: r.cut });
    }
    if (!vad.active) liveText.textContent = '';
    if (S.listening && engine() === 'whisper' && !lastError && !vad.active) {
      setStatus(wh.pendingFinals ? 'Writing down the sentence…' : 'Listening. Speak naturally and pause between sentences.', false);
    }
  }
}

/* A stretch of 2-40 characters repeated three or more times in a row, 24+ characters in all.
   Normal speech ("very, very good") stays; a model loop ("de-re-ra-p-de-re-ra-p-...") matches. */
const LOOP_RE = /(.{2,40}?)\1{2,}/;
function findLoop(s) {
  const m = LOOP_RE.exec(s);
  return m && m[0].length >= 24 ? m : null;
}
/* Returns { text, cut }. `cut` is true when a loop was removed. */
function cleanWhisper(t, voicedSec) {
  let s = String(t || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  let cut = false;
  const loop = findLoop(s);
  if (loop) {
    s = s.slice(0, loop.index).replace(/[\s,;:-]+$/, '').trim();
    cut = true;
  }
  if (!/[a-z]/i.test(s) || (cut && countWords(s) < 2)) return { text: '', cut };
  if (/^(you|bye|thanks for watching[.!]*|subtitles by.*)[.!]*$/i.test(s)) return { text: '', cut };
  if (voicedSec < 1.2 && /^(thank you|thanks)[.!]*$/i.test(s)) return { text: '', cut };
  return { text: cut ? s + ' …' : s, cut };
}

function resample(input) {
  if (rs.ratio === 1) return input;
  const out = new Float32Array(Math.ceil(input.length / rs.ratio) + 2);
  let o = 0;
  for (let i = 0; i < input.length; i++) {
    rs.acc += input[i]; rs.n++; rs.t += 1;
    if (rs.t >= rs.ratio) { out[o++] = rs.acc / rs.n; rs.t -= rs.ratio; rs.acc = 0; rs.n = 0; }
  }
  return out.subarray(0, o);
}

function onAudio(chunk) {
  if (!S.listening) return;
  const fresh = resample(chunk);
  const data = new Float32Array(vad.carry.length + fresh.length);
  data.set(vad.carry); data.set(fresh, vad.carry.length);
  let i = 0;
  for (; i + FRAME <= data.length; i += FRAME) processFrame(data.subarray(i, i + FRAME));
  vad.carry = data.slice(i);
}

let meterTick = 0;
function processFrame(f) {
  let sum = 0;
  for (let k = 0; k < f.length; k++) sum += f[k] * f[k];
  const rms = Math.sqrt(sum / f.length);
  if (++meterTick % 2 === 0) meterBar.style.transform = 'scaleX(' + Math.min(1, rms * 8) + ')';

  if (rms < vad.floor) vad.floor = vad.floor * 0.95 + rms * 0.05;
  else vad.floor = Math.min(vad.floor * 1.0015 + 1e-6, 0.04);
  const speech = rms > Math.max(0.008, vad.floor * 3);
  const copy = f.slice();

  if (!vad.active) {
    vad.pre.push(copy);
    if (vad.pre.length > 10) vad.pre.shift();
    vad.speechRun = speech ? vad.speechRun + 1 : 0;
    if (vad.speechRun >= 3) {
      vad.active = true;
      vad.buf = vad.pre; vad.pre = [];
      vad.voiced = 3; vad.silenceRun = 0;
      wh.partialAt = performance.now();
      if (!lastError) setStatus('Hearing speech…', false);
    }
    return;
  }
  vad.buf.push(copy);
  if (speech) { vad.voiced++; vad.silenceRun = 0; } else vad.silenceRun++;
  const seconds = vad.buf.length * FRAME / RATE;
  const pause = parseFloat($('pause').value) || 0.9;
  /* Long stretches make Whisper more likely to loop, so cut a sentence at 15 seconds. */
  if (vad.silenceRun * FRAME / RATE >= pause || seconds >= 15) endSegment();
  else maybePartial();
}

function flatten(frames) {
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((fr, i) => out.set(fr, i * FRAME));
  return out;
}

function sendJob(job) {
  if (!wh.worker) return;
  wh.busy++;
  wh.worker.postMessage(job, [job.audio.buffer]);
}

function maybePartial() {
  if (wh.device !== 'webgpu' || wh.busy > 0) return;
  const now = performance.now();
  if (now - wh.partialAt < 1500 || vad.buf.length * FRAME < RATE) return;
  wh.partialAt = now;
  sendJob({ type: 'transcribe', partial: true, id: wh.nextJob++, audio: flatten(vad.buf), voiced: 99 });
}

function endSegment() {
  const keep = Math.max(1, vad.buf.length - Math.max(0, vad.silenceRun - 8));
  const frames = vad.buf.slice(0, keep);
  const voicedSec = vad.voiced * FRAME / RATE;
  vad.active = false; vad.buf = []; vad.pre = []; vad.speechRun = 0; vad.silenceRun = 0;
  wh.segId = wh.nextJob;
  if (voicedSec < 0.4) { liveText.textContent = ''; return; }
  wh.pendingFinals++;
  sendJob({ type: 'transcribe', id: wh.nextJob++, audio: flatten(frames), voiced: voicedSec });
  if (!lastError) setStatus('Writing down the sentence…', false);
}

async function startCapture(stream) {
  let ctx = null, src = null;
  try {
    ctx = new AudioContext({ sampleRate: RATE });
    src = ctx.createMediaStreamSource(stream);
  } catch (e) {
    if (ctx) ctx.close().catch(() => {});
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(stream);
  }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* resumes on next click */ } }
  rs.ratio = ctx.sampleRate / RATE; rs.t = 0; rs.acc = 0; rs.n = 0;
  let node;
  try {
    await ctx.audioWorklet.addModule('capture-worklet.js');
    node = new AudioWorkletNode(ctx, 'speaking-capture');
    node.port.onmessage = e => onAudio(e.data);
  } catch (e) {
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = e => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  Object.assign(wh, { ctx, src, node, sink });
}

function stopCapture() {
  if (vad.active) endSegment();
  try { if (wh.src) wh.src.disconnect(); } catch (e) { /* ignore */ }
  try { if (wh.node) wh.node.disconnect(); } catch (e) { /* ignore */ }
  if (wh.ctx) wh.ctx.close().catch(() => {});
  Object.assign(wh, { ctx: null, src: null, node: null, sink: null });
  vad.carry = new Float32Array(0);
}

async function startWhisper() {
  lastError = '';
  const my = ++startSeq;
  S.starting = true;
  toggle.setAttribute('aria-pressed', 'true');
  toggleLabel.textContent = 'Cancel';
  setStatus($('source').value === 'call' ? 'Choose the tab or screen with the call…' : 'Opening the microphone…', false);
  const micErr = await openInput();
  if (stale(my)) return;
  if (micErr) { S.starting = false; resetButton(); setStatus(micErr, true); return; }
  if (!wh.ready || wh.model !== MODELS[$('modelSize').value]) setStatus('Loading the speech model…', false);
  try {
    await loadModel();
  } catch (err) {
    if (!stale(my)) { S.starting = false; stopMeter(); resetButton(); setStatus(err.message, true); }
    return;
  }
  if (stale(my)) return;
  try {
    beginSession('Listening' + (wh.device === 'webgpu' ? ' (using the graphics card)' : '') + '. Speak naturally and pause between sentences.');
    await startCapture(meter.stream);
  } catch (err) {
    lastError = 'The browser could not read the microphone audio (' + (err.name || err.message) + ').';
    stopWhisper();
  }
}

function stopWhisper() {
  stopCapture();
  finishListening();
}

/* ---------- start / stop ---------- */
function cancelStart() {
  startSeq++;
  S.starting = false;
  stopMeter();
  resetButton();
  setStatus('Cancelled. Press start when you are ready.', false);
}
function startListening() { return engine() === 'google' ? startGoogle() : startWhisper(); }
function stopListening() { return rec && want ? stopGoogle() : stopWhisper(); }
toggle.addEventListener('click', () => {
  if (S.starting) cancelStart();
  else if (S.listening) stopListening();
  else startListening();
});

function restartIfListening(prevEngine) {
  if (!S.listening) return;
  if (prevEngine === 'google') stopGoogle(); else stopWhisper();
  setTimeout(startListening, 400);
}
$('accent').addEventListener('change', () => { if (engine() === 'google') restartIfListening('google'); });
const SOURCE_STORE = 'speakingcheck.source';
function applySource() {
  $('callHelp').hidden = $('source').value !== 'call';
}
$('source').addEventListener('change', () => {
  try { localStorage.setItem(SOURCE_STORE, $('source').value); } catch (e) { /* storage unavailable */ }
  if (S.starting) cancelStart();
  if (S.listening) stopListening();
  applySource();
});
$('modelSize').addEventListener('change', () => { if (engine() === 'whisper') restartIfListening('whisper'); });

/* ---------- typed sentences ---------- */
$('manual').addEventListener('submit', e => {
  e.preventDefault();
  const box = $('manualText');
  addSegment(box.value, 0);
  box.value = '';
});

/* ---------- report and clear ---------- */
function buildReport() {
  const name = $('student').value.trim() || 'Student';
  const words = S.cards.reduce((a, c) => a + c.words, 0);
  const ms = elapsed();
  const L = [];
  L.push('Speaking check: ' + name);
  L.push(new Date().toLocaleDateString() + ' | level ' + $('level').value + ' | ' + fmt(ms) + ' | ' + words + ' words' +
    (ms > 5000 ? ' | ' + Math.round(words / (ms / 60000)) + ' words/min' : ''));
  L.push(S.cards.filter(isFlagged).length + ' of ' + S.cards.length + ' sentences flagged');
  L.push('');
  [...S.cards].sort((a, b) => a.id - b.id).forEach(c => {
    L.push(c.id + '. ' + c.text);
    const fixed = correctedFor(c);
    if (fixed && norm(fixed) !== norm(c.text)) L.push('   Better: ' + fixed);
    const aiIssues = (c.ai && c.ai.issues) || [];
    aiIssues.forEach(i => L.push('   - ' + i.wrong + ' -> ' + i.right + (i.why ? ' (' + i.why + ')' : '')));
    if (!aiIssues.length) (c.lt || []).forEach(m => {
      const w = c.text.slice(m.offset, m.offset + m.length);
      L.push('   - ' + (w ? w + ' -> ' + (m.replacement || '?') + ' ' : '') + '(' + m.message + ')');
    });
    if (c.cut) L.push('   Part of this sentence was unclear and was left out');
    if (c.confidence > 0 && c.confidence < 0.8) L.push('   Audio clarity low (' + Math.round(c.confidence * 100) + '%), check pronunciation');
    L.push('');
  });
  return L.join('\n');
}

$('copy').addEventListener('click', async () => {
  if (!S.cards.length) { toast('Nothing to copy yet'); return; }
  const text = buildReport();
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
  }
  toast('Report copied');
});

$('clear').addEventListener('click', () => {
  const btn = $('clear');
  if (!S.cards.length) return;
  if (Date.now() - clearArmed > 3000) {
    clearArmed = Date.now();
    btn.textContent = 'Click again to clear';
    setTimeout(() => { btn.textContent = 'Clear session'; }, 3000);
    return;
  }
  clearArmed = 0;
  btn.textContent = 'Clear session';
  S.cards = []; S.nextId = 1; S.activeMs = 0; S.startedAt = Date.now();
  feed.replaceChildren();
  showExample();
  updateStats();
});

/* ---------- settings ---------- */
try {
  const k = localStorage.getItem(KEY_STORE);
  if (k) { keyEl.value = k; rememberEl.checked = true; }
} catch (e) { /* storage unavailable */ }
function saveKey() {
  try {
    if (rememberEl.checked && keyEl.value.trim()) localStorage.setItem(KEY_STORE, keyEl.value.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch (e) { /* storage unavailable */ }
}
keyEl.addEventListener('input', saveKey);
rememberEl.addEventListener('change', saveKey);

/* ---------- start-up ---------- */
if (!SR) $('support').hidden = false;
try { if (localStorage.getItem(SOURCE_STORE) === 'call') $('source').value = 'call'; } catch (e) { /* storage unavailable */ }
applySource();
showExample();
updateStats();
})();
