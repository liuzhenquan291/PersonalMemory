# 统一查询与预算召回

> API：`POST /api/v1/recall/query`

## 契约

调用方提供查询、需要访问的层级和硬预算：

- `levels`：L0、L1、L2、L3 的去重集合，默认只访问 L1/L0；未选择的层不会调用上游。
- `max_items`：1–50，默认 10。
- `max_chars`：128–32,000，默认 6,000。
- `max_tokens`：32–8,000，默认 1,500；首版按 ASCII 4 字符/token、非 ASCII 2 token/字符保守估算。
- `timeout_ms`：50–10,000，默认 2,000，作为整个召回请求的统一截止时间。

PersonalMemory 使用上游结构化只读 API 搜索 L0/L1、列出并读取 L2、读取 L3。
允许的 v2 上游路径固定为 conversation/search、atomic/search、scenario/ls、scenario/read、core/read；
不开放 v2 写入、删除或 instance/destroy。

预算在所有来源合并后再次强制执行。字符和估算 token 两项预算分别计算并同时限制；
截断按 Unicode 码点进行，不会切断代理对，最后一项可被截断并明确标记 `truncated`。
响应返回实际使用条数、字符、估算 token 和 `exhausted`，调用方不能通过单层 limit 绕过总预算。

## 排序与降级

层级顺序固定为 L1、L0、L2、L3。L0/L1 在层内按 score 降序、ID 升序稳定排列。
L2 用 path/summary 与查询的词面命中率排序，再按更新时间和 path 稳定打破平局；L3 是单一 persona。
不同层分数不可直接比较，因此不伪造跨层统一相关度。

各层并行读取。单层超时、不可用或响应不符合契约时，该层返回在 `degraded_levels`，
其他成功层仍可返回；错误响应和结构化日志不包含查询正文或召回正文。

当前不向 PersonalMemory API 暴露 type/time/session 元数据过滤。上游 v2 schema 虽声明部分字段，
实际搜索实现仍有召回后过滤或忽略情况；在内核完成真正的召回前过滤前，不作该能力承诺。

## M2.3 评测基线

数据版本：`m2.1-v1`，100 个完全合成样本。确定性双字词面 smoke 基线在本机 macOS arm64
记录 Recall@5=1.00、无依据答案注入率=0、过期命中率=0、无答案拒答率=1.00，
字符/token 预算违规率=0，纯内存词面排序 P95 < 10 ms。

这些数字只验证数据集、过期过滤、拒答阈值、指标计算和预算编排，不包含 HTTP、SQLite、
embedding 或模型耗时，不能宣传为产品检索质量或端到端性能。M2 退出门仍需对真实本地存储链路
生成 100 样本报告。
