# 验证与发布

## 本地构建

命令从仓库根目录运行。使用支持 `node:sqlite` 的 Node.js。安卓流水线的 Node、Java 和 SDK 版本见 [build-apk.yml](../../.github/workflows/build-apk.yml)。

新工作副本按锁文件安装依赖。

```powershell
node --version
node -e "require('node:sqlite')"
npm ci
npm --prefix client ci
npm --prefix server ci
```

开发时用 `npm run dev`。验证桌面生产构建用以下命令，启动后按日志中的地址访问前端与 API。

```powershell
npm run build
npm start
```

[启动脚本](../../启动知悟.bat)有已构建的前端时会直接启动服务。拉取代码后按本次更新重新安装依赖并构建。

## 按变更选验证

服务端测试从 `server/dist` 加载编译产物，变更后先构建。完整回归可在另一终端直接执行，不需要预先启动应用。

```powershell
npm run build
node --test --test-concurrency=1 server/test/*.test.mjs
node --test client/test/*.test.mjs
```

| 改动 | 相关用例 | 手动检查 |
| --- | --- | --- |
| 笔记、导入、撤销或回收站 | [桌面笔记](../../server/test/notes.test.mjs)、[离线库](../../client/test/library.test.mjs) | 桌面和安卓离线各验证一遍。打开原件，撤销一条摘录，移入回收站再恢复。查看引用数量、展开列表和首页统计。 |
| 对话模式 | [新建、切换和续聊](../../client/test/browser/tutor_modes.py) | 桌面和手机的「新建对话」均默认普通模式。输入知识问题再追问，检查模型收到聊天上下文，笔记库中的独有文字未发出。原会话改为深度答疑或费曼后，核对参考资料、消息和刷新后的模式。 |
| 对话修改笔记 | [提案与目标原文](../../server/test/tutor-note-edit.test.mjs)、[应用修改与重试](../../client/test/browser/tutor_note_edit.py) | 确认操作前核对原文，应用后重新打开。覆盖版本冲突、同名笔记、过期来源、旧摘录保留和重试去重。 |
| MCP 配置入口 | [桌面和独立版配置](../../client/test/browser/mcp_settings.py)、[stdio 集成](../../server/test/notes.test.mjs) | 在「设置 → MCP 配置」分别选择读与编辑权限，复制到外部客户端。用临时库核对读取、改名或改正文，并验证版本过期时的行为。 |
| 手机远程 MCP | [工具与存储](../../client/test/phone-mcp.test.mjs)、[原生桥](../../client/test/mobile-mcp-bridge.test.mjs)、[APK 与 HTTPS 转发](../../client/test/browser/phone_mcp.py) | 用临时手机库从外部 MCP 客户端读写，核对切换应用后的访问、同一笔记经两个地址读回、权限变更与关闭后的旧令牌。 |
| 手机助教顶部间距 | [浏览器安全区](../../client/test/browser/reader_tutor.py)、[APK 屏幕实测](../../client/test/browser/phone_mcp.py) | 从系统状态栏下沿量到「普通对话／历史对话／新建对话」工具栏的上沿。两者间只有工具栏边框。普通浏览器还应留足系统安全区。 |
| 助教检索、原文引用 | [检索和续查](../../server/test/active-tutor.test.mjs)、[来源范围](../../server/test/tutor-context.test.mjs)、[两端交互](../../client/test/browser/tutor_retrieval.py) | 用中文问没有目录的长笔记和英文 PDF。核对实际原文、引用页或段落，以及返回对话后的位置。 |
| 历史对话 | [两端共用的旧会话样例](../../server/test/fixtures/tutor-history.mjs)、[离线写入和重试](../../client/test/tutor-history.test.mjs)、[桌面与安卓界面](../../client/test/browser/tutor_history.py) | 准备超过 30 个旧会话，按标题、用户问题和助教回答查找。核对分页、续聊、改名及取消或确认删除。手机点「历史对话」时检查消息区的尺寸。 |
| 学习进度、图谱或自动出题 | [桌面笔记](../../server/test/notes.test.mjs)、[离线库](../../client/test/library.test.mjs) | 同时准备已评估和待测知识点。验证只有可用来源参与实时统计，已有复习排期和测验结果仍可见。 |
| 备份格式、保存或扫码传输 | [桌面备份](../../server/test/backup.test.mjs)、[离线归档](../../client/test/backup.test.mjs)、[安卓保存](../../client/test/backup-save.test.mjs)、[备份设置入口](../../client/test/browser/backup_settings.py)、[接收备份](../../server/test/backup-transfer.test.mjs) | 从设置分别导出和恢复，检查原文件字节、学习进度及重复恢复。安卓用系统选择器实际保存并测试取消。旧 APK 检查导出按钮，以及同一个快传入口接收文件、同步笔记和发送备份。 |
| MCP 或分类 | [MCP 集成](../../server/test/notes.test.mjs)、[文件范围](../../server/test/mcp-files.test.mjs)、[分类路径](../../server/test/category-paths.test.mjs) | 用 stdio 客户端验证默认工具、读权限、重名分支、可打开的回执和撤销入口。 |

