// Writing the ISO into the browser's own storage (OPFS) where the page cannot (Safari has no
// createWritable): a sync access handle, which only a worker may open. Messages: {open: name},
// {data: Uint8Array}, {close: true}; each answered with {ok} or {ok: false, error}.
let handle = null, at = 0;
self.onmessage = async ({data}) => {
  try {
    if (data.open) {
      const dir = await navigator.storage.getDirectory();
      const file = await dir.getFileHandle(data.open, {create: true});
      handle = await file.createSyncAccessHandle();
      handle.truncate(0); at = 0;
    } else if (data.data) {
      for (let o = 0; o < data.data.length;) { const n = handle.write(data.data.subarray(o), {at}); o += n; at += n; }
    } else if (data.close) {
      handle.flush(); handle.close(); handle = null;
    }
    self.postMessage({ok: true});
  } catch (e) {
    self.postMessage({ok: false, error: String((e && e.message) || e)});
  }
};
