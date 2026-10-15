/* Flood Explorer background worker: runs the heavy flow analysis off the
 * page's main thread so building or reopening a model doesn't freeze it. */
importScripts('flood-core.js');

self.onmessage = (e) => {
  const { id, grid, opts } = e.data;
  try {
    const a = self.FloodCore.analyse(grid, opts);
    const transfer = new Set();
    for (const v of Object.values(a)) {
      if (ArrayBuffer.isView(v) && !transfer.has(v.buffer)) transfer.add(v.buffer);
    }
    self.postMessage({ id, a }, Array.from(transfer));
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
