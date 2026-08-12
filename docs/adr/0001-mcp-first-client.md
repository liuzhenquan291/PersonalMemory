# ADR-0001：通用 MCP 作为首发 Agent 接入

- 状态：accepted
- 决定日期：2026-08-07
- 负责人：PersonalMemory maintainers

## 决定

首发 Agent 接入采用版本化的通用 MCP Server。首个真实客户端验收固定为 Codex CLI/桌面端共享的本机配置，第二客户端留给 M4.4 选择；Codex、CodeBuddy、OpenClaw 或 Hermes 均只作为客户端适配/验收对象，不成为核心包依赖，现有 HTTP/SDK 兼容面继续保留。

## 原因与替代方案

MCP 能验证产品不绑定单一 Agent，并允许 Web、CLI 与 Agent 共用 PersonalMemory Gateway 权限和预算边界。M4.3 选择 Codex 是因为官方客户端原生支持 stdio、环境变量转发、工具审批和严格配置校验，且本机已有可实际运行的客户端；该选择不允许向核心契约加入 Codex 特例。沿用 OpenClaw 插件可更快复用上游，但会把宿主目录和生命周期带入产品核心。

## 后果与复议触发

M4 冻结最小工具契约并至少用两个客户端验证。Codex 安装配置必须保留已有内容，不把 Bearer 明文写入配置，卸载只能移除可验证的受管区块；搜索/读取可自动批准，捕获、反馈和遗忘交接默认提示确认。若目标客户端缺少必要 MCP 能力、MCP 权限模型无法表达删除/来源边界，或协议发生不兼容变化，则复议。
