# PersonalMemory Workspace 边界

M1.1 在不移动腾讯上游源码的前提下增加产品层。根目录现有 `src/`、`index.ts`、上游脚本和 SDK 继续保持原位置，便于后续对照 `upstream/feat/server`；PersonalMemory 新功能只进入以下 workspace。

| 目录                       | 包                           | 职责                                   | 允许依赖                        |
| -------------------------- | ---------------------------- | -------------------------------------- | ------------------------------- |
| `packages/personal-memory` | `@personalmemory/core`       | 产品领域模型、schema 和 migration      | Node 标准库；后续经审查的通用库 |
| `apps/gateway`             | `@personalmemory/gateway`    | PersonalMemory HTTP 外观与进程入口     | `@personalmemory/core`          |
| `packages/mcp-server`      | `@personalmemory/mcp-server` | MCP 协议适配                           | `@personalmemory/core`          |
| `apps/web`                 | `@personalmemory/web`        | 浏览器产品界面，通过 HTTP 访问 Gateway | 不直接依赖服务端包              |

## 强制规则

1. 上游 `src/` 不得反向导入 `@personalmemory/*` 或 `apps/`、`packages/`。
2. 产品代码不得通过多级相对路径直接进入根 `src/`；M1.3 的上游适配必须位于 Gateway 外观层并有显式接口。
3. Web 不直接读取 SQLite、数据文件或服务端核心包；MCP 不依赖 Gateway 实现细节。
4. 构建顺序固定为 core → gateway/MCP，Web 独立；不能依赖残留 `dist`。
5. 根 `package-lock.json` 管理产品 workspace；上游 TypeScript SDK 继续保留独立 lockfile，不在本步改写其发布边界。
6. `npm run verify:boundaries` 是提交门禁；新增 workspace 或依赖方向必须同步更新检查器和本文。

## Schema 与迁移规范

- 当前 PersonalMemory schema version 为 1，与上游 `vectors.db` schema 分离；本步不修改上游数据库。
- migration 从 1 连续递增，名称和 checksum 一经应用不可修改；禁止删除、重排或复用版本号。
- 每项迁移在 `BEGIN IMMEDIATE` 事务中执行，成功后才写 migration ledger；失败必须回滚。
- migration 只声明 SQL，不取得数据库句柄；每个数组元素必须是一条不含分号、且不以前导 SQL 注释开头的 SQL。runner 在开启事务前拒绝事务控制语句，再以 prepared statement 顺序执行并写入 ledger。
- runner 必须可重复执行；遇到高于当前应用支持的数据库版本时 fail closed，禁止降级覆盖。
- 多进程竞争时不在 runner 内无限重试：锁竞争返回可诊断失败，由启动协调层在释放锁后重试；重试必须幂等。
- 每次 schema 变化必须同时提交 migration、旧版本 fixture、空库/幂等测试，以及失败回滚或备份恢复测试。
- 高风险或 SQLite 不支持事务化的变更必须在迁移前创建已校验备份，并以恢复测试作为合入条件。

## 统一命令

| 命令                  | 含义                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run install:all` | 按根锁文件和 TypeScript SDK 锁文件执行 Node 干净安装；Python SDK 继续使用其独立 Python 3.9+ 环境 |
| `npm run build`       | 构建上游核心、脚本和全部产品 workspace                                                           |
| `npm run typecheck`   | 检查产品 workspace，并构建校验 TypeScript SDK                                                    |
| `npm test`            | 运行上游常规测试与产品核心测试                                                                   |
| `npm run verify`      | 依次执行边界、构建、类型、测试、黄金链路和 SDK 测试                                              |

`build:products` 会先删除四个明确的产品 `dist` 目录再按拓扑构建，避免残留产物掩盖缺失依赖；不会删除源码、数据目录或上游构建产物。v0 fixture 表示“尚无 PersonalMemory 产品 schema”的起点，并用一个无关 legacy 表验证初始化不会破坏既有用户表；它不是腾讯上游 `vectors.db` 的格式声明。
