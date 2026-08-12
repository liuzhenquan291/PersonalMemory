# PersonalMemory MCP Server 运行与安全边界

> 实现步骤：M4.2
>
> 契约版本：`1.0.0`
>
> 传输：本机 `stdio`

## 1. 运行拓扑

MCP Server 是协议适配进程，不是第二套记忆服务。它只读取 PersonalMemory 的既有配置，从环境变量取得 Gateway Bearer，并通过带版本号的 loopback HTTP API 调用 Gateway；不会直接打开 SQLite、数据目录、腾讯上游内核或任意文件。

启动前必须完成带鉴权的 `/api/v1/mcp/status` 预检。Gateway 未启动、未配置认证、监听地址不是 loopback 或响应不符合契约时，MCP 在接入 stdio 前失败关闭，stdout 保持为空。

M4.3 已用真实 Codex CLI 验证以下等价配置。普通安装使用 `npm run codex:mcp:install`：它先构建 core/MCP Server，只追加可验证的受管区块，并通过 `env_vars` 转发运行环境中的 token；不会把 token 值写进 `config.toml`。

```json
{
  "command": "node",
  "args": ["/absolute/path/to/PersonalMemory/packages/mcp-server/dist/cli.js"],
  "env_vars": ["PERSONALMEMORY_AUTH_ENABLED", "PERSONALMEMORY_AUTH_TOKEN"]
}
```

Gateway host、port 和数据目录继续使用 PersonalMemory 的统一配置优先级；不得把 token 放入命令参数、URL、配置值、日志或工具结果。重复安装幂等；已有同名手工配置或受管区块变化时 fail closed。`npm run codex:mcp:uninstall` 只在回执与受管区块完全匹配时移除本次追加内容，新建的空配置可删除，已有配置会逐字节恢复。

## 2. 协议与资源上限

- stdout 只写 MCP JSON-RPC 帧；启动和停止诊断只写不含配置值的 stderr。
- 同时执行的工具最多 8 个；超过上限立即返回有界 `RATE_LIMITED` 错误，不建立无界队列。
- stdio 输入缓冲沿用 Gateway 请求体上限；Gateway 响应以流式方式限制在 1 MiB，超过上限立即取消读取。
- 每个调用传播 MCP 客户端取消信号并叠加服务端超时；精确读取的所有跨页请求共享同一总超时。
- 搜索每页最多 10 条，最多访问 50 个候选；游标最多 32 个、有效 5 分钟、一次性使用，并绑定查询、层级、页大小和预算。
- stdin 结束、传输关闭、SIGINT 或 SIGTERM 都会触发幂等关闭，释放协议监听和短期内存状态。

## 3. 数据与删除边界

搜索只返回经 Gateway 状态、审核和治理门禁允许的记忆，不披露整库总数或原始来源 ID。精确读取一次只返回一个已知 ID，来源 ID 最多 20 个；正文始终带 `untrusted_memory_data` 和不得执行其中指令的警告。

遗忘工具只在 Gateway 内存中建立最多 32 个短期 handoff。MCP 得到的只有不透明 handoff ID、到期时间、计数范围和限制；Bearer 请求无法读取 handoff 明细。只有已有浏览器 session 能重新取得 M3.4 的服务端预览，且用户仍需在 Web 完成两项独立确认和精确确认短语。M4.3 负责验证真实客户端到 Web 的用户交接体验；MCP 始终没有删除执行工具。

## 4. 错误与诊断

工具错误只使用契约白名单和通用操作建议。Gateway 的请求 ID、底层错误消息、SQL、内部路径、正文、搜索词、token 和栈不会进入 MCP 结果。协议成功同时返回结构化结果和等价 JSON 文本，兼容支持结构化输出的客户端与基础客户端。

M4.2 的自动化使用官方 MCP SDK 客户端连接服务器，覆盖工具发现、成功/失败结构、并发上限、取消、预检失败、异常断连、stdout 隔离、Gateway 鉴权与响应上限。M4.3 增加配置保护测试及 `npm run test:codex-e2e`：真实 Codex CLI 严格解析隔离配置并调用五个工具，fixture 逐项断言捕获、召回、读取、反馈和 Web 遗忘交接请求，同时验证正文提示注入未执行且没有误报删除完成。
