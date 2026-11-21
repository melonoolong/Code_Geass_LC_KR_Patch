// The release page: the player's PS2 ISO (and PSP ISO for the complete edition) -> the Korean ISO, made
// in this browser by lib/patcher.js from the patches in data/ (tools/make-ps2-release.mjs). Output: the
// file the player picks (showSaveFilePicker: Chrome, Edge on PC), else the browser's own storage (OPFS)
// and a download link. Test hooks: ?ps2=URL&psp=URL&ending=1&sink=hash&auto=1 reads the discs over HTTP
// Range requests, hashes the result without writing it and puts the result in window.result.
import {makeIso} from './lib/patcher.js';
import {sha256} from './lib/sha256.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const logEl = $('log'), bar = $('bar'), start = $('start'), endingBox = $('ending'), endingOpt = $('endingOpt');
const say = (text, cls) => { const p = document.createElement('div'); p.textContent = text; if (cls) p.className = cls; logEl.append(p); return p; };
let manifest = null, ps2 = null, psp = null, running = false;

const fileReader = f => ({size: f.size, name: f.name, read: async (o, n) => new Uint8Array(await f.slice(o, o + n).arrayBuffer())});
async function urlReader(url) {
  const r = await fetch(url, {method: 'HEAD'}), size = Number(r.headers.get('content-length'));
  if (!r.ok || !size) throw Error('cannot read ' + url);
  return {size, name: url, read: async (o, n) => {
    const res = await fetch(url, {headers: {Range: `bytes=${o}-${o + n - 1}`}});
    if (res.status !== 206) throw Error('range request refused: ' + url);
    return new Uint8Array(await res.arrayBuffer());
  }};
}
const fetchPart = p => (async function* () {
  const res = await fetch('data/' + p.replace(/^data\//, ''));
  if (!res.ok) throw Error('패치 파일을 받지 못했습니다: ' + p);
  const r = res.body.getReader();
  for (;;) { const {done, value} = await r.read(); if (done) return; yield value; }
})();

// ffmpeg.wasm in a worker; the core files are checked against the manifest first.
async function encode(args, input) {
  const c = manifest.ending.core;
  const wasm = new Uint8Array(await (await fetch(c.wasm)).arrayBuffer());
  const js = new Uint8Array(await (await fetch(c.js)).arrayBuffer());
  if (sha256(wasm) !== c.wasmSha256 || sha256(js) !== c.jsSha256) throw Error('변환기 파일이 손상되었습니다.');
  const w = new Worker('ending-worker.js');
  try {
    return await new Promise((res, rej) => {
      w.onmessage = ({data}) => data.ok ? res(data.out) : rej(Error(data.error));
      w.onerror = e => rej(Error(e.message || '변환기 오류'));
      w.postMessage({core: new URL(c.js, location.href).href, wasm: wasm.buffer, args, input}, [wasm.buffer]);
    });
  } finally { w.terminate(); }
}

// Sinks: {write(Uint8Array), close() -> File | null}.
async function pickedSink(name) {
  const h = await showSaveFilePicker({suggestedName: name, types: [{description: 'ISO', accept: {'application/octet-stream': ['.iso']}}]});
  const w = await h.createWritable();
  return {write: d => w.write(d), close: async () => { await w.close(); return null; }, abort: () => w.abort()};
}
async function opfsSink(name) {
  const dir = await navigator.storage.getDirectory();
  try { await dir.removeEntry(name); } catch {}
  const fh = await dir.getFileHandle(name, {create: true});
  if (fh.createWritable) {
    const w = await fh.createWritable();
    return {write: d => w.write(d), close: async () => { await w.close(); return fh.getFile(); }, abort: () => w.abort(), dir, name};
  }
  const worker = new Worker('opfs-worker.js');
  const call = msg => new Promise((res, rej) => { worker.onmessage = ({data}) => data.ok ? res() : rej(Error(data.error)); worker.postMessage(msg); });
  await call({open: name});
  return {write: d => call({data: d}), close: async () => { await call({close: true}); worker.terminate(); return fh.getFile(); },
    abort: async () => { try { await call({close: true}); } catch {} worker.terminate(); }, dir, name};
}
const hashSink = () => ({write: async () => {}, close: async () => null, abort: () => {}});

function refresh() {
  start.disabled = running || !ps2 || !manifest;
  endingBox.disabled = running || !psp;
  endingOpt.classList.toggle('off', !psp);
  if (!psp) endingBox.checked = false;
}

function dropZone(zone, input, set) {
  const take = f => { if (!f) return; set(fileReader(f)); zone.classList.add('set'); zone.querySelector('span').textContent = `${f.name} (${(f.size / 1e9).toFixed(2)} GB)`; refresh(); };
  input.addEventListener('change', () => take(input.files[0]));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files[0]); });
}

