# Security Policy

## Supported versions

TryBoard is alpha software. Only the latest release and the `main` branch receive fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Preferred: use GitHub's **private vulnerability reporting** ("Security" tab → "Report a vulnerability").
- Or email **hello@wqu.guru** with "TryBoard security" in the subject.

Include what you found, how to reproduce it (a firmware image, input log or URL), and the impact you expect. We aim to
acknowledge reports within 7 days and to agree on a fix and disclosure date with you.

## What is in scope

- The web site and its pages: cross-site scripting, unsafe handling of uploaded firmware, ELF or project files, leaks
  of locally stored data, problems with the real-network switch (C-03) reaching hosts it should not.
- The simulator core (Rust / wasm) and `tryboard` CLI: memory-safety bugs, panics or hangs triggered by crafted
  firmware that escape the per-run limits.
- Build and release scripts in `tools/`.

Firmware running *inside* the simulator is untrusted by design; the simulated chip misbehaving is a correctness bug,
not a vulnerability, unless it affects the host browser or machine.
