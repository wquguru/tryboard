# tryboard (local package, not published)

The TryBoard command line: wasm core + Espressif ROM + checkpoint definitions packed into one npm package, so you can check firmware on your machine without installing Rust / Python.
Judging rules, output format, run fingerprints and exit codes match `tools/check.py` in the repository.

```
npx ./tryboard-0.1.0.tgz check app.bin --level 04
npx ./tryboard-0.1.0.tgz run flash.bin --seconds 3 --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325
```

Build in the repository: `tools/build_npm.sh` (output `packages/tryboard/tryboard-0.1.0.tgz`).

## Third party
- `rom/*.elf`: from https://github.com/espressif/esp-rom-elfs , Apache License 2.0, see `LICENSE-esp-rom-elfs.txt` and `NOTICE.txt`.
