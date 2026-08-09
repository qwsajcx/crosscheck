# 异步任务队列设计

## 目标

为批量报表生成系统提供一个可靠的异步任务队列，支持任务提交、排队、执行、重试与结果回传。核心指标：任务从提交到完成的 P99 延迟不超过 30 秒（不含任务自身执行时间），系统吞吐不低于 1000 任务/秒，队列积压超过 10000 时自动触发限流。

## 总体架构

任务队列采用 Redis List + Stream 混合结构：List 负责 FIFO 排队，Stream 负责任务生命周期事件（提交、开始、完成、失败、重试、死亡）的持久化与消费确认。Worker 进程池消费 List 中的任务，执行完成后将结果写入结果存储（MySQL），并通过 Stream 确认完成。

**Stream 消费组设计**：所有生命周期事件写入名为 `task_events` 的 Stream。主控进程通过消费组 `task_events_consumers` 消费事件，用于状态审计和监控聚合。每条事件在消费后立即 `XACK` 确认。Stream 设置 `MAXLEN ~`（近似裁剪），保留上限为 100 万条，防止无限增长。

### 任务生命周期

1. **提交**：客户端调用 `POST /tasks` 提交任务（基于 `task_id` 的提交端幂等：Redis `SET task:submit:<task_id> 1 NX EX 3600` 去重，重复提交返回已有任务信息），任务入 List 尾部，同时向 Stream 追加 `task_submitted` 事件。
2. **排队**：任务在 List 中等待 Worker 消费。
3. **执行**：Worker 从 List 头部 BRPOP 取出任务，更新状态为 `running`，Stream 追加 `task_started` 事件。
4. **完成**：Worker 执行完毕，写入结果到 MySQL，Stream 追加 `task_completed` 事件。
5. **失败**：Worker 执行异常，Stream 追加 `task_failed` 事件（payload 含 `error`、`retry_count`），进入重试队列。
6. **重试**：重试间隔到期后任务重新入队，Stream 追加 `task_retrying` 事件（payload 含 `retry_count`、`next_attempt_at`）。
7. **死亡**：超过最大重试次数后标记为 `dead`，写入死信队列，Stream 追加 `task_dead` 事件（payload 含 `final_error`、`total_retries`）。

### 任务结构

任务 JSON 格式：

```json
{
  "task_id": "uuid-v7",
  "type": "report_generation",
  "priority": 1,
  "payload": { "report_id": "rpt-001", "params": {} },
  "created_at": "2026-08-09T00:00:00Z",
  "max_retries": 3,
  "retry_count": 0,
  "timeout_sec": 10
}
```

## 优先级与调度

任务支持 3 个优先级：`high`(2)、`normal`(1)、`low`(0)。优先级通过独立 List 实现——每个优先级对应一个 Redis List（`tasks:high`、`tasks:normal`、`tasks:low`），Worker 按优先级从高到低依次尝试 BRPOP。

**饥饿防护**：每消费 10 个高优先级任务后，强制从 `tasks:normal` 或 `tasks:low` 尝试消费 1 次（优先 normal），避免低优先级任务长期得不到执行。

高优先级任务配额：高优先级任务占比不超过总提交量的 20%，超过配额的 high 任务降级为 normal 入队。配额统计基于滑动窗口（最近 1 分钟的提交量），窗口内不足 50 条时不触发配额限制。

## 重试机制

任务执行失败后按指数退避重试：第 1 次间隔 1 秒，第 2 次间隔 5 秒，第 3 次间隔 15 秒。超过最大重试次数（默认 3 次）后标记为 `dead`，写入死信队列。

重试任务保持原始 `task_id`，`retry_count` 递增。Worker 通过 `task_id` + `retry_count` 幂等判断，防止重复执行。

## Worker 管理

Worker 进程池大小动态调整：默认最小 4 个、最大 32 个 Worker，基于队列深度自动伸缩。队列深度低于 100 时缩容到最小值，高于 5000 时扩容到最大值。

Worker 健康检查：每个 Worker 每 5 秒向 Redis 发送心跳（`HSET workers:heartbeat <worker_id> <timestamp>`），主控进程检测超过 15 秒未心跳的 Worker 并回收其正在执行的任务。

