---
description: 对指定文档启动双模型交叉审核循环
---

对以下目标文档启动 crosscheck 双模型交叉审核循环。严格按 crosscheck skill 执行：先过前置检查清单（git 仓库、权限模式、**用 AskUserQuestion 与用户确认 A/B 角色各用哪个模型及谁先修改**、既有循环检测），再对每个文档 `init`（带上用户确认的 --label-primary/--label-secondary）并进入循环体；多文档串行处理。目标文档（可能一个或多个）：

$ARGUMENTS
