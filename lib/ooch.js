// OOCH (the game's LZ: 9-bit literals, 17-bit distance/length matches, 0x800 header) for the browser
// patcher and the release tool. compress is tools/ooch.mjs compressOOCH on Uint8Array: the same tokens,
// so the same bytes as the build.
const check = (v, m) => { if (!v) throw Error(m); };
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >>> 8 & 255; b[o + 2] = v >>> 16 & 255; b[o + 3] = v >>> 24 & 255; };
export const isOoch = b => b[0] === 0x4f && b[1] === 0x4f && b[2] === 0x43 && b[3] === 0x48;

export function unpack(b) {
  check(isOoch(b) && u32(b, 8) + 2048 === b.length, 'OOCH header');
  const out = new Uint8Array(u32(b, 12));
  let bit = 16384, pos = 0;
  const bits = n => { let v = 0; while (n--) { v = v * 2 + ((b[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return v; };
  while (pos < out.length) {
    check(bit + 9 <= b.length * 8, 'OOCH truncated');
    if (bits(1) === 0) out[pos++] = bits(8);
    else { const d = bits(8), n = bits(8); check(d > 0 && d <= pos && n > 0 && pos + n <= out.length, 'OOCH match'); for (let j = 0; j < n; j++, pos++) out[pos] = out[pos - d]; }
  }
  return out;
}

// header: the 2048-byte OOCH header of the file it replaces (fields 8 and 12 are rewritten).
export function compress(data, header) {
  check(data.length > 0 && header.length >= 2048, 'OOCH input');
  const out = new Uint8Array(2048 + Math.ceil(data.length * 9 / 8)); out.set(header.subarray(0, 2048));
  let bit = 16384;
  const emit = (value, n) => { while (n) { const room = 8 - (bit & 7), take = Math.min(room, n); n -= take; out[bit >>> 3] |= ((value >>> n) & ((1 << take) - 1)) << (room - take); bit += take; } };
  const head = new Int32Array(65536).fill(-1), previous = new Int32Array(256).fill(-1);
  const lengths = new Uint8Array(data.length), distances = new Uint8Array(data.length);
  let runEnd = 0;
  for (let p = 0; p < data.length; p++) {
    let length = 0, distance = 0;
    if (p + 1 < data.length) {
      const limit = Math.min(255, data.length - p), key = data[p] * 256 + data[p + 1];
      for (let q = head[key]; q >= 0 && p - q <= 255; q = previous[q & 255]) {
        let n = 2;
        if (q === p - 1) {
          if (runEnd < p + 2) { runEnd = p + 2; while (runEnd < data.length && data[runEnd] === data[p]) runEnd++; }
          n = Math.min(limit, runEnd - p);
        } else while (n < limit && data[q + n] === data[p + n]) n++;
        if (n > length) { length = n; distance = p - q; if (n === limit) break; }
      }
      previous[p & 255] = head[key]; head[key] = p;
    }
    lengths[p] = length; distances[p] = distance;
  }
  const costs = new Uint32Array(512).fill(0xffffffff), positions = new Uint32Array(512);
  const better = (a, b) => costs[a] < costs[b] || (costs[a] === costs[b] && positions[a] > positions[b]) ? a : b;
  const update = (p, cost) => { let i = 256 + (p & 255); costs[i] = cost; positions[i] = p; while (i > 1) { i >>= 1; const j = better(i * 2, i * 2 + 1); costs[i] = costs[j]; positions[i] = positions[j]; } };
  const range = (lo, hi) => { let a = lo + 256, b = hi + 256, best = 0; while (a <= b) { if (a & 1) best = better(best, a++); if (!(b & 1)) best = better(best, b--); a >>= 1; b >>= 1; } return best; };
  update(data.length, 0);
  for (let p = data.length - 1; p >= 0; p--) {
    let cost = 9 + costs[256 + ((p + 1) & 255)], length = 1;
    if (lengths[p] >= 2) {
      const lo = (p + 2) & 255, hi = (p + lengths[p]) & 255;
      const best = lo <= hi ? range(lo, hi) : better(range(lo, 255), range(0, hi));
      if (costs[best] + 17 < cost) { cost = costs[best] + 17; length = positions[best] - p; }
    }
    lengths[p] = length; update(p, cost);
  }
  // Same as tools/ooch.mjs: the game's streaming loader stops short when a file ends exactly on a
  // sector, so split the last match of length 3+ into a literal and a shorter match (+9 bits).
  let bits = 16384, last = -1;
  for (let p = 0; p < data.length; p += lengths[p]) { if (lengths[p] >= 2) { bits += 17; if (lengths[p] >= 3) last = p; } else bits += 9; }
  if (Math.ceil(bits / 8) % 2048 === 0) { check(last >= 0, 'OOCH sector-end split'); lengths[last + 1] = lengths[last] - 1; distances[last + 1] = distances[last]; lengths[last] = 1; }
  for (let p = 0; p < data.length;) {
    const length = lengths[p];
    if (length >= 2) emit(0x10000 | (distances[p] << 8) | length, 17); else emit(data[p], 9);
    p += length;
  }
  const bytes = Math.ceil(bit / 8); check(bytes % 2048 !== 0, 'OOCH file ends on a sector'); put32(out, 8, bytes - 2048); put32(out, 12, data.length);
  return out.subarray(0, bytes);
}
