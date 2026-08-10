# PersonalMemory Gateway 外观层

M1.3 在腾讯上游 standalone Gateway 外侧建立稳定的个人版 `/api/v1` 边界。个人版不复制 L0–L3、检索或提炼逻辑；它只负责产品 API、安全策略和对上游的受限适配。

## API 契约

| PersonalMemory                      | 腾讯上游                     | 认证                               |
| ----------------------------------- | ---------------------------- | ---------------------------------- |
| `GET /health`                       | 不转发                       | 公开                               |
| `GET /version`                      | 不转发                       | 公开                               |
| `GET /api/v1/config/status`         | 不转发                       | 公开，仅返回布尔状态               |
| `POST /api/v1/session`              | 不转发                       | Bearer；仅 loopback 创建浏览器会话 |
| `DELETE /api/v1/session`            | 不转发                       | 删除当前浏览器会话                 |
| `POST /api/v1/memories/capture`     | `POST /capture`              | Bearer 或 session + CSRF           |
| `POST /api/v1/memories/recall`      | `POST /recall`               | Bearer 或 session + CSRF           |
| `POST /api/v1/memories/search`      | `POST /search/memories`      | Bearer 或 session + CSRF           |
| `POST /api/v1/conversations/search` | `POST /search/conversations` | Bearer 或 session + CSRF           |
| `POST /api/v1/sessions/end`         | `POST /session/end`          | Bearer 或 session + CSRF           |

`/v2/instance/destroy`、seed、任意文件路径和未列入表格的上游路由不会通过个人版代理。彻底删除仍由 M3 的级联删除语义实现，不能把上游 instance destroy 冒充为个人数据彻底删除。

## Web、MCP 与 Gateway 信任模型

- 未配置认证时，健康、版本和配置状态可用于引导；所有记忆访问返回 `AUTH_SETUP_REQUIRED`。
- MCP/SDK 使用 `Authorization: Bearer`。token 只来自 `SecretValue.reveal()` 的最小调用范围，不进入 URL、正文、日志或错误。
- loopback Web 用 Bearer 换取短期、`HttpOnly`、`SameSite=Strict` cookie；之后所有记忆写请求同时要求 session cookie 和 `X-CSRF-Token`。
- 非 loopback 不签发浏览器 session，只接受 Bearer；部署者还必须在可信网络边界处理 TLS，产品默认仍为 loopback。
- 浏览器带 `Origin` 时必须精确命中显式 CORS origin；没有 Origin 的 MCP/SDK 请求不走浏览器 CORS，但仍需 Bearer。

## 请求与错误边界

- 每个请求始终生成服务端 request ID，并通过 `X-Request-ID` 回传；客户端提供的 ID 不进入日志。
- 请求必须为 `application/json`，流式读取超过上限立即取消；契约使用严格 Zod schema，未知字段拒绝。
- 上游超时返回稳定的 `UPSTREAM_TIMEOUT`；连接或非法响应返回安全的 502。上游错误正文、路径和密钥不透传。
- API 响应默认 `no-store`、`nosniff`、`DENY` frame policy 和 `no-referrer`。
- 日志只包含事件、服务端 request ID、方法、有限路由标签、状态和耗时；未知路径统一记录为 `<unmatched>`，不记录 query string、header、cookie、请求/响应正文或错误 cause。
- 业务限流只在认证成功后计入单用户窗口；公开流量和失败认证不能耗尽合法用户配额。无效 Bearer、缺失/未知/过期 session 和错误 CSRF 统一进入独立失败认证窗口。
- 浏览器 session 在创建时主动清扫过期项，活动 session 上限为 32，避免长期积累。

## 上游传输

`FetchUpstreamGatewayClient` 名称保留客户端语义，但生产传输使用 `node:http` 直接连接配置的 credential-free IPv4/IPv6 loopback origin，并显式使用一次性 agent；不读取 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`。目标路径来自编译期 allowlist，响应上限为 10 MiB。配置和客户端构造器分别验证 loopback，形成两层边界。

## 生命周期

`PersonalMemoryGatewayServer` 使用 idle/starting/running/stopping 状态机，支持端口 `0` 测试、端口占用错误、失败后重试、启动中立即停止、并发 stop、停止接受新连接、关闭 idle/active connection 和 stop 后重启。M1.5 已把个人版 Gateway 与 Web 纳入统一开发启动和健康检查；腾讯上游 standalone 在 M2 接入真实记忆操作时再纳入生命周期。
