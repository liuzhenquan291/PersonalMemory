# PersonalMemory 名称与渠道初查（2026-08-30）

检索日期：2026-08-30（Asia/Shanghai）。范围：工程名 `PersonalMemory` / `personalmemory`、带空格的 `Personal Memory`、GitHub、npm、PyPI、`.com` / `.ai` 域名、Apple / Google 应用商店，以及官方商标查询渠道。

## 结论与发布建议

**已发现同名 GitHub 仓库、名称相近的记忆类应用；两个目标域名均已注册。不能宣称名称唯一、渠道无冲突或商标已清查通过。** 本文完成的是公开渠道技术初查，不是商标可注册性或不侵权意见。

工程层面建议：当前开源 MVP 如继续使用既有工程名，应在发布页、下载说明和安装入口显著标注完整仓库身份 `liuzhenquan291/PersonalMemory`，避免单独使用名称导致用户下载到其他项目；不依赖未持有的域名，不创建新的同名 npm/PyPI 发布入口，不改变既有版本或仓库地址。是否接受该名称的剩余混淆风险属于项目发布决策；本报告不代替该决策，也不将技术初查标成品牌放行。

在正式品牌推广、商标申请、独立域名启用、应用商店上架或 npm/PyPI 发布前，完成目标地区及相关商品服务的人工商标清查，决定是否更名，并复核渠道实际可用性。开源许可与品牌权利是不同问题，开源发布本身不代表名称权利安全。

## 可核查结果

