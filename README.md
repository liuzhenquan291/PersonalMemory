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

M0–M5 已完成个人记忆核心闭环、可信治理、Codex/Claude Code MCP 互操作、一条命令服务安装、安全升级、备份恢复和卸载基线。复盘后确认当前 Agent 接入仍是“可调用 MCP 工具”，尚未安装自动召回/自动捕获 Hook；隐私采集策略、模型授权和部分来源追溯承诺也仍需收口。因此项目当前不是完整 MVP 或发布候选，正在补做 M4.5–M5.5，且尚未合并到 `main`、推送或对外发布。详见 [MVP 缺口与后续路线](docs/MVP_GAPS_AND_ROADMAP.md)。

## 产品安装

macOS 或 Linux 安装 Node.js 22.19.0 以上版本后，校验并解压版本化源码包，在版本目录运行：

```bash
./install-personalmemory.sh
```

命令会检查环境，缺少依赖时按锁文件获取，随后完成构建、私有数据目录初始化、核心 Gateway、PersonalMemory Gateway 与 Web 后台启动，并验证三个健康入口和非降级 L0/L1 召回。模型访问和遥测保持关闭。重复执行只验证已有受管进程和召回状态，不替换记忆数据；失败不会删除既有数据。发布包生成、SHA-256 校验和支持平台见[源码包分发说明](docs/RELEASE_DISTRIBUTION.md)。

已安装版本可在同一源码仓库中执行安全升级：

```bash
npm run upgrade:product
```

升级会在停止服务前检查版本与磁盘空间，随后构建新版本、停止受管进程、创建并校验完整备份、显式执行数据库迁移、重启并检查健康状态。升级失败时从已校验备份恢复数据；升级备份保留在独立状态目录中，不自动删除。M5.2 不联网下载代码或执行远程脚本。

安装后的日常生命周期使用统一命令：

```bash
npm run lifecycle:product -- status
npm run lifecycle:product -- backup --output /absolute/backup
npm run lifecycle:product -- restore --input /absolute/backup
npm run lifecycle:product -- stop
npm run lifecycle:product -- uninstall
```

备份和恢复会安全停止服务、验证备份并重新启动。默认卸载只移除受管运行状态，完整保留记忆数据，可再次运行安装命令继续使用。只有增加 `--purge-data --confirm "DELETE <绝对数据目录>"` 且确认文本精确匹配时才清除数据；执行前命令会列出并严格校验实际目标。

Gateway 已启动且认证环境变量可用时，可为 Codex 安装或卸载 MCP 配置：

```bash
npm run codex:mcp:install
npm run codex:mcp:uninstall
```

安装只转发 `PERSONALMEMORY_AUTH_TOKEN` 等变量名，不把密钥值写入 Codex 配置。当前命令只安装 MCP 工具，不安装 PersonalMemory Hook；捕获、反馈和遗忘交接默认由客户端提示确认。自动召回/自动捕获和 Claude Code 正式安装器属于重新开放后的 M4.5，完成前请勿把当前接入描述为自动记忆维护。

本地 Gateway 停止后，可使用以下命令管理统一 SQLite 数据根：

```bash
npm run data:export -- --format json --output /安全路径/memory-export.json
npm run data:backup -- --output /安全路径/memory-backup
npm run data:verify -- --input /安全路径/memory-backup
npm run data:restore -- --input /安全路径/memory-backup --confirm "RESTORE /绝对路径/PersonalMemory"
```

导出和备份包含个人记忆正文，移动或共享前请确认目标路径权限。完整格式、排除项和恢复边界见[可移植数据说明](docs/architecture/PORTABLE_DATA.md)。

- [项目执行规则](docs/PROJECT_RULES.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)
- [实施计划](docs/IMPLEMENTATION_PLAN.md)
- [MVP 缺口与后续路线](docs/MVP_GAPS_AND_ROADMAP.md)
- [实施记录](docs/implementation-records/README.md)
- [MCP Server 运行与安全边界](docs/architecture/MCP_SERVER.md)
- [上游中文文档](README_CN.md)

## 项目名称

`PersonalMemory` 适合作为工程名和 MVP 名称：直观，并能与团队版定位区分。正式发布前仍需完成域名、GitHub、商标和应用商店重名检索，再决定最终品牌名。

## 开源与归属

本项目基于 MIT 许可的 TencentDB-Agent-Memory 开发，保留上游版权与 [LICENSE](LICENSE)。PersonalMemory 并非腾讯或 TencentDB 官方产品。

## 当前兼容性说明

上游的 Opik 可选观测依赖暂未随 PersonalMemory 安装，因为其当前依赖链包含未解决的高危安全公告。默认本地记忆能力不依赖 Opik；相关 tracer 在缺少该包时会安全禁用。恢复该能力前需完成依赖升级、离线降级测试和联网集成测试。
