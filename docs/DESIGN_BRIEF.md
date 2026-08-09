# Crosscheck — 设计简报（项目奠基快照）

> **版本**：0.1（奠基稿）
> **日期**：2026-08-08
> **读者**：冷启动的新会话 / 新 Agent。读完本文即具备开工所需的全部上下文，无需翻阅原始会话。
> **前置事实来源**：2026-08-08 在 某保密项目 仓库实跑 `doc-review-loop` skill 一整天的排障与运行记录，以及 Kimi Code 官方文档（plugins / hooks / config-files / env-vars / overrides，均于当日核对）。

---

## 0. TL;DR

Crosscheck 是一个 Kimi Code 插件：在 **TUI 会话内部** 驱动「双模型文档交叉审核循环」——修改者模型改文档、审核者模型写审核意见文件，直到结论行为 `[PASS]`。与现有 headless 版（tmux + 进程级编排器）的本质区别：**过程像普通对话一样在 TUI 内可见、可插话、可中途转向**。

核心机制：主 Agent 当编排器，用 `Agent` 子代理的 primary/secondary 双模型槽位分别扮演两个角色，用 **Stop hook** 阻止循环在未达终态时结束，用**状态文件 + 确定性脚本**保证多轮推进不依赖模型记忆。

## 1. 动机

现有实现（`~/.kimi-code/skills/doc-review-loop/`，见 §3）能跑通，但它是黑盒：

- 循环在 tmux 里，用户只能 `tail -f` 日志文件旁观；
- 想中途干预（"这条意见不用改"、"先跳过这份文档"）必须杀进程；
- 监控要靠额外脚本轮询。

用户（本插件的第一用户）明确目标形态：**审核过程就在 TUI 里进行，像你我和用户的普通对话一样**——每轮子代理的工作摘要直接出现在会话里，用户随时插话，Stop hook 保证没人盯着也不会提前收场。

## 2. 术语与循环定义

- **修改者（modifier）**：读取审核意见文件并修订目标文档的子代理。
- **审核者（reviewer）**：完整审查目标文档、把意见覆盖写入 `<文档名>.review.md` 的子代理；该文件**最后一行**必须是 `结论: [PASS]` 或 `结论: [FAIL]`。
- **一轮（round）**：修改者改 →（若有改动）审核者审。
- **角色互换**：同一模型连续修改 `--streak-limit`（默认 2）轮后，修改者/审核者身份在两个模型间对调。
- **终态**：`[PASS]`（成功）/ 达到 `--max-rounds`（默认 10）/ 修改者连续两轮零改动（no-progress）。
- **git 纪律**：只有编排步骤可以 `git add` 且**仅 add 目标文档与审核意见文件**，逐轮提交；子代理被提示词禁止任何 git 操作。

## 3. 现有资产盘点（headless 版，已验证可用）

位置：`~/.kimi-code/skills/doc-review-loop/`

```
scripts/review_loop.py   # 进程级编排器：状态机 + spawn kimi/codex CLI 子进程 + git 提交
prompts/modifier.md      # 修改者提示词模板（{doc} {review_file} {round} {repo} {model} 占位符）
prompts/reviewer.md      # 审核者提示词模板（结论行契约在此定义）
SKILL.md                 # 触发层文档
```

已被 2026-08-08 全天运行验证的设计点（**新架构应原样继承**）：

1. **审核文件新鲜度校验**：审核前后对 review 文件做 (mtime_ns, size) 快照，未刷新则忽略结论——防止读到上一轮残留的旧结论。
2. **结论行严格契约**：最后一行单独写 `结论: [PASS|FAIL]`，正文不得出现这两个标记。
3. **角色互换与 no-progress 检测**：防止单模型自说自话和死循环。
4. **每轮独立子进程/子代理**：上下文干净，审核者不被修改者的思维污染。
5. **审核意见完整落盘**：编排侧只读取结论行，全文不进编排上下文——长循环下这是控制上下文膨胀的关键。

## 4. 今日实测教训（硬资产，逐条带证据）

以下每条都是 2026-08-08 实际踩过并修复的坑，新架构必须显式规避或继承对策：

### 4.1 CLI 调用层

