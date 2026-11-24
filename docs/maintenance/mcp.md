# MCP 维护

[server/mcp.mjs](../../server/mcp.mjs)由 AI 客户端启动，经 stdio 提供工具，再调用现有的知悟 HTTP API。工具 schema 以脚本里的 `registerTool` 为准。配置示例见 [README](../../README.md#从外部-ai-收录)。

## 连接和权限

| 配置 | 含义 |
| --- | --- |
| `ZHIWU_URL` | 必填。用 AI 客户端所在设备实际能访问的 HTTP(S) 知悟地址。请求保留服务路径前缀，每个工具先检查 `api/health` 返回的状态与应用名。 |
| `ZHIWU_TOKEN` | 可选。适配器将值放进 HTTP Bearer 请求头，供已配置鉴权的部署使用。服务的访问控制由部署负责。 |
| `ZHIWU_IMPORT_DIR` | 启用原文件导入时填写。目录位于运行 MCP 进程的机器上，工具接收其中的相对路径。 |
| `ZHIWU_ALLOW_READ=1` | 注册搜索和读回工具。默认可查看分类、建分类、保存、追加及导入。 |

stdio 的标准输出用于 MCP 消息，启动和诊断信息写标准错误。配置变更后重启客户端里的适配器并重新列工具。

## 工具和回执

以下都是 `tools/call` 的参数对象。将示例中的 `分类ID` 和 `笔记ID` 换成前一次回执里的真实编号。原文件示例对应已授权目录内存在的文件。

```json
[
  { "name": "list_zhiwu_categories", "arguments": {} },
  {
    "name": "ensure_zhiwu_category",
    "arguments": { "categoryPath": ["项目", "记账小程序", "设计"] }
  },
  {
    "name": "save_to_zhiwu",
    "arguments": { "title": "记账设计", "content": "## 决策\n保留原始交易时间。", "categoryId": "分类ID", "tags": ["设计"] }
  },
  {
    "name": "append_to_zhiwu_note",
    "arguments": { "noteId": "笔记ID", "content": "追加讨论记录。", "excerptId": "design-review-1" }
  },
  {
    "name": "import_zhiwu_files",
    "arguments": { "paths": ["docs/设计.md", "docs/界面.png"], "categoryId": "分类ID" }
  },
  {
    "name": "search_zhiwu_notes",
    "arguments": { "query": "交易时间", "categoryId": "分类ID", "limit": 10 }
  },
  { "name": "read_zhiwu_note", "arguments": { "noteId": "笔记ID" } }
]
```

| 工具 | 预期 `structuredContent` | 使用规则 |
| --- | --- | --- |
| `list_zhiwu_categories` | `categories`，每项含 `id`、`name`、`parentId`、`categoryPath`、`noteCount`。 | 用路径展示，用 ID 选目标。数量是该分类下的直接可用笔记数。 |
| `ensure_zhiwu_category` | `categoryId`、完整 `categoryPath`。 | 一次建齐或复用路径。选定上级 ID 后，可传 `parentId` 和相对于它的 `categoryPath`。 |
| `save_to_zhiwu` | `id`、`title`、`url`、`categoryId`，有分类时带 `categoryPath`。 | 保存 Markdown 正文。分类路径和编号二选一，都省略时存为未分类。 |
| `append_to_zhiwu_note` | 笔记回执及 `excerptId`。 | 按 ID 写入独立摘录。客户端重试应复用同一 `excerptId` 和正文。 |
| `import_zhiwu_files` | `notes`、`warnings`，有分类时带 `categoryPath`。每篇回执包含原文件名。 | 一个文件生成一篇笔记。分类规则与保存一致。 |
| `search_zhiwu_notes` | `notes`，每项包含笔记回执、`tags` 和 `excerpt`。 | 关键词、分类和标签可组合。默认返回 20 条，`limit` 允许 1–100。 |
| `read_zhiwu_note` | 笔记回执及 `tags`、`content`、`sourceContent`、`chatExcerpts`、`sourceFilename`、`attachmentUrl`。 | `noteId` 可取自回执 URL 的 `note` 参数。原件地址跟随所选服务及部署权限。 |

## 边界和排障

- 地址错时先看适配器启动错误和目标的 `/api/health`。核对地址、服务路径及现有鉴权，再尝试收录。
- 旧库同级同名时，建路径返回冲突。列出分类后按确认的 `categoryId` 保存，或以 `parentId` 在选定分支下建子分类。[分类路由](../../server/src/routes/categories.ts)在事务内创建路径，[共享路径函数](../../server/src/shared/categoryPaths.ts)供前后端展示。
- 相同笔记和摘录 ID 重传相同正文时返回已有结果，正文冲突时返回错误。用户可从笔记详情撤销这条追加。普通创建与批量导入遇到结果不明时，先核对已有笔记或回执，再决定重试哪些记录。
- [文件选择器](../../server/mcpFiles.mjs)预检整批相对路径，解析实际路径并限制在已授权目录内，每次 1–30 份且单份小于 30 MiB。导入使用精简回执，图片先保存原件，OCR 在知悟中按需执行。批量导入可能同时含成功项和警告，按 `notes` 和 `warnings` 确认结果后再补失败项。
- 读回及搜索遵循可用笔记的范围。变更 [笔记 API](../../server/src/routes/notes.ts)时保留界面所用的常规返回结构，同时验证 MCP 的精简搜索和导入回执。

变更时跑 [stdio 到数据库的集成测试](../../server/test/notes.test.mjs)、[文件范围测试](../../server/test/mcp-files.test.mjs)和涉及的 [分类路径测试](../../server/test/category-paths.test.mjs)。用临时库手动验证一次回执链接落到实际笔记。
