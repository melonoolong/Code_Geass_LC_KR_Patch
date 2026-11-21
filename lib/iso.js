// ISO 9660 and CRI CVM listing over an async reader read(offset, length) -> Uint8Array (a File in the
// browser, a file handle in Node). Files: {container, path, offset, size}; container is null for the
// disc's own files, else the CVM's name without extension in upper case ("ROOT", "MOVIE", ...).
const check = (v, m) => { if (!v) throw Error(m); };
const CVM_HEADER = 6144;
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const ascii = (b, s, e) => String.fromCharCode(...b.subarray(s, e));

async function tree(read, base, container, files) {
  let pvd = null;
  for (let i = 16; i < 64 && !pvd; i++) { const d = await read(base + i * 2048, 2048); check(ascii(d, 1, 6) === 'CD001', 'ISO descriptor'); if (d[0] === 1) pvd = d; else check(d[0] !== 255, 'no primary volume descriptor'); }
  const seen = new Set();
  async function walk(lba, size, prefix, depth) {
    check(depth < 16 && !seen.has(lba) && size < 16 << 20, 'directory'); seen.add(lba);
    const b = await read(base + lba * 2048, size);
    for (let p = 0; p < b.length;) {
      const n = b[p]; if (!n) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
      const loc = u32(b, p + 2), len = u32(b, p + 10), nameLen = b[p + 32];
      if (!(nameLen === 1 && b[p + 33] < 2)) {
        const path = prefix + '/' + ascii(b, p + 33, p + 33 + nameLen).replace(/;\d+$/, '');
        if (b[p + 25] & 2) await walk(loc, len, path, depth + 1);
        else files.push({container, path, offset: base + loc * 2048, size: len});
      }
      p += n;
    }
  }
  await walk(u32(pvd, 158), u32(pvd, 166), '', 0);
}

export async function listFiles(read) {
  const files = [];
  await tree(read, 0, null, files);
  for (const e of files.filter(f => f.container === null && /\.cvm$/i.test(f.path))) {
    const head = await read(e.offset, 4);
    if (ascii(head, 0, 4) === 'CVMH') await tree(read, e.offset + CVM_HEADER, e.path.split('/').pop().replace(/\.cvm$/i, '').toUpperCase(), files);
  }
  return files;
}
export const findFile = (files, container, path) => files.find(f => f.container === container && f.path.toUpperCase() === path.toUpperCase());
