# 知悟维护指南

接手时先看 `git status --short`，保留已有改动。按任务查下面的入口，再读对应实现和已有回归用例。在临时库验证写入、删除和恢复。

## 从哪里查

| 任务 | 实现入口 | 维护说明 |
| --- | --- | --- |
| 笔记、分类、回收站、学习进度 | [桌面 API](server/src/routes)、[安卓离线实现](client/src/api/localEngine.ts)、[共享规则](server/src/shared) | [数据与恢复](docs/maintenance/data.md) |
| 原件预览、摘录撤销 | [笔记页面](client/src/pages/NotesPage.tsx)、[原件预览](client/src/components/NoteSource.tsx)、[笔记内容模型](server/src/shared/noteContent.ts) | [数据与恢复](docs/maintenance/data.md) |
| 完整备份、换设备恢复 | [桌面归档](server/src/services/backupArchive.ts)、[安卓归档](client/src/api/backupArchive.ts)、[合并规则](server/src/shared/libraryBackup.ts) | [数据与恢复](docs/maintenance/data.md) |
| 外部 AI、原文件导入 | [MCP 适配器](server/mcp.mjs)、[本机文件选择](server/mcpFiles.mjs) | [MCP 维护](docs/maintenance/mcp.md) |
| 构建、回归、安卓发布 | [桌面测试](server/test)、[前端与离线测试](client/test)、[APK 与 OTA 流水线](.github/workflows/build-apk.yml) | [验证与发布](docs/maintenance/verification.md) |

## 改动时保留的行为

- [API 选择层](client/src/api/client.ts)在知悟服务和安卓离线实现之间切换。调整数据行为时检查两端的正常入口、旧数据和失败后重试，再决定共享规则放在哪里。
- 笔记移入回收站后，实时统计、搜索、图谱和聊天引用按可用笔记计算。参考数量和展开列表使用同一组 ID。保留学习记录及可恢复的关联，永久删除时清理真正失效的引用。
- 保留笔记正文、原件、提取文本和单条聊天摘录各自的用途。撤销追加时按摘录 ID 移除，保留正文和其他摘录。
- 完整备份应带走可用原件、回收站状态和学习进度。修改存储字段或合并规则时，用旧备份校验两端恢复及重试行为。
- MCP 按 `ZHIWU_URL` 使用现有知悟服务。原文件读取遵守 `ZHIWU_IMPORT_DIR` 的范围，搜索和读回由 `ZHIWU_ALLOW_READ` 控制。

## 交付前

按[验证矩阵](docs/maintenance/verification.md#按变更选验证)跑相关检查。变更行为时同步更新受影响的文档，并用回归用例覆盖变化的条件。交付说明记录实际跑过的命令及结果，区分浏览器、安卓离线逻辑和真机验证。涉及发布时，按用户当前的发布要求核对目标分支和产物。
