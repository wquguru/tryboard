# 子代理任务说明模板

派全新子代理（不是 fork）时照这个写，要求子代理不靠主会话也能独立完成。原因见 AGENTS.md §9。

```
你在 TryBoard 仓库（<repo-root>，本地 git，分支 main）的独立 worktree 里工作。
先读：AGENTS.md（规则、命令）、docs/ARCH.md 的〈相关节〉、docs/STATUS.md、〈相关源码文件〉。

目标：〈一句话〉
范围：〈要做的 / 明确不做的〉
接口约束：〈要复用的 trait / 函数，不能改的公共接口〉
验收：
  - cd core && cargo test && cargo clippy -- -D warnings
  - tools/build_fw.sh 〈固件〉 && tools/accept.sh --no-web 〈或指定用例〉
  - 〈新增验收用例写进 firmware/accept.json〉
授权：只能用 docs/LICENSING.md 列出的来源；GPL 代码只读规格，不复制。
完成后：在 worktree 分支提交（中文提交信息，末尾加 Co-Authored-By 行）；更新 docs/STATUS.md 与 DECISIONS.md。
汇报（≤ 300 字）：做了什么、验收结果（贴通过 / 失败的行）、遗留问题、改动了哪些公共接口。不要贴大段日志。
```
