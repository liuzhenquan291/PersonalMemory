# TencentDB Agent Memory 上游同步 Runbook

本文用于把腾讯上游 `feat/server` 的候选变化安全地带入 PersonalMemory。同步是独立评审流程，不是定期自动 merge。任何候选在进入产品分支前都必须完成来源固定、分类、风险检查、隔离集成和回归。

## 1. 固定边界

- 首个产品基线固定为 tag `v1.0.1` / `505877cc5160d3ea5cdb5bbd72902db03c97dd10` / `feat/server` 代码线。
- `upstream` 只允许 fetch，push URL 必须保持 `DISABLED`。
- `main` 只在一个完整里程碑通过退出门后移动；同步工作在 `sync/upstream-feat-server-<yyyy-mm-dd>-<shortsha>` 分支进行。
- 同步前创建 `backup/pre-sync-<yyyy-mm-dd>-<current-shortsha>`，并记录当前 HEAD、上游 HEAD 和 merge-base。
- 不使用 rebase、force push、`git reset --hard` 或把上游分支直接检出覆盖工作树。
- 不假定 `main`、`feat/server`、`feat/server_team` 属于同一历史。每条代码线必须单独计算 merge-base；没有共同祖先时禁止 merge。

## 2. 同步前来源与状态检查（不写工作树）

`ls-remote` 只查询远端；`fetch` 会写入 Git 对象并推进指定的 remote-tracking ref，但不修改工作树。fetch 前的 remote-tracking ref 在全新环境可以不存在，此时 `show-ref --verify` 的 status 1 记为 `absent` 后继续；fetch 后必须存在。fetch 前后都要把 ref SHA 写入实施记录；远端非 fast-forward 更新被拒绝时立即停止，不用 `+` 强制覆盖。

```bash
git status --short --branch
git remote -v
git ls-remote --heads upstream
git ls-remote --tags upstream refs/tags/v1.0.1 'refs/tags/v1.0.1^{}'
# 首次运行若 ref 不存在，status 1 只记录为 absent；不是同步失败
git show-ref --verify refs/remotes/upstream/feat/server
git fetch --no-tags upstream \
  refs/heads/feat/server:refs/remotes/upstream/feat/server
git show-ref --verify refs/remotes/upstream/feat/server
git rev-parse HEAD v1.0.1^{commit} upstream/feat/server
git merge-base <last-contiguous-upstream-base> upstream/feat/server
git rev-list --left-right --count <last-contiguous-upstream-base>...upstream/feat/server
```

门禁：

1. 工作区必须干净；若存在用户改动，先停止，不自动暂存或覆盖。
2. 单独校验 release tag：记录远端 tag ref 和可选的 `^{}` peeled ref；轻量 tag 的 ref SHA 或 annotated tag 的 peeled SHA 必须等于已知 release commit `505877cc5160d3ea5cdb5bbd72902db03c97dd10`，本地 `v1.0.1^{commit}` 也必须相等。远端/本地 tag 被移动、重打、彼此不一致或无法 peel 到 commit 时停止；不得自行重打 tag。
3. 候选分支 HEAD 正常可以领先 release tag。`git merge-base` 必须成功，且结果等于最近完整接收的连续上游基线 `last-contiguous-upstream-base`；否则视为历史改写或换线，停止并单独决策。
4. 实施记录分别固定：`last-contiguous-upstream-base`、`last-evaluated-candidate`、`selectively-ported-shas` 和仍延期/拒绝的 ledger；不得只写会移动的分支名。
5. 选择性移植或 cherry-pick 非连续提交不会推进连续上游基线。下次增量发现可从 `last-evaluated-candidate` 查询新增提交，但必须继续保留并复查此前 defer/reject 的 ledger，不能因游标前进而永久跳过。

## 3. 候选提交分类

按从旧到新的顺序逐个审阅，不只看最终 diff。每个提交只能得到 `accept`、`selective`、`defer` 或 `reject` 之一。

| 类别 | 例子 | 必查项 |
|---|---|---|
| 修复 | 数据一致性、安全、崩溃、兼容修复 | 是否适用于当前代码；是否已有等价修复；回归测试是否覆盖根因 |
| 功能 | 新 API、provider、存储、SDK 方法 | 是否属于当前 MVP；权限、外联、迁移、删除和用户可感知变化 |
| 架构漂移 | 目录重组、运行模式、核心抽象、进程边界 | 是否破坏上游可辨识边界；是否应重新立 ADR |
| 依赖/供应链 | lockfile、运行时、镜像、安装脚本 | 官方注册表、许可证、漏洞、Node/Python 支持范围、下载校验 |
| 数据格式 | schema、JSONL/Markdown、manifest、路径 | 向前/向后兼容、migration、备份恢复、旧 fixture |
| 文档/测试 | README、测试、示例 | 是否反映产品事实；测试能否独立移植而不暗带功能假设 |

