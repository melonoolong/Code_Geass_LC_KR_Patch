// The release page's work, without the page: from the player's discs and the release manifest
// (tools/make-ps2-release.mjs, data/manifest.json) to the Korean ISO, written window by window and
// hashed on the way. Runs in the browser (release-page/app.js) and in Node (tools/test-ps2-release-page.mjs),
// so the page's path is tested on the real discs before it ships.
//   base      PS2 ISO + base patch -> the base edition
//   complete  PS2 ISO + PSP material (jlf.js) + complete patch -> the complete edition with the stand-in
//             ending (the Black Knights ED pictures) and the lowercase COMPLETE ver. logo
//   ending    with the complete edition: 28.PMF encoded by ffmpeg.wasm (encode, injected: a worker in the
//             browser), the ending patch turns that stream into 29.SFD, written over the slot, and the
//             logo patch turns the lowercase TJ.P into the uppercase one. If the encode fails (a phone
//             out of memory), the rest is still made with the stand-in and the result says why.
// Inputs: ps2/psp {size, read(offset, length) -> Promise<Uint8Array>}, fetchPart(path) -> AsyncIterable
// of Uint8Array, write(Uint8Array) awaited, log(text), progress(done, total, stage).
import {listFiles, findFile} from './iso.js';
import {materials} from './jlf.js';
import {decode} from './vcdiff.js';
import {Sha256, sha256} from './sha256.js';

const check = (v, m) => { if (!v) throw Error(m); };

// A patch in its parts, hashed as it streams; the hash is checked after the decode.
function patchStream(patch, fetchPart) {
  const h = new Sha256();
  let bytes = 0;
  return {
    chunks: (async function* () { for (const p of patch.parts) for await (const c of fetchPart(p)) { h.update(c); bytes += c.length; yield c; } })(),
    verify: name => check(bytes === patch.bytes && h.hex() === patch.sha256, name + ' 패치 파일이 손상되었습니다. 다시 시도해 주세요.'),
  };
}

async function decodeAll(patch, fetchPart, source, name) {
  const s = patchStream(patch, fetchPart), parts = [];
  const n = await decode(s.chunks, async (o, k) => source.subarray(o, o + k), source.length, async w => { parts.push(w); });
  s.verify(name);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function makeIso({manifest, ps2, psp = null, ending = false, encode = null, fetchPart, write, log = () => {}, progress = () => {}}) {
  check(ps2.size === manifest.ps2.bytes, `PS2 ISO 크기가 일본판 v1.01 원본과 다릅니다(${ps2.size}바이트, 원본 ${manifest.ps2.bytes}바이트). v2.00이나 다른 덤프는 쓸 수 없습니다.`);
  const edition = psp ? 'complete' : 'base', ed = manifest[edition];
  let source = ps2, endingSfd = null, endingError = null;

  if (psp) {
    log('PSP ISO에서 일본해방전선편 자료를 읽는 중…');
    const files = await listFiles(psp.read);
    const parts = await materials(psp.read, files, ed.materials, f => progress(f, 1, 'material'));
    const material = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { material.set(p, at); at += p.length; }
    check(material.length === ed.materialBytes && sha256(material) === ed.materialSha256, 'PSP 자료를 다시 만든 결과가 다릅니다.');
    // The complete patch's source: the PS2 ISO followed by the material.
    source = {size: ps2.size + material.length, read: async (o, n) => {
      if (o + n <= ps2.size) return ps2.read(o, n);
      if (o >= ps2.size) return material.subarray(o - ps2.size, o - ps2.size + n);
      const b = new Uint8Array(n), a = await ps2.read(o, ps2.size - o);
      b.set(a); b.set(material.subarray(0, n - a.length), a.length); return b;
    }};

    if (ending) {
      const E = manifest.ending;
      try {
        const pmfEntry = findFile(files, 'MOVIE', '/28.PMF');
        check(pmfEntry && pmfEntry.size === E.pmf.bytes, 'PSP ISO에 엔딩 영상(28.PMF)이 없습니다.');
        const pmf = await psp.read(pmfEntry.offset, pmfEntry.size);
        check(sha256(pmf) === E.pmf.sha256, 'PSP ISO의 엔딩 영상이 원본과 다릅니다.');
        log('엔딩 영상을 변환하는 중… (PC는 몇 분, 휴대폰은 더 걸립니다)');
        const es = await encode(E.encode.args, pmf);
        check(es.length === E.encode.esBytes && sha256(es) === E.encode.esSha256, '변환한 엔딩 영상이 예상과 다릅니다.');
        endingSfd = await decodeAll(E.patch, fetchPart, es, '엔딩 영상');
        check(endingSfd.length === E.slot.bytes && sha256(endingSfd) === E.endingSha256, '엔딩 영상 패치 결과가 다릅니다.');
      } catch (e) {
        endingError = e.message || String(e);
        endingSfd = null;
        log('엔딩 영상을 넣지 못했습니다: ' + endingError + '\n영상 없이 나머지를 마저 만듭니다.');
      }
    }
  }

  // The target, window by window: the ending over its slot; the logo region is held until all of it has
  // come (the uppercase TJ.P is made from the lowercase one) and then written with the others held.
  const E = manifest.ending, logo = endingSfd ? E.logo : null, slot = E.slot;
  const total = ed.target.bytes, h = new Sha256();
  let pos = 0, held = [], lower = logo ? new Uint8Array(logo.bytes) : null, got = 0, upper = null;
  const overlap = (at, n, r) => [Math.max(at, r.offset), Math.min(at + n, r.offset + r.bytes)];
  const out = async (t, at) => { if (upper) { const [a, b] = overlap(at, t.length, logo); if (a < b) t.set(upper.subarray(a - logo.offset, b - logo.offset), a - at); } h.update(t); await write(t); };
  const s = patchStream(ed.patch, fetchPart);
  log(edition === 'base' ? '기본판을 만드는 중…' : '합본판을 만드는 중…');
  const n = await decode(s.chunks, source.read, source.size, async t => {
    const at = pos; pos += t.length;
    if (endingSfd) { const [a, b] = overlap(at, t.length, slot); if (a < b) t.set(endingSfd.subarray(a - slot.offset, b - slot.offset), a - at); }
    if (logo && !upper) {
      const [a, b] = overlap(at, t.length, logo);
      if (a < b) { lower.set(t.subarray(a - at, b - at), a - logo.offset); got += b - a; }
      if (got < logo.bytes) { if (a < b || held.length) { held.push([t, at]); return; } }
      else {
        check(sha256(lower) === logo.lowerSha256, '타이틀 로고 자리가 예상과 다릅니다.');
        upper = await decodeAll(logo.patch, fetchPart, lower, '타이틀 로고');
        check(upper.length === logo.bytes && sha256(upper) === logo.upperSha256, '타이틀 로고 패치 결과가 다릅니다.');
        for (const [ht, hat] of held) await out(ht, hat);
        held = [];
      }
    }
    await out(t, at);
    progress(pos, total, 'iso');
  });
  s.verify(edition === 'base' ? '기본판' : '합본판');
  check(n === total && held.length === 0, '결과 ISO 크기가 다릅니다.');
  const want = endingSfd ? E.resultSha256 : ed.target.sha256, got256 = h.hex();
  check(got256 === want, '결과 ISO의 해시가 다릅니다. 원본 ISO가 손상되었거나 다른 판일 수 있습니다.');
  return {edition, ending: !!endingSfd, endingError, bytes: n, sha256: got256};
}
