# Crosscheck — 双模型文档交叉审核循环（Kimi Code 插件）

让两个不同的 AI 模型在你的终端会话里互审一份文档，直到达标为止。循环逻辑：

1. **修改者**（模型 A）修订目标文档；
2. **审核者**（模型 B）通读全文，把分级意见（HIGH/MEDIUM/LOW）写入 `<文档名>.review.md`，最后一行落结论：`结论: [PASS]` 或 `结论: [FAIL]`；
3. `FAIL` → 回到第 1 步继续改；`PASS` → 循环结束。同一模型最多连续修改 2 轮，随后 A/B 角色互换，防止自说自话；达到最大轮次（默认 10）或连续两轮零改动也会安全停止；
4. 每一轮自动 git 提交，且只提交文档与审核文件这两个路径。

整个过程像普通对话一样在会话里可见：每轮谁改了什么、审核给了几条意见、结论如何，都直接出现在对话中——你随时可以插话："这条意见不用改"、"先跳过这份文档"、"停下来"。

适合的场景：需求稿、方案文档、设计文档在交付前，让两个不同模型互相挑刺、迭代收敛，而不是同一个模型自写自夸。

## 前提条件

逐项自查，缺一不可：

| 条件 | 说明 | 检查方法 |
|---|---|---|
| Kimi Code CLI ≥ 0.36.0 | 子代理模型池（按别名派发子代理）从 0.36 开始；**0.40 起该特性已转正，无需实验开关**（0.36–0.39 需 `export KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`）；更老版本只能用 primary/secondary 两个固定槽位（功能降级） | `kimi --version` |
| secondary-model 实验开关（仅 0.36–0.39 需要） | 0.40 起该特性已转正，无需任何开关；老版本不开则子代理永远跟随主模型 | 0.36–0.39：`export KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` |
| Node.js ≥ 18（建议 22） | 插件 hooks 与状态脚本的运行时 | `node --version` |
| 目标文档在 git 仓库内 | 循环逐轮自动提交 | `git rev-parse --show-toplevel` |
| 权限模式 yolo 或 auto | 否则每轮子代理和写文件都要人工确认 | 会话内 `/permission-mode` 切换 |
| 配置好两个模型别名 | 互相审核的两个模型，需已存在于你的 `[models]` 配置 | 见下方池配置示例 |

**推荐：把两个模型登记进子代理模型池**（`~/.kimi-code/config.toml`）。池 = `[secondary_model.models]` 里登记的"可派发子代理模型清单"，启动循环时从中挑选 A/B。完整示例（含思考档位配置，可直接照抄后改别名）：

```toml
# ---- 子代理模型池：循环里 A/B 两个角色从这里挑选 ----
[secondary_model]
default_model = "kimi-code/k3"          # 没特别指定时子代理的默认模型
[secondary_model.models]
# 键 = [models] 里已配置的别名；值 = 给编排者看的选用描述（写清楚它擅长什么）
"kimi-code/k3" = "深度修改者：复杂推理与文档重写。"
"kimi-code/kimi-for-coding" = "严格审核者：正确性/一致性/完整性/可执行性四维审查。"
# ↑ 换成你自己 [models] 里配置好的任意两个别名

# ---- 思考档位（effort）：给每个模型单独钉档 ----
# effort 是该模型思考深度的档位（各模型支持的档位不同，写错会自动回退到该模型默认档）。
# 解析顺序：全局 [thinking].effort（若设置，则压过下面所有钉档，全池同档）
#          → 这里各别名的 default_effort（未设全局时生效）
#          → 模型自带默认档
# 想让 A/B 不同档（如修改者 max、审核者 high），请确认 config.toml 里【没有】全局 [thinking].effort 行。
[models."kimi-code/k3".overrides]
default_effort = "max"
[models."kimi-code/kimi-for-coding".overrides]
default_effort = "high"
```

池配置改完后 `/reload` 或新开会话生效。插件在启动循环时若发现所选别名不在池中，会（经你确认）用自带的 `scripts/setup_pool.mjs` 自动备份并补写这部分配置（含为两个角色准备的一句话默认描述；池中已有自定义描述时会先问你保不保留），再提醒你 reload——上述手动配置只是让你提前就绪。

## 安装

```bash
git clone git@github.com:qwsajcx/crosscheck.git   # 或 gitee 同名校验仓
```

