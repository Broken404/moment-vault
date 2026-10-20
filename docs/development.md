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

## 自用开发安装

构建完成后，执行注册脚本，只写当前用户的 Edge Native Messaging 项：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-helper.ps1
```

在 Edge 扩展管理页打开开发人员模式，加载 dist/extension。正式开发扩展 ID 固定为 config/extension-identity.json 中的 ID，与试验版不同；仓库只保存公钥，不保存私钥。扩展首次打开设置，检测助手并使用系统目录选择器配置草稿箱和资产库。已有网页刷新后显示 P3-C。

注册脚本是开发安装工具，尚不等于已交付 Inno Setup 安装包。移除开发注册可执行同一脚本的 -Unregister；保留所有素材。

## 数据与接口

- 原生宿主只通过标准输入/输出长度前缀协议通信，没有本地 HTTP 服务；stdout 只输出协议消息。
- 扩展按 192 KiB 分块并等待确认；同一分块重复写入必须字节一致。完整校验后才出现正式草稿。
- 描述.md 顶部采用 YAML 1.2 允许的 JSON 流式映射，底部是用户自由备注。使用 System.Text.Json 读写并保留未知字段，避免维护第二套元数据解析依赖；保存检查原说明哈希。
- 管理接口通过条目 ID 定位，不接受网页提供的系统命令。目录设置和破坏性操作仅允许管理页调用。
- .moment-vault 是草稿目录中的管理区，包含未完成上传、回收区和转移记录，不作为素材显示；不应手动混入普通素材附件。
- 未完成事务、目标校验失败或源被外部修改时保留原数据并显示真实结果。永久删除只处理用户确认的资产库或回收区条目。

## Git 与发布

codex/v1-implementation 按职责提交，保留设计基线和试验历史。不把 SDK、node_modules、bin/obj、dist、浏览器配置、实际录像、凭据或本机目录配置提交。软件候选标签与发布必须等实际验收完成，当前不把开发构建称为首版交付完成。
