# 第三轮一次跑完：总调度提示词

把下面整段贴进一个新会话（先 `/clear`）。这个会话只负责调度和合并，每一项仍由新的子代理去做，所以每项的 token 消耗和单独开会话差不多；调度会话只读每项的短汇报，上下文涨得慢。

---

你是 TryBoard 第三轮（G-05b – G-17c）的总调度。先读 AGENTS.md §9、§10，再读 docs/internal/plan-G/BRIEFS.md 里「第三轮」那一节（第 150 行起），不要读别的大文件。

**做法**
1. 按波次派子代理，每项一个，同一波的放在同一条消息里并行发出：
   - 第 3 波：G-14、G-05b、G-16a、G-17a
   - 第 4 波：G-05c、G-05d、G-16b、G-17b
   - 第 5 波：G-16c、G-17c
2. 每个子代理：`subagent_type: "general-purpose"`；`model` 按 brief 标题写的来（G-14 用 `sonnet`，其余用 `opus`）；**不要**设 `isolation`，因为 brief 第一步会自己 `git worktree add ../tb-<ID>`。prompt 就是 BRIEFS.md 里该项的整段原文，末尾再加上：
   「你是子代理：不要再派子代理；只在你的 worktree 里改、在你的分支上提交，不要合并进 main；agent-browser 用端口 51<两位序号> 和 `--session <ID>`；上限约 150 次调用，做不完就提交已完成部分，并在汇报里写明剩下什么；最后只汇报 ≤300 字：分支名、提交号、验收结果、未完成项。」
3. 一波全部回来后，由你在主仓库按顺序合并（第 3 波：G-05b → G-16a → G-17a → G-14；其余波按列出的顺序）：`git merge --no-ff <分支>`。docs/PLAN.md、STATUS.md、DECISIONS.md 冲突时两边都保留。每合一个跑一次 `cd core && cargo test 2>&1 | tail -3`。
4. 一波合完后：`tools/build_web.sh > Reviews/g3-build.log 2>&1`，`tools/accept.sh > Reviews/g3-accept.log 2>&1`，只用 `tail` 或 `grep` 看结果。黄金快照的差异如果是本波改动导致的、且 DECISIONS 里写了原因，就 `tools/golden.py save`，否则按缺陷处理：派一个新子代理去修，不要自己大改。全绿后提交，然后 `git worktree remove ../tb-<ID>`。
5. 某项失败时，最多再派一次子代理补做（brief 加上上次的汇报）；还不行就按 §10 在 PLAN 和 STATUS 里标 ✗ 写明原因，继续往下做。依赖它的后续项一并跳过。

**省 token 的规矩**
- 你自己不写功能代码、不做浏览器验证，这些都交给子代理。
- 日志一律重定向到 Reviews/，只看 tail 或 grep；不要 cat 整个文件。
- 每一波结束，把进度追加到 `Reviews/batch-G3.md`：每项一行，写结果、提交号、遗留问题。上下文被压缩后，从这个文件和 `git log` 恢复进度，不要重读代码。

**必须停下来问人**：推送或建远程、公开部署、花钱，以及 brief 里写着「需人工决定」的地方。其余都直接做到底。

**结束**：十项全部合并，或已标 ✗，accept 全绿，PLAN 状态已更新，`Reviews/batch-G3.md` 写完，提交，然后用 10 行以内告诉我结果。