建议检查：

```bash
git log --reverse --date=short --pretty=fuller <old>..<new>
git diff --name-status <old>..<new>
git diff --stat <old>..<new>
git diff <old>..<new> -- 'package*.json' sdk scripts 'LICENSE*' 'THIRD_PARTY*'
git diff <old>..<new> -- .github 'Dockerfile*' 'docker-compose*' 'compose*' 'sdk/**/pyproject.toml' 'sdk/**/poetry.lock'
git diff <old>..<new> -- src/core/store src/core/storage src/gateway
```

安装脚本、Docker/Compose、CI、SDK、默认配置和数据格式即使改动很小也必须显式写“有变化”或“无变化”，不能因不在核心源码中而跳过。

## 4. 决策与集成方式

### accept

提交完整适用且没有夹带无关变化。优先在同步分支按原顺序 cherry-pick，并保留上游 SHA 到实施记录；若一组提交不可拆分，可在明确范围后 merge，但不得跳过逐提交分类。

### selective

只有部分修复/测试适用。手工移植时提交正文记录来源 SHA、选择范围和未采用部分；不得伪装成完整同步。凡涉及许可证声明的文件不得只复制源码而漏掉归属。

### defer

功能正确但不属于当前里程碑、缺少迁移/安全证据或与产品层冲突。记录重新评估触发条件和目标里程碑。

### reject

历史换线、降低安全默认、引入不可接受许可证/漏洞、破坏数据可恢复性，或无法证明来源与兼容性。拒绝不删除记录；未来只有新证据才能重新打开。

## 5. 隔离集成与质量门

1. 先固定并核对产品 HEAD，确认目标 refs 不存在；执行 `git branch backup/pre-sync-<date>-<shortsha> <product-head>`，再从同一 SHA 执行 `git switch -c sync/upstream-feat-server-<date>-<shortsha> <product-head>`。不得覆盖已有同名分支，不移动 `main`。
2. 先应用最小候选，解决冲突时以 PersonalMemory 的项目规则和 ADR 为准；不能用“上游最新版”覆盖本地安全修复。
3. schema/格式变化必须同提交包含 migration、旧版本 fixture、重复迁移和失败恢复测试。
4. 依赖变化后重新生成锁文件并执行官方 registry audit、许可证和秘密扫描。
5. 至少执行：根 build/test、TypeScript SDK build/test、Python SDK test、standalone 黄金链路；涉及安装、备份、MCP 或 UI 时增加对应 E2E。
6. 对网络、端口、日志、密钥、删除和备份行为做差异检查；默认零外联是硬门禁。
7. 独立审查 P0/P1 为零；P2 必须修复或由用户明确接受并记录理由。
8. 以原子 Conventional Commit 提交，不添加 AI 标记，不自动 push。

## 6. 发布前同步评估

每个发布候选冻结前重新获取 `feat/server`，比较“最近已评估 SHA..当前 SHA”，同时携带并复审此前 defer/reject ledger。无新提交也要记录检查日期和 SHA。存在新提交时可以决定延期到下个版本，但必须说明：安全影响、数据格式影响、用户可见功能、不同步风险和计划复议时间。

发布不得仅因为“上游有更新”临时整体合并；高风险同步应在发布冻结前完成完整验证周期。

## 7. 同步记录模板

```markdown
# Upstream sync assessment YYYY-MM-DD

- Product HEAD:
- Last fully accepted contiguous upstream base:
- Last evaluated candidate SHA:
- Selectively ported upstream SHAs:
- Deferred/rejected ledger carried forward:
- Candidate upstream SHA:
- Merge-base:
- Branch topology result:
- Dependency/license/install/schema changes:

| Upstream SHA | Category | Decision | Reason | Verification/revisit |
|---|---|---|---|---|

## Conflicts with PersonalMemory changes
## Test and security evidence
## Final release recommendation
```

## 8. 恢复

同步分支失败时先保存 `git status` 证据。若正在 cherry-pick，执行 `git cherry-pick --abort`；若正在 merge，执行 `git merge --abort`，只能按实际进行中的操作二选一。确认同步分支回到操作前 HEAD 且工作区干净后，再切回原产品分支；若 abort 失败则停止并请求人工处理，不用 reset 绕过。备份分支和实施记录必须足以定位同步前 HEAD。已经共享的错误提交通过新 revert 提交修复，不 force push。
