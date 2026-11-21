// The JLF ending encode off the page's thread: ffmpeg.wasm (@ffmpeg/core, single thread) with the
// release manifest's arguments, the same core and arguments as the build (tools/ffmpeg-wasm.mjs), so
// the stream is the same bytes. Message in: {core: script URL, wasm: ArrayBuffer (hash checked by the
// page), args, input: Uint8Array}; out: {ok, out: Uint8Array} or {ok: false, error}.
self.onmessage = async ({data}) => {
  try {
    importScripts(data.core);
    const ff = await createFFmpegCore({wasmBinary: data.wasm, print() {}, printErr() {}});
    ff.FS.writeFile('/input', data.input);
    const rc = ff.exec(...data.args.map(a => a === '{input}' ? '/input' : a === '{output}' ? '/output' : a));
    if (rc !== 0) throw Error('ffmpeg exited with ' + rc);
    const out = ff.FS.readFile('/output');
    self.postMessage({ok: true, out}, [out.buffer]);
  } catch (e) {
    self.postMessage({ok: false, error: String((e && e.message) || e)});
  }
};
