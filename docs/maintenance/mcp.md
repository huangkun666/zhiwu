# MCP 维护

## 安卓独立 APK

在「设置 → MCP 配置」开启手机服务。客户端将 MCP 网址和 Bearer 令牌填入自己的远程 MCP 连接设置。工具读写这部手机的 IndexedDB。手机即可独立提供服务，原生能力版本要求为 4。配置步骤见 [README](../../README.md#连接手机上的笔记)。

- 本机入口是 `http://127.0.0.1:37821/mcp`。其他设备可使用能路由到的手机 IPv4 或 IPv6 地址，包含 VPN 地址。云端客户端需要从运行工具的服务器能到达的网址。使用域名时，先通过 HTTPS 反向代理或隧道转发到手机的 37821 端口，再将完整外部网址存为「自定义连接地址」。代理可保留外部路径，也可改写到 `/mcp`。
- 由网页直接发请求的客户端可在高级设置填写「网页客户端来源」，例如 `https://ai.example.com`。服务只允许匹配来源的预检，请求笔记仍须提交 Bearer 令牌。服务端调用的客户端通常可留空。
- 默认只读，提供查看分类、搜索、读回笔记。选择「可编辑」后可新建分类、保存笔记、修改标题或可编辑正文、追加可撤销的摘录。手机读回包括原件的提取文字，原件保存在手机应用内。更新正文前读取 `updatedAt` 和 `editableContent`，断线重试收录用同一 `requestId`（UUID），重试追加用同一 `excerptId`。
- 原生前台服务负责监听、校验授权，并将请求送到当前知悟 WebView。切换到其他应用时可以继续使用。知悟被关闭或系统终止后，重新打开可恢复已授权的连接。用户主动关闭会撤销令牌，变更读写权限后须更新客户端的令牌。令牌和外部连接设置独立于笔记备份。

网络入口、协议工具及笔记读写分别见 [Android 服务](../../client/android/app/src/main/java/com/zhiwu/learning/McpHttpServer.java)、[手机 MCP 工具](../../client/src/api/phoneMcpTools.ts)和[离线库](../../client/src/api/localEngine.ts)。设备与反向代理验证见[验证矩阵](verification.md#按变更选验证)。

## 桌面 stdio 适配器

[server/mcp.mjs](../../server/mcp.mjs)由 AI 客户端启动，经 stdio 提供工具，再调用现有的知悟 HTTP API。在知悟「设置 → MCP 配置」可填写服务地址、适配器脚本路径与笔记权限，然后复制 JSON 到外部客户端。本机桌面访问可自动填入脚本路径，跨设备需要填写运行外部 AI 的电脑上的路径。配置示例见 [README](../../README.md#连接桌面资料库)。

## 连接和权限

| 配置 | 含义 |
| --- | --- |
| `ZHIWU_URL` | 必填。用 AI 客户端所在设备实际能访问的 HTTP(S) 知悟地址。请求保留服务路径前缀，每个工具先检查 `api/health` 返回的状态与应用名。 |
| `ZHIWU_TOKEN` | 可选。适配器将值放进 HTTP Bearer 请求头，供已配置鉴权的部署使用。服务的访问控制由部署负责。 |
| `ZHIWU_IMPORT_DIR` | 启用原文件导入时填写。目录位于运行 MCP 进程的机器上，工具接收其中的相对路径。 |
| `ZHIWU_ALLOW_READ=1` | 注册搜索和读回工具。默认可查看分类、建分类、保存、追加及导入。 |
| `ZHIWU_ALLOW_EDIT=1` | 与读权限一起启用时注册更新已有笔记的工具。旧的只读配置可继续使用。 |

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
| `read_zhiwu_note` | 笔记回执及 `updatedAt`、`editableContent`、`tags`、`content`、`sourceContent`、`chatExcerpts`、`sourceFilename`、`attachmentUrl`。 | 按笔记 ID 读回。`editableContent` 是可编辑的正文。旧导入仅存原文时该字段为 null。 |
| `update_zhiwu_note` | 笔记回执及新的 `updatedAt`。 | 传入 `noteId`、读回的 `expectedUpdatedAt`，以及要更新的 `title` 或完整 `content`。保留原件和独立摘录。版本冲突后先重新读回。 |

## 边界和排障

- 地址错时先看适配器启动错误和目标的 `/api/health`。核对地址、服务路径及现有鉴权，再尝试收录。
- 旧库同级同名时，建路径返回冲突。列出分类后按确认的 `categoryId` 保存，或以 `parentId` 在选定分支下建子分类。[分类路由](../../server/src/routes/categories.ts)在事务内创建路径，[共享路径函数](../../server/src/shared/categoryPaths.ts)供前后端展示。
- 相同笔记和摘录 ID 重传相同正文时返回已有结果，正文冲突时返回错误。用户可从笔记详情撤销这条追加。普通创建与批量导入遇到结果不明时，先核对已有笔记或回执，再决定重试哪些记录。
- [文件选择器](../../server/mcpFiles.mjs)预检整批相对路径，解析实际路径并限制在已授权目录内，每次 1–30 份且单份小于 30 MiB。导入使用精简回执，图片先保存原件，OCR 在知悟中按需执行。批量导入可能同时含成功项和警告，按 `notes` 和 `warnings` 确认结果后再补失败项。
- 读回及搜索遵循可用笔记的范围。变更 [笔记 API](../../server/src/routes/notes.ts)时保留界面所用的常规返回结构，同时验证 MCP 的精简搜索和导入回执。

变更时跑 [stdio 到数据库的集成测试](../../server/test/notes.test.mjs)、[文件范围测试](../../server/test/mcp-files.test.mjs)和涉及的 [分类路径测试](../../server/test/category-paths.test.mjs)。用临时库手动验证一次回执链接落到实际笔记。
