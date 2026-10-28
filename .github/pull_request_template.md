## What and why

<!-- One or two sentences. Link the issue or PLAN ID (e.g. P2-11) if there is one. -->

## How it was verified

- [ ] `cd core && cargo fmt --check && cargo test`
- [ ] `just lint`
- [ ] `cd web && npm test && npx tsc --noEmit` (web changes)
- [ ] `tools/accept.sh` (changes to simulation results; say so if you could not run it)
- [ ] New behaviour has an acceptance test; no existing test was weakened
- [ ] Web UI: screenshot attached, 390×844 checked, strings added in en / zh / ja / ko

## Licensing

- [ ] No code copied, translated or mirrored from GPL / AGPL projects; new dependencies are listed in
      `docs/LICENSING.md` and `docs/DECISIONS.md`
