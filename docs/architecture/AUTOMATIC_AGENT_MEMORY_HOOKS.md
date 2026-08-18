# 自动 Agent 记忆 Hook 契约

> 契约版本：`1.0.0`
>
> 状态：M4.5.1 已冻结；Adapter、安装器、Gateway 路由和真实客户端 E2E 在后续 M4.5 步骤实施。
>
> 适用客户端：Codex、Claude Code。

## 1. 目的与边界

自动记忆生命周期由两个主 Agent 事件组成：用户原始提示提交后、模型处理前执行召回；主 Agent 成功完成回答后捕获本轮成对的原始 user/assistant 文本。用户不需要逐轮要求“搜索”或“保存”。

Hook 只是客户端 Adapter。它不得直接打开 SQLite、上游内核、数据目录、索引或 MCP 写工具；所有召回和捕获都必须经 PersonalMemory Gateway，复用产品层审核、冲突/替代、失效、删除 tombstone、预算、采集策略、授权和审计门禁。跨客户端差异只存在于事件解析和客户端输出编码层，不能进入 Gateway 的产品语义。

M4.5.1 只冻结公共契约和安全边界，不安装或启用 Hook，不改变现有 MCP 工具审批策略，不实现 outbox、模型配置或服务端敏感内容规则。

## 2. 已核验的客户端事件

| 公共阶段  | Codex                                                                | Claude Code                                                                      | 公共 Adapter 只接受                                       |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 前置召回  | `UserPromptSubmit`，含 `session_id`、`turn_id`、`cwd`、原始 `prompt` | `UserPromptSubmit`，含 `session_id`、`prompt_id`（新版本）、`cwd`、原始 `prompt` | 主 Agent 的稳定 session/turn、cwd、原始 prompt            |
| 成功捕获  | `Stop`，含 `session_id`、`turn_id`、`last_assistant_message`         | `Stop`，含 `session_id`、`prompt_id`（新版本）、`last_assistant_message`         | 同一主 Agent turn 的暂存原始 prompt 与最终 assistant 文本 |
| 失败/中断 | 不捕获无最终正文、子 Agent 或继续型 Stop                             | 用户中断不触发 `Stop`，API 错误走 `StopFailure`，子 Agent 走 `SubagentStop`      | 明确成功且非子 Agent 的一轮                               |

官方客户端都提供 transcript 路径，但它不是公共事实源：Codex 明确不保证 transcript 格式稳定；Claude Code 明确说明文件异步写入，Stop 时可能尚未包含最终消息。因此 Adapter 必须在 `UserPromptSubmit` 时把原始 prompt 按 client/session/turn 暂存于私有、容量和 TTL 有界的状态中，`Stop` 时优先使用事件的 `last_assistant_message` 完成配对。不得解析 system/developer、工具调用、工具输出或记忆注入块来重建捕获正文。

Claude Code v2.1.196 以后可直接使用 `prompt_id` 作为 turn 标识；更早版本必须由客户端 Adapter 在前置事件生成并持久匹配一个不泄漏正文的稳定 turn 标识。Codex 使用原生 `turn_id`。生成策略属于客户端 Adapter，进入公共契约后统一命名为 `turn_id`。

## 3. 公共请求与输出

TypeScript 中的 Zod schema 是唯一事实源：`packages/personal-memory/src/hook-contract.ts`。`createPersonalMemoryHookContractManifest()` 提供确定性的 JSON Schema manifest；破坏兼容性的字段或语义变更必须升级契约主版本。

每个公共请求固定包含：

- `contract_version`；
- `event.client/session_id/turn_id/subagent = false`；
- `authorization.installation_id/authorization_revision/policy_revision`；
- `source.kind = agent_lifecycle` 与当前 `working_directory`；
- 召回的原始 `prompt`，或捕获的严格两条 user/assistant `messages`；
- 捕获的稳定 `idempotency_key`，格式为 `hook:v1:<sha256-hex>`。

公共请求不接受 transcript 路径、agent/subagent 标识、工具事件、附件、system/developer 指令、模型外联同意或任意客户端配置。Adapter 必须先拒绝或跳过这些输入，再调用 Gateway。

召回输出只有三种结果：

- `recalled`：返回有界且标为 `untrusted_memory_data` 的 `additional_context`；
- `skipped`：未授权、策略排除、无结果或事件无效，不注入；
- `degraded`：Gateway 不可达或超时，不注入但允许 Agent 继续。

捕获输出区分 `captured`、`duplicate`、`queued`、`skipped` 和 `conflict`。只有 Gateway 不可达或超时可进入 `queued`；策略排除、无授权、敏感内容排除、缺失配对或无效事件不可重试；同一幂等键不同载荷必须返回 `conflict` 并告警，不能覆盖或合并。

## 4. 召回契约

前置 Hook 必须同步执行，因为注入内容需要进入当前模型请求。硬上限固定为最多 5 条、4,000 字符、估算 1,000 token、1,000 ms；配置只能向下收紧，不能由客户端扩大。

Gateway 只能返回 `approved`、未失效、未删除、未被活动冲突或替代关系抑制且通过当前来源策略的记忆。MVP 默认不自动注入原始 L0、`pending`/`rejected` L1。返回正文必须有固定不可信数据警告；Adapter 只能把它放入客户端支持的 additional context 通道，不能拼接成用户提示、system 指令或隐藏工具调用。

Codex 的 `UserPromptSubmit` 通过 `hookSpecificOutput.additionalContext` 返回，Claude Code 通过同名字段返回。两端都不得使用 `decision: block` 实现记忆召回。超时、进程错误、无授权或 Gateway 故障必须 fail-open：输出无记忆上下文并让原始提示继续。

