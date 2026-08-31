# LinuxDo-Advanced-Fitler

[linux.do](https://linux.do/) 主题帖高级过滤器 —— 按**类别 / 标签 / 标题**过滤或高亮帖子列表。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 等用户脚本管理器
2. 打开 [linuxdo-filter.user.js](linuxdo-filter.user.js)，点 Raw 后按提示安装
3. 打开 linux.do，通过 **设置** 管理规则

## 功能

- **过滤 / 高亮**两种模式：命中高亮的帖子置顶并标记，且优先于过滤（不会被隐藏）
- **作用域**：全局 / 仅首页 / 指定类别页（可选是否包含首页）
- 草稿规则、匹配预览、规则导入 / 导出

## 规则 DSL

| 原子 | 含义 |
|---|---|
| `category("名称")` | 匹配类别（含子类），可加级别：`category("名称", 1)` 只匹配 Lv1 子类 |
| `tag("a", "b")` | 匹配任一标签 |
| `title(/正则/i)` 或 `title("关键词")` | 匹配标题（不区分大小写） |

用 `AND` / `OR` / `NOT` 和括号组合：

```
category("开发调优") AND title(/gpt|claude/i)
NOT tag("精华") AND NOT category("非技术")
(tag("LLM") OR title("AI")) AND NOT title(/广告/i)
```

## License

[MIT](LICENSE)

## 友链

[linux.do](https://linux.do/)