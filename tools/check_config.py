#!/usr/bin/env python3
"""R-13: cross-check configuration that lives in different languages and files.

Checks that ids referenced in one place exist where they are defined:
  firmware/accept.json, levels.json, examples.json   -> firmware/<dir>, chips, CLI device names, scene part types
  web/src/catalog (templates / rules / advisor)      -> part ids, example ids
Usage: tools/check_config.py            exit 1 and list every problem
       tools/check_config.py --selftest  break one id per check in memory and confirm each is reported
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web/src"


def read(p):
    return (ROOT / p).read_text()


def ts_files():
    return [p for p in WEB.rglob("*.ts*") if "node_modules" not in p.parts]


def load():
    """Everything the checks need, as plain data, so --selftest can corrupt it."""
    cfg = {f: json.loads(read(f"firmware/{f}.json")) for f in ("accept", "levels", "examples")}
    fw = ROOT / "firmware"
    cfg["fw_dirs"] = {p.name for p in fw.iterdir() if (p / "CMakeLists.txt").exists()}
    # Arduino sketches build to firmware/build/arduino-<name> (tools/build_fw.sh)
    cfg["fw_dirs"] |= {f"arduino-{p.name}" for p in (fw / "arduino").iterdir() if p.is_dir()}
    # boards.txt variants build to arduino-<name>-<variant> (one output per board)
    for p in (fw / "arduino").glob("*/boards.txt"):
        rows = [l.split() for l in p.read_text().splitlines() if l.strip() and not l.startswith("#")]
        cfg["fw_dirs"] |= {f"arduino-{p.parent.name}-{r[0]}" for r in rows}
    cfg["chips"] = set(re.findall(r"(\w+): '", re.search(r"CHIP_LABEL[^{]*\{([^}]*)\}", read("web/src/chips.ts")).group(1)))
    # The union may move between files during refactors: find it wherever it is declared
    union = next(m.group(1) for p in ts_files() if (m := re.search(r"export type PartSpec =(.*?);\n\n", p.read_text(), re.S)))
    cfg["part_types"] = set(re.findall(r"\{ type: '(\w+)'", union))
    # devices/ is moving from esp32c3 to soc (R-05): search every crate
    dev = "".join(p.read_text() for p in (ROOT / "core/crates").rglob("devices/mod.rs"))
    make = re.search(r"fn make_i2c.*?\n}\n", dev, re.S)
    cfg["i2c_devices"] = set(re.findall(r'"(\w+)"', make.group(0))) if make else set()
    cli = read("core/crates/cli/src/main.rs")
    cfg["spi_devices"] = set(re.findall(r"--spi (\w+)", cli))
    parts = read("web/src/catalog/parts.ts")
    cfg["part_ids"] = set(re.findall(r"^    id: '([\w.-]+)'", parts, re.M)) | set(re.findall(r"^  id: '([\w.-]+)'", read("web/src/catalog/aioboards.ts"), re.M))
    cfg["part_refs"] = {}
    for f in ("web/src/catalog/templates.ts", "web/src/catalog/rules.ts", "web/src/advisor/data.ts"):
        if (ROOT / f).exists():
            cfg["part_refs"][f] = set(re.findall(r"partId: '([\w.-]+)'", read(f)))
    tpl = read("web/src/catalog/templates.ts")
    cfg["works"] = set(re.findall(r"'(\w+)'", re.search(r"id: ('[^;\n]*);", tpl).group(1)))
    adv = read("web/src/advisor/data.ts")
    cfg["advisor_examples"] = {e for lst in re.findall(r"examples: \[([^\]]*)\]", adv) for e in re.findall(r"'([\w-]+)'", lst)}
    return cfg


def args_devices(args):
    """(bus, name) pairs from CLI args like --i2c ssd1306@0x3c,bme280@0x76 / --spi gc9a01."""
    out = []
    for flag, val in zip(args, args[1:]):
        if flag == "--i2c":
            out += [("i2c", d.split("@")[0]) for d in val.split(",")]
        elif flag == "--spi":
            out += [("spi", d) for d in val.split(",")]
    return out


def check(cfg):
    errs = []
    known = {"i2c": cfg["i2c_devices"], "spi": cfg["spi_devices"]}

    def args_ok(where, args):
        for bus, name in args_devices(args):
            if name not in known[bus]:
                errs.append(f"{where}: --{bus} device '{name}' is not one the CLI builds ({', '.join(sorted(known[bus]))})")

    for t in cfg["accept"]:
        w = f"accept.json {t['id']}"
        if t.get("fw", t["id"]) not in cfg["fw_dirs"]:
            errs.append(f"{w}: firmware/{t.get('fw', t['id'])} does not exist")
        if "chip" in t and t["chip"] not in cfg["chips"]:
            errs.append(f"{w}: unknown chip '{t['chip']}'")
        args_ok(w, t.get("args", []))
    # A level with variants (07) carries ref / work / args per variant instead
    for lv in (v | {"id": x['id'] + (f"/{v['key']}" if 'key' in v else '')} for x in cfg["levels"] for v in x.get("variants", [x])):
        w = f"levels.json {lv['id']}"
        if lv["ref"] not in cfg["fw_dirs"]:
            errs.append(f"{w}: reference firmware/{lv['ref']} does not exist")
        if "work" in lv and lv["work"] not in cfg["works"]:
            errs.append(f"{w}: work '{lv['work']}' is not a template id")
        args_ok(w, lv.get("args", []))
    ex_ids = {e["id"] for e in cfg["examples"]}
    for e in cfg["examples"]:
        w = f"examples.json {e['id']}"
        if e["id"] not in cfg["fw_dirs"]:
            errs.append(f"{w}: firmware/{e['id']} does not exist")
        if e["chip"] not in cfg["chips"]:
            errs.append(f"{w}: unknown chip '{e['chip']}'")
        for p in e.get("scene", {}).get("parts", []):
            if p["type"] not in cfg["part_types"]:
                errs.append(f"{w}: scene part type '{p['type']}' is not in PartSpec")
    for f, refs in cfg["part_refs"].items():
        for r in sorted(refs - cfg["part_ids"]):
            errs.append(f"{f}: partId '{r}' is not in catalog/parts.ts")
    for x in sorted(cfg["advisor_examples"] - ex_ids):
        errs.append(f"web/src/advisor/data.ts: example '{x}' is not in examples.json")
    # Empty registries mean a parser no longer matches the source: fail loudly rather than pass vacuously
    for k in ("fw_dirs", "chips", "part_types", "i2c_devices", "spi_devices", "part_ids", "works"):
        if not cfg[k]:
            errs.append(f"check_config: found no {k} (source layout changed? update the parser)")
    return errs


def selftest():
    breaks = {
        "accept fw": lambda c: c["accept"][0].__setitem__("fw", "no-such-fw"),
        "accept chip": lambda c: c["accept"][0].__setitem__("chip", "esp32x9"),
        "accept i2c": lambda c: c["accept"].append({"id": "blink", "args": ["--i2c", "ssd1307@0x3c"]}),
        "accept spi": lambda c: c["accept"].append({"id": "blink", "args": ["--spi", "st7789"]}),
        "level ref": lambda c: c["levels"][0].__setitem__("ref", "no-such-ref"),
        "level work": lambda c: c["levels"][0].__setitem__("work", "nowork"),
        "example part": lambda c: c["examples"][0].setdefault("scene", {}).setdefault("parts", []).append({"type": "ledd"}),
        "example fw": lambda c: c["examples"][0].__setitem__("id", "no-such-example"),
        "part ref": lambda c: c["part_refs"].setdefault("x", set()).add("no-such-part"),
        "advisor example": lambda c: c["advisor_examples"].add("no-such-example"),
    }
    base = len(check(load()))
    bad = []
    for name, brk in breaks.items():
        c = load()
        brk(c)
        if len(check(c)) <= base:
            bad.append(name)
    print(f"selftest: {len(breaks) - len(bad)}/{len(breaks)} deliberate errors reported" + (f"; missed {bad}" if bad else ""))
    return not bad


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    errs = check(load())
    for e in errs:
        print("✗", e)
    cfg = load()
    print(f"config: {len(errs)} problem(s); {len(cfg['accept'])} accept cases, {len(cfg['levels'])} levels, {len(cfg['examples'])} examples, "
          f"{len(cfg['part_ids'])} parts, i2c {sorted(cfg['i2c_devices'])}, spi {sorted(cfg['spi_devices'])}")
    sys.exit(1 if errs else 0)
