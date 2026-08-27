# MVP 合并前审计

- 状态：ready-for-decision
- 检查日期：2026-08-13
- 范围：同步 M0–M5 完成状态，核对提交图、备份锚点、发布候选和进入 `main` 前的授权边界。
- 非目标：本步骤不移动 `main`，不推送远端，不创建远端发布，也不扩大 MVP 功能范围。
- 分支关系：`main` 与 `origin/main` 都是 `integration/upstream-v1.0.1` 的祖先；集成结果可以纯 fast-forward 进入本地 `main`，不需要 rebase、squash 或改写共享历史。
- 恢复锚点：`backup/pre-upstream-v1.0.1` 仍指向迁移前本地 `main`，用于审查和恢复参考；任何实际回退是否移动分支仍需用户决定。
- 发布候选：M5.4 已完成 macOS arm64 与 Linux arm64 的真实分发物验收；macOS x64 与 Linux x64 在实测前仍不列为支持平台。
- 安全边界：移动本地 `main`、推送远端和对外发布分别需要明确授权。正式发布前还需完成名称、域名、商标及发布渠道重名检查。
- 结论：没有提交图阻断项；完成本次状态同步、发布包重建和提交后回归后，可由用户决定是否 fast-forward 本地 `main`。
