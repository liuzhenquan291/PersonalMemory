# PersonalMemory 源码包分发

MVP 首个正式分发物是版本化源码压缩包，不是根项目现有的上游 npm 插件包。

## 生成与校验

```sh
npm run release:check
npm run release:package
cd release
shasum -a 256 -c PersonalMemory-0.1.1-source.tar.gz.sha256
```

Linux 可使用 `sha256sum -c` 校验同一个文件。发布产物默认写入被 Git 忽略的 `release/` 目录。

## 用户安装

完整的安装、首次授权、日常使用、备份恢复和卸载说明见 [PersonalMemory 使用手册](USER_GUIDE_CN.md)。

校验并解压后，在版本目录运行：

```sh
./install-personalmemory.sh
```

安装器支持可重复的 Agent 选择参数。例如只接入 Codex：

```sh
./install-personalmemory.sh --agent codex
```

同时接入多个 Agent：

```sh
./install-personalmemory.sh --agent codex --agent claude-code
```

还可使用 `--agent all` 安装全部当前支持的 Agent Hook，或使用 `--agent none` 只安装核心服务和 Web。不传 `--agent` 时自动检测当前 `PATH` 中可用的客户端。

安装入口要求 macOS 或 Linux、Node.js 22.19.0 以上和 npm。首次运行在依赖不存在时通过 `npm ci` 按锁文件安装，随后构建并启动核心 Gateway、PersonalMemory Gateway 和 Web；重复运行验证受管进程、三个健康入口和非降级 L0/L1 召回，并可按新参数调整受管 Agent Hook，不重复安装依赖。

## 包内容边界

包内包含 Git 候选源码、锁文件、上游 `LICENSE`、`THIRD_PARTY_NOTICES.txt`、`RELEASE-MANIFEST.json` 和安装入口。打包器拒绝符号链接及非普通文件，并排除 `release/` 自身；`.git`、`node_modules`、构建输出、日志、密钥和用户数据均不进入分发物。

当前已验证平台是 macOS arm64 和 Linux arm64。macOS x64 与 Linux x64 已锁定所需原生依赖，但在对应架构实测前不列入发布清单的支持平台。