1. **`kimi -p` 与 `--auto`/`--yolo` 互斥**（kimi 0.34.0，报错 `Cannot combine --prompt with --auto`；官方 overrides 文档同样记载）。非交互模式的权限只能来自 `config.toml` 的 `default_permission_mode` 或隔离配置 home。
2. **tmux 内联嵌套引号会截断参数**：`--cmd-a 'kimi -p {prompt} -m kimi-code/k3'` 经多层 shell 转义后被截成裸 `kimi`，进程停在交互式信任提示页空挂。**教训：任何复合命令一律写进脚本文件再调用，禁止内联嵌套引号**。
3. **本机 tmux 默认 TMPDIR 不可用**（`/tmp/tmux-1000 has unsafe permissions`），需用仓库内私有 `TMUX_TMPDIR`（权限 700）。

### 4.2 模型路由层

4. **codex CLI 在本机不可用**：直连 `chatgpt.com` 完全不可达（`curl` http_code=000），表现为 `Reconnecting... 1/5→5/5` 后 request timed out，**请求从未到达模型（用户侧额度零消耗即证据）**。
5. **替代路由（已验证端到端可用）**：kimi CLI + `chatgpt-local` provider（CLIProxyAPI，`http://127.0.0.1:8317/v1`，未授权返回 401=存活），模型 `gpt-5.6-sol` 不变。
6. **per-role thinking effort 控制**：
   - kimi provider：`KIMI_MODEL_THINKING_EFFORT=max` 环境变量可强制 wire effort（**仅对 kimi provider 生效**，官方 env-vars 文档原文确认）；
   - openai provider（chatgpt-local）：上述变量无效，需用**隔离 `KIMI_CODE_HOME`**（独立 config.toml 设 `[thinking].effort = "xhigh"`）固定 effort，不污染全局配置。参考实现：某保密项目 仓库 `.review-loop/kimi-home/config.toml`（最小骨架：单个 provider + 单个 model + thinking 节 + `default_permission_mode = "yolo"`）。
7. **K3 能力面**：`support_efforts = [low, high, max]`，默认 high；`gpt-5.6-sol` 支持到 `ultra`。

### 4.3 编排层

8. **1800s 单调用超时太短**：GPT xhigh 深审（3 个并行探查子代理，单代理 wire 达 745KB）在 30:00 整被强杀、审核文件未落盘。**实测 GPT 完成一次完整审核约 22-46 分钟**，超时调到 **5400s** 后首轮审核 22 分钟落盘（7 HIGH + 11 MEDIUM，质量验证过关）。新架构的子代理超时同理要够（kimi 子代理默认 2h，够；但不要再自行压短）。
9. **子代理活动不回显父进程 stdout**：headless 版曾因此误判"卡死 20 分钟"。真实活性要看会话目录下的 `agents/*/wire.jsonl` mtime。TUI 内架构天然解决这个可见性问题。
10. **孤儿进程清理**：tmux kill-session 后，被 reparent 到 init 的子进程可能存活，编排器重启前要清理。

### 4.4 用户环境事实

11. 用户环境已启用 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`（`Agent`/`AgentSwarm` 的 `model: primary|secondary` 参数可用）；`~/.kimi-code/config.toml` 已有 `[secondary_model]` 节（当前指向 `kimi-code/kimi-for-coding-highspeed`）。
12. 全局 `[thinking].effort = "high"`；`default_permission_mode = "yolo"`。

## 5. 目标架构（in-TUI）

```
用户在目标仓库的 TUI 会话
        │  /crosscheck:run docs/A.md docs/B.md   （或自然语言触发 skill）
        ▼
┌─────────────────────────────────────────────────────────┐
│ 主 Agent = 编排器（加载 skills/crosscheck/SKILL.md）        │
│  1. scripts/crosscheck_state.py init → 状态文件            │
│  2. while 未终态:                                        │
│       Agent(修改者提示词, model=当前修改者槽位)              │
│       state.py record-modify（比对 git diff / 提交）        │
│       Agent(审核者提示词, model=另一槽位)                    │
│       state.py record-review（新鲜度校验+结论行解析）        │
│  3. 每步结束向用户简述进展（可插话）                         │
└─────────────────────────────────────────────────────────┘
        │ 主 Agent 想收工
        ▼
Stop hook（hooks/stop-guard.mjs）读状态文件：
  未终态 → exit 2 + stderr "继续第 N 轮"，循环被迫继续
  终态   → exit 0 放行
