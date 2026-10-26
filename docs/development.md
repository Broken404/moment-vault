# 开发与本地检查

正式代码从批准的 v1.0 方案开始，保留 spikes 作为独立实验与证据。当前已接通扩展、本地助手、图片/文件流程，并加入正式录制到 MP4 草稿的代码链路；实际采集验收单独记录，不能拿已有试验成片作为正式代码验收。

2026-10-23 开发构建可从桌宠的“屏幕录制”进入原轨道选段与独立预览，真正采集由扩展录制快捷键触发，到 B 自动停止并异步保存 MP4。选段和试播本身不保存。首轮状态条布局错误修正后，真实 YouTube 的自动停止、快捷键提前结束、关闭模式保存三条路径均取得实际 MP4，并完成文件检查；编码时长余量、旧停帧和完整支持矩阵仍待验收。见 [选段与预览](video-preview-implementation.md)、[录制联动](recording-integration.md)。

## 环境与构建

Node.js 22.22.2 或更高受支持版本、.NET 10 SDK、Windows x64。仓库使用锁文件固定依赖。

```powershell
npm ci
npm run check
npm run build:host
```

扩展输出 dist/extension；自包含助手输出 dist/host。开发者本地 .tools/dotnet/dotnet.exe 存在时构建脚本优先使用它；SDK 与依赖不提交。

```powershell
.tools/dotnet/dotnet.exe run --project native/MomentVault.Host.Tests -c Release
```

原生检查使用自行创建的临时目录和 PNG，覆盖真实分块、哈希、说明外部修改、完整转移、清理失败、重启重试、删除确认及长度前缀通信。此检查不是 Edge Native Messaging 的浏览器集成验收。

`npm run build` 还会执行生成脚本检查：在无 Node 全局变量的 DOM 环境运行实际 content.js，检查身份、启动、四宫格与接收入口。该检查不代替真实浏览器视觉、拖放或 Native Messaging。

```powershell
node tools/check-native.mjs --require-cross-volume
```

该命令启动真实助手进程，使用临时目录和仓库的 .local-data 检查协议、分块重试、实际文件读回及跨卷入库；只有两处确实位于不同卷时才通过上述参数要求。自包含助手存在时优先检查它，未发布助手时使用本地 SDK 运行已编译 DLL。

## 自用开发安装

2026-10-26 日常助手已改为 Inno Setup 安装到 `%LOCALAPPDATA%\Programs\MomentVault\host`，与源码目录分离；实际安装、注册与 origin 通信、保留原目录配置、只读现有素材及安装后 MP4 文件管线通过。核对当前安装版使用 `npm run check:registration -- --installed`。现有开发扩展仍加载 `dist/extension`，不移除扩展、不搬动素材；用户已确认重新加载后设置显示已连接，独立核对也见安装位置的助手由 cmd → Edge 父链启动，指纹和配置保持。此后实际 Windows 重启也通过系统启动记录、指纹、原目录素材读取及用户 Edge 连接/数据保留确认，无需再次加载或录制。完整步骤和边界见 [安装与升级](installation-and-upgrade.md)。下面保留此前开发副本的部署记录，已不代表当前注册位置。

2026-10-24 历史开发部署：大量素材首次加载修正版曾注册在 `dist/host-library-load`，当时用匹配的 `--host-directory dist/host-library-load` 核对。该轮通过 36 项原生、88 项前端、实际规模、跨盘入库及 MP4 文件管线检查，用户已确认正式扩展重新加载后列表和预览正常，当时的注册、origin 通信和助手指纹亦核对通过，目录配置和录制脚本指纹不变，见 [首次加载优化](large-library-startup.md)。`dist/host-library-load`、`dist/host-material-read` 和 `dist/host-upload-recovery` 现保留为历史开发副本，不将其指纹视为安装版当前运行指纹，也不因保留副本而重新注册。

