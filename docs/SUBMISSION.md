# 参赛前交付与报名文本

官方入口：[mcd-developer-innovation-challenge](https://github.com/M-China/mcd-developer-innovation-challenge)。核查时的报名截止为 **2026-10-25 23:59（北京时间）**。

## 提交前需要本人完成

1. 真实 `order-list`、积分与优惠券只读联调已完成，参见 [联调记录](LIVE_VALIDATION.md)。提交前本人复核消费结果；更换账号或遇到接口变化时重新核验。
2. 检查报告中的来源标签和数据质量说明，导出一张不含敏感信息的 SVG 卡；演示可使用示例数据，但不能称其为真实消费。
3. 确认根目录有 `README.md`、`CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md`、`mcp-config.example.json` 和可运行源代码。参赛声明保持官方原文。
4. 执行 `node --test`，本机运行 `npm.cmd start` 并走一次主要交互。
5. 逐项检查 Git 提交内容，排除 `.env`、真实 Token、个人订单、手机号、地址、个人账户截图等。需要保留的私人数据放在已忽略的 `private-data/` 中。
6. 将项目发布到本人 GitHub 账户下、公开可访问的仓库，阅读并接受官方活动规则，再在截止前提交报名 Issue。
7. 等待官方报名成功回复；若系统返回失败原因，按要求修改并重新报名。

未使用 WorkBuddy 开发时，不创建或编造 `workbuddy.md`。项目不宣称已获得任何官方背书、名次或奖励。

## 可复制的 Issue 草稿

项目公开仓库为 [gorge-cat/mcfinance](https://github.com/gorge-cat/mcfinance)。项目地址使用原始 URL；每个字段名与值放在同一行，不在冒号后换行。可直接复制的纯文本正文见 [SUBMISSION_ISSUE.txt](SUBMISSION_ISSUE.txt)。

标题：

```text
【参赛申请】McFinance · 门财报
```

正文：

```text
【参赛申请】
项目名称：McFinance · 门财报
项目地址：https://github.com/gorge-cat/mcfinance
项目简介：基于麦当劳 MCP order-list 历史订单的个人消费研报 Skill，生成消费 KPI、预算进度和有数据依据的趣味解读，支持 7/30/90 天分析、SVG 分享卡与 Markdown 导出；采用只读查询，不下单、不领券，明确标注示例与真实数据来源。
```

此文件只是准备好的提交材料。创建公开仓库、上传源代码与发送报名 Issue 尚需由参赛者实际执行。

