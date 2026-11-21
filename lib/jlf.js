// The Japan Liberation Front material taken from the player's PSP disc (v1.01): the bytes the complete
// edition's ISO holds that come from PSP files, rebuilt here exactly as the build made them, so the
// complete patch copies them from this material instead of carrying them. The recipe comes from
// tools/make-ps2-release.mjs (release manifest):
//   scripts: [{path, sourceSha256, edits: [[offset, [bytes]]], sha256}]  ROOT script: decode, edit
//     (platform marker PSP -> PS2, the JLF endings' movie 28 -> 29), OOCH again with its own header
//   tables:  [{path, chunk, sha256}]  a chunk of a decoded ROOT pack (UNION.P selection tables)
// read(offset, length) reads the PSP disc; files is its listing (iso.js listFiles).
import {unpack, compress, isOoch} from './ooch.js';
import {sha256} from './sha256.js';
import {findFile} from './iso.js';
const check = (v, m) => { if (!v) throw Error(m); };
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;

async function decoded(read, files, path) {
  const f = findFile(files, 'ROOT', path); check(f, 'PSP disc lacks ' + path);
  const raw = await read(f.offset, f.size);
  return {raw, data: isOoch(raw) ? unpack(raw) : raw};
}

// One Uint8Array per recipe item, in recipe order (scripts, then tables); throws naming the first file
// that is not the original's.
export async function materials(read, files, recipe, progress = () => {}) {
  const out = [], total = recipe.scripts.length + recipe.tables.length;
  for (const s of recipe.scripts) {
    const {raw, data} = await decoded(read, files, s.path);
    check(sha256(data) === s.sourceSha256, 'not the original PSP file: ' + s.path);
    const edited = data.slice();
    for (const [offset, bytes] of s.edits) edited.set(bytes, offset);
    const packed = compress(edited, raw);
    check(sha256(packed) === s.sha256, 'rebuilt script differs: ' + s.path);
    out.push(packed); progress(out.length / total);
  }
  const packs = new Map();
  for (const t of recipe.tables) {
    if (!packs.has(t.path)) { const {data} = await decoded(read, files, t.path); check(String.fromCharCode(...data.subarray(0, 4)) === 'pack', 'pack ' + t.path); packs.set(t.path, data); }
    // pack: chunk count at +8, n + 1 offsets from +16 (the last is the pack's length)
    const p = packs.get(t.path), at = u32(p, 16 + t.chunk * 4), end = u32(p, 20 + t.chunk * 4);
    check(t.chunk < u32(p, 8), 'pack chunk ' + t.chunk);
    const chunk = p.slice(at, end);
    check(sha256(chunk) === t.sha256, 'not the original PSP table: ' + t.path + ' #' + t.chunk);
    out.push(chunk); progress(out.length / total);
  }
  return out;
}
