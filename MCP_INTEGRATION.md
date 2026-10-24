# 麦当劳 MCP 接入说明

McFinance 读取个人历史订单，转成消费 KPI 与趣味研报。它不创建、取消、支付订单，不领取优惠券，不进行积分兑换或抽奖。

## 官方服务与依据

- Server：`https://mcp.mcd.cn`
- 传输：Streamable HTTP。
- 鉴权：请求头 `Authorization: Bearer <个人 MCP Token>`。
- 主要业务 Tool：`order-list`，官方说明为“查询近期的到店/外送历史订单（非商城订单）”。
- 官方文档：[M-China/mcd-mcp-server](https://github.com/M-China/mcd-mcp-server)。本项目核查的文件版本见 [官方来源记录](docs/OFFICIAL_SOURCES.md)。

工具 schema 以连接后服务端实际返回为准。官方 README 给出了工具名称和用途，但没有提供 `order-list` 的完整入参/返回结构；本项目不会把猜测的分页参数当作官方保证。

## 实际调用流程

```text
本机浏览器 → 本机 Node 服务 → 固定官方 MCP Server
                                 initialize
                                 notifications/initialized
                                 tools/list
                                 tools/call: order-list
                    ↓
              字段归一化 → 时间/状态筛选 → 消费分析 → 图表 / SVG / Markdown
```

1. 本机服务从 `MCD_MCP_TOKEN` 环境变量或页面连接请求接收 Token，在内存中使用；不写入项目文件。
2. 完成 MCP 初始化，读取工具清单与 input schema。
3. 检查服务端是否提供 `order-list`；按实际 schema 提交只读参数。缺少必填参数时应先明确参数，不能偷偷回退为示例成功。
4. 将订单映射到项目统一结构，记录金额/日期缺失等数据质量问题。不能可靠识别的记录不得变成“0 元订单”。
5. 报告注明来源、观察窗口、样本范围和缺失信息。请求失败时显示真实错误，不用示例数据伪装成真实订单。

本项目为小型本机客户端；不承诺自动拉齐所有分页、补齐完整历史或兼容未来任意 schema。同步得到的样本可能少于选择的观察窗口；需要更多历史时，应根据当前 schema 和权限补充读取，再检查重复与时间范围。

## Tool 范围

| Tool | 本项目用途 | 是否为主流程必需 |
| --- | --- | --- |
| `order-list` | 个人到店/外送历史订单分析 | 是 |
| `query-my-coupons` | 同步时尝试读取本人已有券；Skill 可应用户要求单独查询 | 否，失败不阻断订单分析 |
| `available-coupons` | 同步时尝试读取可领取券数量供参考 | 否，查询不代表已经领取 |
| `query-my-account` | 同步时尝试读取账户会员等级与可识别的积分字段 | 否，失败不阻断订单分析 |

后面三个为补充查询：客户端会在主要订单查询成功后尝试，工具缺失、参数不足或失败时明确跳过并提示。若对应字段无法识别，显示未知，不杜撰账户资料。未实际成功返回时，不声称已查到券或积分。优惠券面额不等于已实现节省；积分不换算成人民币资产。网页服务的业务调用严格保持只读。

## 本机配置

1. 访问 [开放平台](https://open.mcd.cn/mcp)，自行阅读条款、登录并激活 Token。
2. 在本机设置 `MCD_MCP_TOKEN` 或使用页面连接入口。不要将 Token 交给评审、写入提交材料或发送到其他服务。
3. 启动服务，连接后核查当前 `order-list` schema，在需要时填写参数，再执行同步。
4. 对照官方账户中的少量订单，核验时间、币种、金额单位、状态与商品数量。

[配置示例](mcp-config.example.json) 只包含 `${MCD_MCP_TOKEN}` 占位符。第三方 MCP 客户端的变量解析机制不同，应使用该客户端支持的环境变量/密钥配置。

## API 与可复现验证

| API | 目的 |
| --- | --- |
| `GET /api/report?source=demo&days=30&budget=600` | 固定示例报告 |
| `GET /api/report?source=live&days=30&budget=600` | 已同步真实数据的报告 |
| `POST /api/analyze` | 传入标准 `orders`、`days`、`asOf`、`budget` 做本地分析 |
| `POST /api/connect` | 在内存中接收 Token 并发现工具 |
| `POST /api/sync` | 按当前 schema 的 `arguments` 同步历史订单 |
| `POST /api/disconnect` | 清除本机服务内存中的 Token、连接与同步数据 |
| `GET /api/export.svg` | 导出分享卡；窗口/来源参数与报告保持一致 |
| `GET /api/export.md` | 导出 Markdown 研报；窗口/来源参数与报告保持一致 |

`POST /api/sync` 可通过 `optionalToolArguments` 按工具名传入补充查询参数。JSON 导入后的导出使用 `POST /api/export.svg` 或 `POST /api/export.md`，请求体与本地分析一致；导入数据不会因此上传到官方 MCP。

运行 `node --test` 验证本地逻辑和模拟协议流程。模拟协议通过不代表真实账户已通过认证。真实服务可能返回授权失败、限流、参数变化、响应字段变化或无法覆盖的订单类型。

**真实联调状态：2026-10-24 已通过。** 已使用账户本人授权的 Token 成功完成初始化、工具发现、历史订单、积分和优惠券只读查询，并按实际返回结构补齐归一化。验证时另只读查询一笔 `query-order` 详情，交叉核对列表支付金额与详情一致；详情商品单价 schema 明确为元，未调用任何下单或资产变更工具。`query-order` 仅用于本次人工联调核验，不在网页自动同步的工具白名单中。公开记录见 [LIVE_VALIDATION.md](docs/LIVE_VALIDATION.md)，不包含 Token、账号标识或真实订单。

当前实际列表结构为 `data.list[]`，采用 `realTotalAmount`、`createTime`、`orderStatus` 和 `orderProductList`。`订单已完成` 被识别为完成状态；`orderType` 的数字含义没有官方枚举说明时不猜渠道。列表未提供原价，不推算优惠。积分读取 `data.availablePoint` 的有效非负数字字符串，保留小数积分；优惠券保留本次返回项数和已确认的分页总数。字段定义和服务行为仍可能变化，换账号或服务变更后应重新核验。

页面刷新可恢复当前本机服务内存中的已同步报告；关闭服务后 Token 与订单缓存清除。不会自动把个人原始数据写入文件。

## 业务价值与数据边界

`order-list` 让研报以真实个人消费为依据，回答“花了多少、常买什么、预算走到哪里”。研报金句围绕已计算指标，避免凭空编造节省金额、排名或消费增长。SVG 卡只分享汇总信息；导出前仍应由用户检查，尤其是样本极少时。

取消/退款/未支付记录、原价缺失、重复订单与无效时间都可能影响口径，见 [数据说明](docs/DATA.md)。项目只分析实际取得的记录，不推断其他渠道消费、完整家庭支出、健康状态或投资能力。

