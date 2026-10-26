# 自用安装与升级

实施日期：2026-10-26。沿用已批准方案中的 Inno Setup、.NET 自包含、当前 Windows 用户安装。安装包包含普通扩展、助手与配套媒体工具，用户不需要安装 SDK、Node.js 或 .NET。

本轮 6 组隔离生命周期、默认位置实际安装、原生连接、既有素材只读及 MP4 文件管线通过，用户已确认正式 Edge 重连。随后实际重启 Windows，系统启动记录及安装/配置指纹核对通过，仍可列出 23 条草稿、1 条资产并完整读回两份抽样图片；用户确认「已连接，目录和素材都正常」。本机自用安装与重启验收通过，无需再次加载或录制；不扩大为全素材历史字节、全新系统或其他环境验收。具体证据见 [安装验收记录](evidence/installation-upgrade-2026-10-26.json)。

## 安装与日常使用

运行 `dist/installer/MomentVault-0.1.0-win-x64.exe`。默认安装到 `%LOCALAPPDATA%\Programs\MomentVault`，不请求管理员权限，不建立服务或监听端口。助手仍由 Edge Native Messaging 按需启动。

新用户在 `edge://extensions/` 打开开发人员模式，加载安装目录中的 `extension` 文件夹，再检查 `edge://extensions/shortcuts` 中的录制快捷键。素材管理的设置里分别选择草稿箱和资产库。安装目录中的 `INSTALL.txt` 与开始菜单入口提供相同步骤。

本机已经加载的开发扩展使用相同身份，可继续使用原来的加载路径。安装助手不会移除扩展、移动素材或重选目录；重新连接后读取原有 `%LOCALAPPDATA%\MomentVault\config.json`。开发扩展以后仍从原加载目录更新，只有从安装目录加载的扩展才随安装包更新。两种来源要区分，当前不为了切换来源而移除扩展，避免清除浏览器偏好。

当前候选未签名，仅用于本人的私有安装。原始 MIT 许可、前端第三方声明、实际 .NET 运行包许可与原 FFmpeg 构建许可随包保留；版本和文件哈希记录在 `package-receipt.json`，安装包旁提供 SHA-256。不是商店提交或公开发行版本。

## 升级与卸载

等待保存完成、关闭 Edge 后运行新安装包。相同 AppId 复用原安装路径，助手宿主名称、扩展 ID 与协议 1 保持稳定；配置和用户选择的素材目录不属于安装负载。

安装器在覆盖前检查助手可执行文件是否被占用，占用时停止并提示先关闭 Edge；不强制关闭浏览器或正在保存的助手，不安排下次启动覆盖。该检查也用于卸载。开始检查后又出现新进程属于竞争情况，仍应先完成保存并关闭 Edge。

卸载只移除安装器跟踪的程序文件，清单单独生成并跟踪。不使用通配符递归清理，不删除配置或素材，也不删除用户放入安装目录的其他文件。两处 Native Messaging 注册仅在当前值仍指向本安装副本时移除，防止卸载旧副本误删后来改用的开发注册。浏览器扩展可由用户另行停用或移除。

## 备份

复制完整草稿箱（包含隐藏的 `.moment-vault`）及资产库，另备份 `%LOCALAPPDATA%\MomentVault\config.json`。在新位置恢复后重新选择两处目录。浏览器内的界面偏好与快捷键另属于 Edge，卸载助手不会重置它们，删除扩展可能清除其偏好。

## 构建与复核

在既有 Node/.NET 开发环境中安装 [Inno Setup 6.7.3](https://jrsoftware.org/isdl.php)。构建机本轮通过 [官方签名验证说明](https://jrsoftware.org/isdl-verify.php)检查安装器 Authenticode 为有效的 Pyrsys B.V.，编译器位于忽略目录 `.tools/inno`。其他机器用 `--compiler` 指定其位置。

```powershell
npm run build:installer -- --compiler .tools/inno/ISCC.exe --media-directory dist/host-library-load/media
npm run check:installer
```

构建重新生成普通扩展与 win-x64 自包含助手，核对项目版本、固定扩展身份、源工具来源、非 nonfree 构建和实际运行包许可。拒绝启用采集/性能实验开关；不打发布标签。媒体目录需含 `ffmpeg.exe`、`ffprobe.exe`、`LICENSE-FFmpeg.txt` 与 `README-FFmpeg.txt`。本轮沿用已验证的 Gyan 8.1.1 GPL v3 工具，仅打包本人私有安装，公开分发前另行准备完整对应源码及第三方材料，不将来源链接当成已完成发行义务。

`check:installer` 在 `.local-data` 建立中文带空格安装目录、独立 AppId 与 `com.momentvault.host.installcheck` 注册；同一安装脚本和完整负载生成 0.0.9/0.1.0 两个合成标签，检查安装、占用拒绝、覆盖升级、进程重启、备份重配、同版修复、卸载及数据保留。0.0.9 是测试前身，不是历史发行版本。真实现用注册和配置只读核对，不被该测试更改。失败时保留本地日志供定位。

实际安装到默认位置后，可只读复核：

```powershell
npm run check:registration -- --installed
```

这会核对两处注册和宿主清单，并使用隔离配置启动真实助手做带扩展 origin 的协议 ping；不写用户目录配置，也不等于已经验证 Edge 中的连接。隔离助手进程重启不等于 Windows 重启。本机实测范围为 Windows 11 25H2 x64，其他系统尚未实测。

实现依据：[Inno 当前用户安装](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)、[卸载文件边界](https://jrsoftware.org/ishelp/topic_uninstalldeletesection.htm)、[安装准备事件](https://jrsoftware.org/ishelp/topic_scriptevents.htm)、[.NET 10 支持系统](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md)。实际结果另见本轮实施记录和结构化证据，不用构建成功替代安装验收。
