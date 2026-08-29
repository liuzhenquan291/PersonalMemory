# PersonalMemory MVP 首发与源码分发

MVP 首发版本为 `personalmemory-v0.1.1`。该 annotated Git tag 指向包含首发文档和实现的固定提交，与上游基线标签 `v1.0.1` 含义不同，不得混用或移动。

用户可以直接检出固定 tag：

```sh
git clone --branch personalmemory-v0.1.1 --depth 1 \
  https://github.com/liuzhenquan291/PersonalMemory.git
cd PersonalMemory
./install-personalmemory.sh
```

也可以使用首发 tag 内的远程引导器，并显式传入仓库、版本和可重复 Agent 参数：

```sh
curl -fsSL \
  https://raw.githubusercontent.com/liuzhenquan291/PersonalMemory/personalmemory-v0.1.1/bootstrap-personalmemory.sh |
sh -s -- \
  --repo https://github.com/liuzhenquan291/PersonalMemory.git \
  --version personalmemory-v0.1.1 \
  --gateway-port 17175 \
  --agent codex \
  --agent claude-code
```

引导器只接受规范化的 PersonalMemory 版本 tag 和绝对安装目录，验证远端 tag 后浅克隆固定版本，再调用包内正式安装器。`--upstream-port`、`--gateway-port`、`--web-port` 可覆盖默认 `17173`、`17175`、`17177`，三者必须有效且互不相同。它不会使用 Docker，也不会静默覆盖已有目录或有本地修改的检出。

版本化源码压缩包及其独立 SHA-256 文件仍是可离线校验的正式分发物。MVP 不发布根项目现有的上游 npm 插件包。

## 生成与校验

```sh
npm run release:check
npm run release:package
cd release
shasum -a 256 -c PersonalMemory-0.1.1-source.tar.gz.sha256
```

Linux 可使用 `sha256sum -c` 校验同一个文件。发布产物默认写入被 Git 忽略的 `release/` 目录。

## 用户安装

完整的安装、首次授权、日常使用、备份恢复和卸载说明见项目 [README](../README.md)。

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

MVP 首发版暂不使用 Docker。安装器直接启动本机 Node.js 受管进程，Docker 不是安装依赖，也不是 Web、Gateway 或 Hook worker 的运行方式。

## 包内容边界

包内包含 Git 候选源码、锁文件、上游 `LICENSE`、`THIRD_PARTY_NOTICES.txt`、`RELEASE-MANIFEST.json` 和安装入口。打包器拒绝符号链接及非普通文件，并排除 `release/` 自身；`.git`、`node_modules`、构建输出、日志、密钥和用户数据均不进入分发物。

当前已验证平台是 macOS arm64 和 Linux arm64。macOS x64 与 Linux x64 已锁定所需原生依赖，但在对应架构实测前不列入发布清单的支持平台。
