---
description: 查看当前仓库的 crosscheck 循环状态
---

运行 `node <插件根>/scripts/crosscheck_state.mjs verdict --repo <当前仓库根>`（插件根 = 本 skill 文件向上两级目录），然后用 3 行以内向用户汇总每个循环：文档、轮次、阶段、modifier 槽位、状态、最近一次审核结论。若没有任何循环，说明未发现 `.crosscheck/` 状态目录。

用户附加说明（如有）：$ARGUMENTS
