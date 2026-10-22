# 开发与本地检查

正式代码从批准的 v1.0 方案开始，保留 spikes 作为独立实验与证据。当前版本先接通扩展、本地助手与图片/文件流程；视频录制未启用，不能拿已有试验成片作为正式代码验收。

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

构建完成后，执行注册脚本，只写当前用户的 Edge Native Messaging 项：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-helper.ps1
npm run check:registration
```

注册脚本同时写入当前用户的 Edge 注册位置与微软文档支持的 Chrome 兼容查找位置，指向同一份清单，仍仅允许本扩展的固定 ID。2026-10-21 在本机 Edge 155.0.4283.62 上实测：仅有 Edge 项时返回 `Specified native messaging host not found.`；补上兼容项后同一扩展可启动助手。删除兼容项并重新建立连接可重现原错误，恢复后再次接通。没有将这一现象推断为所有 Edge 版本的规则。

`check:registration` 检查两个实际注册项、REG_SZ 类型、清单与扩展身份，并从注册清单定位真实助手，以扩展 origin 和长度前缀协议执行隔离 ping。它不改动用户的目录配置；缺少兼容项时已确认返回失败。此检查仍不能替代真实浏览器联动。

在 Edge 扩展管理页打开开发人员模式，加载 dist/extension。正式开发扩展 ID 固定为 config/extension-identity.json 中的 ID，与试验版不同；仓库只保存公钥，不保存私钥。扩展首次打开设置，检测助手并使用系统目录选择器配置草稿箱和资产库。已有网页刷新后显示 P3-C。

注册脚本是开发安装工具，尚不等于已交付 Inno Setup 安装包。移除开发注册可执行同一脚本的 -Unregister，同时移除本助手的两处注册；保留所有素材。

### 目录选择窗口

目录选择由扩展管理页直接调用 `runtime.sendNativeMessage`，每次启动一个短时助手。浏览器会向助手传入当前浏览器窗口的 `--parent-window`；服务工作线程发起的请求则为 0，不能用于关联目录弹窗。助手使用浏览器提供的有效句柄作为 `FolderBrowserDialog.ShowDialog` 的 owner，不接受请求正文指定任意窗口，不设置全局置顶或抢占其他应用焦点。其他文件操作继续通过后台连接。

2026-10-21 用户确认第二次目录窗口实际出现在浏览器后面，并已完成两处配置。旧助手的启动参数确认为 `--parent-window=0`。修复加入直接管理页调用、父窗口传递和无效窗口的可恢复错误。更新开发构建后，在扩展管理页点本扩展的“重新加载”，然后刷新管理页；已保存的目录保持不变。需要在真实 Edge 中连续打开和取消两次目录选择，确认更新后的窗口层级；自动检查不代替这项人工确认。

依据：[Edge Native Messaging 窗口参数](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)、[CommonDialog.ShowDialog owner](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.commondialog.showdialog?view=windowsdesktop-10.0)。

## 数据与接口

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

开发环境需 .NET 10 和已安装的 FFmpeg。脚本只在 `.local-data` 生成自制运动片、音频尾段反例与独立草稿/资产库，执行真实编解码、分块协议、失败保留、重启重试和导入保留原格式检查。实际 Edge 保留样本也已单独跑过同组检查；脚本生成的反例不代表浏览器复现。原生普通文件/协议检查当前为 15 项。

产品助手从自身目录的 `media/ffmpeg.exe`、`media/ffprobe.exe` 取工具；未随包时报告缺失，不自动使用系统 PATH。本轮没有部署新助手或开放浏览器录制入口。录制协议、验收结果和剩余范围见 [本地处理](recording-processing.md)。

## Git 与发布

codex/v1-implementation 按职责提交，保留设计基线和试验历史。不把 SDK、node_modules、bin/obj、dist、浏览器配置、实际录像、凭据或本机目录配置提交。软件候选标签与发布必须等实际验收完成，当前不把开发构建称为首版交付完成。
