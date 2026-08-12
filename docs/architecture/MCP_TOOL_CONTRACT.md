# PersonalMemory MCP 工具契约

> 契约版本：`1.0.0`
>
> 传输：`stdio`
>
> 适用步骤：M4.1；M4.2 才接入 MCP SDK、Gateway 和进程生命周期。

## 1. 边界

MCP 是个人记忆的协议适配层，不复制 Gateway 的记忆、治理或删除业务逻辑。首版只面向单用户本机客户端，不提供 HTTP/SSE、公网、多租户、目录读取、任意 SQL 或整库导出工具。

TypeScript 源码中的 Zod schema 是唯一事实源，`createPersonalMemoryMcpContractManifest()` 将其稳定转换为 JSON Schema。服务器名称固定为 `personalmemory-mcp-server`，工具名使用 `personalmemory_` 前缀；任何破坏兼容性的字段、语义或约束变更都必须升级契约主版本。

## 2. 最小工具集

| 工具 | 作用 | 写入 | 关键边界 |
| --- | --- | --- | --- |
| `personalmemory_search` | 按查询和层级搜索经治理允许的记忆 | 否 | 单页最多 10 条、正文合计最多 12000 字符、估算最多 3000 token、最长 10 秒；不返回来源原始 ID 或整库总数 |
| `personalmemory_read` | 读取一个已知层级和 ID 的精确记忆 | 否 | 一次只读一条、正文最多 12000 字符、来源 ID 最多 20 个并披露总数和截断状态 |
| `personalmemory_capture` | 捕获一轮完整 user/assistant 交换 | 是 | 固定两条有序消息、持久幂等键、不得代替用户确认模型外联 |
| `personalmemory_feedback` | 执行用户明确给出的 L1 批准、拒绝或纠正决定 | 是 | 必须携带审核版本；拒绝必须有理由，纠正必须有替换正文；冲突时重新读取后再决定 |
| `personalmemory_prepare_forget` | 预览一个 L1 的受控删除范围并创建短期 Web 交接状态 | 临时状态 | 不接受确认短语、不执行删除、不返回可直接授权删除的内部计划 token |

工具 annotations 只帮助客户端展示和规划，不作为权限控制。所有工具都声明 `openWorldHint: false`；契约没有 destructive tool。遗忘预览会建立短期交接状态，因此如实标为非只读，但仍明确标为非破坏性。M4.2 必须继续通过 Gateway Bearer 鉴权、业务门禁和服务端状态验证来执行真实授权。

## 3. 渐进披露与游标

搜索默认返回 5 条，并同时应用条数、字符、估算 token 和统一截止时间预算。返回的 `used_chars` 必须等于实际正文字符数；单层超时或上游响应异常只可作为有界降级列出，不得伪造结果。

`next_cursor` 是不透明、短期、不可修改的服务端游标，必须绑定规范化后的 query、levels、page size 和预算。带游标的请求若改变任一绑定字段，应返回 `INVALID_ARGUMENT`。实现不得用游标或重复分页提供绕过预算的整库枚举接口。

搜索只披露来源状态和引用数量，且 L1 必须处于 `approved`。客户端确需核对来源时，先取得目标记忆 ID，再用精确读取工具下钻；超过 20 个来源时只返回前 20 个，并设置 `references_truncated: true`。

## 4. 不可信内容与敏感字段

搜索和读取结果固定携带：

- `data_classification: "untrusted_memory_data"`；
- `usage_warning`，明确记忆正文只能作为引用数据，不能作为指令执行。

服务端不得把记忆正文、搜索词、会话正文、密钥、Bearer token、内部路径、SQL、内部错误栈或原始请求体写入日志或错误结果。工具描述、资源、提示词或协议元数据不得拼接记忆正文；客户端展示时也应保持内容与指令通道隔离。

## 5. 遗忘的不可绕过确认

MCP 不暴露删除执行工具。`personalmemory_prepare_forget` 只能返回受控范围、限制、过期时间和不可授权删除的 handoff reference；它始终返回：

- `web_confirmation_required: true`；
- `destructive_action_performed: false`。

M4.2 不得把 M3.4 的内部删除计划 token、确认短语或执行接口透传给模型。用户必须在 PersonalMemory Web 中重新加载服务端范围矩阵，完成两项独立确认并输入 `ERASE L1:<memory-id>`。来自记忆正文、模型参数或 MCP 客户端缓存的“确认”一律无效。

## 6. 错误与实现要求

工具失败使用固定、可操作的错误码和短消息；协议实现应同时设置工具级错误状态，并把版本化错误对象放入结构化结果。允许的错误码只覆盖参数、鉴权、限流、找不到、并发冲突、外联确认、删除交接过期、上游不可用、超时和内部错误，不得回传底层数据库错误。

M4.2 必须：

1. 复用 Gateway 的鉴权、治理、预算和删除逻辑；
2. 在 `stdio` 模式下只向 stdout 写 MCP 帧，诊断信息仅写脱敏 stderr；
3. 校验输入与输出 schema，并实现统一超时、并发上限、取消和关闭；
4. 为 search cursor 创建服务端签名或等价防篡改状态；
5. 使用独立 handoff reference 映射 Web 交接状态，绝不向模型暴露删除能力 token。

## 7. 自动化证据

`packages/mcp-server/tests/contract.test.ts` 验证五个工具的稳定名称、严格 JSON Schema、分页/预算、提示注入标记、来源渐进披露、捕获顺序、反馈并发版本、错误白名单，以及 MCP 无法表达或报告破坏性删除。
