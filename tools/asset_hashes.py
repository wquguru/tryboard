#!/usr/bin/env python3
"""R-19: content hashes of the large fixed-name files in web/public -> JSON manifest {"wasm/tryboard.wasm": "<sha256[:10]>", ...}.
The vite plugin inlines it into every HTML page; web/src/assetver.ts appends ?v=<hash> so those URLs can be cached as immutable.
Usage: python3 tools/asset_hashes.py <public dir> <out.json>. Sidecars (.gz / .b64.txt) are derived and share the base file's hash."""
import glob, hashlib, json, os, sys

PATTERNS = ["wasm/*.wasm", "rom/*.elf", "fw/examples.json", "fw/*/flash.bin", "fw/*/src.json", "fw/*/src.zip", "audio/*.wav", "fonts/fonts.css"]


def manifest(pub):
    out = {}
    for pat in PATTERNS:
        for f in sorted(glob.glob(os.path.join(pub, pat))):
            with open(f, "rb") as h:
                out[os.path.relpath(f, pub).replace(os.sep, "/")] = hashlib.sha256(h.read()).hexdigest()[:10]
    return dict(sorted(out.items()))


if __name__ == "__main__":
    pub, dst = sys.argv[1], sys.argv[2]
    m = manifest(pub)
    with open(dst, "w") as h:
        json.dump(m, h, separators=(",", ":"))
    print(f"[assets] {len(m)} hashed URLs -> {dst}")