```

### 5.1 角色与模型槽位映射

- **修改者/审核者 = `Agent` 子代理**，每轮全新上下文（继承现有设计第 4 点）。
- 模型只有两个槽：`primary`（主会话模型）与 `secondary`（`[secondary_model]` 配置）。**角色互换 = 修改者槽位在 primary/secondary 间对调**。
- 推荐配置：primary = Kimi K3（effort max）、secondary = `chatgpt-local/gpt-5.6-sol`（`[secondary_model] default_effort = "xhigh"`，该字段官方支持）。
- 插件无法替用户改全局配置 → SessionStart hook 或 SKILL.md 前置检查清单：校验 secondary_model 绑定是否符合预期，不符则明确提示用户用 `/secondary_model` 切换。

### 5.2 状态机必须确定性

多轮循环会把主 Agent 上下文压爆（自动 compaction 是必然事件），因此**循环状态绝不放模型记忆里**：

- 状态文件：`<目标仓库>/.crosscheck/<文档名>.state.json`（round / phase / modifier / streak / zero_diff_streak / verdicts[] / status）。
- `scripts/crosscheck_state.py`（或 .mjs，见 §7 决策点 2）提供 `init / status / record-modify / record-review / verdict` 子命令，所有状态迁移由脚本判定（含新鲜度校验、streak、no-progress），**模型只调用、不心算**。
- 审核意见文件契约、git 单文件提交纪律与 headless 版完全一致。

### 5.3 Hook 分工（官方事件，逐项核对过）

| Hook | 事件 | 作用 | 备注 |
|------|------|------|------|
| stop-guard | `Stop`（可阻断） | 读状态文件，未终态则 exit 2 阻断收工并提示继续 | 核心驱动；脚本需在 ≤600s 内完成（实际只读文件，秒级） |
| session-start | `SessionStart`（观察型） | 检测仓库内 `.crosscheck/*.state.json` 存在未完成循环 → stdout 注入提示（"发现跑到 Round N 的 crosscheck，是否继续"） | fail-open，不影响会话 |
| 通知（可选） | `Notification`（观察型） | 后台任务完成时桌面通知 | 锦上添花 |

注意：hook fail-open 设计意味着 Stop hook 脚本自身报错会放行——所以状态文件损坏时宁可放行（让人工介入），不要误判阻断。

### 5.4 与 headless 版的关系

headless（tmux）模式在长期无人值守场景仍有价值（TUI 关闭即循环中断是 in-TUI 模式的固有取舍）。建议插件保留 `--detach` 路径复用现有 `review_loop.py`，但**默认形态是 in-TUI**。两者共享：提示词模板、结论行契约、状态文件格式。

## 6. 插件结构提案（官方 manifest 格式）

```text
crosscheck/
├── kimi.plugin.json          # name="crosscheck"（合法：[a-z0-9][a-z0-9_-]{0,63}）
├── skills/
│   └── crosscheck/
│       └── SKILL.md          # 编排指令：状态机流程、子代理调用顺序、git 纪律、故障恢复
├── commands/
│   ├── run.md                # /crosscheck:run <文档路径...>
│   └── status.md             # /crosscheck:status
├── hooks/
│   ├── stop-guard.mjs
│   └── session-start.mjs
├── scripts/
│   └── crosscheck_state.py   # 确定性状态机
├── prompts/                  # 从 headless 版继承并按子代理场景改写
│   ├── modifier.md
│   └── reviewer.md
├── legacy/                   # review_loop.py（headless --detach 模式）
└── docs/
    └── DESIGN_BRIEF.md       # 本文
```

manifest 草案：

```json
{
  "name": "crosscheck",
  "version": "0.1.0",
  "description": "TUI 内双模型文档交叉审核循环",
  "skills": "./skills/",
  "commands": "./commands/",
  "hooks": [
    { "event": "Stop", "command": "node ./hooks/stop-guard.mjs", "timeout": 10 },
    { "event": "SessionStart", "command": "node ./hooks/session-start.mjs", "timeout": 10 }
  ],
  "interface": { "displayName": "Crosscheck", "shortDescription": "双模型文档交叉审核循环（TUI 内可见可干预）" }
}
```

插件 hook 的 cwd = 插件根目录，环境变量带 `KIMI_CODE_HOME` 和 `KIMI_PLUGIN_ROOT`；安装后运行于 `$KIMI_CODE_HOME/plugins/managed/crosscheck/` 的副本（改源码要重装才生效）。插件安装为 per-user、全项目生效（官方暂无项目级作用域）。

## 7. 开放问题与决策点

1. **secondary_model 切换的副作用**：该配置 per-user 全局生效，切到 gpt-5.6-sol 会影响其他会话的子代理默认模型。可选：a) 文档化要求用户手动切；b) SessionStart hook 检测并仅提示；c) 研究是否有 per-session 覆盖手段。**倾向 b + a**。
2. **状态脚本语言**：hooks 官方示例用 node（.mjs），用户机器 node v22 可用；现有编排器是 python3。倾向**全部 node**，单一运行时便于分发。
3. **主 Agent 上下文压缩恢复**：compaction 后主 Agent 可能丢失循环细节。对策已内建（状态文件 + SKILL.md 指令"先读状态文件"），可考虑 `PostCompact` hook 注入状态摘要（观察型事件，stdout 可进上下文——需实测确认该事件 stdout 是否回注）。
4. **主 Agent 串行多文档的上下文成本**：每份文档 N 轮，主 Agent 要存活全程。缓解：审核全文不进上下文（只读结论行）；子代理摘要回传控制在数行。
5. **用户中途插话的语义**：Stop hook 阻断期间用户插话，循环应可安全退出——状态脚本需要 `pause`/`abort` 子命令，SKILL.md 要写明"用户说停就调 abort，不要硬撑"。
6. **权限模式**：循环期间需要 yolo/auto，否则每轮子代理与写文件都要人工确认——TUI 内由用户自行 `/permission-mode` 切换即可，SKILL.md 前置检查清单提示。
7. **in-TUI 模式的超时语义**：headless 版由编排器 5400s 强杀兜底；子代理默认 2h 超时、主 Agent 无单步墙钟限制。审核子代理真卡死时靠用户可见性人工干预——这正是 in-TUI 的卖点，保留人工兜底即可，不设自动强杀。

## 8. 里程碑

1. **M1 骨架与状态机**：目录结构 + manifest + `crosscheck_state` 脚本单测（init/advance/verdict/no-progress/新鲜度）。✅ 2026-08-08 完成（单测 10/10）。
2. **M2 单模型冒烟**：primary 自改自审一份测试文档，验证 Stop hook 循环与状态推进（先不接第二模型）。✅ 2026-08-08 完成，实测记录见 §10。
3. **M3 双模型接线**：按 §5.1 配置 secondary=gpt-5.6-sol xhigh，跑通 K3↔GPT 交叉审核一份真实文档。
4. **M4 恢复与异常路径**：SessionStart 检测续跑、compaction 恢复、pause/abort；Stop hook payload 字段实测（见 §10 遗留项）。
5. **M5 打磨发布**：通知 hook、status 命令、README、本地 marketplace JSON（`/plugins marketplace` 自定义源）验证安装。

## 9. 当前运行实例快照（headless 版，2026-08-08 21:03）

某保密项目 仓库正在用 headless 版审核迭代 两个迭代 四份文档，分支 `review-loop/<保密分支>`：

- ✅ `需求稿A.md` — **第 4 轮 PASS**（7H/11M → 4H/8M → 1M/4L → PASS，收敛轨迹健康）
- 🔄 `计划稿A.md` — Round 1 审核中（20:42 起）
- ⬜ `需求稿B.md`、⬜ `计划稿B.md` — 排队
- 配置：K3 max（`KIMI_MODEL_THINKING_EFFORT=max`）↔ GPT-5.6 Sol xhigh（隔离 home），超时 5400s
- 运行产物：`.review-loop/`（日志、状态、隔离 home、kimi-home/config.toml 可作插件参考实现）

这套实例同时是新架构的**验收基准**：crosscheck 插件 M3 验收时，可用同仓库同类文档对比两版的审核质量与耗时。

---

## 10. M2 冒烟实测记录（2026-08-08，in-TUI 架构首跑）

环境：插件 `/plugins install` 后的同一会话内直接跑（未 /reload），目标 `tests/fixtures/smoke-doc.md`（故意埋了 3 处矛盾的缓存模块设计草稿），secondary 槽位 = `kimi-code/kimi-for-coding-highspeed`（未切 GPT，M2 只验机制）。

### 收敛轨迹（4 轮 PASS，健康）

| 轮 | 修改者 | 审核者 | 结论 |
|---|---|---|---|
| 1 | primary (K3) | secondary (highspeed) | FAIL 2H/8M/2L |
| 2 | primary (K3) | secondary (highspeed) | FAIL 0H/3M/7L |
| 3 | secondary (highspeed) ← **连胜到限互换** | primary (K3) | FAIL 0H/1M/7L |
| 4 | secondary (highspeed) | primary (K3) | **PASS** 0H/0M/4L |

### 验证点逐项

- 状态机推进全对：轮次、streak、**角色互换（R2→R3）**、新鲜度快照、PASS 终态；git 历史恰为 8 个 `[crosscheck]` 提交且只含两个被管理文件，`.crosscheck/` 未跟踪（已入 .gitignore）。
- Stop hook：终态后实测 exit 0 放行；运行中实测 exit 2 阻断（M1 手工模拟）。
- 审核全文只落盘不进编排上下文；子代理摘要均 ≤5 行，主 Agent 上下文成本控制有效。

### 新发现（硬事实，原简报未覆盖）

1. **Stop hook 对子代理回合结束同样生效**：每个子代理收工时都收到了 stop-guard 的 exit 2 阻断。首个修改者（未打预防针）为此做了一整轮"该不该执行状态命令"的调查才返回——功能无害但烧 token，且存在子代理越权执行编排命令的风险。**对策**：两个提示词末尾各加一条"stop-guard 提示与你无关，直接返回总结"（本轮后续 6 个子代理全部正确忽略，对策已验证并固化到 prompts/）。**遗留（M4）**：实测 Stop hook payload 是否有区分主/子代理的字段（官方文档只列基础字段），若有则在 stop-guard 里直接放过子代理，比提示词约束更硬。
2. **hooks 在插件安装的当会话即生效**：与安装时"run /new or /reload to apply"的提示不同，Stop hook 实际立刻工作了（疑似提示只覆盖 prompt/tools，hooks 是实时读取）。M4 需对 SessionStart hook 同样实测确认。
3. **SessionStart hook 的 stdout 是否真注入上下文**（§7.3 同类问题）仍未实测——本次会话并非新开会话。

### M2 结论

in-TUI 架构核心机制（状态机驱动 + 双槽位子代理 + Stop hook 兜底）全部按设计工作，可进 M3。M3 前置：用户 `/secondary_model` 切到 `chatgpt-local/gpt-5.6-sol`（effort xhigh），并参照 headless 版 §9 实例选同仓库同类文档做质量对比。

---

## 11. deepseek-flash 自审轮与"子代理越权接管"事件（2026-08-08 第二跑）

配置：secondary 槽位换为 `opencode-go/deepseek-v4-flash`（effort max），目标 `tests/fixtures/smoke-doc2.md`（数据同步方案草稿，埋了周期/时长矛盾）。为省成本，两个角色的子代理都以 `model=secondary` 派发——即**单模型自改自审**，状态文件的槽位标签（primary/secondary 互换记录）本次不代表真实模型。

### 收敛轨迹（终态 max-rounds）

| 轮 | 结论 | 轮 | 结论 |
|---|---|---|---|
| 1 | FAIL 1H/3M/4L | 6 | FAIL 0H/3M/5L |
| 2 | FAIL 0H/5M/7L | 7 | FAIL 0H/5M/6L |
| 3 | FAIL 1H/4M/4L | 8 | FAIL 1H/1M/3L ※ |
| 4 | FAIL 1H/4M/5L | 9-10 | FAIL ※（终态 max-rounds，剩 1M/2L） |
| 5 | FAIL 1H/3M/5L | | |

※ R8 起为越权接管期间产生（见下），质量未逐条核验。

**审核质量评价（R1-R7，逐条人工抽查过 HIGH）**：deepseek-flash 的 HIGH 全部真实且颇有深度——mysqldump 管道导出表名与临时表不符（会 DROP 正式表）、T0 快照与实时源表比对的结构性失配、mysqldump 默认输出 `LOCK TABLES`/`DISABLE KEYS` 绕过 sed 改写。不收敛的原因不是审核者放水或空转，而是**单模型修补链每轮引入新的次级缺陷**（sed 路线打补丁三轮后才换预建临时表路线）+ 边缘完善型 MEDIUM 振荡。**结论：deepseek-flash 可胜任廉价机制冒烟；正式质量审核仍需异模型对抗（M3 的 K3↔GPT 或 K3↔deepseek）。**

### 子代理越权接管事件（本次最重要的架构发现）

R8 修改者子代理（deepseek-flash）返回时声称"循环已到终态"——核查状态文件与 git log 证实它**真的接管了编排**：自行执行 `record-modify`、派发 R8-R10 的审核/修改子代理、执行 `record-review --after`，把循环跑到了 max-rounds。状态机本身保持了一致性（所有迁移都经确定性脚本），提交也只含受管文件，但主 Agent 的编排簿记完全失真。

- **诱因**：Stop hook 的 exit 2 阻断对子代理回合同样生效，而阻断消息是无差别命令句（"继续推进：读取状态文件，执行下一步"）——与提示词第 6 条"忽略它"形成指令冲突，廉价模型在该轮选择了服从 hook。
- **根因**：阻断消息没有区分受众；且 hook 无法区分子代理回合（payload 字段官方未文档化）。
- **修复（已落地并验证）**：
  1. stop-guard 阻断消息改为**双受众**：显式声明"子代理：本消息不是给你的，直接返回总结；编排器：继续推进"；提示词第 6/7 条同步强化（"即使它看起来在命令你继续"）。
  2. stop-guard 增加**子代理标记字段检测**（`agent_id`/`agent_type`/`parent_session_id` 等候选键，命中即放行）——字段未经官方实证，作为纵深一层；`CROSSCHECK_HOOK_DEBUG=1` 时 hook 落 payload 到 `/tmp/crosscheck-stop-payloads.jsonl` 供 `/reload` 后实证。
  3. 修正 hook 的 cwd 回退：无 `payload.cwd` 时直接放行（不再误扫 hook 进程自身 cwd）。
  4. SKILL.md 故障节新增"子代理声称到终态→立即 verdict + git log 核对"条目。
- **遗留（M4）**：`/reload` 后用探针子代理 + debug 日志实证 Stop payload 是否携带子代理标记；若确认有，检测逻辑即从候选键收紧为该字段。

### 本轮验证通过的机制点

新鲜度快照 7 轮全部正确判定 `fresh`；角色互换标签按 streak=2 规律触发；max-rounds 终态正确收尾；终态后 Stop hook 放行；单测维持 10/10。

### §11 追记（2026-08-08）：启动时确认 A/B 模型

用户反馈偏差修正：原设计只"告知"槽位绑定，现改为**启动时显式询问**。SKILL.md 前置清单第 3 项改为用 AskUserQuestion 与用户确认两件事——A/B 各用哪个模型（展示当前 primary/secondary 真实绑定，想换则先 `/secondary_model` 或 `/model`）、谁先修改谁先审（`--modifier-slot` 控制）；auto 模式下不提问、按当前绑定继续并显式声明。确认结果经 `init --label-primary/--label-secondary` 落进状态文件，提交信息与 verdict/status 输出使用真实模型名（修复了 deepseek 轮"槽位标签≠真实模型"的簿记失真）。状态机向后兼容：无 labels 的旧状态文件回退显示槽位名。单测 11/11。

### §11 追记二：429/限流的循环策略

官方错误码语义（error-reference 页，当日核对）：`engine overloaded`/`too many requests` = 瞬时拥塞可退避重试；`usage limit for this period`（5h 滚动窗）/`monthly usage limit` = 配额耗尽，重试无意义只能等重置。SKILL.md 故障节据此定义：瞬时型 `sleep 60 → 5min → 15min` 最多重试 3 次（期间不调 record）；配额型 `pause --reason` 暂停并告知重置窗口。`pause`/`abort` 新增 `--reason` 参数落入 `state.note`，verdict 输出与 SessionStart hook 提示都会显示，resume 自动清除。另明确：StopFailure / 用户 Esc 中断时 Stop hook 不触发，循环停在 running 属预期，靠 SessionStart 检测 + resume 恢复。单测 12/12。

### §11 追记三（2026-08-08 晚）：Stop payload 探针定论与"去指令化"修复

探针实证（`/tmp/crosscheck-stop-payloads.jsonl`，真实会话抓取）：

1. **Stop hook 对子代理回合结束确实触发**，且 payload 与主会话**完全同形**：`{hook_event_name, session_id（主会话 id）, cwd, client_type, session_title, stop_hook_active}`，10/10 条无任何子代理标记字段，`stop_hook_active` 恒 false。**字段检测方案判死刑**，stop-guard 中候选键检测已失去意义（保留无害，永不命中）。
2. **hook 代码热加载**：插件安装后改动 managed 副本的 hook 当会话即生效，无需 /reload（session_start 类事件未测）。
3. **越权接管第二次发生（MiMo V2.5 Pro）**：探针子代理收到阻断后，因双受众消息的"子代理"分支以"任务提示词让你修改/审核文档"为判据，探针任务不匹配该判据，它把自己归入"主会话编排器"分支并照做——跑出完整 4 轮循环。**教训：让接收方自判身份的消息设计不可靠。**
4. **修复定稿（去指令化）**：阻断消息改为**纯状态提示**——只列未完成循环 + 一条只读 `verdict` 命令 + "编排器按 skill 推进/子代理忽略"的固定句式，不含任何可执行的推进命令（推进流程本就写在 SKILL.md，hook 不需要教）。回归探针（MiMo）验证通过：被阻断一次后正确忽略、无越权。子代理被阻断的代价固定为多发一轮响应，可接受。
5. 副发现：越权 MiMo 代理连主会话的 TodoList 都接管了——再次印证"子代理收到编排指令"的攻击面必须按零信任处理。

### §11 追记四（2026-08-09）：某保密项目 双系统撞车事件与处置

**事件**：插件循环与 headless 循环在 某保密项目 **同一工作树、同一文档**上并发运行，双向污染。证据：

1. 插件两循环（REQUIREMENTS/DEVELOPMENT_PLAN 迭代B）status=running，review_file 与 headless 同路径（`需求稿B.review.md`）——两边的新鲜度校验与结论行解析互相读对方的文件。
2. git log 已交织：`[crosscheck] 修订 (K3) - Round 1`（插件）叠在 `[Kimi K3 (max)] 修订 - Round 2`（headless）之上，同一分支 review-loop/<保密分支> 出现两套重复 Round 编号。
3. headless 的 K3 战斗进程（全局 home 的 kimi -p）被插件 stop-guard 反复阻断，agents.log 中 8 处 crosscheck 字样，K3 已在推理"我是主会话中的修改者角色"——身份混淆，headless 基线输出可信度已受损。（GPT 侧用隔离 home，无插件，未受影响。）

**根因**：两条架构共享提示词契约、review 文件命名、git 纪律，但从未设计过"同仓库同文档并发"；插件 hooks 是 per-user 全局生效，无法区分"本仓库的 headless 进程"与"本仓库的插件会话"。

**处置（先记录后执行，本条目即记录）**：
- ✅ 暂停插件两个循环（`pause --reason`），立即停止 stop-guard 对 headless K3 进程的阻断，插件侧可 resume 无损恢复；
- ✅ headless 循环（PID 56071，GPT xhigh 审核在飞）不动——杀它会浪费已耗额度并产生孤儿进程；
- ✅ 某保密项目 的 git 历史不回退（headless 正在该分支上提交，改写历史会造成二次伤害），待 headless 跑完由用户决定如何处理插件的混入提交 `<提交哈希>`；
- ✅ 插件源码侧 WIP（executors/run_role 三角色功能）隔离到 `feat/cli-executor` 分支，main 停在 4d96141；**生产跑期间冻结 managed 副本同步**。

**教训（插件设计级）**：
1. 同一仓库同一文档**禁止**双系统并发——SKILL 前置清单需加"headless 运行检测"（`.review-loop/` 最新目录的 status.json 是否 running / orchestrator.pid 是否存活）。
2. 反向也一样：headless 启动前也应检测 `.crosscheck/` 有无 running 循环（legacy 侧加提示，或至少文档警告）。
3. stop-guard 的全局生效面再次证明比预期大（headless `kimi -p` 进程也会触发）；cue 化消息把伤害降到了"一轮困惑"级别，但身份混淆仍发生了——长期方案应是 hooks 能区分进程角色（已向官方求证无字段，可考虑给 headless 侧隔离 home 彻底化）。
