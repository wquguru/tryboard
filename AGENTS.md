# AGENTS.md — TryBoard

The single guide for AI agents (Claude Code, Codex, …) and humans working in this repository. `CLAUDE.md` only includes this file.

## 1. What this is
A browser-based simulator for the ESP32 family, built as an educational product. Goal: **hardware hobbyists run the project they have in mind in a web page before buying boards**, so they know which chip, board and peripherals to buy, and which risks only real hardware can rule out.

Three layers:
1. **Core**: a home-grown instruction-level simulator (Rust → wasm) running the user's real compiled firmware (ESP-IDF / Arduino output).
2. **World**: a 3D browser scene (three.js, WebGPU first, WebGL2 fallback) with board / breadboard / peripherals / room; sensor readings come from the scene (cameras see the render, ultrasonic is a ray cast, IMU comes from physics).
3. **Decision**: selection / BOM / pins / power estimates; every conclusion carries a trust level (simulated / behavioural / estimated / needs real hardware).

## 2. Hard rules
- **Licensing**: see `docs/LICENSING.md` (evidence in `LICENSING_REVIEW.md`). External code / binaries / assets not listed there must not enter the repo or the site. GPL / AGPL code (espressif/qemu, CircuitJS, SimulIDE, …) may be read to understand behaviour, but never copied, translated line by line or structurally mirrored; record what you referenced in DECISIONS and verify with firmware differential tests.
- **Acceptance first**: every peripheral model needs acceptance tests (§6). A feature without acceptance is not done.
- **Do not publish the repo, deploy publicly, post, send external email or spend money** without a human's OK (autonomy limits in §10).
- Never weaken a test to make it pass; never delete `docs/` content to "simplify" — fix it when outdated.

## 3. Layout
```
AGENTS.md              this file (rules, commands, roadmap)
README.md              project overview (English); zh-CN / ja / ko copies in docs/readme/
docs/PRODUCT.md        positioning, users, scenario corpus
docs/PLAN.md           P0–P2 implementation list (IDs, acceptance, status) — the basis for autonomous work
docs/DESIGN.md         visual and interaction spec (the agent-facing copy of the design canvas)
docs/DESIGN_V2.md      design v2: logo, selection advisor, lab v2, mobile layout (wins over DESIGN.md on conflict)
docs/design-v2/        design v2 source files (inline-styled static HTML; read the source for sizes / colours / copy)
docs/ARCH.md           architecture, memory map, boot flow, peripheral model conventions
docs/I18N.md           internationalization and comment rules (U-07)
docs/LICENSING.md      licensing conclusions and rules (LICENSING_REVIEW.md has the evidence)
docs/plan-F/           F programme (retention & sharing): evaluation, research, dispatch plan
docs/DECISIONS.md      autonomous decisions awaiting human review
docs/STATUS.md         peripheral × chip coverage matrix (updated from test results)
core/                  Rust workspace
  crates/rv32          RISC-V RV32IMC core
  crates/xtensa        Xtensa LX6 / LX7 core
  crates/soc           shared SoC parts (bus, MMIO framework, peripheral models)
  crates/esp32c3       ESP32-C3 SoC
  crates/esp32s3       ESP32-S3 SoC
  crates/esp32         classic ESP32 SoC
  crates/elec          electrical model
  crates/cli           native command-line runner (firmware, traces, tests)
  crates/wasm          browser bindings (bare extern "C", no wasm-bindgen)
firmware/              acceptance firmware (ESP-IDF projects) + build output (git-ignored)
web/                   front end (Vite + TS + React + three.js); i18n in web/src/i18n
tools/                 build, acceptance and comparison (QEMU oracle) scripts
Reviews/               screenshots, traces, reports (git-ignored, regenerated every run)
```
`docs/` is still written in Chinese (except I18N.md); keep editing it in Chinese until a human decides otherwise.

## 4. Environment
- Rust (rustup, with `wasm32-unknown-unknown`): `. ~/.cargo/env`
- ESP-IDF v5.5.1: `~/esp/esp-idf-v5.5`, run `. tools/idf_env.sh` first (esp32c3 / esp32s3 / esp32 toolchains + qemu-riscv32 / qemu-xtensa, including the classic esp32 machine, are installed)
- arduino-cli with esp32 core 3.3.2 (`~/Library/Arduino15`, ~5 GB): local builds only; see `docs/M5STACK.md` §7 before shipping Arduino-built binaries
- Python 3.12 (brew) for IDF; the system python3 is 3.9
- Node 24 (nvm)
- Only ~60 GB of disk left: don't install large toolchains casually, don't commit build output

