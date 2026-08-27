# PersonalMemory 使用手册

> 适用版本：PersonalMemory 0.1.1 源码分发包
>
> 已验证平台：macOS arm64、Linux arm64

PersonalMemory 是运行在本机的个人 Agent 记忆服务。安装后，它可以为 Codex 和 Claude Code 自动召回已批准的记忆，并在一轮对话成功结束后把本轮 user/assistant 文本保存到本地。默认不启用模型外联。

## 1. 功能概览

### 自动捕获与召回

授权后，PersonalMemory 会在 Codex 或 Claude Code 的主 Agent 成功完成一轮回答时，将本轮 user/assistant 文本保存到本地；下一次对话开始前，它会按相关性和预算召回已经批准的记忆。失败、中断、子 Agent 轮次和已经注入的记忆默认不会被重复捕获。

召回失败时 Agent 会继续正常工作。自动本地捕获本身不调用模型；需要模型参与的 L1–L3 提炼由独立的模型配置和外联授权控制。

### L0–L3 分层记忆

PersonalMemory 按层组织信息，避免把全部历史对话直接塞回上下文：

- **L0 Conversation**：保留原始对话证据；
- **L1 Atom**：从对话中提炼出的单条事实、偏好或约束；
- **L2 Scenario**：围绕具体场景组织的记忆；
- **L3 Persona**：更高层的用户画像和长期倾向。

当前 MVP 对 L0 和带真实引用的新 L1 提供可核对来源；旧 L1、L2、L3 没有可靠引用时会明确显示“来源未记录”，不会用相似搜索结果伪造来源关系。

### 审核与记忆治理

新提炼的 L1 默认进入收件箱，只有人工批准后才有资格自动召回。用户可以在 Web 中：

- 浏览、筛选、搜索和查看 L0–L3；
- 接受、修改后接受或拒绝待审核记忆；
- 纠错、失效或删除错误记忆；
- 处理冲突、合并和替代关系；
- 查看高影响操作的审计时间线；
- 核对删除范围并强确认彻底删除。

### 隐私与用户控制

- 服务默认只监听本机回环地址，模型默认关闭，不会因继承的模型或代理环境自动外联；
- 自动召回和自动本地捕获分别授权，可以随时关闭；
- 模型 provider、目标地址或发送字段变化后，需要重新授权外联；
- 可以按 Agent、工作目录树和来源设置采集排除；
- 凭据、支付卡号和中国居民身份证号等固定敏感类别会在写入前阻断整轮捕获；
- L0/L1 保留期和自动清理使用独立授权，恢复备份时也会防止已过期数据复活。

### Agent 接入

受管安装会为 Codex 和 Claude Code 配置自动记忆 Hook，并提供五个 MCP 工具用于搜索、捕获、反馈等需要 Agent 主动调用的操作。自动 Hook 授权与手动工具的逐次确认互相独立。

### 数据便携与生命周期

- 导出可人工阅读的 JSON 或 Markdown；
- 创建、校验和恢复完整备份；
- 安全升级并在失败时回滚；
- 查看状态、重启或停止受管服务；
- 卸载时默认保留记忆，只有精确确认后才删除数据。

当前只有完整备份可以承担跨安装恢复。JSON/Markdown 可读导出尚不能重新导入或重建索引。

## 2. 安装前准备

- macOS 或 Linux；当前仅正式验证 arm64。
- Node.js 22.19.0 或更高版本，以及 npm。
- Codex、Claude Code 可以按需安装；没有安装的客户端不会影响核心服务运行。
- 默认端口 `8420`、`8787`、`4173` 未被其他程序占用。

请从可信渠道取得 `PersonalMemory-0.1.1-source.tar.gz` 和同目录的 `.sha256` 文件。先校验摘要，再解压：

```sh
shasum -a 256 -c PersonalMemory-0.1.1-source.tar.gz.sha256
tar -xzf PersonalMemory-0.1.1-source.tar.gz
cd PersonalMemory-0.1.1
```

Linux 可将第一条命令替换为：

```sh
sha256sum -c PersonalMemory-0.1.1-source.tar.gz.sha256
```

## 3. 安装和首次启动

在解压后的版本目录运行：

```sh
./install-personalmemory.sh
```

首次运行会按锁文件安装依赖、构建产品、创建私有数据目录并启动四个受管进程。重复运行用于检查和恢复安装，不会删除已有记忆。

成功后终端会显示 Web 地址、健康检查地址、Codex/Claude Code Hook 状态、数据目录和日志位置。默认 Web 地址是：

```text
http://127.0.0.1:4173
```

### Hook 冲突

安装器不会覆盖 Codex 或 Claude Code 中已有的同名 `UserPromptSubmit`、`Stop` Hook。如果提示 `conflicts with the managed definition`，请先检查对应客户端的 Hook 配置，决定保留哪一套定义，再重新运行安装。不要直接删除不认识的 Hook。

Codex 安装后还需在客户端使用 `/hooks` 核对 PersonalMemory 的精确定义并授予信任；未信任时状态可能显示 `installed_untrusted`，自动 Hook 不会正常生效。