**主控进程部署与容灾**：主控进程采用主备 + Redis 选主（`SET controller:leader <instance_id> NX EX 10`，续约周期 5 秒）部署。备实例检测到选主 key 过期后自动竞选接管。主控不可用期间（切换窗口 ≤ 15 秒），Worker 自检心跳写入时间戳，若超过 30 秒未见主控续约，自行完成当前任务后安全退出，避免任务悬挂。

## 超时控制

任务执行超时由 Worker 端控制：Worker 取出任务时记录开始时间，执行过程中定期检查是否超过 `timeout_sec`；超时则强制终止任务并进入重试。单个任务的最大执行时间上限为 300 秒，超过后不再重试，直接标记为 `dead`。

单个任务 payload 大小上限为 1 MB（含 JSON 序列化后的完整任务体），超过限制时 `POST /tasks` 返回 `413 Payload Too Large`。

## 结果存储

任务结果写入 MySQL `task_results` 表：

```sql
CREATE TABLE task_results (
  task_id       CHAR(36) PRIMARY KEY,
  type          VARCHAR(64) NOT NULL,
  status        ENUM('completed', 'dead') NOT NULL,
  result        JSON,
  retry_count   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  timeout_sec   SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  created_at    DATETIME NOT NULL,
  completed_at  DATETIME NOT NULL,
  worker_id     VARCHAR(64),
  INDEX idx_type_status (type, status),
  INDEX idx_completed_at (completed_at),
  INDEX idx_worker_id (worker_id)
) ENGINE=InnoDB;
```

结果保留 7 天，每日凌晨 UTC 02:00 清理过期记录。

## 结果获取

客户端通过 `GET /tasks/{task_id}` 轮询任务状态与结果。响应包含当前状态（`queued`、`running`、`completed`、`dead`），任务完成时附带结果 JSON，未完成时仅返回状态与排队位置。可选配置 Webhook 回调 URL（在 `POST /tasks` 请求体中传入 `callback_url` 字段），任务完成或标记为 `dead` 时向该 URL 发送 POST 通知。

## 限流与背压

- 入队限流：队列积压超过 10000 时，`POST /tasks` 返回 `429 Too Many Requests`，响应头 `Retry-After` 指示预估等待秒数。
- 出队背压：Worker 消费速率受 Redis 内存压力影响；Redis 内存使用超过 80% 时暂停消费，等待内存回落。
- 客户端重试：客户端收到 429 后按 `Retry-After` 等待后重试，最多重试 3 次。

## 监控指标

采集周期 10 秒，标签维度：`task_type`、`priority`、`worker_id`、`status`。指标采集采用 Prometheus Pull 模式，每个 Worker 暴露 `/metrics` HTTP 端点，Prometheus 定时拉取；队列深度等 Redis 侧指标由独立 Exporter（`redis_exporter`）采集。

- 队列深度（各优先级 List 长度）：正常范围 < 1000，告警阈值 5000。
- 任务延迟 P50/P99（提交到完成，含排队时间，不含任务自身执行时间）：P99 告警阈值 30 秒。
- 吞吐（每秒完成任务数）：目标 ≥ 1000/s，告警阈值 500/s。
- 重试率：告警阈值 10%。
- 死信率：告警阈值 1%。
- Worker 心跳丢失率：告警阈值 5%。

## 部署

Redis 使用 Sentinel 模式部署（1 主 + 2 从 + 3 Sentinel），内存各配置 16GB，Sentinel 自动故障转移。主从切换对 BRPOP 的影响：Sentinel 完成切换后客户端自动重连新主节点，切换窗口期间（通常 ≤ 5 秒）BRPOP 返回超时，Worker 自动重试。Stream 消费组在切换后自动在新主上重建。Worker 进程部署在独立容器中，通过环境变量 `REDIS_URL` 连接 Redis Sentinel。MySQL 结果存储复用现有分析库实例。

## 故障处理

- **Redis 不可用**：Worker 暂停消费并本地缓存正在执行的任务结果，Redis 恢复后批量写入；新提交请求直接返回 `503 Service Unavailable`。
- **Worker 崩溃**：心跳超时后主控进程回收其任务，回收前通过分布式锁（`SET task:lock:<task_id> <new_worker_id> NX EX <timeout_sec>`）确保同一任务不被并发执行。新 Worker 获取锁成功后方可重新执行该任务，获取失败则跳过等待锁释放。任务重新入队等待其他 Worker 消费。
- **MySQL 不可用**：任务执行结果暂存 Worker 本地文件（JSON Lines 格式），MySQL 恢复后批量导入；暂存文件最多保留 24 小时。
