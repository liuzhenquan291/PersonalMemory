# 实施记录

本目录保存 [实施计划](../IMPLEMENTATION_PLAN.md) 各步骤的检查、审查、风险和提交证据。

| 步骤   | 状态      | 记录                                                    |
| ------ | --------- | ------------------------------------------------------- |
| M0.0   | completed | Git 迁移 Runbook 已写入实施计划并通过独立审查           |
| M0.1   | completed | [建立安全迁移点](M0.1.md)                               |
| M0.2   | completed | [未经修改的 v1.0.1 基线验证](M0.2.md)                   |
| M0.3   | completed | [合并上游并执行集成回归](M0.3.md)                       |
| M0.4   | completed | [standalone Gateway 黄金链路](M0.4.md)                  |
| M0.5   | completed | [架构清单、威胁模型与 ADR](M0.5.md)                     |
| M0.6   | completed | [上游同步 Runbook 与只读演练](M0.6.md)                  |
| M1.1   | completed | [PersonalMemory workspace 与迁移骨架](M1.1.md)          |
| M1.2   | completed | [配置、数据目录和密钥边界](M1.2.md)                     |
| M1.3   | completed | [PersonalMemory Gateway 外观层](M1.3.md)                |
| M1.4   | completed | [Web 应用壳](M1.4.md)                                   |
| M1.5   | completed | [开发环境联合启动](M1.5.md)                             |
| M2.1   | completed | [黄金测试数据和验收场景](M2.1.md)                       |
| M2.2   | completed | [会话捕获与批量导入](M2.2.md)                           |
| M2.3   | completed | [统一查询与预算召回](M2.3.md)                           |
| M2.4   | completed | [记忆列表、搜索和详情](M2.4.md)                         |
| M2.5   | completed | [修改、失效和受控删除](M2.5.md)                         |
| M2.6   | completed | [导出、备份和恢复](M2.6.md)                             |
| M2     | completed | [个人记忆闭环退出验收](M2-EXIT.md)                      |
| M3.1   | completed | [记忆审核收件箱](M3.1.md)                               |
| M3.2   | completed | [冲突、合并和替代关系](M3.2.md)                         |
| M3.3   | completed | [来源时间线和审计](M3.3.md)                             |
| M3.4   | completed | [可验证级联删除](M3.4.md)                               |
| M3     | completed | [可信记忆治理退出验收](M3-EXIT.md)                      |
| M4.1   | completed | [冻结 MCP 工具契约](M4.1.md)                            |
| M4.2   | completed | [实现 PersonalMemory MCP Server](M4.2.md)               |
| M4.3   | completed | [首个真实 Codex 客户端验收](M4.3.md)                    |
| M4.4   | completed | [第二客户端可移植性验证](M4.4.md)                       |
| M4     | completed | [双客户端 MCP 互操作退出验收](M4-EXIT.md)               |
| M4.5.1 | completed | [冻结自动 Hook 契约与授权/隐私边界](M4.5.1.md)          |
| M4.5.2 | completed | [实现 Gateway Hook Adapter 与本地持久化边界](M4.5.2.md) |
| M4.5.3 | completed | [实现双客户端事件解析、turn 暂存与 HMAC](M4.5.3.md)     |
| M4.5.4 | completed | [实现 Hook Runtime 与私有有界 outbox](M4.5.4.md)        |
| M4.5.5 | completed | [双客户端受管 Hook 安装与维护 worker](M4.5.5.md)       |
| M4.6.1 | completed | [统一模型配置与权威出站门禁](M4.6.1.md)                |
| M4.6.2 | completed | [版本化模型授权与受管生命周期映射](M4.6.2.md)          |
| M4.6.3 | completed | [生产 Hook 本地 L0 capture sink](M4.6.3.md)           |
| M4.6.4 | completed | [版本化 Hook 生命周期授权](M4.6.4.md)                |
| M4.6.5 | completed | [产品化采集策略、敏感规则与保留期策略](M4.6.5.md) |
| M4.6.6.1 | review    | [冻结保留期执行与恢复防复活契约](M4.6.6.1.md)   |
| M5.1   | completed | [一条命令安装器](M5.1.md)                               |
| M5.2   | completed | [升级和数据库迁移](M5.2.md)                             |
| M5.3   | completed | [备份、恢复和卸载](M5.3.md)                             |
| M5.4   | completed | [发布候选验证](M5.4.md)                                 |

M0–M5 完成后的合并前状态和授权边界见 [MVP 合并前审计](MVP_MERGE_READINESS.md)。

步骤提交 SHA 在提交完成后的任务报告或 CI 中记录，不通过 amend 回填到产生该 SHA 的同一提交。
