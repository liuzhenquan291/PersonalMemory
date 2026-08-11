# 记忆纠错、状态与受控删除

> PersonalMemory API：`POST /api/v1/memories/:level/:id/{update|invalidate|delete}`

## 支持范围

| 操作 | L0 | L1 | L2 | L3 |
| --- | --- | --- | --- | --- |
| 修改 | 只读 | 上游原子记忆更新 | 情境文件整文件写入 | 核心画像整文件写入 |
| 失效 | 不支持 | 状态层隐藏 | 状态层隐藏 | 状态层隐藏 |
| 受控删除 | 不支持 | tombstone + 尽力删除 L1 索引 | 不支持 | 不支持 |
| 彻底删除 | 来源引用随 L1 删除 | [M3.4 受控范围级联删除](PRIVACY_ERASURE.md) | 精确内容脱敏 | 精确内容脱敏 |

所有写请求沿用 Bearer，或 loopback browser session + CSRF。请求必须携带当前 `expected_revision`；同一进程内对同一记忆串行执行，过期 revision 返回冲突，不覆盖已发生的修改。

设置页允许用户输入本地访问令牌换取短期 browser session。Bearer 只用于该次 session 请求，不写入浏览器存储；Web 仅在 `sessionStorage` 保存随页面会话销毁的 CSRF token，session cookie 由 Gateway 以 `HttpOnly` 设置。

## 权威状态层

SQLite `personalmemory_memory_states` 保存 `(level, memory_id)` 的状态、原因、revision 和更新时间。浏览与召回在返回内容前都应用这张表：`invalidated` 和 `deleted` 不可见，即使上游重建索引或再次返回同一 ID，也不能绕过 tombstone。

普通修改不会隐式恢复失效记忆。M2 不提供恢复入口，删除 tombstone 不可恢复；后续若增加恢复，必须使用显式操作并记录治理事件。

## 删除顺序与失败语义

L1 删除要求输入精确目标 `DELETE L1:<memory-id>`。服务先提交本地 `deleted` tombstone，再调用上游 `/v2/atomic/delete`。上游成功时返回 200；上游失败时保留 tombstone 并返回 202，因此记忆仍从 PersonalMemory 浏览和召回中隐藏，后续可以安全重试索引清理。

此入口不删除原始对话、L2/L3 派生资产、日志、导出物或备份，也不承诺完整擦除。M3.4 另提供先预览、再双重确认和精确短语确认的级联删除入口；它覆盖受控数据根及产品登记副本，并明确披露无法发现的用户复制品。详见 [可验证级联删除](PRIVACY_ERASURE.md)。

## 已知边界

- 状态过滤发生在上游分页后，存在 tombstone 时当前页可能少于 `page_size`；响应把 `total` 设为 `null`，避免显示不准确总数。
- L2/L3 是整文件更新，不是复杂结构化字段编辑；首版管理重点仍是查看、来源状态和受控纠错。
- 进程内锁不替代跨进程分布式锁；SQLite revision 是最终并发冲突门。
- 彻底删除只自动识别真实来源引用和完整精确派生内容；缺少来源或经过语义改写的内容不能凭相似搜索猜测后删除。
