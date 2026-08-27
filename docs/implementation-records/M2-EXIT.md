# M2 个人记忆闭环退出验收

- 状态：completed
- 日期：2026-08-11
- 基线：`1d1482e`

## 退出结论

M2.1–M2.6 已完成，M2 退出门通过。自动化产品黄金链路覆盖：

`导入 → 提炼 → 搜索 → 追溯 → 纠错 → 停服导出 → 重启 → 受控删除`

该结论只代表个人记忆核心闭环完成，不代表产品 MVP 已完成；彻底删除、真实客户端 MCP 接入、
一条命令安装、升级回滚和发布候选门禁仍分别属于 M3–M5。

## 自动化证据

- `tests/standalone-golden.e2e.test.ts` 经真实 PersonalMemory Gateway 和上游 standalone Gateway
  完成整条产品链；不使用固定等待，只轮询可观察状态。
- L1 查询和搜索返回真实 `source_message_ids`，产品详情展示 L0 消息 ID；旧数据不伪造来源。
- 纠错写回上游 SQLite，并在 PersonalMemory 状态账本递增 revision。
- 导出只在上游和产品数据库均关闭后执行；导出中同时包含记忆与状态记录。
- 重启后受控删除隐藏 PersonalMemory 结果并尝试删除 L1 索引，同时明确不删除来源会话、衍生画像、
  既有导出或备份，也不声称彻底擦除。

## 100 样本与上下文预算

- `src/gateway/sqlite-recall-evaluation.test.ts` 对 `m2.1-v1` 的 100 个合成样本逐一执行真实 SQLite
  FTS5 + sqlite-vec 双路召回，答案样本 Recall@5=100%，来源 ID 匹配率=100%，无答案拒答率=100%。
- 评测使用确定性本地 embedding，零网络、零外部模型；P95 自动门槛为 100 ms。
- Gateway 预算测试覆盖 `max_items`、`max_chars`、`max_tokens`、统一超时、Unicode 截断、层级降级
  和稳定排序；超预算内容不进入返回上下文。

## 验收中发现并修复的问题

- P1：产品导入经 legacy `/capture` 写入默认实例，而 v2 浏览原读取 `personalmemory` 实例，形成
  “导入成功但产品不可见”的分裂数据路径。产品 v2 请求现统一读取 `default` 实例，与 standalone
  根 `vectors.db`、可移植导出和备份保持一致。
- P1：SQLite 原先丢弃 L1 的 `source_message_ids`。现增加向后兼容列并贯通 FTS、向量搜索、v2 API、
  TypeScript SDK 和产品浏览；旧行迁移为空数组。

## 边界与后续

- M2 删除仍是受控删除，不是彻底删除；完整级联和擦除验证在 M3.4。
- L2/L3 暂无可验证的下级引用，完整 L3→L2→L1→L0 下钻不在 M2 范围。
- 100 样本全部为 CC0 合成数据，指标不是现实用户分布或外部模型质量声明。
- 下一步进入 M3.1：冻结治理动作与状态机契约。