然后在 TUI 会话中执行（注意是斜杠命令，不是 shell 命令）：

```
/plugins install /path/to/crosscheck
/reload
```

也可以用本仓库自带的 marketplace 源：在 TUI 中 `/plugins marketplace /path/to/crosscheck/marketplace.json`，然后从 Custom 页安装。

安装后运行于 `$KIMI_CODE_HOME/plugins/managed/crosscheck/` 的副本（改源码要重装才生效）；per-user 全局生效。注意：插件 hooks 是全局的——任何 cwd 树下存在 running 状态 `.crosscheck/` 的仓库，其内所有 kimi 会话（含 `kimi -p` 非交互进程）的回合结束都会被 stop-guard 评估。

停用与卸载：`/plugins disable crosscheck`（hooks 与命令即刻失效）或 `/plugins remove crosscheck`。

## 使用

在目标文档仓库的 TUI 会话中：

```
/crosscheck:run docs/A.md docs/B.md     # 对指定文档启动交叉审核（多文档串行）
/crosscheck:status                      # 查看当前仓库的循环状态
```

也可以用自然语言触发（"crosscheck 审核一下这份文档"）。启动时插件会：扫描当前模型配置 → 用交互提问与你确认 A/B 各用哪个模型、谁先改谁先审 → 所选别名未入池时自动备份并补写配置、提醒你 `/reload` 后再开跑。同时会检查既有未完成循环与旧版脚本并发冲突。

实用建议：

- 循环会在目标仓库产生逐轮提交，**建议先切专用分支**（如 `crosscheck/<日期>`）再启动。
- 单模型自审收敛质量差（实测见 `docs/DESIGN_BRIEF.md` §11），只建议用于廉价机制冒烟；正式审核用两个不同的模型。
- 中断恢复：会话中断后循环停在 running 属预期，新会话会自动提示"发现未完成循环"，说"继续 crosscheck"即续跑。

## 工作原理

```
用户在目标仓库的 TUI 会话
        │  /crosscheck:run docs/A.md docs/B.md
        ▼
┌─────────────────────────────────────────────────────────┐
│ 主 Agent = 编排器（按 skills/crosscheck/SKILL.md 执行）     │
│  1. state.mjs init → 状态文件                             │
│  2. while 未到终态：                                      │
│       Agent(修改者提示词, model=状态文件记录的 A 模型)       │
│       state.mjs record-modify                            │
│       Agent(审核者提示词, model=状态文件记录的 B 模型)       │
│       state.mjs record-review（新鲜度校验 + 结论行解析）    │
│  3. 每步结束向用户简报（可插话）                            │
└─────────────────────────────────────────────────────────┘
        │ 主 Agent 想收工
        ▼
Stop hook（hooks/stop-guard.mjs）读状态文件：
  未到终态 → exit 2 + stderr 提示继续，循环被迫推进
  已到终态 → exit 0 放行
```

核心设计：

- **双模型对抗**：修改者/审核者由 `Agent` 子代理扮演，派发模型按状态文件记录精确指定（0.36+ 模型池任意别名；老版本为 primary/secondary 两槽）。同一模型连续修改 `--streak-limit`（默认 2）轮后角色互换，防止单模型自说自话。
- **确定性状态机**：循环状态全部落盘到 `<仓库>/.crosscheck/*.state.json`，由 `scripts/crosscheck_state.mjs` 裁决轮次、角色、连胜、无进展判定与审核新鲜度——多轮循环下主 Agent 上下文可能被压缩，**状态文件是唯一事实来源**。
- **结论行严格契约**：审核意见文件最后一行必须是 `结论: [PASS]` 或 `结论: [FAIL]`，正文不得出现标记；审核前后对 review 文件做 (mtime, size) 快照，未刷新则忽略结论，防止读到上一轮残留。
- **Stop hook 兜底**：未达终态时阻断收工；hook 消息刻意「去指令化」（只读提示 + 固定句式），避免廉价模型把阻断消息当成命令越权接管编排（实测两次真实发生）。
- **git 纪律**：只有状态脚本会提交，且只 `git add` 目标文档与审核意见文件两个路径，逐轮提交；子代理提示词禁止一切 git 操作。
- **fail-open**：所有 hook 出错即放行，宁可人工介入也不误判阻断。

### 状态机 CLI（排障用，正常无需手动调用）

循环由编排器自动驱动；以下命令供你查看状态或人工干预：