服务端集成测试使用临时数据库及回环端口。受限环境中若端口或文件链接权限导致测试失败或跳过，记录具体原因，并在允许这些能力的本机测试环境重跑相关用例。浏览器窄视口用于验证移动布局，原生选择器、WebView 存储和 OTA 安装在涉及这些行为时用安卓设备或模拟器验证。

[PDF 与手机对话浏览器回归](../../client/test/browser/reader_tutor.py)使用 Python Playwright 和 Chromium。用以下命令启动临时离线前端，在另一个终端从仓库根目录运行 `python client/test/browser/reader_tutor.py`。测试在独立浏览器上下文生成 81 页 PDF，检查放大翻页的位置、末页文字是否发给模型、手机消息区及输入框布局。模型请求由测试在本地拦截。自定义服务地址或 Chromium 路径分别使用 `ZHIWU_TEST_ORIGIN`、`CHROMIUM_PATH`。

```powershell
$env:VITE_STANDALONE='true'
npm --prefix client run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

同一个临时离线前端还可验证纯图像 PDF 的指定页视觉请求，以及重复段落、摘录、资料变更和回收站中的旧引用。测试视觉接口会检查实际渲染的页图。

```powershell
python client/test/browser/reader_tutor.py -v
python client/test/browser/citation_reader.py -v
```

验证手机 MCP 和系统状态栏间距时，在专用安卓设备或模拟器安装调试 APK，打开知悟并允许显示通知。测试机需要 Python Playwright、Pillow、OpenSSL 和 ADB。指定 `ANDROID_SERIAL` 和可选的 `ADB`、`OPENSSL` 路径，运行以下命令。

APK 用例用标准 Node MCP 客户端读写临时笔记，验证通过 HTTPS 转发编辑、切回知悟读回，以及重启后授权恢复。模拟器通过网络端口转发连接网卡，使用真机时可在 `ZHIWU_MCP_NETWORK_URL` 填入测试机可直连的手机网址。覆盖升级时，可先在旧版本导入一篇含唯一标记的笔记，将标记填入 `ZHIWU_MCP_UPGRADE_NOTE` 验证原文。界面用例打开已滚动的长对话，以屏幕物理像素核对状态栏和聊天工具栏的位置。设置 `ZHIWU_CHAT_SCREENSHOT` 可保存浅色主题的原始屏幕截图。

```powershell
node --test client/test/phone-mcp.test.mjs client/test/mobile-mcp-bridge.test.mjs
python client/test/browser/phone_mcp.py -v
```

端到端检索验收自建临时 SQLite、离线库、回环服务和可复现的模型接口，需要先执行 `npm run build` 并安装 Python Playwright 和 Chromium。每次生成新的随机答案，用中文提问后断言搜索、读回原文、点击引用、返回对话和保存后的链接。桌面和 IndexedDB 用例默认运行。

```powershell
python client/test/browser/tutor_retrieval.py -v
```

历史对话的交互验收复用临时 SQLite、IndexedDB 与本地测试模型。执行 `python client/test/browser/tutor_history.py -v`，以桌面生产构建和临时构建的离线版验证搜索、分页及管理操作。安卓 APK 用例也支持下述 WebView 调试地址。覆盖安装验收使用预先装入 67 个样例会话的专用测试设备，设置 `ZHIWU_HISTORY_UPGRADE=1`，测试会先核对升级前的逐条消息；普通 APK 验收从空库开始。

使用同样的测试环境执行 `python client/test/browser/tutor_modes.py -v`，核对新建弹窗、普通回答的模型请求和已建对话的模式设置。已安装 APK 可通过下述 `ZHIWU_APK_CDP` 地址运行设备用例。验证覆盖安装时，先在旧调试版装入该用例的答疑和费曼样例，再覆盖安装新包，设置 `ZHIWU_MODES_UPGRADE=1` 以核对旧会话及消息后续聊。

运行同一脚本验证 Android 时，使用空库调试设备，设置 `ANDROID_SERIAL` 及可选的 `ADB` 路径。将设备 Chrome 或已安装调试 APK 的 WebView 调试套接字通过 `adb forward` 映射到本机，在 `ZHIWU_ANDROID_CDP` 和 `ZHIWU_APK_CDP` 填入各自的 HTTP 调试地址。脚本通过 `adb reverse` 临时连接测试模型，APK 用例从应用设置和导入界面进入，运行后清理临时端口。没有设置对应地址时该设备用例会跳过。

提交前看 `git status --short` 和 `git diff --check`，确认文件与任务一致。前端构建可能改写 `client/tsconfig.tsbuildinfo`，检查它是否仅为本次构建生成。

## 发布和核对

1. 记录待发布的完整提交号，完成相关回归。桌面从该提交重新安装所需依赖并构建，检查首页、笔记及健康接口能打开。
2. 安卓沿用 [现有流水线](../../.github/workflows/build-apk.yml)。现有配置在推送时构建按提交区分的 OTA 包，主线或手动发布还会构建 APK。其他分支的推送也会触发构建与上传，只有 `ota-index` 分支被排除。
3. 判断本次改动的原生要求。纯 Web 改动可随对应的 OTA 包交付。变更 Java、Capacitor 插件或原生权限时检查 APK 的兼容范围，并用目标原生版本跑涉及的流程。对照 [MainActivity 的 NATIVE_VERSION](../../client/android/app/src/main/java/com/zhiwu/learning/MainActivity.java)、[工作流生成的 nativeVersion](../../.github/workflows/build-apk.yml)和 [前端门槛判断](../../client/src/utils/ota.ts)。APK 报告的是设备能力版本，包里的 `nativeVersion` 是安装最低要求。
4. 发布后核对 Actions 的运行提交、实际更新索引中 `branches[].headSha` 与 `bundlesBySha[短提交号]`、按提交命名的 `web-bundle-<短提交号>.zip` 和 APK 下载。索引地址以 [ota.ts](../../client/src/utils/ota.ts)为准。确认版本和完整 SHA 对应同一构建，再报告更新可用。
5. 真机上从已安装版本检查更新、打开关键页面并验证学习库可读。有 OTA 时可从设置选择「恢复内置」测试切回当前 APK 自带的 Web 版本。数据恢复按[完整备份流程](data.md#恢复验证)单独验证。

覆盖安装 APK 前用 `apksigner verify --print-certs` 比较新旧签名。只有签名兼容的安装包才能保留原安装直接升级。更换签名时应先导出完整备份并在其他设备或临时库验证恢复。

当前网页更新包兼容原生版本 2 及以上，使用手机 MCP 服务需要原生版本 4。旧安装通过 OTA 可以获得聊天布局等网页改动，进入「MCP 配置」可下载含原生服务的新 APK。
