// VCDIFF (RFC 3284) decoder for xdelta3 patches made with -S none (no secondary compression), with
// xdelta3's per-window Adler-32. Streams: the patch comes in as chunks, the source is read on demand
// (readSource(offset, length) -> Promise<Uint8Array>), the target goes out window by window.
const check = (v, m) => { if (!v) throw Error(m); };
const NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
const TABLE = (() => {   // the default code table (RFC 3284 5.6)
  const t = [[RUN, 0, 0, NOOP, 0, 0]];
  for (let s = 0; s <= 17; s++) t.push([ADD, s, 0, NOOP, 0, 0]);
  for (let m = 0; m < 9; m++) { t.push([COPY, 0, m, NOOP, 0, 0]); for (let s = 4; s <= 18; s++) t.push([COPY, s, m, NOOP, 0, 0]); }
  for (let m = 0; m < 6; m++) for (let a = 1; a <= 4; a++) for (let c = 4; c <= 6; c++) t.push([ADD, a, 0, COPY, c, m]);
  for (let m = 6; m < 9; m++) for (let a = 1; a <= 4; a++) t.push([ADD, a, 0, COPY, 4, m]);
  for (let m = 0; m < 9; m++) t.push([COPY, 4, m, ADD, 1, 0]);
  return t;
})();

// Sequential reader over an async iterable of Uint8Array chunks.
class Stream {
  constructor(chunks) { this.it = chunks[Symbol.asyncIterator](); this.buf = new Uint8Array(0); this.pos = 0; this.done = false; this.read = 0; }
  // The chunks a read needs are gathered and joined once: joining at every chunk was quadratic for a
  // window of tens of MB arriving in a browser fetch's small chunks (2026-11-21: the page stalled at 3.3 GB).
  async fill(n) {
    let have = this.buf.length - this.pos;
    if (have >= n || this.done) return have >= n;
    const parts = [this.buf.subarray(this.pos)];
    while (have < n) {
      const r = await this.it.next(); if (r.done) { this.done = true; break; }
      parts.push(r.value); have += r.value.length;
    }
    const next = new Uint8Array(have);
    let at = 0;
    for (const p of parts) { next.set(p, at); at += p.length; }
    this.buf = next; this.pos = 0;
    return have >= n;
  }
  async bytes(n) { check(await this.fill(n), 'patch truncated'); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; this.read += n; return b; }
  async byte() { return (await this.bytes(1))[0]; }
  async varint() { let v = 0, b; do { b = await this.byte(); v = v * 128 + (b & 127); } while (b & 128); return v; }
  async end() { return !(await this.fill(1)); }
}
function adler32(b) { let a = 1, s = 0; for (let i = 0; i < b.length;) { const e = Math.min(b.length, i + 3800); for (; i < e; i++) { a += b[i]; s += a; } a %= 65521; s %= 65521; } return (s * 65536 + a) >>> 0; }

// Source blocks of 64 KiB, the most recent 1024 kept (64 MiB). The base patch's 3.3-3.5 GB copies from
// scattered places: 1 MiB x 64 read 155 GB of source in all (148k reads; the page in a browser stalled
// there), 64 KiB x 1024 reads 3.5 GB (54k reads), measured 2026-11-21.
function sourceCache(readSource, sourceBytes) {
  const BLOCK = 1 << 16, cache = new Map();
  const block = async i => {
    let b = cache.get(i);
    if (b) { cache.delete(i); cache.set(i, b); return b; }
    b = await readSource(i * BLOCK, Math.min(BLOCK, sourceBytes - i * BLOCK)); cache.set(i, b);
    if (cache.size > 1024) cache.delete(cache.keys().next().value);
    return b;
  };
  return async (out, at, offset, n) => {
    while (n > 0) { const i = Math.floor(offset / BLOCK), b = await block(i), o = offset - i * BLOCK, k = Math.min(n, b.length - o); check(k > 0, 'source read past its end'); out.set(b.subarray(o, o + k), at); at += k; offset += k; n -= k; }
  };
}

// chunks: AsyncIterable<Uint8Array> of the patch; write(Uint8Array) awaited per window; progress(targetBytes).
export async function decode(chunks, readSource, sourceBytes, write, progress = () => {}) {
  const s = new Stream(chunks), copySource = sourceCache(readSource, sourceBytes);
  const magic = await s.bytes(4);
  check(magic[0] === 0xd6 && magic[1] === 0xc3 && magic[2] === 0xc4 && magic[3] === 0, 'not a VCDIFF patch');
  const hdr = await s.byte();
  check(!(hdr & 3), 'patch uses secondary compression or a custom code table');
  if (hdr & 4) await s.bytes(await s.varint());   // xdelta3 application header (file names)
  let total = 0;
  while (!(await s.end())) {
    const ind = await s.byte();
    check(!(ind & 2), 'target-segment windows are not supported');
    let segLen = 0, segPos = 0;
    if (ind & 1) { segLen = await s.varint(); segPos = await s.varint(); check(segPos + segLen <= sourceBytes, 'source segment past the source'); }
    await s.varint();   // delta encoding length
    const targetLen = await s.varint(), deltaInd = await s.byte();
    check(deltaInd === 0, 'compressed sections');
    const dataLen = await s.varint(), instLen = await s.varint(), addrLen = await s.varint();
    let checksum = null;
    if (ind & 4) { const c = await s.bytes(4); checksum = (c[0] << 24 | c[1] << 16 | c[2] << 8 | c[3]) >>> 0; }
    const data = (await s.bytes(dataLen)).slice(), inst = (await s.bytes(instLen)).slice(), addr = (await s.bytes(addrLen)).slice();
    const t = new Uint8Array(targetLen), near = [0, 0, 0, 0], same = new Array(768).fill(0);
    let tp = 0, dp = 0, ip = 0, ap = 0, slot = 0;
    const iv = () => { let v = 0, b; do { b = inst[ip++]; v = v * 128 + (b & 127); } while (b & 128); return v; };
    const av = () => { let v = 0, b; do { b = addr[ap++]; v = v * 128 + (b & 127); } while (b & 128); return v; };
    const address = (here, mode) => {
      let a;
      if (mode === 0) a = av(); else if (mode === 1) a = here - av(); else if (mode < 6) a = near[mode - 2] + av(); else a = same[(mode - 6) * 256 + addr[ap++]];
      near[slot] = a; slot = (slot + 1) % 4; same[a % 768] = a;
      return a;
    };
    const run = async (type, size, mode) => {
      if (type === NOOP) return;
      if (size === 0) size = iv();
      check(tp + size <= targetLen, 'instruction past the window');
      if (type === ADD) { t.set(data.subarray(dp, dp + size), tp); dp += size; tp += size; }
      else if (type === RUN) { t.fill(data[dp++], tp, tp + size); tp += size; }
      else {
        let a = address(segLen + tp, mode), n = size;
        if (a < segLen) { const k = Math.min(n, segLen - a); await copySource(t, tp, segPos + a, k); tp += k; n -= k; a = segLen; }
        for (let src = a - segLen; n > 0; n--) t[tp++] = t[src++];
      }
    };
    while (ip < inst.length) { const e = TABLE[inst[ip++]]; await run(e[0], e[1], e[2]); await run(e[3], e[4], e[5]); }
    check(tp === targetLen && dp === dataLen && ap === addrLen, 'window sections not fully used');
    if (checksum !== null) check(adler32(t) === checksum, 'window checksum mismatch at ' + total);
    await write(t); total += targetLen; progress(total);
  }
  return total;
}
