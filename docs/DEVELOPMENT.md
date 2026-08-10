# PersonalMemory 本地开发

## 首次准备

要求 Node.js 22.19.0 或更高版本。在仓库根目录安装锁定依赖：

```bash
npm ci
```

安装过程是显式步骤；`npm run dev` 不会联网或隐式下载安装任何组件。

## 一条命令启动

```bash
npm run dev
```

启动成功后终端会显示：

- Web：`http://127.0.0.1:4173/memories`
- PersonalMemory Gateway 健康检查：`http://127.0.0.1:8787/health`
- 本轮隔离数据目录；它位于仓库的 `.personalmemory-dev/` 下，仅供本次开发运行使用。

按 `Ctrl+C` 会同时停止 Web 与 Gateway，并删除本轮临时数据。开发命令不会启动腾讯上游 `8420` 服务；当前 Web 壳和 Gateway 状态可独立工作，M2 接入真实记忆操作时再加入上游核心生命周期。

## 端口占用

启动器会先检查两个端口。端口被占用时直接失败，不会终止或复用未知进程。可以先停止已有进程，或显式换用端口：

```bash
PERSONALMEMORY_DEV_GATEWAY_PORT=18787 \
PERSONALMEMORY_DEV_WEB_PORT=14173 \
npm run dev
```

两个变量只接受 `1`–`65535` 的整数；Web 代理会同步使用指定的 Gateway 端口。

## 失败与清理

- Gateway 或 Web 任一进程意外退出时，启动器会停止另一个进程并以失败状态结束。
- 正常和失败启动都会清理本轮临时数据，且只删除受控根目录下以 `personalmemory-dev-` 开头的目录。
- 若终端被强制杀死而无法执行清理，可在确认没有开发服务运行后删除 `.personalmemory-dev/personalmemory-dev-*`；不得把该路径用于正式用户数据。

## 平台验证

- macOS arm64：M1.5 已实测首次启动、连续两轮启动、端口占用、Gateway/Web 健康、代理、Ctrl+C、异常子进程退出和临时数据清理。
- Linux：启动器只使用 Node.js、POSIX 信号和进程组；实现目标为 Linux，但 M1.5 尚未在 Linux 实机验证，不得宣称已实测支持。
