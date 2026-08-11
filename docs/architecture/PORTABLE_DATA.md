# 可读导出、备份与恢复

M2.6 面向单用户 macOS/Linux 的统一本地 SQLite 数据根。上游 L0–L3 资产、`vectors.db` 和 PersonalMemory `personalmemory.sqlite` 必须位于同一数据根；`.metadata/manifest.json` 必须声明 `sqlite` 且路径为 `vectors.db`。远程 TCVDB、拆分数据根和运行中热备份不在本阶段支持范围，工具会拒绝执行而不是生成不完整包。

## 离线与路径安全

PersonalMemory Gateway 启动时写入只含 PID 的 `.personalmemory-running`，正常停止后移除。导出、备份和恢复检测到活动 PID 时立即失败；崩溃遗留且 PID 已不存在的 marker 会自动清理。命令行入口还会直连检查配置的 loopback 上游 `/health`；上游仍可连接或健康检查无法可靠判定时同样失败。因此操作前必须停止整套本地服务，而不只是 Web 页面。

所有源、目标和清单路径拒绝符号链接及越界路径。导出和备份目标必须位于数据根之外且不能预先存在；文件以 `0600`、目录以 `0700` 创建。备份恢复应选择与数据根相同文件系统的目标父目录，以保证 rename 原子切换。

## 可读导出

`data:export` 支持 JSON 和 Markdown，包含：

- L0 `conversations/*.jsonl` 原始对象；
- L1 `records/*.jsonl` 原始对象，包括现有 `source_message_ids` 等来源字段；
- L2 `scene_blocks/*.md` 与 L3 `persona.md`；
- `personalmemory_memory_states` 中 active、invalidated、deleted 状态、原因和 revision。

解析错误不会被跳过。命令返回输出 SHA-256 和各层计数。导出是可读迁移资产，不包含检索索引，不能单独冒充可直接启动的完整备份。
单次导出最多读取 256 MiB 文本和 1,000,000 条 JSONL 记录；超过预算会明确失败，避免异常数据耗尽本地进程内存。

## 备份格式

备份是一个私有目录，包含 `manifest.json` 和 `data/`。manifest 固定格式版本、PersonalMemory schema 版本、创建时间、明确排除项，以及每个资产的相对路径、字节数和 SHA-256。

允许资产为 `personalmemory.sqlite`、`vectors.db`、`persona.md`、`conversations/`、`records/`、`scene_blocks/` 和 `.metadata/`。配置文件、环境密钥、日志、历史备份、导出物和运行 marker 明确排除；根目录出现未分类资产时失败，避免静默遗漏新事实资产。SQLite 文件使用一致性 snapshot API，不复制 WAL/SHM 临时文件。

## 验证与恢复

`data:verify` 在不修改数据根的前提下验证格式版本、schema 兼容性、路径范围、重复项、文件类型、大小、SHA-256 和统一 SQLite 数据根声明。

`data:restore` 要求精确输入 `RESTORE <绝对数据根>`。校验全部通过后，工具在目标父目录构建私有 staging，执行 SQLite `integrity_check`，再把当前数据根 rename 为随机 `.pre-restore-*` 回退目录，并把 staging 原子切换为正式数据根。切换失败会尝试恢复原目录；备份损坏或版本不兼容时不会触碰现有数据。

恢复前目录和备份本身都可能含已删除或已纠正记忆。M2 不自动销毁它们；用户确认新数据可用后应按自己的保留策略处理，M3.4/M5.3 将补全级联删除和生命周期管理。