`tools/measure-material-library.mjs --check-first-list` 使用 500 条新建自制素材和 2 秒本机诊断门槛；1,500 条专项显式传 `--items=1500 --max-first-list-ms=3000`。完整规模测量与 `tools/check-native.mjs` 均通过 `MOMENT_VAULT_TEST_HOST` 显式选择本次候选助手，避免误测旧的默认 `dist/host`。计时属于原生文件/协议路径，不是浏览器绘制时间或通用性能承诺。

构建完成后，执行注册脚本，只写当前用户的 Edge Native Messaging 项：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-helper.ps1
npm run check:registration
```

注册脚本同时写入当前用户的 Edge 注册位置与微软文档支持的 Chrome 兼容查找位置，指向同一份清单，仍仅允许本扩展的固定 ID。2026-10-21 在本机 Edge 155.0.4283.62 上实测：仅有 Edge 项时返回 `Specified native messaging host not found.`；补上兼容项后同一扩展可启动助手。删除兼容项并重新建立连接可重现原错误，恢复后再次接通。没有将这一现象推断为所有 Edge 版本的规则。

`check:registration` 检查两个实际注册项、REG_SZ 类型、清单与扩展身份，并从注册清单定位真实助手，以扩展 origin 和长度前缀协议执行隔离 ping。它不改动用户的目录配置；缺少兼容项时已确认返回失败。此检查仍不能替代真实浏览器联动。

在 Edge 扩展管理页打开开发人员模式，加载 dist/extension。正式开发扩展 ID 固定为 config/extension-identity.json 中的 ID，与试验版不同；仓库只保存公钥，不保存私钥。扩展首次打开设置，检测助手并使用系统目录选择器配置草稿箱和资产库。已有网页刷新后显示 P3-C。

注册脚本是开发安装工具。独立的 Inno Setup 自用安装包、构建及验收边界见 [安装与升级](installation-and-upgrade.md)。移除开发注册可执行同一脚本的 -Unregister，同时移除本助手的两处注册；保留所有素材。已改用安装版时不运行此开发卸载命令，而使用 Windows 的应用卸载入口。

### 目录选择窗口

目录选择由扩展管理页直接调用 `runtime.sendNativeMessage`，每次启动一个短时助手。浏览器会向助手传入当前浏览器窗口的 `--parent-window`；服务工作线程发起的请求则为 0，不能用于关联目录弹窗。助手使用浏览器提供的有效句柄作为 `FolderBrowserDialog.ShowDialog` 的 owner，不接受请求正文指定任意窗口，不设置全局置顶或抢占其他应用焦点。其他文件操作继续通过后台连接。

2026-10-21 用户确认第二次目录窗口实际出现在浏览器后面，并已完成两处配置。旧助手的启动参数确认为 `--parent-window=0`。修复加入直接管理页调用、父窗口传递和无效窗口的可恢复错误。更新开发构建后，在扩展管理页点本扩展的“重新加载”，然后刷新管理页；已保存的目录保持不变。需要在真实 Edge 中连续打开和取消两次目录选择，确认更新后的窗口层级；自动检查不代替这项人工确认。

依据：[Edge Native Messaging 窗口参数](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)、[CommonDialog.ShowDialog owner](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.commondialog.showdialog?view=windowsdesktop-10.0)。

## 数据与接口

草稿合并使用固定操作 ID、当前草稿目录和按显示顺序排列的条目 ID/说明版本；目标完整后才清理来源，重试保留同一 ID。实现及实际文件检查方式见 [草稿合并](material-merge.md)。

列表缩略图由 `items.thumbnail` 异步生成，当前助手需带配套 FFmpeg；普通网页不能调用该接口。缓存、生成限制及检查方式见 [素材缩略图](material-thumbnails.md)。

未完成文件保存通过 `uploads.list/get/discard` 从原草稿目录发现，完整附件直接继续保存，缺失附件重选原文件并比对已收到的前缀。实现和生产上传代码连接真实助手的复核命令见 [上传恢复](upload-recovery.md)。

- 原生宿主只通过标准输入/输出长度前缀协议通信，没有本地 HTTP 服务；stdout 只输出协议消息。
- 扩展按 192 KiB 分块并等待确认；同一分块重复写入必须字节一致。完整校验后才出现正式草稿。
- 描述.md 顶部采用 YAML 1.2 允许的 JSON 流式映射，底部是用户自由备注。使用 System.Text.Json 读写并保留未知字段，避免维护第二套元数据解析依赖；保存检查原说明哈希。
- 管理接口通过条目 ID 定位，不接受网页提供的系统命令。目录设置和破坏性操作仅允许管理页调用。
- .moment-vault 是草稿目录中的管理区，包含未完成上传、回收区和转移记录，不作为素材显示；不应手动混入普通素材附件。
- 未完成事务、目标校验失败或源被外部修改时保留原数据并显示真实结果。永久删除只处理用户确认的资产库或回收区条目。

### 录制本地处理检查

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-recording-media.ps1
```

