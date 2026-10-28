/* Speech-to-text worker for call audio. Runs Whisper in the browser with transformers.js,
   on the graphics card (WebGPU) when available, otherwise on the CPU (WebAssembly). */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null, loadedModel = '', device = 'wasm';
const queue = [];
let running = false;
async function hasWebGPU() {
  try { return !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { return false; }
}
async function load(model) {
  if (asr && loadedModel === model) return;
  if (asr) { try { await asr.dispose(); } catch (e) {} asr = null; }
  const progress_callback = p => {
    if (p && (p.status === 'progress' || p.status === 'done' || p.status === 'initiate')) {
      postMessage({ type: 'progress', status: p.status, file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 });
    }
  };
  if (await hasWebGPU()) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback
      });
      device = 'webgpu';
    } catch (e) { asr = null; }
  }
  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
    device = 'wasm';
  }
  loadedModel = model;
  await asr(new Float32Array(16000));
}
self.onmessage = e => { queue.push(e.data); pump(); };
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.type === 'load') {
      try { await load(job.model); postMessage({ type: 'ready', device }); }
      catch (err) { postMessage({ type: 'loaderror', message: String((err && err.message) || err) }); }
    } else if (job.type === 'transcribe') {
      if (job.partial && (!asr || queue.some(j => j.type === 'transcribe'))) {
        postMessage({ type: 'skipped', id: job.id });
        continue;
      }
      try {
        // Whisper can loop on unclear audio ("de-re-ra-de-re-ra..."). Block any 6-token
        // phrase from repeating, and cap the output to what a person can say in that time.
        const seconds = job.audio.length / 16000;
        const out = await asr(job.audio, {
          no_repeat_ngram_size: 6,
          max_new_tokens: Math.min(220, Math.ceil(seconds * 6) + 12)
        });
        postMessage({ type: 'text', id: job.id, partial: !!job.partial, voiced: job.voiced, text: (out && out.text) || '' });
      } catch (err) {
        postMessage({ type: 'error', id: job.id, partial: !!job.partial, message: String((err && err.message) || err) });
      }
    }
  }
  running = false;
}
