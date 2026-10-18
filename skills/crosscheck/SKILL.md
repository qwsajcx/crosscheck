---
name: crosscheck
description: TUI 内双模型文档交叉审核循环。修改者子代理改文档、审核者子代理写审核意见文件，直到结论行为 [PASS]、达到最大轮次或判定无进展。触发词：crosscheck、交叉审核、审核循环、cross review、文档互审、双模型审核。
---

# crosscheck — TUI 内双模型文档交叉审核循环

你是**编排器**。你不开刀，只调度：每个"修改"或"审核"动作都派一个全新子代理去做，所有循环状态（轮次、角色、连胜、无进展判定、审核新鲜度）由确定性脚本裁决——**你只调用脚本、读状态文件，绝不心算轮次或角色**。你的上下文随时可能被压缩，状态文件是唯一事实来源。

## 路径约定

本 SKILL.md 位于 `<插件根>/skills/crosscheck/SKILL.md`，因此：

- 状态脚本：`<插件根>/scripts/crosscheck_state.mjs`（下文统称 `state.mjs`）
- 提示词模板：`<插件根>/prompts/modifier.md` 与 `<插件根>/prompts/reviewer.md`

下文所有 `node state.mjs ...` 都指该脚本的绝对路径。

## 前置检查清单（启动前逐项过）

1. **目标文档在 git 仓库内**（`git rev-parse --show-toplevel` 能出根目录）。不在则报错停下。
2. **权限模式**：循环期间需要"必要时询问"（旧名 yolo）或"完全自动"（旧名 auto），否则每步都要用户确认。若不是，提示用户 `/permission-mode` 切换。
3. **扫描配置并与用户交互确认审核模型（必须做，不要自作主张）**：
   - **扫描** `~/.kimi-code/config.toml` 并整理出可派发清单：当前会话模型（恒可用别名 `"primary"`）、`[secondary_model]` 的 `default_model` 与 `[secondary_model.models]` 池内容、是否有 `force = true`、全局 `[thinking].effort`、`[models]` 里已登记但尚未入池的别名（候选补充）。
   - **用 AskUserQuestion 一次问清**：
     - **A（修改者）/B（审核者）各用哪个模型**：选项 = 池别名 + `"primary"` + 已登记未入池的别名（标注"需加入池"）。同一模型同扮 A/B 时警告"单模型自审收敛质量差"（简报 §11），用户坚持才继续。
     - **谁先改谁先审**：默认 A=primary 先修改、B=secondary 先审核（init `--modifier-slot` 控制）。
   - **若所选模型都已可派发（在池或为 primary）**：直接进入启动步骤，`--model-primary/--model-secondary` 落用户确认的别名。
   - **若需要改配置**（别名未入池 / `force = true` 挡住了选择 / 用户要求 effort 钉档）——**用户已在流程目标中授权插件改配置**，按序执行：
     1. **用确定性脚本写入**，不要手改 TOML：
        `node <插件根>/scripts/setup_pool.mjs add <别名> --role modifier|reviewer [--desc "自定义描述"] [--dry-run]`（脚本自动备份 `config.toml.bak-<时间戳>`）。池条目描述用脚本内置的 crosscheck 角色文案（`--role`），用户想自定义再 `--desc`。
     2. **确认闸门（退出码语义）**：exit 3 = 池中已有该别名且描述不同——把现有描述与默认描述并排展示，AskUserQuestion 确认后才可加 `--overwrite` 重跑（用户选择保留则原样不动、直接用现有别名继续）；exit 4 = `force = true` 挡路——向用户说明并确认后加 `--remove-force` 重跑。
     3. **effort 钉档**（`[models."<别名>".overrides] default_effort`）脚本不管，手工编辑：先 `cp config.toml config.toml.bak-<YYYYMMDD-HHMM>` 再精确改；注意全局 `[thinking].effort` 存在时池中模型同档，分档需用户确认后一并删除该行。
     4. 把改动内容展示给用户，**提醒 `/reload`（或新开会话）**——池别名要等 reload 后才进入 Agent 工具的 model 列表。
     5. 就此停下：**此时还未 init，无任何副作用**。告诉用户"reload 后说继续 crosscheck 即可"；reload 后用已确认的别名直接 init，不要重复提问。
   - 例外：auto 权限模式（不能提问）时，按池 `default_model` 与 `"primary"` 组合继续，并在第一条进展消息里显式声明实际 A/B 与方向；**auto 模式下也不改全局配置**。