开发环境需 .NET 10 和已安装的 FFmpeg。脚本只在 `.local-data` 生成自制运动片、音频尾段反例与独立草稿/资产库，执行真实编解码、分块协议、失败保留、重启重试和导入保留原格式检查。实际 Edge 保留样本也已单独跑过同组检查；脚本生成的反例不代表浏览器复现。原生普通文件/协议检查当前为 30 项。

产品助手从自身目录的 `media/ffmpeg.exe`、`media/ffprobe.exe` 取工具；未随包时报告缺失，不自动使用系统 PATH。录制协议及剩余范围见 [本地处理](recording-processing.md)。

### 正式录制开发部署与文件管线检查

浏览器占用原助手文件时可以构建到新的仓库内开发目录；注册后重新加载正式扩展，已有用户目录配置保持原位置。不要直接结束浏览器正在使用的助手进程。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-host.ps1 -OutputDirectory dist/host-recording
powershell -NoProfile -ExecutionPolicy Bypass -File tools/stage-media-tools.ps1 -SourceDirectory '<已安装的 FFmpeg 分发目录>' -HostDirectory dist/host-recording
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-helper.ps1 -HostDirectory dist/host-recording
npm run check:registration -- --host-directory dist/host-recording
```

`stage-media-tools.ps1` 需要源目录内的 `bin/ffmpeg.exe`、`bin/ffprobe.exe`、`LICENSE` 和 `README.txt`，保留原许可证、README 及工具版本/哈希。这只是显式选择现有安装用于本机开发，不会下载组件或完成最终分发包。脚本默认目标仍为 `dist/host`；使用其他目录注册后，注册检查必须带匹配的 `--host-directory` 参数。

```powershell
$env:MOMENT_VAULT_TEST_HOST = (Resolve-Path 'dist/host-recording/MomentVault.Host.exe').Path
$env:MOMENT_VAULT_TEST_FFMPEG = (Resolve-Path 'dist/host-recording/media/ffmpeg.exe').Path
$env:MOMENT_VAULT_TEST_FFPROBE = (Resolve-Path 'dist/host-recording/media/ffprobe.exe').Path
node tools/check-recording-pipeline.mjs
```

该检查编译并执行生产 TypeScript 上传代码，通过真实长度前缀协议连接助手，生成自制 WebM，模拟服务端接受分片后确认丢失，重放后检查仅有一条 MP4、实际解码及编解码信息。配置、媒体与结果都位于独立 `.local-data` 目录，不使用用户素材目录；不验证浏览器标签页采集。

首次加载录制构建需接受 Edge 显示的扩展权限变化。关闭试验扩展以免争用快捷键，并在 `edge://extensions/shortcuts` 检查正式扩展的实际绑定；仅关闭试验版不保证绑定自动转移。内部扩展页需人工操作。开发构建新增 `tabCapture`、`offscreen`，采集只由实际命令开始，没有开放普通网页启动采集的接口。

## Git 与发布

codex/v1-implementation 按职责提交，保留设计基线和试验历史。不把 SDK、node_modules、bin/obj、dist、浏览器配置、实际录像、凭据或本机目录配置提交。软件候选标签与发布必须等实际验收完成，当前不把开发构建称为首版交付完成。