## 4. 首次使用

1. 打开安装结果给出的 Web 地址。
2. 在“设置”页解锁当前浏览器会话。
3. 分别决定是否授权“自动召回”和“自动本地捕获”。两项授权互相独立，也不同于模型外联授权。
4. 在 Codex 或 Claude Code 中开始一次普通对话。无需说“保存这段话”：成功结束的主 Agent 对话会按授权自动捕获；失败、中断和子 Agent 轮次默认不捕获。
5. 新提炼出的 L1 记忆默认进入“收件箱”等待审核。批准后，它才有资格被后续对话自动召回。

自动召回失败时 Agent 会继续工作，不会因为记忆服务故障而中断对话。自动本地捕获本身不调用模型。

## 5. Web 日常使用

Web 是日常记忆治理入口：

- “记忆”：浏览、筛选和搜索 L0–L3，查看详情及可用来源；
- “收件箱”：审核新 L1，接受、修改后接受或拒绝；
- 记忆详情：纠错、失效、处理冲突与替代关系；
- “审计”：查看高影响操作时间线；
- “设置”：查看 Agent/Hook 状态，并开关自动召回与自动本地捕获；
- 删除：按界面提示核对范围并强确认后执行彻底删除。

来源显示遵循当前证据边界：L0 和带真实引用的新 L1 可以核对来源；旧 L1、L2、L3 可能显示“来源未记录”。相似搜索结果不等于来源关系。

## 6. 查看状态和管理服务

以下命令都应在当前安装包目录运行。

查看脱敏状态，包括版本、数据目录及 Hook worker/backlog：

```sh
npm run lifecycle:product -- status
```

重启全部受管服务：

```sh
npm run lifecycle:product -- restart
```

停止服务：

```sh
npm run lifecycle:product -- stop
```

停止会移除当前运行回执。需要再次启动时运行：

```sh
./install-personalmemory.sh
```

## 7. 升级

先取得并校验新版本源码包，在新版本目录运行：

```sh
npm ci
npm run upgrade:product
```

升级会检查空间、创建升级前备份、执行迁移和健康验证；失败时按受管流程回滚。不要覆盖旧版本目录后再升级。

## 8. 导出、备份与恢复

### 可读导出

可读导出适合人工审阅或迁移到其他系统，但不能用于恢复 PersonalMemory：

```sh
npm run lifecycle:product -- stop
npm run data:export -- --format json --output personalmemory-export-20260827.json
./install-personalmemory.sh
```

`--format` 也可以使用 `markdown`。当前 MVP 不支持从可读导出重新导入或重建索引。

### 完整备份

完整备份是当前支持的迁移和灾难恢复介质。生命周期命令会安全停止服务、生成并校验备份，然后自动重新启动：

```sh
npm run lifecycle:product -- backup --output personalmemory-backup-20260827
```

可单独复验备份：

```sh
npm run data:verify -- --input personalmemory-backup-20260827
```

### 恢复完整备份

恢复会替换当前安装的数据。先确认输入目录正确并保留额外副本，再运行：

```sh
npm run lifecycle:product -- restore --input personalmemory-backup-20260827
```

生命周期命令会校验备份、在隔离 staging 中恢复并重新启动服务；失败时保留原数据。

## 9. 卸载

默认卸载会停止服务、移除受管 Hook 和运行状态，但保留记忆数据：

```sh
npm run lifecycle:product -- uninstall
```

只有确定不再需要任何记忆且已有所需备份时，才删除数据。先用 `status` 读取输出中的绝对 `dataDirectory`，然后逐字输入确认：

```sh
npm run lifecycle:product -- uninstall --purge-data --confirm "DELETE <绝对数据目录>"
```

该操作不可从 PersonalMemory 内恢复。

## 10. 默认数据位置

macOS：

- 数据：`~/Library/Application Support/PersonalMemory`
- 运行状态：`~/Library/Application Support/PersonalMemory Runtime`

Linux：

- 数据：`${XDG_DATA_HOME:-~/.local/share}/personalmemory`
- 运行状态：`${XDG_STATE_HOME:-~/.local/state}/personalmemory`

不要在服务运行时直接修改 SQLite、Hook secret 或安装回执。需要迁移时使用完整备份与恢复命令。

## 11. 当前能力边界

- 仅验证 macOS arm64 和 Linux arm64；Windows、macOS x64、Linux x64 尚未列入支持平台。
- 首版是源码包，需要 Node.js/npm；尚无签名桌面安装包和自动更新。
- Web 负责日常记忆治理与 Hook 授权；安装、升级、备份恢复和卸载仍通过受管命令完成。
- L2/L3 首版以查看和来源可用性披露为主。
- 完整备份可以恢复；JSON/Markdown 可读导出目前不能导入。
- Skill、Wiki、CodeGraph、多用户和多设备同步不属于当前 Chat Memory MVP。

发生问题时，先保存安装命令输出和安装结果给出的日志路径，再运行 `npm run lifecycle:product -- status` 获取脱敏状态。不要公开数据目录内容、模型密钥或 Hook secret。