4. **工作区脏文件**：`git status --porcelain` 有无关改动时提醒一句：循环提交只含被管理的两个文件，其余原样保留。
5. **未完成循环检测**：`node state.mjs verdict --repo <仓库根>`，若已有 running/paused 的同名文档循环，问用户续跑（resume）还是重置（init --force），不要默默覆盖。
6. **headless 并发检测（2026-08-09 撞车教训，必须做）**：检查目标仓库是否存在活跃的 headless 审核——`ls -t <仓库根>/.review-loop/2*/status.json | head -1` 读最新 status.json，`state=running` 且对应 orchestrator.pid 进程存活（`kill -0 <pid>`）则为活跃。**同一文档上 headless 与插件并发会双向污染**（review 文件串写、提交交织、stop-guard 阻断 headless 进程），发现活跃 headless 循环时：不同文档→提醒用户后可继续；同文档→拒绝启动，建议等 headless 完成或换干净分支/worktree。

## 启动

对每个目标文档执行：

```bash
node state.mjs init --doc <文档路径> [--max-rounds 10] [--streak-limit 2] \
  [--modifier-slot primary] \
  [--model-primary "<派发别名或 primary>"] [--model-secondary "<派发别名或 primary>"] \
  [--label-primary "<显示名>"] [--label-secondary "<显示名>"]
```

脚本返回单行 JSON，`state_file` 字段是状态文件路径。**记住每个文档的状态文件路径**（也写进你的进展汇报，方便压缩后恢复）。

多文档串行处理：一份到终态再开下一份，不要并行开多个循环（子代理会互相污染工作区）。

## 循环体（严格按序，逐步调用）

每步前先 `node state.mjs status --doc <文档>` 读状态，按 `status`/`phase`/`modifier_slot` 行动：

**phase=modify**：
1. 渲染修改者提示词：读 `prompts/modifier.md`，替换 `{doc}`（绝对路径）、`{review_file}`（绝对路径）、`{round}`、`{repo}`（仓库根绝对路径）、`{model}`（状态文件里该槽位的 label，如 `K3`；无 label 则用槽位名）。
2. 派子代理：`Agent(prompt=渲染结果, description="Round N 修改", model=<状态文件 models[modifier_slot] 的值>)`——池时代该值是池别名（如 `kimi-code/k3`）；老配置则是符号 `primary`/`secondary`。
3. 子代理返回后：`node state.mjs record-modify --doc <文档>`，按返回 JSON 的 `next` 字段走：
   - `review` → 进入审核阶段
   - `modify` → 本轮零改动，继续下一轮修改（同一修改者）
   - `done:no-progress` / `done:max-rounds` → 收尾

**phase=review**：
1. `node state.mjs record-review --doc <文档> --before`（ freshness 快照，**必须**在派审核子代理之前做）。
2. 渲染审核者提示词（`prompts/reviewer.md`，同上占位符），派子代理：`Agent(..., model=<状态文件 models[另一槽位] 的值>)`——审核者永远是非修改者的那个槽位。
3. 子代理返回后：`node state.mjs record-review --doc <文档> --after`，按 `next` 走：`modify` → 下一轮；`done:pass` / `done:max-rounds` → 收尾。`swapped=true` 时告知用户角色已互换。

**每完成一个阶段，用 2-3 行向用户简报**：轮次、谁改了/审了、结论、下一步。不要贴审核全文（全文在 `<文档名>.review.md`，用户自己会看）。

## 终态与收尾

- `pass`：告知用户审核通过，指向最终文档与审核意见文件。
- `max-rounds` / `no-progress`：明确告知这需要人工看最后一版审核意见，**不要自动重跑**。
- 此时 Stop hook 会放行，正常收工。