| 渠道 | 本次证据 | 判断与边界 |
| --- | --- | --- |
| GitHub | 官方仓库搜索 API `personalmemory in:name` 返回 HTTP 200、11 条、`incomplete_results=false`；其中有 `AIBIZSOL/PersonalMemory`、`sri16thulasi/personalmemory`、`AccountOfPersonal/PersonalMemory`，另有本项目 `liuzhenquan291/PersonalMemory` | 已存在同名仓库，完整 owner/repo 可区分；搜索仅覆盖本次可见的公开索引，不代表不存在更多项目。见 [GitHub 官方 API](https://api.github.com/search/repositories?q=personalmemory%20in%3Aname&per_page=50)、[AIBIZSOL/PersonalMemory](https://github.com/AIBIZSOL/PersonalMemory)、[sri16thulasi/personalmemory](https://github.com/sri16thulasi/personalmemory)、[AccountOfPersonal/PersonalMemory](https://github.com/AccountOfPersonal/PersonalMemory)。 |
| 同领域近似名称 | `avrabyt/PersonalMemoryBot` 描述为给聊天机器人加入记忆；`tedhsieh1966/personal_memory_system` README 描述本地 AI 记忆系统 | 存在领域与名称相近项目，增加搜索辨识难度；不是法律冲突判断。见 [PersonalMemoryBot](https://github.com/avrabyt/PersonalMemoryBot)、[Personal Memory System](https://github.com/tedhsieh1966/personal_memory_system)。 |
| npm | 精确公开端点返回 HTTP 404，正文 `{"error":"Not found"}` | 仅确认查询时未返回公开的 `personalmemory` 包；未检查保留、发布权限、命名政策、所有 scope 或近似拼写，不保证可以注册。见 [npm registry 精确查询](https://registry.npmjs.org/personalmemory)。 |
| PyPI | 精确 JSON 端点返回 HTTP 404，正文 `{"message": "Not Found"}` | 仅确认查询时未返回公开的 `personalmemory` 项目；不保证名称未保留或允许创建，也未覆盖带连字符等不同名称。见 [PyPI 精确查询](https://pypi.org/pypi/personalmemory/json)。 |
| `personalmemory.com` | Verisign 官方 RDAP 返回 HTTP 200，`ldhName=PERSONALMEMORY.COM`、状态 `active`；注册日期 2008-06-12，记录到期日期 2028-06-12 | 已有注册记录，不能当作空闲域名；未查明是否由项目方持有，亦未询价或购买。见 [Verisign RDAP](https://rdap.verisign.com/com/v1/domain/personalmemory.com)。 |
| `personalmemory.ai` | Identity Digital RDAP 返回 HTTP 200，`ldhName=personalmemory.ai`、状态 `client transfer prohibited`；注册日期 2025-08-20，记录到期日期 2027-08-20 | 已有注册记录，不能当作空闲域名；注册人隐私保护，未查明是否与项目方有关。见 [Identity Digital RDAP](https://rdap.identitydigital.services/rdap/domain/personalmemory.ai)。 |
| Apple App Store | 官方页面存在 `Recall: Personal Memory` 与 `Snapback: Personal Memory` | 已有标题包含相同词组的应用，均非完全相同的独立标题；不能推断 `PersonalMemory` 可上架。见 [Recall](https://apps.apple.com/us/app/recall-personal-memory/id6758715992)、[Snapback](https://apps.apple.com/us/app/snapback-personal-memory/id6748515444)。 |
| Google Play | 官方页面存在 `Echooo Personal Memory`，介绍为隐私与离线优先的记忆应用 | 名称与用途均相近；未完成所有国家地区的完整商店检索，不得记为无冲突。见 [Echooo Personal Memory](https://play.google.com/store/apps/details?id=com.nikoghosyan.echoomemory)。 |

Apple 官方 Search API 的美国区 `term=personalmemory&entity=software&limit=50` 本次返回 47 个结果，但 `trackName` 中包含 personal 的结果只有 `Logg: Personal Journal & Diary`，未返回上述已存在的 Recall / Snapback 页面。因此不能把该 API 的单词搜索结果用作不存在近似应用的依据；本报告采用已取得的官方产品页作为存在性证据。见 [Apple 查询端点](https://itunes.apple.com/search?term=personalmemory&entity=software&country=us&limit=50)。

## 商标：仅核实入口，尚未完成名称清查

| 官方渠道 | 已核实内容 | 必须补做 |
| --- | --- | --- |
| 中国国家知识产权局商标局 | [中国商标网](https://sbj.cnipa.gov.cn/)提供商标网上查询入口；[官方统一身份认证手册](https://sbj.cnipa.gov.cn/sbj/tzgg/202310/W020231017374500440623.pdf)说明查询系统的用户身份认证流程 | 由有访问条件的项目负责人或专业人员查询 `PersonalMemory`、`Personal Memory` 及拟用中文名/近似名称，保存检索条件、结果、日期、状态和相关类别。此次未取得名称查询结果。 |
| USPTO（美国） | 已核实 [官方检索说明](https://www.uspto.gov/trademarks/search)、[Trademark Search](https://tmsearch.uspto.gov/search/)；官方说明不仅检查完全一致，也检查近似名称及相关商品服务 | 若美国属于目标市场，执行并留存实际名称清查结果；此次未取得结果。 |
| EUIPO（欧盟） | [官方搜索入口](https://www.euipo.europa.eu/search)列出 eSearch plus、TMview；[eSearch plus](https://euipo.europa.eu/eSearch/)可用于欧盟相关查询 | 若欧盟属于目标市场，执行实际名称及近似名称查询；此次未取得结果。 |
| WIPO | [官方可用性检查说明](https://www.wipo.int/en/web/madrid-system/check-availability)建议检索相同和近似标志，并说明部分国家数据可能不完整，需补查当地知识产权局 | 通过 Global Brand Database 补充检索，不能代替各目标市场的官方查询；此次未取得名称查询结果。 |

不把“找到商标查询入口”写成“已检索且没有商标”。目标市场、拟用正式品牌和相关商品服务范围也尚需确认。专业判断以合适的商标专业人员审查为准。

## 待办与关闭条件

- [ ] 正式品牌清查：负责人明确目标地区、拟用名称及相关商品服务，保存官方名称/近似名称检索证据并评估混淆风险；结论可以是保留名称或更名，不预设通过。
- [ ] 域名策略：确认项目方是否持有目标域名；未持有则选择其他已核验可控入口。不得把本报告当作购买或联系域名持有人的授权。
- [ ] 新渠道启用前复核：npm、PyPI、Apple/Google 分别检查命名规则、权限、保留和实际发布条件；本次未注册、预留、购买或上架任何名称。

## 方法与限制

采用公开网页搜索发现线索，再用 GitHub 官方 API、平台官方页面、npm/PyPI 官方端点和注册局 RDAP 确认。浏览抓取部分端点失败后，改用系统 curl 和正常 TLS 验证取得实时响应；没有关闭证书校验。Python 请求因本机证书链问题失败，其结果没有被用作“名称不存在”的证据。

搜索结果具有时间性、索引覆盖和地区差异；404 不是可注册承诺；域名注册记录不证明网站用途或权利归属；同名仓库和近似应用不自动构成商标侵权，但足以否定“全网唯一”的表述。本次未登录商标/应用商店后台、未做付费清查、未处理人机验证，也未向第三方发送消息。
