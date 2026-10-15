/* Flood Explorer background worker: runs the heavy flow analysis off the
 * page's main thread so building or reopening a model doesn't freeze it. */
importScripts('flood-core.js');

self.onmessage = (e) => {
  const { id, grid, opts, kind } = e.data;
  try {
    if (kind === 'timeline') {
      const tl = self.FloodCore.floodTimeline(e.data.a, e.data.s, opts);
      const bufs = [tl.firstWet, tl.lastWet, tl.firstDeep, tl.lastDeep, tl.wetCount, tl.gauge].map((x) => x.buffer);
      self.postMessage({ id, a: tl }, bufs);
      return;
    }
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
