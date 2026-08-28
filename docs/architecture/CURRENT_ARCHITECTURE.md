# 上游基线架构记录

> 状态：历史基线，不是 PersonalMemory 当前整体技术事实源。

本文件原先用于 M0 阶段盘点 TencentDB-Agent-Memory v1.0.1 上游 standalone
实现。随着 PersonalMemory Gateway、Web、MCP、自动 Hook、治理账本、模型出站门禁和受管运行时落地，其中关于“当前产品”的描述已不再完整。

PersonalMemory 当前整体设计统一以 [TECHNICAL_DESIGN](../TECHNICAL_DESIGN.md) 为准。用户安装、配置和故障排查以根目录 [README](../../README.md) 为准；已确认且有约束力的产品决定以 [PROJECT_RULES](../PROJECT_RULES.md) 为准。

需要精确子系统契约时，直接阅读：

- [MVP_USER_BOUNDARIES](MVP_USER_BOUNDARIES.md)
- [MCP_SERVER](MCP_SERVER.md)
- [PORTABLE_DATA](PORTABLE_DATA.md)
- [PRIVACY_ERASURE](PRIVACY_ERASURE.md)
- [GATEWAY_BOUNDARY](GATEWAY_BOUNDARY.md)
- [CONFIGURATION](CONFIGURATION.md)
- [SECURITY_THREAT_MODEL](SECURITY_THREAT_MODEL.md)
- [AUTOMATIC_AGENT_MEMORY_HOOKS](AUTOMATIC_AGENT_MEMORY_HOOKS.md)

历史实现与验收证据位于 [implementation-records](../implementation-records/README.md)。历史记录用于解释决策形成过程，不覆盖当前技术方案。
