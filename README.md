# PersonalMemory

> MVP 首发版本：`personalmemory-v0.1.1`；已验证平台：macOS arm64、Linux arm64。

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

M0–M5 的核心闭环与发布工程基线，以及 M4.5 自动 Agent 生命周期、M4.6 模型/隐私门禁和 M4.7 现有承诺收口均已完成。M5.5 已在 macOS arm64 与 Linux arm64 真实源码分发物上重新验收双客户端 Hook、首条自动召回/捕获、升级、默认零外联、模型与 Hook 授权变化、敏感采集、故障/outbox 恢复、重复事件、长期运行、备份恢复和卸载；M5.6 已支持自动检测及单个或多个 Agent 安装。项目已恢复完整 MVP / 本地发布候选证据；移动 `main`、推送和对外发布仍需用户明确授权。详见 [MVP 缺口与后续路线](docs/MVP_GAPS_AND_ROADMAP.md)。

## 使用手册导航

- [功能概览](#功能概览)
- [安装前准备](#安装前准备)
- [安装和首次启动](#安装和首次启动)
- [首次使用](#首次使用)
- [Web 日常使用](#web-日常使用)
- [工作机制与提炼时机](#工作机制与提炼时机)
- [配置记忆提炼模型](#配置记忆提炼模型)
- [记忆如何被使用](#记忆如何被使用)
- [查看状态和管理服务](#查看状态和管理服务)
- [手动 MCP 工具](#手动-mcp-工具)
- [升级](#升级)
- [导出、备份与恢复](#导出备份与恢复)
- [卸载](#卸载)
- [默认数据位置](#默认数据位置)
- [当前能力边界](#当前能力边界)
- [故障排查](#故障排查)

## 功能概览

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

## 工作机制与提炼时机

自动捕获成功只代表 L0 原文已经安全落盘，不代表立即产生 L1。实际链路是：

1. 主 Agent 成功结束一轮后，Hook 提交本轮 user/assistant 原文。
2. Gateway 在本地事务中完成授权、排除策略、敏感内容和幂等检查，然后写入 L0。
3. L0 提交成功后，Gateway 在事务外异步通知上游提炼管线；Hook 不等待模型，通知失败也不会删除 L0。
4. 管线根据新会话 warmup、累计轮数或空闲刷新等条件调度模型提炼。当前实现通常在新会话、后续累计约 5 轮或空闲约 10 分钟时触发，而不是承诺每轮立即生成 L1。
5. 新 L1 进入“收件箱”，默认状态为 `pending`。只有人工批准后才可自动召回。

L2/L3 由上游管线在更高层继续归纳。MVP 对它们以查看和诚实披露来源可用性为主，不承诺每段对话都会生成四层记忆。

## 配置记忆提炼模型

首版支持 OpenAI-compatible 接口。先在 Web“设置”页解锁浏览器会话，然后填写：

- 模型接口地址（Base URL）；远端必须使用 HTTPS，本机回环地址可使用 HTTP；
- API Key；
- 模型名称。

API Key 只写入本机权限为 `0600` 的受管 `gateway.env`，不会进入浏览器、状态接口、授权记录或记忆数据库。macOS 路径是 `~/Library/Application Support/PersonalMemory Runtime/gateway.env`；Linux 路径是 `${XDG_STATE_HOME:-~/.local/state}/personalmemory/gateway.env`。保存配置之后，Web 会显示模型外联的目标 origin 和可能发送的字段；点击“授权模型外联”是独立的明确授权。配置不等于授权，provider、origin 或发送字段变化会让旧授权失效。

授权只允许 PersonalMemory 把当次披露的模型输入、选中记忆上下文和导入会话消息发送到目标模型服务，用于 L0→L1/L2/L3 提炼。撤销授权不会删除 API Key、模型配置、现有 L0 或既有记忆；它会追加一条撤销记录，并在受管重启后停止新的模型外联和需要模型的提炼。若要移除密钥，应在 Web 单独点击“删除模型配置和 API Key”；这会从 `gateway.env` 删除模型配置，但仍不会删除记忆。

配置和授权完成后，在安装目录运行：

```sh
personalmemory restart
```

Web 不会自行重启本机进程。未配置、未授权或撤销授权时，自动捕获仍会保存 L0，但 L1–L3 提炼暂停。模型调用可能产生服务商费用，费用和数据处理规则由你选择的模型服务商决定。

提炼任务由 PersonalMemory 管线直接调用模型接口，不经过 Agent 生命周期 Hook。提炼请求和响应不会再次写入 L0；解析后的模型输出只进入 L1–L3 流程，内部 memory pipeline session 也会被捕获入口排除，因此不会形成递归提炼或造成 L0 膨胀。

## 记忆如何被使用

- 自动召回发生在 Agent 模型处理当前提示之前。
- 查询只返回已批准、仍有效、未删除且未被冲突或替代关系抑制的 L1。
- 默认最多注入 5 项、4,000 字符、约 1,000 token，并受约 1 秒超时限制。
- 注入内容标记为不可信记忆数据；Agent 应把它当作参考事实，而不是新的系统指令。
- L0 原文、pending/rejected L1 默认不会自动注入。
- 没有匹配项或 Gateway 超时、不可用时，当前提示继续执行，不因记忆失败阻断 Agent。

用户可在设置中分别关闭自动召回和自动本地捕获；撤销模型外联只停止需要模型的提炼，不会删除已经存在的 L0 或已审核记忆。

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

受管安装可以按需为 Codex 和 Claude Code 配置自动记忆 Hook，并提供五个 MCP 工具用于搜索、捕获、反馈等需要 Agent 主动调用的操作。自动 Hook 授权与手动工具的逐次确认互相独立。

### 数据便携与生命周期

- 导出可人工阅读的 JSON 或 Markdown；
- 创建、校验和恢复完整备份；
- 安全升级并在失败时回滚；
- 查看状态、重启或停止受管服务；
- 卸载时默认保留记忆，只有精确确认后才删除数据。

当前只有完整备份可以承担跨安装恢复。JSON/Markdown 可读导出尚不能重新导入或重建索引。

## 安装前准备

- macOS 或 Linux；当前仅正式验证 arm64。
- Node.js 22.19.0 或更高版本，以及 npm。
- Codex、Claude Code 可以按需安装；没有安装的客户端不会影响核心服务运行。
- 默认端口 `8420`、`8787`、`4173` 未被其他程序占用。

### 使用 Git 固定版本安装

MVP 首发版使用独立 Git tag `personalmemory-v0.1.1`，不要使用上游基线标签 `v1.0.1`。通过 HTTPS 获取并固定到首发版本：

```sh
git clone --branch personalmemory-v0.1.1 --depth 1 \
  https://github.com/liuzhenquan291/PersonalMemory.git
cd PersonalMemory
```

`--branch` 在这里会检出该 tag；`--depth 1` 只获取首发版本所需历史。需要审阅完整历史时可去掉 `--depth 1`。

### 使用版本化源码包安装

也可以从可信渠道取得 `PersonalMemory-0.1.1-source.tar.gz` 和同目录的 `.sha256` 文件。先校验摘要，再解压：

```sh
shasum -a 256 -c PersonalMemory-0.1.1-source.tar.gz.sha256
tar -xzf PersonalMemory-0.1.1-source.tar.gz
cd PersonalMemory-0.1.1
```

Linux 可将第一条命令替换为：

```sh
sha256sum -c PersonalMemory-0.1.1-source.tar.gz.sha256
```

Git tag、发布包生成、SHA-256 校验和支持平台见[源码包分发说明](docs/RELEASE_DISTRIBUTION.md)。

## 安装和首次启动

### 一条命令安装

通过 `curl` 获取首发 tag 中的轻量引导脚本，并显式指定 Git 地址、版本、安装目录和 Agent：

```sh
curl -fsSL \
  https://raw.githubusercontent.com/liuzhenquan291/PersonalMemory/personalmemory-v0.1.1/bootstrap-personalmemory.sh |
sh -s -- \
  --repo https://github.com/liuzhenquan291/PersonalMemory.git \
  --version personalmemory-v0.1.1 \
  --install-dir "$HOME/.local/share/personalmemory-installations/personalmemory-v0.1.1" \
  --gateway-port 8787 \
  --agent codex \
  --agent claude-code
```

`--repo` 指定 Git 仓库，`--version` 必须是 `personalmemory-v<主版本>.<次版本>.<修订版本>` 格式的真实 tag，`--install-dir` 必须是绝对路径，`--agent` 可以重复。服务端口可分别用 `--upstream-port`、`--gateway-port` 和 `--web-port` 指定，必须是三个互不相同的 1–65535 端口，默认分别为 `8420`、`8787` 和 `4173`。仓库默认为本项目，版本默认为 `personalmemory-v0.1.1`，安装目录默认为 `$HOME/.local/share/personalmemory-installations/<版本>`；未传 Agent 时自动检测 Codex 和 Claude Code。查看全部参数：

```sh
curl -fsSL \
  https://raw.githubusercontent.com/liuzhenquan291/PersonalMemory/personalmemory-v0.1.1/bootstrap-personalmemory.sh |
sh -s -- --help
```

引导脚本只接受远端确实存在的精确 tag。目标目录不存在时执行浅克隆；已经是同一仓库、同一 tag 且没有本地修改时可安全重复运行；其他已有目录、符号链接、仓库不一致、版本不一致或本地修改都会在正式安装前被拒绝。

### 从已取得的源码安装

在 Git 检出目录或解压后的版本目录运行：

```sh
./install-personalmemory.sh
```

未指定 Agent 时，安装器会检测当前 `PATH` 中可用的 Codex 和 Claude Code，只为检测到的客户端安装自动记忆 Hook。也可以通过可重复的 `--agent` 参数明确选择：

```sh
# 只接入 Codex
./install-personalmemory.sh --agent codex

# 只接入 Claude Code
./install-personalmemory.sh --agent claude-code

# 同时接入 Codex 和 Claude Code
./install-personalmemory.sh --agent codex --agent claude-code

# 接入当前版本支持的全部 Agent
./install-personalmemory.sh --agent all

# 只安装核心服务和 Web，不配置任何 Agent Hook
./install-personalmemory.sh --agent none
```

支持的值为 `codex`、`claude-code`、`all` 和 `none`。重复的具体 Agent 会自动去重；`all` 或 `none` 不能和其他值组合，未知值会在安装前报错。

源码安装入口也支持相同端口参数。例如仅把已占用的 PersonalMemory Gateway 默认端口改为 `8788`：

```sh
./install-personalmemory.sh \
  --gateway-port 8788 \
  --agent codex \
  --agent claude-code
```

端口在该次受管安装中固定，并由后续 restart、backup/restore 和 upgrade 沿用。运行中的安装若要更换端口，必须先停止服务，再用新参数重新安装；安装器不会静默忽略端口差异。

首次运行会按锁文件安装依赖、构建产品、创建私有数据目录并启动四个受管进程。重复运行用于检查、恢复安装或调整 Agent 集合，不会删除已有记忆。重新选择 Agent 时，安装器只新增所选的受管 Hook，并精确移除不再选择的 PersonalMemory Hook；不会删除客户端中的其他用户配置或自有 Hook。

当前安装与运行不使用 Docker。四个服务由本机 Node.js 直接作为后台进程启动，只监听 `127.0.0.1`；Docker 不属于 MVP 首发版的安装依赖或运行时。

成功后终端会显示 Web 地址、健康检查地址、Codex/Claude Code Hook 状态、数据目录和日志位置。默认 Web 地址是：

```text
http://127.0.0.1:4173
```

### Hook 共存与冲突保护

安装器允许所选 Agent 的 `UserPromptSubmit`、`Stop` 事件中已有其他 Hook。例如 Claude Code 的 usage-tracking `Stop` Hook 会保持原样，PersonalMemory 只追加自己的受管条目。重复安装、升级、切换 Agent 和卸载都通过私有回执中的定义摘要精确识别 PersonalMemory 条目，不会移除或改写其他 Hook。

如果 PersonalMemory 自身的受管条目缺失、被修改或重复，安装器会拒绝继续，避免扩大管理范围。未选择的 Agent 不参与配置检查。不要直接删除不认识的 Hook。

Codex 安装后还需在客户端使用 `/hooks` 核对 PersonalMemory 的精确定义并授予信任；未信任时状态可能显示 `installed_untrusted`，自动 Hook 不会正常生效。

## 首次使用

1. 打开安装结果给出的 Web 地址。
2. 在终端读取只保存在本机私有文件中的访问令牌，然后在“设置”页粘贴它以解锁当前浏览器会话。令牌不会写入浏览器存储：

   macOS：

   ```bash
   sed -n 's/^PERSONALMEMORY_AUTH_TOKEN=//p' "$HOME/Library/Application Support/PersonalMemory Runtime/gateway.env"
   ```

   Linux：

   ```bash
   sed -n 's/^PERSONALMEMORY_AUTH_TOKEN=//p' "${XDG_STATE_HOME:-$HOME/.local/state}/personalmemory/gateway.env"
   ```

   请把该令牌视为本机密码，不要发送给他人或写入项目文件。

3. 分别决定是否授权“自动召回”和“自动本地捕获”。两项授权互相独立，也不同于模型外联授权。
4. 在 Codex 或 Claude Code 中开始一次普通对话。无需说“保存这段话”：成功结束的主 Agent 对话会按授权自动捕获；失败、中断和子 Agent 轮次默认不捕获。
5. 新提炼出的 L1 记忆默认进入“收件箱”等待审核。批准后，它才有资格被后续对话自动召回。

自动召回失败时 Agent 会继续工作，不会因为记忆服务故障而中断对话。自动本地捕获本身不调用模型。

## Web 日常使用

Web 是日常记忆治理入口：

- “记忆”：浏览、筛选和搜索 L0–L3，查看详情及可用来源；
- “收件箱”：审核新 L1，接受、修改后接受或拒绝；
- 记忆详情：纠错、失效、处理冲突与替代关系；
- “审计”：查看高影响操作时间线；
- “设置”：查看 Agent/Hook 状态，并开关自动召回与自动本地捕获；
- 删除：按界面提示核对范围并强确认后执行彻底删除。

来源显示遵循当前证据边界：L0 和带真实引用的新 L1 可以核对来源；旧 L1、L2、L3 可能显示“来源未记录”。相似搜索结果不等于来源关系。

## 查看状态和管理服务

正式安装会把用户级命令安装到 `~/.local/bin/personalmemory`。安装器不会修改 shell 配置；如果该目录不在 `PATH`，请按安装结果中的提示自行加入。

查看命令帮助：

```sh
personalmemory help
```

查看脱敏状态，包括版本、数据目录及 Hook worker/backlog：

```sh
personalmemory status
```

打开仅监听本机回环地址的 Web 设置页：

```sh
personalmemory open
```

重启全部受管服务：

```sh
personalmemory restart
```

停止服务：

```sh
personalmemory stop
```

停止会保留经过校验的安装信息，因此之后可以直接运行：

```sh
personalmemory restart
```

Web 首次建立安全会话时，可以在交互式终端显式读取本地访问令牌：

```sh
personalmemory token show
```

令牌不会进入状态输出、日志或命令安装回执。不要把它粘贴到聊天、工单或公开终端记录中。

## 手动 MCP 工具

Gateway 已启动且认证环境变量可用时，可按需为 Codex 安装或卸载五个手动 MCP 工具：

```sh
npm run codex:mcp:install
npm run codex:mcp:uninstall
```

MCP 安装只转发 `PERSONALMEMORY_AUTH_TOKEN` 等变量名，不把密钥值写入 Codex 配置。手动 MCP 捕获、反馈和遗忘交接仍由客户端逐次提示确认，与 Web 中持久化的自动 Hook 授权相互独立。

## 升级

先取得并校验新版本源码包，在新版本目录运行：

```sh
npm ci
npm run upgrade:product
```

升级会检查版本与磁盘空间、创建并校验升级前完整备份、显式执行数据库迁移、重启并检查健康状态；失败时按受管流程从备份回滚。不要覆盖旧版本目录后再升级。当前升级流程不联网下载代码或执行远程脚本。

## 导出、备份与恢复

导出和备份包含个人记忆正文，移动或共享前请确认目标路径权限。完整格式、排除项和恢复边界见[可移植数据说明](docs/architecture/PORTABLE_DATA.md)。

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
personalmemory backup --output personalmemory-backup-20260827
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

## 卸载

默认卸载会停止服务、移除受管 Hook 和运行状态，但保留记忆数据：

```sh
npm run lifecycle:product -- uninstall
```

只有确定不再需要任何记忆且已有所需备份时，才删除数据。先用 `status` 读取输出中的绝对 `dataDirectory`，然后逐字输入确认：

```sh
npm run lifecycle:product -- uninstall --purge-data --confirm "DELETE <绝对数据目录>"
```

该操作不可从 PersonalMemory 内恢复。

## 默认数据位置

macOS：

- 数据：`~/Library/Application Support/PersonalMemory`
- 运行状态：`~/Library/Application Support/PersonalMemory Runtime`

Linux：

- 数据：`${XDG_DATA_HOME:-~/.local/share}/personalmemory`
- 运行状态：`${XDG_STATE_HOME:-~/.local/state}/personalmemory`

不要在服务运行时直接修改 SQLite、Hook secret 或安装回执。需要迁移时使用完整备份与恢复命令。

## 当前能力边界

- 仅验证 macOS arm64 和 Linux arm64；Windows、macOS x64、Linux x64 尚未列入支持平台。
- 首版通过固定 Git tag 或版本化源码包安装，需要 Node.js/npm；暂不使用 Docker，尚无签名桌面安装包和自动更新。
- Web 负责日常记忆治理与 Hook 授权；安装、升级、备份恢复和卸载仍通过受管命令完成。
- L2/L3 首版以查看和来源可用性披露为主。
- 完整备份可以恢复；JSON/Markdown 可读导出目前不能导入。
- Skill、Wiki、CodeGraph、多用户和多设备同步不属于当前 Chat Memory MVP。

## 故障排查

### L0 没有记录

1. 在 Web 设置中确认已授权“自动本地捕获”。
2. 运行 `npm run lifecycle:product -- status`，确认目标 Agent Hook 已安装、Codex Hook 已信任、worker 正常且 outbox 没有持续积压。
3. 只有主 Agent 成功完成、包含有效 user/assistant 成对文本的轮次才会捕获；中断、失败、子 Agent 和命中敏感内容阻断的轮次不会写入。
4. 查看安装结果给出的 Hook worker 与 Gateway 日志，但不要公开 Hook secret 或对话正文。

### 有 L0，但没有 L1

1. 这不一定是故障：提炼是异步触发，不保证每轮立即产生 L1。
2. 在 Web 设置中确认模型配置完整、模型外联已授权，并在配置或授权变化后执行过受管重启。
3. 确认 Base URL 可达、模型名称正确、API Key 有效且模型服务商余额/配额可用。
4. 等待新会话 warmup、累计轮数或空闲刷新触发；失败时 L0 会保留，可修复配置后继续处理。

### 有 L1，但 Agent 没有使用

1. 确认该 L1 已在收件箱批准，而不是 pending、rejected、失效或已删除。
2. 确认已授权“自动召回”，Hook 已安装并信任。
3. 召回按当前提示的相关性和硬预算筛选；存在记忆不代表每轮都会注入。
4. 运行状态命令检查 Gateway 和 Hook；召回失败采用 fail-open，Agent 不会报错中断。

### Web 显示无法读取记忆或要求令牌

确认 Gateway 正常后，在设置页使用受管 `gateway.env` 中的本地访问令牌建立短期会话。令牌不会持久写入浏览器；浏览器重启、会话过期或 Gateway 重启后可能需要重新解锁。不要把模型 API Key 当成本地访问令牌。

发生问题时，先保存安装命令输出和安装结果给出的日志路径，再运行 `npm run lifecycle:product -- status` 获取脱敏状态。不要公开数据目录内容、模型密钥或 Hook secret。

## 项目文档

- [整体技术方案](docs/TECHNICAL_DESIGN.md)
- [源码包分发说明](docs/RELEASE_DISTRIBUTION.md)
- [MVP 用户边界](docs/architecture/MVP_USER_BOUNDARIES.md)
- [可移植数据说明](docs/architecture/PORTABLE_DATA.md)
- [MCP Server 运行与安全边界](docs/architecture/MCP_SERVER.md)
- [项目执行规则](docs/PROJECT_RULES.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)
- [实施计划](docs/IMPLEMENTATION_PLAN.md)
- [MVP 缺口与后续路线](docs/MVP_GAPS_AND_ROADMAP.md)
- [实施记录](docs/implementation-records/README.md)
- [上游 TencentDB-Agent-Memory 中文参考文档（不是 PersonalMemory 使用说明）](README_CN.md)

## 项目名称

`PersonalMemory` 适合作为工程名和 MVP 名称：直观，并能与团队版定位区分。正式发布前仍需完成域名、GitHub、商标和应用商店重名检索，再决定最终品牌名。

## 开源与归属

本项目基于 MIT 许可的 TencentDB-Agent-Memory 开发，保留上游版权与 [LICENSE](LICENSE)。PersonalMemory 并非腾讯或 TencentDB 官方产品。

## 当前兼容性说明

上游的 Opik 可选观测依赖暂未随 PersonalMemory 安装，因为其当前依赖链包含未解决的高危安全公告。默认本地记忆能力不依赖 Opik；相关 tracer 在缺少该包时会安全禁用。恢复该能力前需完成依赖升级、离线降级测试和联网集成测试。
