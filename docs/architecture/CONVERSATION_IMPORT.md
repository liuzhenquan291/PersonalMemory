# 会话捕获与批量导入契约

> API：PersonalMemory `/api/v1`；Schema：PersonalMemory 数据库 v2

## 用户接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/conversations/capture` | 提交一个会话 |
| POST | `/api/v1/conversations/imports` | 提交 1–50 个会话的批量任务 |
| GET | `/api/v1/conversations/imports/:id` | 查询任务进度 |
| POST | `/api/v1/conversations/imports/:id/retry` | 只重试失败或取消的轮次 |
| POST | `/api/v1/conversations/imports/:id/cancel` | 取消当前和未开始的轮次 |

写接口沿用 Bearer 或 loopback browser session + CSRF；进度查询允许已认证的 browser session
不带 CSRF。请求继续受全局流式 body 限制保护。

每个会话包含稳定 `session_key`、可选 `session_id` 和 `messages`。消息角色只允许
`user`、`assistant`，每相邻两条必须各含一种角色；允许 assistant/user 或 user/assistant
顺序，以兼容先由 Agent 提问的历史会话。单条正文最多 32 KiB，单会话最多 200 条消息，
单任务最多 50 个会话和 500 个轮次。

## 幂等、进度与恢复

调用方必须提供 `idempotency_key`。Gateway 对规范化后的轮次计算 SHA-256：

- 相同 key、相同载荷返回原任务，不再次捕获；
- 相同 key、不同载荷返回 `409 IDEMPOTENCY_CONFLICT`；
- 每个轮次独立持久化为 pending/running/completed/failed/cancelled；
- 重试只重新排队 failed/cancelled，completed 永不重复发送；
- 进程中断遗留的 running 轮次恢复为 `INTERRUPTED` 失败，可显式重试。

任务状态为 pending、running、completed、partial、failed 或 cancelled。进度只返回计数，
错误响应和结构化日志不包含会话正文、模型密钥或幂等载荷。

## 网络和模型边界

PersonalMemory Gateway 只通过不读取代理环境变量的 loopback HTTP 调用腾讯上游 `/capture`；
导入实现本身不连接远端模型或其他网络目标。默认模型关闭时无需外联确认。

配置模型 provider 后，`GET /api/v1/config/status` 会先返回 provider、目标 origin 和发送字段。
提交方必须显式设置 `model_outbound_acknowledged: true`，否则导入在调用上游前返回
`409 MODEL_OUTBOUND_CONSENT_REQUIRED`。该确认不进入幂等载荷，也不替代 provider allowlist、
远端 HTTPS 和密钥脱敏规则。
