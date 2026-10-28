# Agent session cost reviews

Moved out of AGENTS.md §9 on 2026-10-28; the rules derived from them stay in AGENTS.md.

## 2026-10-15

Session review 2026-10-15: 495 M cache-read tokens in total, 374 M of them from 10 fork sub-agents. Each fork inherited 330–660 k tokens of main-session context at start and re-read it on every tool call, and the main session itself grew to 680 k before compacting.

## 2026-10-19

(top 3 sessions, 655 M tokens, ~98% cache read, so cost ≈ calls × context): sub-agents averaged ~100 k context per call and all climbed to 163–171 k before compacting (up to 16 times), including sessions started after rule 10; a 38–41 k fixed prefix (system prompt, tools, ~7.7 k skill list, this file) was ~40% of the total; Bash output was another ~40%, about 70% of it from reading code (grep plus wide `sed -n 1,320p` views), re-read after every compaction (one `lib.rs` 12 times); 30 of 31 U-07 translation agents ran on the default model; one main session did 886 calls itself (95 M, 28 compactions). Screenshots (~1.5%) and build logs (~2%) were not a problem.
