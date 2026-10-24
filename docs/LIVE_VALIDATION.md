# 官方 MCP 真实只读联调记录

验证日期：2026-10-24，北京时间。使用账户本人授权的 Token，仅连接官方 `https://mcp.mcd.cn`。

## 验证范围

- `initialize`、`notifications/initialized`、`tools/list` 成功，读取官方实时 input/output schema。
- `order-list` 成功，真实返回结构为 `data.list`；当前 input schema 不要求参数，没有编造分页或日期参数。
- `query-my-account`、`query-my-coupons`、`available-coupons` 只读查询成功，核对积分数字字符串和券分页字段。
- 人工联调额外只读查询一笔 `query-order` 详情：列表与详情的 `realTotalAmount` 一致，详情商品 `price` schema 标注“原价,单位元”。没有执行订单或资产变更。
- 根据真实字段完成归一化和消费报告，真实接口不会回退为示例数据。
- 本机 HTTP 同步接口返回成功，浏览器核对真实来源、指标、7/30/90 天窗口、账户积分、页面刷新恢复及 SVG/Markdown 导出均通过。45 项离线自动化测试与合成数据浏览器回归通过。

## 由联调确认的适配

| 数据 | 实际字段与处理 |
| --- | --- |
| 订单 | `data.list[]`；使用 `orderId` 去重 |
| 金额 | `realTotalAmount` 数字字符串，按人民币元处理 |
| 时间 | `createTime`，无时区的完整时间按北京时间解释 |
| 状态 | `orderStatus: 订单已完成` 识别为完成 |
| 商品 | `orderProductList[].productName/quantity`；不重复展开套餐子项 |
| 渠道 | 无明确数字枚举含义时显示未知 |
| 原价与优惠 | 列表未返回原价，显示缺失，不计算虚构优惠 |
| 积分 | `data.availablePoint` 的有效非负数字字符串，保留官方返回的小数积分，不换算为现金 |
| 持有券 | `data.coupons`；区分本页项数和官方 `totalCount`，保留有效期 |

## 保留的限制

查询成功证明该账户在验证时可用，不代表所有账号、所有历史与未来 schema 均兼容。统计只覆盖本次工具返回的记录；选择 90 天不代表取得完整 90 天流水。原价、未说明的渠道枚举及未返回的历史不补造。

本文件只记录协议、字段与验证状态。Token、账号编号、手机号、地址、订单编号、真实消费明细与个人截图未放入公开样例、源码包或回归测试。私人导出放在已被 Git 忽略的 `private-data/` 中。
