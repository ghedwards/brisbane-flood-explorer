"""Compare the Python and Rust pipeline outputs (run on the same data).

Usage: python tests/compare_pipeline.py <python_dir> <rust_dir> [label]

Walks both folders; JSON files are compared value by value (timestamps
such as 'fetched' are ignored, numbers to a relative 1e-6), GeoTIFFs by
their grids, PNGs by size and colour count, other files byte for byte.
Prints one line per file and a GitHub notice or warning with the summary.
"""
import json
import math
import sys
from pathlib import Path

VOLATILE = {"fetched", "generated", "built", "apiCalls"}


def diff(a, b, path, out, limit=12):
    if len(out) >= limit:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in VOLATILE:
                continue
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'rust' if k in b else 'python'}")
                continue
            diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items in python, {len(b)} in rust")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out, limit)
            if len(out) >= limit:
                return
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        if not (a == b or (math.isfinite(a) and math.isfinite(b) and abs(a - b) <= 1e-6 * max(1, abs(a), abs(b)))):
            out.append(f"{path}: {a!r} vs {b!r}")
    elif a != b:
        out.append(f"{path}: {str(a)[:80]!r} vs {str(b)[:80]!r}")


def grid(path):
    import numpy as np
    import rasterio
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float64")
        if src.nodata is not None:
            arr[arr == src.nodata] = np.nan
        return arr, src.transform, src.crs


def compare_file(p, r):
    suf = p.suffix.lower()
    if suf in (".json", ".geojson"):
        a, b = json.loads(p.read_text()), json.loads(r.read_text())
        out = []
        diff(a, b, "", out)
        return out
    if suf in (".tif", ".tiff"):
        import numpy as np
        (a, ta, ca), (b, tb, cb) = grid(p), grid(r)
        if a.shape != b.shape:
            return [f"grid {a.shape} vs {b.shape}"]
        msgs = []
        if not np.allclose(list(ta)[:6], list(tb)[:6], atol=1e-6):
            msgs.append(f"transform {tuple(ta)[:6]} vs {tuple(tb)[:6]}")
        if ca != cb:
            msgs.append(f"crs {ca} vs {cb}")
        both = np.isfinite(a) & np.isfinite(b)
        only = int((np.isfinite(a) != np.isfinite(b)).sum())
        d = np.abs(a[both] - b[both]) if both.any() else np.zeros(1)
        msgs.append(f"cells differing in data/no data: {only}; height diff mean {d.mean():.4f} m, 99th pct {np.percentile(d, 99):.3f} m, max {d.max():.3f} m")
        return msgs if (only > a.size * 0.001 or np.percentile(d, 99) > 0.05 or len(msgs) > 1) else []
    if suf == ".png":
        from PIL import Image
        a, b = Image.open(p), Image.open(r)
        if a.size != b.size:
            return [f"size {a.size} vs {b.size}"]
        import numpy as np
        aa, bb = np.asarray(a.convert("RGBA")).astype(int), np.asarray(b.convert("RGBA")).astype(int)
        far = int((np.abs(aa - bb).max(axis=2) > 24).sum())
        return [f"{far} of {aa.shape[0] * aa.shape[1]} pixels differ by more than 24 levels"] if far > aa.shape[0] * aa.shape[1] * 0.01 else []
    if suf in (".f32", ".u8"):
        import numpy as np
        dt = "<f4" if suf == ".f32" else "u1"
        a, b = np.fromfile(p, dtype=dt), np.fromfile(r, dtype=dt)
        if a.shape != b.shape:
            return [f"{a.size} vs {b.size} values"]
        if suf == ".u8":
            n = int((a != b).sum())
            return [f"{n} codes differ"] if n else []
        both = np.isfinite(a) & np.isfinite(b)
        n = int((np.isfinite(a) != np.isfinite(b)).sum()) + int((np.abs(a[both] - b[both]) > 1e-4).sum())
        return [f"{n} values differ"] if n else []
    return [] if p.read_bytes() == r.read_bytes() else ["bytes differ"]


def main(pdir, rdir, label=""):
    pdir, rdir = Path(pdir), Path(rdir)
    files = sorted({f.relative_to(pdir) for f in pdir.rglob("*") if f.is_file()} | {f.relative_to(rdir) for f in rdir.rglob("*") if f.is_file()})
    bad = 0
    for f in files:
        p, r = pdir / f, rdir / f
        if not p.exists() or not r.exists():
            print(f"{f}: only in {'rust' if r.exists() else 'python'}")
            bad += 1
            continue
        try:
            msgs = compare_file(p, r)
        except Exception as e:  # noqa: BLE001
            msgs = [f"could not compare: {e}"]
        print(f"{f}: {'same' if not msgs else 'DIFFERS'}")
        for m in msgs:
            print(f"    {m}")
        bad += bool(msgs)
    kind = "warning" if bad else "notice"
    print(f"::{kind}::Pipeline {label}: {len(files) - bad} of {len(files)} files match" + (f", {bad} differ" if bad else ""))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
