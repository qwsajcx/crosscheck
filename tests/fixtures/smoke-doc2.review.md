# 审核意见：数据同步方案（草稿）

- 审核对象：`tests/fixtures/smoke-doc2.md`
- 审核轮次：第 3 轮（secondary 槽位）
- 审核维度：正确性、一致性、完整性、可执行性

## HIGH

### H1（正确性 / 可执行性）mysqldump 管道直接导入会命中正式表 `orders`，而非临时表 `order_sync_tmp`（第 12 行"复制方式"）

文档方案是"导出后管道直导入分析库临时表 order_sync_tmp，不落中间文件"，同时明确"mysqldump 默认导出语句自带 `DROP TABLE IF EXISTS + CREATE TABLE`，导入时由其重建临时表，不要使用 `--no-create-info` 等抑制建表语句的选项"。

但 mysqldump 导出语句中的表名是源表名 `orders`（输出形如 `DROP TABLE IF EXISTS \`orders\`; CREATE TABLE \`orders\` ...; INSERT INTO \`orders\` ...`）。若按文档所述直接管道导入分析库，会在分析库上先 DROP 再重建并灌入正式表 `orders`——同步窗口内报表将直接看到半灌数据，且第 16 行切换序列（`RENAME TABLE orders TO orders_prev, order_sync_tmp TO orders`）的前提（数据先入临时表）被彻底破坏。这是会导致正式表被直接覆盖的危险缺陷。

修改建议：必须在管道中将导出表名改写为 `order_sync_tmp`，例如 `mysqldump ... | sed 's/\`orders\`/\`order_sync_tmp\`/g' | mysql ...`（注意转义，且改写只对导入端生效），或改为"预先创建临时表 + `--no-create-info`"路线（并相应修改"不要使用 --no-create-info"的表述）。文档必须明确表名改写机制，这是整个方案可执行的前提。

## MEDIUM

### M1（一致性）抽样校验与 CHECKSUM TABLE 两种手段混为一谈（第 14 行"校验"）

"以主键为抽样键……抽取 10%"描述的是抽样校验；`CHECKSUM TABLE` 是整表校验，无法只对抽样子集计算。当前文本把"10% 抽样"当主案、把"CHECKSUM TABLE"当作其"实现"，逻辑上不成立：要么采用整表 `CHECKSUM TABLE` 比对（则应删去"抽取 10%"的表述），要么采用"抽样 10% + 对抽样行按主键排序拼接后逐行 CRC32 再聚合"（则应删去 CHECKSUM TABLE 表述，并说明抽样行如何取出、如何保证两表抽到同一批）。建议明确二选一并保持全文一致。

### M2（一致性 / 可执行性）切换序列与"观察一个周期后 DROP orders_prev"存在时序冲突（第 16-17 行）

`RENAME TABLE orders TO orders_prev, order_sync_tmp TO orders` 要求 `orders_prev` 在切换时不存在；而文档要求 `orders_prev` 保留"至少一个同步周期"再 DROP。若实现为"下一轮切换完成后再 DROP 上一轮 orders_prev"，则下一轮执行切换时 `orders_prev` 已存在，RENAME 语句必然失败，方案无法连续运行两轮以上。修改建议：明确时序为"下一轮校验通过 → 先 DROP 上一轮 `orders_prev` → 再执行切换"，或在切换前显式处理旧 `orders_prev`（如先改名后延迟删除）。

### M3（正确性）回滚表名 `orders_bad_<YYYYMMDD>` 同一天内多次回滚会重名（第 27 行"失败处理"）

文档称"带日期后缀，避免多次回滚时 orders_bad 表名重复导致语句失败"，但后缀精度仅为天：同一天内第二次回滚时 `orders_bad_20260808` 已存在，`RENAME TABLE orders TO orders_bad_<YYYYMMDD>` 会因目标已存在而失败，与文档所述目的自相矛盾。修改建议：后缀改用时间戳（如 `orders_bad_YYYYMMDDHHMMSS`），或回滚前先检查并清理旧 `orders_bad_*` 表。

### M4（完整性）对源库的负载与 undo 影响未评估（第 12 行）

每 1 小时执行一次约 30 分钟的长事务快照导出，undo log 膨胀、源库查询性能下降、binlog/磁盘压力是真实风险；文档仅覆盖了"导出期间源库 DDL 混叠"这一项风险。修改建议：补充对源库 undo 空间与负载影响的说明（含观测指标或上限），或说明已评估为无风险及其依据。

## LOW

### L1（完整性）校验耗时未量化（第 14 行）

`CHECKSUM TABLE` 需整表扫描约 5000 万行 × 2 张表，抽样 CRC 也需要取数扫描；第 19 行"单次同步约 40 分钟"的预算是否覆盖校验耗时未说明。建议补充校验耗时的估算或实测方法，确认 40 分钟预算成立。

### L2（可执行性）抽样哈希依赖主键类型（第 14 行）

"按主键哈希取模"的具体实现取决于主键形态（自增整数可直接取模；UUID/复合主键需先哈希）。文档未说明订单表主键类型，建议补充一句，避免实施时卡在抽样实现上。

### L3（可执行性）管道命令缺少连接与字符集细节（第 12 行）

mysqldump 与 mysql 客户端的 `--default-character-set=utf8mb4`、目标库连接与认证方式未提及，实施时可能因字符集或凭据问题失败。建议在附录或待办中补全命令模板。

### L4（编辑/一致性）告警阈值在两处重复描述（第 27 行与第 36 行）

"连续失败 2 次 / 单轮总耗时超 55 分钟"在"失败处理"与"待办"中各出现一次，内容一致但属冗余。建议择一处保留完整定义，另一处改为引用。

## 结论

结论: [FAIL]
