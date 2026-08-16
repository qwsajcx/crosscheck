# Crosscheck — TUI 内双模型文档交叉审核循环

Kimi Code 插件：在 **TUI 会话内部**驱动「双模型文档交叉审核循环」。修改者子代理修订文档、审核者子代理撰写审核意见文件，循环往复直到审核结论为 `[PASS]`，或达到最大轮次、判定无进展。

与传统 headless 编排（tmux + 进程级脚本）的本质区别：**整个循环像普通对话一样在 TUI 里可见、可插话、可中途转向**——每一轮子代理的工作摘要直接出现在会话中，用户随时可以叫停、跳过某条意见或换方向。

## 工作原理

```
用户在目标仓库的 TUI 会话
        │  /crosscheck:run docs/A.md docs/B.md
        ▼
┌─────────────────────────────────────────────────────────┐
│ 主 Agent = 编排器（按 skills/crosscheck/SKILL.md 执行）     │
│  1. state.mjs init → 状态文件                             │
│  2. while 未到终态：                                      │
│       Agent(修改者提示词, model=当前修改者槽位)             │
│       state.mjs record-modify                            │
│       Agent(审核者提示词, model=另一槽位)                  │
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
- **Stop hook 兜底**：未达终态时阻断收工；hook 消息刻意「去指令化」（只读提示 + 固定句式），避免廉价模型把阻断消息当成命令越权接管编排（2026-08-08 实测两次真实发生）。
- **git 纪律**：只有状态脚本会提交，且只 `git add` 目标文档与审核意见文件两个路径，逐轮提交；子代理提示词禁止一切 git 操作。
- **fail-open**：所有 hook 出错即放行，宁可人工介入也不误判阻断。

## 安装

在 TUI 会话中执行（注意是斜杠命令，不是 shell 命令）：

```
/plugins install /path/to/crosscheck
/reload
```

也可以用本仓库自带的 marketplace 源：在 TUI 中 `/plugins marketplace /path/to/crosscheck/marketplace.json`，然后从 Custom 页安装。

安装后运行于 `$KIMI_CODE_HOME/plugins/managed/crosscheck/` 的副本（改源码要重装才生效）；per-user 全局生效。注意：插件 hooks 是全局的——任何 cwd 树下存在 running 状态 `.crosscheck/` 的仓库，其内所有 kimi 会话（含 headless `kimi -p` 进程）的回合结束都会被 stop-guard 评估。

## 使用

在目标文档仓库的 TUI 会话中：

```
/crosscheck:run docs/A.md docs/B.md     # 对指定文档启动交叉审核（多文档串行）
/crosscheck:status                      # 查看当前仓库的循环状态
```

也可以用自然语言触发（"crosscheck 审核一下这份文档"）。启动时按 skill 前置检查清单逐项确认：目标在 git 仓库内、权限模式为 yolo/auto、**用 AskUserQuestion 与用户确认 A/B 角色各用哪个模型及谁先修改**、检测既有循环。

推荐配置（0.36+ 子代理模型池，kimi-code ≥ 0.36.0）：会话开便宜模型做编排（如 deepseek），池里放两个战士，循环内按别名精确派发：

```toml
[secondary_model]
default_model = "kimi-code/k3"
[secondary_model.models]
"kimi-code/k3" = "深度修改者：复杂推理与文档重写。"
"chatgpt-local/gpt-5.6-sol" = "严苛审核者：正确性/一致性/完整性/可执行性四维度审查。"
```

注意 effort：池别名按"全局 `[thinking].effort` → 模型 `default_effort`"解析——要给战士配不同档位（如 K3 max / GPT xhigh），去掉全局 effort 并用 `[models."<别名>".overrides] default_effort` 分别钉档。单模型自审收敛质量差（实测见 `docs/DESIGN_BRIEF.md` §11），仅适合廉价机制冒烟。

### 状态机 CLI

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
│   └── review_loop.py        # headless 版编排器（tmux 黑盒，长期无人值守场景）
├── tests/                    # 状态机单测 + fixtures（冒烟文档）
├── examples/                 # 状态文件样例
└── docs/
    └── DESIGN_BRIEF.md       # 设计简报：动机、实测教训、里程碑、运行记录
```

## 开发状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 骨架与确定性状态机（init/advance/verdict/no-progress/新鲜度） | ✅ 单测 12/12 |
| M2 | 单模型冒烟（自改自审 + Stop hook 循环 + 越权防护定稿） | ✅ 4 轮 PASS |
| M3 | 双模型接线（K3 ↔ GPT-5.6 Sol 交叉审核真实文档） | ✅ 某保密项目 四份 两个迭代 文档全部 PASS（各 4 轮收敛，轨迹 FAIL×3 → PASS，状态样本见 `examples/`） |
| M4 | 恢复与异常路径（pause/abort/resume 实证、429 策略、撞车处置） | ✅ 主体完成；SessionStart stdout 注入未实证（观察型，不影响主流程） |
| M5 | 打包发布（README、marketplace JSON、干净重装验证） | ✅ 0.2.0 已打 tag 并推送 GitHub/Gitee（TUI 侧重装验证随用随做） |

后续：0.3.0 适配 kimi-code 0.36 子代理模型池（`--model-primary/--model-secondary` 派发别名落入状态文件，循环内按别名派发；三角色拓扑原生可行）。

已知边界与取舍：
- kimi-code < 0.36 时子代理模型仅 primary/secondary 两个符号槽；0.36+ 的子代理模型池解除该限制（`Agent model:` 可传任意池别名），三角色拓扑（廉价模型编排 + 两个指定模型互审）已原生可行。早期为此准备的 CLI 执行器方案（`feat/cli-executor` 分支）因此作废，不再合并。
- 单模型自审收敛质量差（实测见 `docs/DESIGN_BRIEF.md` §11），仅适合廉价机制冒烟。
- **禁止**与 headless 版（`legacy/review_loop.py`）在同一仓库同一文档上并发——会互相污染（2026-08-09 撞车实录，简报 §11 追记四）。

## 测试

```bash
node tests/crosscheck_state.test.mjs
```

## 相关文档

- `docs/DESIGN_BRIEF.md` — 完整设计简报：动机、headless 版实测教训、架构决策、里程碑与运行记录（冷启动恢复必读）
- `skills/crosscheck/SKILL.md` — 编排器运行时指令
- `legacy/review_loop.py` — headless（tmux）模式的独立入口，与 in-TUI 版共享提示词契约与状态格式