## 用户插话语义（重要）

Stop hook 会阻断你在未达终态时收工。**用户说停就停**，不要硬撑：

- "暂停一下 / 先别跑了" → `node state.mjs pause --doc <文档>`，然后正常结束回合。
- "不做了 / 停掉 / 放弃" → `node state.mjs abort --doc <文档>`。
- "这条意见不用改 / 跳过这份文档" → 视情况 abort 该文档，或在派修改者时把用户指示明确写进提示词。
- 用户说"继续"且状态为 paused → `node state.mjs resume --doc <文档>` 后按循环体推进。

## 故障与恢复

- **子代理报错/超时/没干完**：状态不会被污染（record 还没调）。直接重派该子代理重试一次；再失败则告诉用户、暂停循环（pause），不要空转烧轮次。
- **429 / 限流（子代理模型调用被拒）**：先看错误文案分两类处理（官方错误码语义）：
  - `The engine is currently overloaded` / `receiving too many requests` → 瞬时拥塞，**退避重试**：`sleep 60` 后重派同一子代理，最多 3 次（间隔 60s → 5min → 15min），期间不调用任何 record 子命令。
  - `usage limit for this period`（5 小时滚动窗）/ `monthly usage limit` → 配额耗尽，**重试无意义**：`node state.mjs pause --doc <文档> --reason "429 配额耗尽，等配额窗口重置"`，告知用户重置窗口（5 小时滚动/月度），等用户说继续再 `resume`。
  - 注意区分是哪个模型 429：只有报错槽位对应的模型受限；用户可能愿意临时改用另一槽位模型继续（回到前置清单第 3 项确认）。
- **会话因错误中断（StopFailure）或用户 Esc 中断**：Stop hook 此时不触发，循环会停在 `running` 状态没人推——这是预期行为。下次会话 SessionStart hook 会提示"发现未完成循环"，用户说继续就从中断的 phase 接着跑。
- **上下文被压缩后**：第一件事是 `node state.mjs verdict --repo <仓库根>` 读全部循环状态，从 `phase` 指示的阶段继续，不要凭记忆跳步。
- **状态文件损坏**：脚本会报错。不要手改状态文件修复不了的字段；最坏情况 `init --force` 重开（git 历史仍在）。
- **审核子代理没写审核文件**：`record-review --after` 会判定 `fresh=false`、结论忽略并继续——但连续发生说明子代理有问题，重派或换提示词重申落盘契约。
- **子代理提到收到 stop-guard 阻断提示**：Kimi Code 的 Stop hook 对子代理回合结束同样生效（M2 实测确认）。两个提示词的最后一条已指示子代理忽略它；若子代理仍越权执行了状态命令，`node state.mjs status --doc <文档>` 核对状态文件与 git log 是否一致。
- **子代理声称"循环已到终态/我已推进状态"（越权接管，2026-08-08 实测真实发生）**：不要信其口述，立即 `node state.mjs verdict --doc <文档>` + `git log --oneline` 核对。状态机本身是确定性的，越权推进不会破坏状态一致性，但你的编排簿记会失真——以状态文件为准继续（或按终态规则收尾）。若越权伴随非受管文件提交，告知用户并检查 `git show --stat`。（kimi-code 0.35+ 已默认禁止 coder 子代理再派子代理，嵌套派发这一半攻击面已堵死；但 Bash 直接调状态脚本仍可能，提示词禁令与本条核查不可省。）

## git 纪律（由状态脚本执行，你和子代理都不碰 git）

- 只有 `record-modify` / `record-review --after` 会提交，且只 `git add` 目标文档/审核意见文件这两个路径，绝不 `git add -A`。
- 子代理提示词已禁止 git 操作；若发现子代理违规提交，告诉用户并检查 `git log`。
- 建议用户开专用分支（如 `crosscheck/<日期>`）跑循环，启动前提醒即可，不代劳。

## 与 headless 版的关系

长期无人值守场景可改用 `legacy/review_loop.py`（tmux 黑盒模式）。默认用本 skill 的 in-TUI 模式：过程可见、可插话。两者提示词与结论行契约一致。
