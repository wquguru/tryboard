# H-16 每课代理的公共说明

每个 H-16 子代理只做一课，先读这份，再读派单里的「本课」部分。

## 先读
- AGENTS.md（规则、命令）
- docs/ARCH.md「新手模式 / 课程」节（约 356 行起，含 H-15 课程层挂点）
- docs/DECISIONS.md「2026-10-26 H-15 / H-16 课程映射」与 H-15 条目
- docs/DESIGN_V2.md §11.1 / §11.2
- 现成样板：web/src/app/lessons.ts 里第 1–3 课（weather 01 / 02 / 03，约 172–493 行），字段定义 `interface Lesson`（约 106 行）

## 写在哪（避免并行合并冲突）
- 本课数据写成新文件 `web/src/app/lessondata/l<课号>.ts`（导出一个 `Lesson`），在 lessons.ts 的 `LESSONS` 数组末尾只加一行引用。不要改其它课的数据。
- 课程表 `web/src/app/course.ts`（COURSE 已有本课条目，work / cp 已定，别改别的条目）。
- i18n：所有新文案走 `t()`，en / zh / ja / ko 同时加，**只在各语言文件末尾追加**（web/src/i18n/{zh,ja,ko}/lab.ts），用脚本批量写入。
- 数据测试：新文件 `web/test/lesson-l<课号>.test.ts`（引用的 part id / wire id / 引脚在台面里真存在、步骤与任务齐全、callout target 合法、`courseLesson(entry)` 不为 null）。

## 内容要求
- 与第 1–3 课同一套结构：5 步左右（认识零件 → 接线 → 代码 → 运行看结果 → 改一改），每步有 tasks（能自动打勾的用 lessontasks.ts 的 done 信号）、callouts（指向台面真实零件 / 引脚）、H-14 的 code / params（参数标来源：bench / code / datasheet / typical / estimate；datasheet 只写文档名不写页码）/ wireNotes / buyTip。
- `parts` 只留本课零件（H-09 sceneView 白名单，id 见 web/src/app/wiring.ts partId）。
- 讲解面向从没碰过硬件的人；数值不编造，算不出的标 estimate。
- 固件：用该检查点在 firmware/levels.json 里的 `ref`；需要新固件的课先写固件（ESP-IDF 5.5，ESP32-S3，`firmware/<name>/`），firmware/levels.json 加关卡（pass 条件可由 tools/check.py 判定），firmware/accept.json 加用例，web/src/app/works.ts 的作品 checkpoints 追加本关。

## 验收
- `cd web && npm test && npx tsc --noEmit`；`python3 tools/lint_comments.py web/src/app`
- 有新固件：`tools/build_fw.sh <name>`、`tools/check.py firmware/build/<name>/flash.bin --level <id>`、`tools/accept.sh --no-web` 里本用例通过（日志重定向到 Reviews/）
- agent-browser：`cd web && npx vite preview --port <派单给的端口>`，`--session <派单给的名字>`；从课程目录（≡）进入本课，走完 5 步（运行固件、看任务自动打勾、看 callout、切 4 个 info tab），截图 Reviews/ab/H-16-l<课号>-*.png 并 Read 看，390×844 手机一张，console 无 error；记录 Reviews/ab/H-16-l<课号>.md
- 不回归：`node tools/webtest/beginner.mjs`

## 收尾
- 在 worktree 分支提交（英文提交信息，末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）。
- PLAN H-16 行不要改状态（多个代理并行，主会话统一改）；在 docs/STATUS.md 末尾追加一行本课结果；取舍写 DECISIONS（末尾追加）。
- worktree：webtest 前把 web/node_modules、third_party、firmware/build 软链到主仓库；需要 wasm / fw 时跑 tools/build_web.sh；Reviews/ 被 git 忽略，截图与记录另拷一份到主仓库 Reviews/ab/。
- 省 token（AGENTS.md §9）：不得再派子代理；单次输出 > 2 万字符先重定向到 Reviews/ 再 grep；读代码先 `grep -n` 再看 ≤ 60 行；超过约 150 次调用先提交阶段成果并在汇报说明。
- 汇报 ≤ 200 字：做了什么、验收结果、遗留问题、改了哪些公共接口。
