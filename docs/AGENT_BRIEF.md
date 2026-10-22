# 子代理任务说明模板

派全新子代理（不是 fork）时照这个写；机械类任务（翻译、改名、格式）派 `model: "sonnet"`，要求子代理不靠主会话也能独立完成。原因见 AGENTS.md §9。

派之前自查（AGENTS.md §9 第 12–15 条）：
- 一个子代理只做一个 PLAN ID；预计 > 150 次调用就先拆。
- `Agent` 调用显式写 `model`（机械活 `sonnet`，架构 / 调试默认模型）。
- 〈入口〉一栏必须填到 `路径:行号` 和要改的函数名，没查清就先在主会话 grep 好再派。

```
你在 TryBoard 仓库（<repo-root>，本地 git，分支 main）的独立 worktree 里工作。
先读：AGENTS.md（规则、命令）、docs/ARCH.md 的〈相关节〉、docs/STATUS.md、〈相关源码文件〉。
入口：〈路径:行号 —— 函数 / 结构体，要改什么〉（从这里开始，不要全仓库摸索）

目标：〈一句话〉
范围：〈要做的 / 明确不做的〉
接口约束：〈要复用的 trait / 函数，不能改的公共接口〉
验收：
  - cd core && cargo test && cargo clippy -- -D warnings
  - tools/build_fw.sh 〈固件〉 && tools/accept.sh --no-web 〈或指定用例〉
  - 〈新增验收用例写进 firmware/accept.json〉
  - 网页改动：`cd web && npx vite preview --port 〈独立端口〉`，用 agent-browser（`--session 〈名字〉`）走主流程：open → 操作 → screenshot Reviews/ab/〈PLAN ID〉.png → console / errors 无 error；用 Read 看截图；记录写 Reviews/ab/〈PLAN ID〉.md
设计：页面照 docs/DESIGN.md；任务对应 docs/PLAN.md 的〈ID〉，完成后把状态改成 ☑。
授权：只能用 docs/LICENSING.md 里 ✅ 的来源；GPL 代码可读不可抄（不复制、不逐行翻译）；新 npm / crate 依赖先写 DECISIONS。
完成后：在 worktree 分支提交（英文提交信息，末尾加 Co-Authored-By 行）；更新 docs/STATUS.md 与 DECISIONS.md。
worktree 注意：webtest 前把 web/node_modules、third_party、firmware/build 软链到主仓库，并在 worktree 里 `cargo build -p tryboard-cli --release`；Reviews/ 被 git 忽略，走查记录和截图另拷一份到主仓库 Reviews/ab/（删 worktree 会一起删掉）。
省 token（AGENTS.md §9 第 6–18 条）：不得再派子代理；单次工具输出 > 2 万字符先重定向到 Reviews/ 再 grep / head；机械改动用脚本抽取 → 整批处理 → 脚本回填，不逐条 Edit；读代码先 `grep -n` 再看命中处 ≤ 60 行，不整文件 cat / `sed -n 1,300p`；查到的位置和签名记在自己的笔记里，压缩后不要重读整文件；工具调用超过约 150 次时先提交阶段性成果并在汇报里说明剩余工作，而不是硬撑到压缩。
汇报（≤ 300 字）：做了什么、验收结果（贴通过 / 失败的行）、遗留问题、改动了哪些公共接口。不要贴大段日志。
```