```
node scripts/crosscheck_state.mjs <子命令> [选项]

init           --doc <path> [--repo <path>] [--max-rounds 10] [--streak-limit 2]
               [--modifier-slot primary|secondary]
               [--model-primary <池别名|primary>] [--model-secondary <池别名|primary>]
               [--label-primary <名>] [--label-secondary <名>] [--force]
status         --doc <path>
record-modify  --doc <path>
record-review  --doc <path> (--before | --after)
verdict        --doc <path> | --repo <path>
pause|abort|resume --doc <path> [--reason "说明"]
```

状态迁移（含新鲜度校验、streak、no-progress、PASS/终态判定）全部由脚本裁定，模型只调用、不心算。

### 故障恢复

- **429 限流**：瞬时拥塞退避重试（60s → 5min → 15min，最多 3 次）；配额耗尽则 `pause --reason`，等窗口重置（5h 滚动 / 月度）。
- **会话中断**：循环停在 `running` 属预期；下次会话 SessionStart hook 会提示"发现未完成循环"，说"继续 crosscheck"即从中断的 phase 续跑。
- **上下文压缩**：先 `verdict` 读全部状态，按 `phase` 指示继续，不凭记忆跳步。
- **子代理越权**：若子代理声称"已推进状态"，立即 `verdict` + `git log --oneline` 核对，以状态文件为准。

## 目录结构

```
crosscheck/
├── kimi.plugin.json          # 插件 manifest（skills/commands/hooks 挂载）
├── skills/crosscheck/        # SKILL.md — 编排指令：状态机流程、子代理调用、git 纪律、故障恢复
├── commands/
│   ├── run.md                # /crosscheck:run <文档路径...>
│   └── status.md             # /crosscheck:status
├── hooks/
│   ├── stop-guard.mjs        # Stop hook：未达终态 exit 2 阻断收工（fail-open）
│   └── session-start.mjs     # SessionStart hook：发现未完成循环 → 提示续跑
├── scripts/
│   └── crosscheck_state.mjs  # 确定性状态机（init/status/record-modify/record-review/verdict/pause/abort/resume）
├── prompts/
│   ├── modifier.md           # 修改者提示词模板（含越权防护条目）
│   └── reviewer.md           # 审核者提示词模板（结论行契约在此定义）
├── legacy/
│   └── review_loop.py        # 旧版独立编排脚本（tmux 后台运行，长期无人值守场景）
├── tests/                    # 状态机单测 + fixtures（冒烟文档）
├── examples/                 # 状态文件样例
└── docs/
    └── DESIGN_BRIEF.md       # 设计简报：动机、实测教训、里程碑、运行记录
```

## 开发状态

当前版本 0.3.0（适配 kimi-code 0.36 子代理模型池）。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 骨架与确定性状态机（init/advance/verdict/no-progress/新鲜度） | ✅ 单测 13/13 |
| M2 | 单模型冒烟（自改自审 + Stop hook 循环 + 越权防护定稿） | ✅ 4 轮 PASS |
| M3 | 双模型接线（K3 ↔ GPT-5.6 Sol 交叉审核真实文档） | ✅ 生产仓库四份文档全部 PASS（各 4 轮收敛，状态样本见 `examples/`） |
| M4 | 恢复与异常路径（pause/abort/resume 实证、429 策略、并发冲突处置） | ✅ 主体完成；SessionStart stdout 注入未实证（观察型，不影响主流程） |
| M5 | 打包发布（README、marketplace JSON、双远程仓库） | ✅ 0.2.0 已打 tag 并推送 GitHub/Gitee |

已知边界：
- kimi-code < 0.36 时子代理模型仅 primary/secondary 两个符号槽（功能降级），建议升级。
- **禁止**与旧版脚本 `legacy/review_loop.py` 在同一仓库同一文档上并发——两边会读写同一个审核文件、交叉提交，互相污染（撞车实录见简报 §11 追记四）。

## 测试

```bash
node tests/crosscheck_state.test.mjs
```

## 相关文档

- `docs/DESIGN_BRIEF.md` — 完整设计简报：动机、实测教训、架构决策、里程碑与运行记录
- `skills/crosscheck/SKILL.md` — 编排器运行时指令
- `legacy/review_loop.py` — 旧版独立入口（tmux 后台运行，插件之外单独使用），与本插件共享提示词契约与状态格式
