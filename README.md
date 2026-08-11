# PersonalMemory

PersonalMemory 是一个面向个人的、本地优先的 AI 记忆工作台，基于
[TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
`v1.0.1` 进行二次开发。

它帮助个人在不同 AI Agent、项目和会话之间持续积累并复用偏好、事实、决定、工作流程、个人文档与项目知识。

## 产品原则

1. 本地优先，用户拥有原始数据和导出能力。
2. 默认私密，任何外发、共享或云端模型处理都需明确配置。
3. 记忆可见、可改、可删，并能追溯到原始证据。
4. 渐进披露，优先注入少量高价值信息，按需下钻。
5. 上游兼容，定期同步安全修复和通用能力。
6. 正式版本以一条命令完成安装、初始化和启动为目标。

## 当前状态

项目已完成安全运行基线、会话导入、预算召回和四层记忆浏览，当前实现记忆修改、失效与 L1 受控删除。受控删除不等于彻底删除；来源、派生资产、导出物和备份的可验证级联删除在后续阶段完成。

- [项目执行规则](docs/PROJECT_RULES.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)
- [实施计划](docs/IMPLEMENTATION_PLAN.md)
- [实施记录](docs/implementation-records/README.md)
- [上游中文文档](README_CN.md)

## 项目名称

`PersonalMemory` 适合作为工程名和 MVP 名称：直观，并能与团队版定位区分。正式发布前仍需完成域名、GitHub、商标和应用商店重名检索，再决定最终品牌名。

## 开源与归属

本项目基于 MIT 许可的 TencentDB-Agent-Memory 开发，保留上游版权与 [LICENSE](LICENSE)。PersonalMemory 并非腾讯或 TencentDB 官方产品。

## 当前兼容性说明

上游的 Opik 可选观测依赖暂未随 PersonalMemory 安装，因为其当前依赖链包含未解决的高危安全公告。默认本地记忆能力不依赖 Opik；相关 tracer 在缺少该包时会安全禁用。恢复该能力前需完成依赖升级、离线降级测试和联网集成测试。
