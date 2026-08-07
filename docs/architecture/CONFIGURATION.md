# PersonalMemory 配置与本地数据边界

M1.2 建立唯一配置入口 `loadConfig()`。优先级固定为：安全默认值 < 配置文件对象 < 环境变量。未知配置键直接拒绝，避免拼写错误静默降级。

## 安全默认值

- Gateway 默认监听 `127.0.0.1:8787`；非 loopback 地址必须同时启用认证并提供 token。
- 默认关闭模型访问和遥测；无密钥时返回 `model-configuration-required`，允许产品安全启动到配置引导。
- 远程 `openai-compatible` provider 必须显式启用、配置 API key，并将目标 origin 加入 allowlist；远程地址必须使用 HTTPS，URL 不得内嵌凭据。
- 本地 provider 只允许 loopback URL。所有请求目标在创建网络请求前必须经过 `assertOutboundAllowed()`；逻辑策略不读取 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`，这些变量不能扩大 allowlist。M1.3 实际网络客户端还必须对 loopback 禁用环境代理并增加传输层集成测试。
- 配置引导启用模型前必须展示 `getModelOutboundDisclosure()` 返回的 provider、目标 origin，以及会发送的 `model input` 和 `selected memory context` 字段。

## 密钥规则

密钥只从 `PERSONALMEMORY_AUTH_TOKEN` 和 `PERSONALMEMORY_MODEL_API_KEY` 读取。配置文件 schema 明确禁止密钥字段。内存中使用 `SecretValue` 包装；字符串化和 JSON 序列化只产生 `[REDACTED]`。调用网络客户端时才允许在最小作用域内调用 `reveal()`。

## 环境变量

| 变量                                                        | 用途                           |
| ----------------------------------------------------------- | ------------------------------ |
| `PERSONALMEMORY_HOST` / `PERSONALMEMORY_PORT`               | Gateway 监听地址               |
| `PERSONALMEMORY_AUTH_ENABLED` / `PERSONALMEMORY_AUTH_TOKEN` | 非 loopback 认证               |
| `PERSONALMEMORY_DATA_DIR`                                   | 本地数据目录                   |
| `PERSONALMEMORY_TELEMETRY_ENABLED`                          | 显式启用遥测，默认关闭         |
| `PERSONALMEMORY_MODEL_ENABLED`                              | 显式启用模型访问，默认关闭     |
| `PERSONALMEMORY_MODEL_PROVIDER`                             | `local` 或 `openai-compatible` |
| `PERSONALMEMORY_MODEL_BASE_URL`                             | provider 基础 URL              |
| `PERSONALMEMORY_MODEL_ALLOWED_ORIGINS`                      | 逗号分隔的远程 origin 白名单   |
| `PERSONALMEMORY_MODEL_API_KEY`                              | 仅环境变量加载的模型密钥       |

布尔值只接受 `true`、`false`、`1`、`0`，端口只接受 1–65535 的整数。错误信息描述具体修复动作，但不得包含密钥值。

## 数据目录

- macOS 默认使用 `~/Library/Application Support/PersonalMemory`。
- Linux 默认使用 `${XDG_DATA_HOME:-~/.local/share}/personalmemory`。
- 初始化拒绝文件系统根目录、既有文件、路径中的符号链接和权限不是 `0700` 的既有目录。
- 新目录只能建立在稳定可信路径下：最近既有祖先以及从文件系统根到该祖先的完整目录链，必须由 root/当前用户拥有且组/其他用户不可写。新目录以 `0700` 创建；重复初始化幂等。初始化不执行跟随路径的事后 `chmod`，不会擅自修改误选既有目录的权限或内容。
- 威胁边界：目录权限用于隔离其他系统用户，不隔离同一操作系统账户下的恶意进程；同账户进程本来就能读写该用户数据。Node 提供可靠的 descriptor-relative 目录 API 后可再收紧竞态保护。
