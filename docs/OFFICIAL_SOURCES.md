# 官方来源与声明校验

核查日期：2026-10-24（北京时间）。来源由 GitHub 连接器 `fetch_file` 从官方仓库读取，文件分支为 `main`。SHA 为 Git blob SHA-1，不是整个仓库的 commit SHA。

| 官方文件 | Git blob SHA-1 |
| --- | --- |
| [活动 README](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/README.md) | `e693168f73634717491890fe4583d4aeb501fb25` |
| [活动规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md) | `e097cb899d2bbae5bf5f810d7196f3f9b960d29c` |
| [参赛声明](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/CONTEST_DECLARATION.md) | `136e76f3160317049f19f5ba03f4d0fedd70fc3c` |
| [MCP Server README](https://github.com/M-China/mcd-mcp-server/blob/main/README.md) | `19ba45bb7472199a09c4fb37e008ed9095bbf00b` |

根目录 `CONTEST_DECLARATION.md` 按官方 UTF-8 原文保存，未修改标题、文字、空行或换行。保存后对原始字节计算 Git blob SHA，结果与官方一致：`136e76f3160317049f19f5ba03f4d0fedd70fc3c`。

在 Git 可用的环境下可重新验证：

```text
git hash-object --no-filters CONTEST_DECLARATION.md
```

不要对该文件运行会改写换行或内容的格式化工具。提交前如官方文件已更新，应重新下载并对照当前官方要求，而不是直接编辑声明。

活动规则额外要求脱敏 `mcp-config.example.json`，因此本项目已提供。报名及排名截止为 2026-10-25 23:59，最终榜单采集时间为 2026-10-26 00:00，均为北京时间。实际规则以官方最新发布为准。

