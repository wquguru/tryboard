# Contributing to TryBoard

Thanks for helping. TryBoard is an instruction-level ESP32 simulator, so most changes are judged by one question:
does the same firmware still produce the same, verified behaviour? This file covers how to propose a change and what
"done" means here. Coding agents (Claude Code, Codex, …) also follow [AGENTS.md](AGENTS.md).

## Before you start

- **Bugs and small fixes**: open a pull request directly, or an issue if you are not sure it is a bug.
- **New peripherals, chips or larger features**: open an issue first so we can agree on scope and on the acceptance
  test. Work items and their acceptance criteria live in [docs/PLAN.md](docs/PLAN.md); coverage is in
  [docs/STATUS.md](docs/STATUS.md).
- **Security issues**: do not open a public issue; see [SECURITY.md](SECURITY.md).

## Setup

Requirements: Rust (rustup, with the `wasm32-unknown-unknown` target), Node 22.18+, Python 3.11+.
ESP-IDF v5.5 is only needed to rebuild the acceptance firmware.

```bash
tools/fetch_third_party.sh             # ROM ELFs and riscv-tests into third_party/ (not committed)
tools/build_web.sh                     # wasm core + web assets
cd web && npm ci && npm run dev        # http://localhost:5180
```

`just --list` shows the everyday commands (`just test`, `just lint`, `just accept`, …).

## What a pull request needs

1. **Acceptance first.** Every peripheral model or behaviour change comes with a test: a Rust unit test, an acceptance
   case in `firmware/accept.json`, or a web regression in `tools/webtest/`. A feature without acceptance is not done.
   Never weaken an existing test to make it pass.
2. **Checks pass locally:**
   - `cd core && cargo fmt --check && cargo test`
   - `just lint` (clippy, comment lint on the files you changed, i18n, config and size checks)
   - `cd web && npm test && npx tsc --noEmit` for web changes
   - `tools/accept.sh` for anything that changes simulation results (needs ESP-IDF; say so in the PR if you could
     not run it)
3. **Web changes** include a screenshot, work at 390×844 without horizontal scroll, and route every user-visible
   string through `t()` with en / zh / ja / ko entries ([docs/I18N.md](docs/I18N.md)).
4. **Code style**: Rust 2021, `cargo fmt` and `cargo clippy` clean; comments in English, explaining why, at most two
   lines in a row. No new Rust crates or npm packages without discussing it first: every dependency has to be listed
   in [docs/LICENSING.md](docs/LICENSING.md) and [docs/DECISIONS.md](docs/DECISIONS.md).
5. **Licensing of what you bring in**: GPL / AGPL code (for example the Espressif QEMU fork) may be read to understand
   behaviour, but must not be copied, translated or structurally mirrored. Say in the PR what you referenced.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org) in English:

```
feat(esp32s3): model the PCNT unit used by rotary encoders

Explain why the change is needed and how it was verified. Mention the
PLAN ID (e.g. P2-11) in the body if there is one.
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. Scopes are crate or area
names (`rv32`, `xtensa`, `soc`, `esp32c3`, `web`, `tools`, `docs`). Keep the subject under 72 characters. Pull
requests are squash-merged, so the PR title becomes the commit subject.

## AI-assisted contributions

AI-assisted work is welcome; much of this repository was written with coding agents. You are responsible for every
line you submit: read it, run the checks above, and make sure it meets the licensing rules. Credit the tool with a
`Co-Authored-By:` trailer if you like.

## Licence

TryBoard is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is
licensed under the same terms (Apache-2.0 §5); there is no separate CLA. Make sure you have the right to submit it.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