async function run() {
  if (running) return;
  running = true; refresh(); logEl.textContent = '';
  const complete = !!psp, ending = complete && endingBox.checked;
  const name = complete ? 'CodeGeass-LostColors-KR-Complete.iso' : 'CodeGeass-LostColors-KR.iso';
  let sink = null, lock = null;
  const guard = e => { e.preventDefault(); e.returnValue = ''; };
  try {
    // The picker first, while the click still counts as the player's.
    if (q.get('sink') === 'hash') sink = hashSink();
    else if (window.showSaveFilePicker) {
      try { sink = await pickedSink(name); } catch (e) { if (e.name === 'AbortError') { say('저장할 곳을 고르지 않아 멈췄습니다.'); return; } throw e; }
    } else {
      const est = await navigator.storage?.estimate?.();
      if (est && est.quota - est.usage < manifest[complete ? 'complete' : 'base'].target.bytes * 1.05)
        say('이 브라우저의 저장 공간이 부족할 수 있습니다. 실패하면 PC의 Chrome이나 Edge를 써 주세요.');
      sink = await opfsSink(name);
    }
    addEventListener('beforeunload', guard);
    try { lock = await navigator.wakeLock?.request('screen'); } catch {}
    bar.hidden = false; bar.value = 0;
    const t0 = Date.now();
    let status = null;   // the GB line goes under the last message, made when the ISO starts coming
    const result = await makeIso({manifest, ps2, psp, ending, encode, fetchPart, write: d => sink.write(d), log: m => { say(m); status = null; },
      progress: (d, t, stage) => { if (stage !== 'iso') return; bar.value = d / t; (status ??= say('')).textContent = `${(d / 1e9).toFixed(2)} / ${(t / 1e9).toFixed(2)} GB`; }});
    const file = await sink.close(); sink = null;
    bar.value = 1;
    say(`완성했습니다. ${result.edition === 'complete' ? '합본판' : '기본판'}${result.ending ? '(엔딩 영상 포함)' : ''}, 확인 해시 ${result.sha256.slice(0, 16)}… (${Math.round((Date.now() - t0) / 1000)}초)`, 'ok');
    if (result.endingError) say('엔딩 영상은 넣지 못해 다른 엔딩 화면이 들어갔습니다: ' + result.endingError, 'bad');
    if (file) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; a.className = 'dl'; a.textContent = `${name} 받기`;
      logEl.append(a);
      const rm = document.createElement('button');
      rm.textContent = '받은 뒤 브라우저에 남은 임시 파일 지우기'; rm.style.marginTop = '8px';
      rm.onclick = async () => { URL.revokeObjectURL(a.href); try { await (await navigator.storage.getDirectory()).removeEntry(name); rm.textContent = '지웠습니다'; rm.disabled = true; } catch (e) { rm.textContent = '지우지 못했습니다: ' + e.message; } };
      logEl.append(rm);
    }
    window.result = result;
  } catch (e) {
    say('실패했습니다: ' + (e.message || e), 'bad');
    window.result = {error: e.message || String(e)};
    if (sink) { try { await sink.abort(); } catch {} }
  } finally {
    removeEventListener('beforeunload', guard);
    try { await lock?.release(); } catch {}
    running = false; refresh();
  }
}

dropZone($('ps2Drop'), $('ps2File'), r => { ps2 = r; });
dropZone($('pspDrop'), $('pspFile'), r => { psp = r; });
start.addEventListener('click', run);
try {
  manifest = await (await fetch('data/manifest.json')).json();
  if (q.get('ps2')) { ps2 = await urlReader(q.get('ps2')); if (q.get('psp')) psp = await urlReader(q.get('psp')); endingBox.checked = q.get('ending') === '1'; }
  refresh();
  if (q.get('auto') === '1' && ps2) run();
} catch (e) {
  say('패치 정보를 읽지 못했습니다: ' + (e.message || e), 'bad');
}