## 5. Common commands
| Task | Command |
|---|---|
| Core unit tests | `cd core && cargo test` |
| Build acceptance firmware | `tools/build_fw.sh [name]` |
| Run firmware natively | `cd core && cargo run -p tryboard-cli --release -- run ../firmware/build/<name>/flash.bin` |
| Run with external parts | `tryboard run <flash.bin> --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325 --oled` (`--oled` prints the screen as ASCII art); S3 round LCD: `--spi gc9a01 --lcd-ppm Reviews/x.ppm`, then `tools/ppm2png.py Reviews/x.ppm Reviews/x.png` |
| Wiring estimate (P2-11) | `tryboard run <flash.bin> --i2c ssd1306@0x3c,bme280@0x76 --i2c-wire 60` (I2C cable cm); `--antenna-loss 30` (antenna blockage dB); conclusion at the end of stderr |
| Full acceptance | `tools/accept.sh [--no-web] [--no-qemu]` (writes `Reviews/accept.md`; cases in `firmware/accept.json`) |
| Golden snapshots (R-02) | `tools/golden.py save` on the unchanged tree before a behaviour-preserving refactor, then `tools/golden.py check [ids]` (byte-identical CLI output of every accept case; accept.sh runs it when `Reviews/golden/` exists) |
| Find hangs / crashes | `tryboard run <flash.bin> --trace 40` (recent jump targets; loads app.elf symbols from the same directory) |
| Logic-analyzer events | `tryboard run <flash.bin> --trace-io Reviews/io.txt [--trace-pins 4,8]` (GPIO / PWM / WS2812 / I2C transactions stamped by cycle; compare with the web page: `node tools/webtest/traceio.mjs`) |
| FreeRTOS task timeline (C-04) | `tryboard run <flash.bin> --trace-tasks Reviews/tasks.json` (open in Perfetto; per-task CPU share at the end of stderr); web parity: `node tools/webtest/tasks.mjs` |
| Fetch third-party inputs (ROM, riscv-tests) | `tools/fetch_third_party.sh` |
| QEMU comparison | `tools/oracle_qemu.sh <name>` |
| External 3D models (STEP → glb, LICENSING ✅ sources only) | `(cd tools/models && npm ci)` once; `node tools/models/fetch.mjs && node tools/models/convert.mjs` (list in `tools/models/models.json`, output + SOURCES.md in `assets/models/<name>/`) |
| Build wasm + web | `tools/build_web.sh` |
| Local dev server | `cd web && npm run dev` |
| Web smoke test | `node tools/webtest/webtest.mjs <example> <expected text>` (screenshots in `Reviews/web/`) |
| Level checks | `tools/check.py <flash.bin> --level 04`; `tools/check.py --ref --all` runs every reference firmware (levels in `firmware/levels.json`) |
| Levels / assembly / home web tests | `node tools/webtest/levels.mjs` (drag-and-drop assembly, web vs CLI fingerprint parity); photo / video `media.mjs`, wiring harness and USB keypad `harness.mjs` |
| Lab interaction / mobile regressions | `node tools/webtest/wiremode.mjs` (wire mode, rewiring, undo / redo); `node tools/webtest/mobile.mjs` (390×844: no horizontal scroll on any page, drawers open / close, primary buttons tappable) |
| BLE virtual phone (C-01) | `tryboard run <flash.bin> --ble-phone` (phone scans → connects → reads all → subscribes; air log `[ble]` on stderr); manual input-log lines `sec:ble=scan` / `ble=connect` / `ble=read 2A19` / `ble=sub 2A37` / `ble=write 0x0019 01` (`0x` = handle, otherwise UUID), replay with `--inputs <file>` |
| SoftAP provisioning phone (C-02) | `tryboard run firmware/build/c3-softap-prov/flash.bin --ap-phone --ap-post 'ssid=MyHome&pass=12345678'` (phone joins the firmware's hotspot, opens the portal, submits; phone log at the end of stderr); script actions `phone=on / join,ssid[,pass] / open / post,,body`; web regression `node tools/webtest/softap.mjs` |
| Real-network switch (C-03) | script actions `realnet=1` / `netreply=id,status,ms,content-type\|reason,base64 body` (exported by the web page's "save replies, replay offline"; `tryboard run --inputs` replays without going online); web regression `node tools/webtest/realnet.mjs` (a local proxy stands in for the internet) |
| Input-log replay parity | `node tools/webtest/replay.mjs` (press BOOT and change temperature on the web → export inputs → `tryboard run --inputs` replay; serial byte-identical, same fingerprint) |
| i18n / comment lint | `python3 tools/lint_comments.py [paths]`; `cd web && node --test test/i18n.test.ts` |
| Browser acceptance (required for new features) | read usage with `agent-browser skills get core`; start `cd web && npx vite preview --port 5180`, then `agent-browser open <url>` → `snapshot` / `click` / `screenshot Reviews/ab/<item>.png` → `console` / `errors`; look at screenshots with Read. Parallel sub-agents use their own port and `--session <name>`; don't share a browser |

## 6. Way of working
1. **Change the docs before the code** when requirements change. Record autonomous decisions in `docs/DECISIONS.md` (date, decision, reason, alternatives).
2. **Four acceptance layers** (mark any missing layer in STATUS):
   - CPU: riscv-tests (rv32ui / um / uc) all pass; instruction-level differential against QEMU
   - Drivers: ESP-IDF examples / test_apps produce the same serial output in the simulator as in QEMU (or real-device logs)
   - Scenarios: corpus projects (`docs/PRODUCT.md`) boot and show the expected behaviour
   - Silicon: real-device HIL (no hardware yet; conclusions say "not calibrated on real hardware")
3. **Only claim done after seeing the result**: web changes must be walked through with `agent-browser` (open → act → screenshot and Read it → no console errors), recorded in `Reviews/ab/<PLAN ID>.md`; anything affecting simulation results must be compared with the CLI fingerprint. The puppeteer scripts (tools/webtest) stay as regressions but don't replace the agent-browser eyeball check. Report failures and skips, and write them into `docs/STATUS.md`. For audio features judge from Web Audio analyser data; headless frame rates don't count, only check for errors.
4. Unimplemented register accesses must never be silent: record them in the trace (`unimpl` counter) and list the top N in the acceptance report.
5. Code style: Rust 2021, `cargo fmt` and `cargo clippy` clean. **Comments in English, explain why, at most 2 consecutive lines** (exceptions and details in `docs/I18N.md` §5). No third-party crates unless recorded in DECISIONS (currently allowed: none). Web npm dependencies also go into DECISIONS first (name, version, licence, size, reason), only from ✅ entries in LICENSING.md; lazy-load where possible, wasm first load still ≤ 2 MB.
6. **Internationalization** (`docs/I18N.md`): the web UI supports en / zh / ja / ko; every user-visible string goes through `t()` with an English key, and zh / ja / ko entries are added together. CLI, tools and Rust output are English only. Firmware `printf` output stays Chinese, and so do expected strings that must match it.
7. Pages follow `docs/DESIGN.md` + `docs/DESIGN_V2.md`; breakpoint `md` (< 768px is mobile; don't use max-[760px] any more); mobile touch targets ≥ 44px, no horizontal scroll at 390×844 in every language; the logo is `web/src/ui/logo.tsx`, don't redraw it; 3D parts are preferably generated procedurally at real dimensions, and external model sources and credits go into the asset directory's `SOURCES.md` (the licences page is generated from it).

## 7. Git
- Local repository, default branch `main`, **no remote yet** (ask before creating one)
- One commit per milestone or independent feature; run `cargo test` + `tools/accept.sh` before committing; **commit messages in English**
- Never commit build output, firmware bins or IDF-generated files

## 8. Roadmap
Details, acceptance and status live in `docs/PLAN.md` (P0 / P1 / P2 / P3); this table is the milestone overview. P0 ≈ M3 + M9 + M10 mainline, P1 ≈ electrical / measurement / 3D assembly, P2 ≈ rest of M2 + M6 S3 Wi-Fi + M8 audio + new projects.

Status: ☐ not started / ◐ in progress / ☑ done

| # | Milestone | Done when |
|---|---|---|
| M0 | ☑ Core bring-up (ESP32-C3) | RV32IMC core passes riscv-tests; IDF `hello_world` boots directly and prints the same as QEMU; FreeRTOS scheduling and `vTaskDelay` work |
| M1 | ☑ GPIO and web | `blink` drives the 3D on-board LED in the browser; wasm first load ≤ 2 MB (excluding 3D assets); serial panel |
| M2 | ◐ Common peripherals | LEDC, RMT (WS2812), I2C (SSD1306, BME280), SPI, ADC, timers; each with acceptance firmware |
| M3 | ◐ Breadboard and 3D world | drag-and-drop parts, wiring; servo / LED strip / display feedback in 3D; drag-to-assemble finished product (SVG, done) |
| M4 | ◐ ESP32-S3 (Xtensa LX7) | M0–M2 acceptance passes on S3 |
| M5 | ◐ USB OTG | S3 acts as keyboard / network adapter; a virtual PC / phone in the browser enumerates and responds (HID keyboard and CDC serial work: s3-usb-keyboard / s3-usb-cdc, project usbkey; network adapter not done) |
| M6 | ◐ Wi-Fi | replaced at the netif layer; HTTP / MQTT examples reach a virtual network on the browser side (C3: open and WPA2-PSK networks work) |
| M7 | ◐ BLE | virtual controller at the VHCI layer + virtual phone (C3 NimBLE peripheral works: c3-ble-hr, see PLAN C-01; S3 and the upload-ELF route not done) |
| M8 | ☐ Audio / camera | I2S microphone / speaker on Web Audio; camera reads the 3D render; xiaozhi-style projects run |
| M9 | ◐ Selection layer | project template → chip / board / BOM / pins / power, with trust labels |
| M10 | ◐ Launch prep | landing page (`/`), 7-level path (merged into lab checkpoints), example library, licence list (`/licenses` + NOTICES); UI v2 (PLAN U-01–U-06: logo, selection advisor, lab v2, mobile) done; i18n (U-07). **Ask a human before going live** |

## 9. Sub-agents and context budget
Session review 2026-10-15: 495 M cache-read tokens in total, 374 M of them from 10 fork sub-agents. Each fork inherited 330–660 k tokens of main-session context at start and re-read it on every tool call, and the main session itself grew to 680 k before compacting. Rules:
1. **Don't use forks for parallel development**; use fresh `general-purpose` sub-agents (`isolation: "worktree"`). The task description must stand on its own; follow the template in `docs/AGENT_BRIEF.md`: goal, files to read, acceptance commands, how to commit. Don't expect it to "remember" the main session.
2. **Use a fork only when it truly needs reasoning from the main session that isn't on disk yet**, and only while the main context is still small (< 150 k).
3. **Write conclusions to disk before dispatching**: what a sub-agent needs to know goes into `docs/` (ARCH, DECISIONS, STATUS) for it to read — two orders of magnitude cheaper than inheriting the conversation.
4. **Auto-compact at 200 k**: `.claude/settings.json` sets `autoCompactWindow: 200000` (the default only compacts at ~967 k). After each milestone commit and report, a human may also run `/compact` manually (the model can't trigger it).
5. **Keep long output out of context**: redirect build / acceptance logs into `Reviews/` and `tail` or `grep` them; crop screenshots to the region of interest before Reading them.
6. **No nested sub-agents**: a sub-agent never spawns its own sub-agents; the brief says so. Split work in the main session instead (U-07 review: 8 planned agents became 25, each paying its own start-up and re-reading the same files).
7. **Cap tool output at ~20 k characters**: `agent-browser snapshot`, logs, whole-file `cat` and sub-agent `.output` files go to `Reviews/` first, then `grep` / `head`. One 600 k-character result is re-read on every later call.
8. **Batch mechanical edits**: for translation, renames and similar sweeps, extract the targets with a script (JSON list), transform the whole batch in one call, write back with a script. Dozens of single `Edit` calls each re-read 100 k+ of context.
9. **Pick the model by task**: mechanical work (translating comments, filling dictionaries, formatting) uses `model: "sonnet"`; architecture, tricky debugging and merge conflicts stay on the default model.
10. **Keep each sub-agent small**: scope it so its context stays under ~80 k; prefer more short agents over a few long ones. Cost ≈ tool calls × context size.
11. **Freeze shared files during sweeps**: while a repo-wide sweep (i18n, renames) is running, other sessions don't commit to the same files, or the sweep has to be merged and redone.

Session review 2026-10-19 (top 3 sessions, 655 M tokens, ~98% cache read, so cost ≈ calls × context): sub-agents averaged ~100 k context per call and all climbed to 163–171 k before compacting (up to 16 times), including sessions started after rule 10; a 38–41 k fixed prefix (system prompt, tools, ~7.7 k skill list, this file) was ~40% of the total; Bash output was another ~40%, about 70% of it from reading code (grep plus wide `sed -n 1,320p` views), re-read after every compaction (one `lib.rs` 12 times); 30 of 31 U-07 translation agents ran on the default model; one main session did 886 calls itself (95 M, 28 compactions). Screenshots (~1.5%) and build logs (~2%) were not a problem. Added rules:
12. **One PLAN ID per sub-agent**: never merge items (C-02 + C-03 in one agent took 504 calls). If a task will clearly exceed ~150 calls, split it before dispatching.
13. **Give the map in the brief**: list entry files with `path:line` and the functions to change, so the sub-agent doesn't spend its first 50 calls exploring. Keep reusable locations in `docs/ARCH.md`.
14. **Read code narrowly**: `grep -n` first, then view ≤ 60 lines around the hit; no whole-file `cat` or `sed -n 1,300p`. Write down what you learned (file:line, signatures) in your notes rather than re-reading after a compaction.
15. **Model is part of the brief**: every `Agent` call states `model` explicitly; translation, comment and dictionary sweeps use `sonnet` (rule 9 was ignored when left implicit).
16. **The main session coordinates, it doesn't grind**: hands-on browser verification, sweeps and multi-file edits go to a fresh sub-agent; the main session reads short reports, merges and commits. A human runs `/clear` between batches once the batch report is on disk.
17. **Trim the fixed prefix**: unrelated user-level skills and claude.ai connectors are turned off for this repo in `.claude/settings.local.json` (git-ignored, per machine: `skillOverrides` `"off"` / `"name-only"` for ones still typed as `/name`, `disableClaudeAiConnectors`). Measured −4.6 k tokens per call (46 → 27 skills), ~$7 / day; cheap, not a main lever. Don't let this file grow — history belongs in `docs/DECISIONS.md`.
18. **Keep `autoCompactWindow` at 200 k for main and sub-agents** (tested 2026-10-19). Opus 5.5 bills cache reads at 0.05× and 5-minute cache writes at 1.25× input, so of the top-3 sessions' $253, reads were 51%, writes 38% (almost all new tool output written once), output 11%. Replaying 52 sub-agents, a 120 k trigger cut reads ~19% but dollars only 3–7% (worse with re-reads, more lossy compactions), so it isn't worth it; 1 M for the main session would cost 3–4.5× (no long-context surcharge, but every call re-reads the whole context). The real lever is putting fewer tokens into context (rules 12–14). For the main session follow Anthropic's guidance: new task → `/clear`, wrong turn → `/rewind`, `/compact <what to keep>` at natural breakpoints instead of waiting for auto-compact.

## 10. Autonomy limits
A human agreed (2026-10-16): work through `docs/PLAN.md` from P0 to P2, report after each batch, continue without waiting for confirmation.
- **OK to do directly**: write code, edit docs, commit on local main, start worktree sub-agents, add dependencies recorded in DECISIONS and ✅ in LICENSING, replace old pages (old links must redirect), download LICENSING ✅ assets into the build.
- **Must ask a human**: creating a remote / pushing, public deployment, external email or posts, spending money (parts, paid services), registering accounts, deleting user data, charging / ads / affiliate links, changing items marked ❌ in the licensing conclusions.
- **When stuck**: if an item can't be done (technical or licensing), mark it ✗ with the reason in PLAN and STATUS and move on; don't force it, don't weaken tests.
- **End of each batch**: accept.sh all green, PLAN status updated, commit, write `Reviews/batch-P<n>.md` (what was done, screenshots, unfinished items), then report to the human.