## 5. 捕获契约

捕获仅使用本轮 `UserPromptSubmit.prompt` 原文和相同 turn 的 `Stop.last_assistant_message`。捕获前必须满足：

1. 是主 Agent，不含 `agent_id`，不是 `SubagentStop`；
2. 前置事件与 Stop 的 client/session/turn 精确匹配；
3. assistant 文本非空，事件不是失败、中断或继续型 Stop；
4. 正文不含 system/developer 指令、工具调用/输出、附件/base64 或 PersonalMemory 注入块；
5. 自动本地捕获授权和服务端采集策略仍有效。

幂等 digest 必须使用安装级私有密钥对规范化的 client、installation、session、turn 和事件契约版本计算 HMAC-SHA-256，不能包含正文、cwd、密钥或可逆标识。Gateway 同时校验 key 与独立 payload 摘要：完全相同的重试返回 `duplicate`；相同 key 的不同 payload 返回 `conflict`。

Stop Hook 永远返回“允许停止”的有效客户端 JSON，不得因捕获失败要求 Agent 继续、创建隐藏用户轮次或再次调用 Agent。Gateway 暂时不可达时，Adapter 把已清洗、已授权的请求写入私有 outbox；outbox 必须有容量、条数、TTL、文件权限和有限退避上限，并在 Web/doctor 暴露 backlog。outbox 的具体持久化和重试参数留给 M4.5 实现及故障注入测试冻结。

## 6. 授权、策略与人工操作

自动召回与自动本地捕获是两个独立、默认关闭的授权。首次安装或 Web 引导必须分别解释处理阶段、数据范围、预算、失败行为和撤销方式；只有用户明确开启后，Gateway 才签发版本化授权。Hook 配置存在、客户端信任 Hook 或 MCP 已连接都不等同于产品授权。

每次请求必须携带安装、授权和策略 revision；Gateway 以服务端当前值为权威。授权撤销、策略更新或安装身份变化后，旧请求必须 `skipped`，不得由 Adapter 猜测迁移。

采集策略按“全局 → Agent → 项目/工作目录 → 来源”由严到宽求交集，任一层排除即排除；服务端必须在任何 L0 落盘和 outbox 接纳前再次执行。敏感内容识别和保留期同样是服务端门禁，客户端清洗只能作为纵深防护，不能作为权威控制。

本地捕获授权不授予模型外联。未取得有效模型 provider/origin/发送字段授权时，允许 L0 本地落盘，但暂停需要模型的 L1–L3 提炼。provider、origin、发送字段或授权版本改变后必须重新同意。

Agent 主动调用 `personalmemory_capture`、反馈和遗忘交接仍按 MCP 契约逐次提示；Hook 授权不能自动批准这些工具。批准、拒绝、纠错、合并、冲突/替代、失效和删除仍需用户明确操作，彻底删除仍只在 Web 重新核对范围后强确认。

## 7. 客户端安装与信任

Codex 支持用户级、项目级、插件和托管 Hook。PersonalMemory 首版采用用户级受管文件和回执，不写项目仓库；安装必须保留已有 `hooks.json`/`config.toml`，检测同事件冲突并 fail closed。Codex 非托管 command Hook 按当前定义哈希要求用户在 `/hooks` 中审阅信任；安装成功必须明确报告 `installed_untrusted`，只有客户端可验证的信任状态和首次事件回执同时存在时才能显示 healthy。升级改变命令或定义后必须重新信任，不得使用 `--dangerously-bypass-hook-trust` 作为产品安装策略。

Claude Code 首版写入用户级 `~/.claude/settings.json` 的受管条目并保留全部其他设置。正式安装不得复用测试专用 `dontAsk` 或全工具白名单。重复安装、升级和卸载必须通过独立回执验证受管 JSON 内容；用户修改、重复复制或标记损坏时 fail closed，只精确移除未修改的受管条目。

两端安装器都不能把 Bearer、正文、授权 token 或模型密钥写入命令、配置、回执和日志。Hook 进程从私有凭据文件或既有安全环境间接取得 loopback Gateway 凭据。

## 8. 日志、状态与验收

日志和审计只记录客户端、事件、结果码、耗时、条数、预算、backlog 数量和 HMAC/摘要标识；不得记录 prompt、assistant 正文、additional context、cwd 原文、transcript 路径、密钥或 outbox payload。Web/doctor 至少展示：安装状态、客户端信任、两项授权、策略 revision、最近成功时间、最近脱敏错误、backlog 和暂停/排除状态。

M4.5 后续退出测试必须覆盖：自然提示无需“搜索/保存”口令、前置召回、成功捕获、重复 Stop、相同 key 不同载荷、失败/中断、子 Agent、pending 不召回、注入不回写、授权撤销、来源排除、敏感内容、Gateway 超时、outbox 重启恢复、配置保护、重新信任与可逆卸载。所有真实客户端测试必须在隔离 HOME 和本地 Gateway fixture 下运行，不能用测试专用自动批准设置冒充用户安装状态。

## 9. 官方契约核对

- Codex Hooks 文档：支持 `UserPromptSubmit`/`Stop` command Hook、公共输入字段、additional context、信任哈希和 transcript 非稳定边界：<https://learn.chatgpt.com/codex/hooks>。
- Claude Code Hooks reference：支持逐 turn 的 `UserPromptSubmit`/`Stop`、`prompt_id`、`last_assistant_message`、子 Agent 标识和 transcript 异步写入边界：<https://code.claude.com/docs/en/hooks>。

客户端版本漂移必须在真实安装前重新核验。若字段、信任或输出语义变化，先升级客户端 Adapter 和契约版本，不得用解析 transcript 或放宽授权作为兼容捷径。
