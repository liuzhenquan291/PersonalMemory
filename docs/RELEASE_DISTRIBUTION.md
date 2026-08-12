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

校验并解压后，在版本目录运行：

```sh
./install-personalmemory.sh
```

安装入口要求 macOS 或 Linux、Node.js 22.19.0 以上和 npm。首次运行在依赖不存在时通过 `npm ci` 按锁文件安装，随后构建并启动核心 Gateway、PersonalMemory Gateway 和 Web；重复运行只验证受管进程、三个健康入口和非降级 L0/L1 召回，不重复安装依赖。

## 包内容边界

包内包含 Git 候选源码、锁文件、上游 `LICENSE`、`THIRD_PARTY_NOTICES.txt`、`RELEASE-MANIFEST.json` 和安装入口。打包器拒绝符号链接及非普通文件，并排除 `release/` 自身；`.git`、`node_modules`、构建输出、日志、密钥和用户数据均不进入分发物。

当前已验证平台是 macOS arm64 和 Linux arm64。macOS x64 与 Linux x64 已锁定所需原生依赖，但在对应架构实测前不列入发布清单的支持平台。
