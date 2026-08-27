# ADR-0001：通用 MCP 作为首发 Agent 接入

- 状态：accepted
- 决定日期：2026-08-07
- 负责人：PersonalMemory maintainers

## 决定

首发 Agent 接入采用版本化的通用 MCP Server。首个真实客户端为 Codex CLI/桌面端共享的本机配置，第二客户端为 Claude Code `2.1.228`；两者均只作为客户端适配/验收对象，不成为核心包依赖，现有 HTTP/SDK 兼容面继续保留。

## 原因与替代方案

MCP 能验证产品不绑定单一 Agent，并允许 Web、CLI 与 Agent 共用 PersonalMemory Gateway 权限和预算边界。M4.3 选择 Codex 是因为其原生支持 stdio、环境变量转发、工具审批和严格配置校验；M4.4 选择 Claude Code 是因为其支持独立 MCP JSON、严格忽略其他 MCP 配置、精确工具白名单和非持久化无交互模式，且协议结果文本包装与 Codex 不同，能形成有价值的可移植性验证。两端必须使用同一 Gateway fixture，不允许向核心契约加入客户端特例。沿用 OpenClaw 插件可更快复用上游，但会把宿主目录和生命周期带入产品核心。

## 后果与复议触发

M4 已用 Codex 与 Claude Code 冻结并验证最小工具契约。Codex 安装配置必须保留已有内容，不把 Bearer 明文写入配置，卸载只能移除可验证的受管区块；搜索/读取可自动批准，捕获、反馈和遗忘交接默认提示确认。Claude Code 验收只加载隔离配置并显式白名单五个工具；确定性本地 Messages API 只驱动调用顺序，不替代真实 Claude Code 的 MCP 工具发现、参数传递和结果回送。若客户端缺少必要 MCP 能力、权限模型无法表达删除/来源边界，或协议发生不兼容变化，则复议。
