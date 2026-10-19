# Edge 本地文件与视频选区技术验证

这是独立的技术试验，不是正式扩展发布版。只使用仓库下 `.spike-data/` 的测试素材；视频必须由用户明确触发开始，选区预览不录制。

## 启动

Windows、Python 3.13、已安装的 Edge 和 FFmpeg：

```powershell
py -3.13 spikes/edge-local-capture/run_spike.py
```

服务只监听 `127.0.0.1:43817`。在用于测试的 Edge 配置中手动加载 `extension/` 为解压缩扩展，然后打开：

```text
http://127.0.0.1:43817/dashboard.html
```

可选的 `--launch` 会使用 `.spike-data/edge-profile` 单独启动 Edge，避免改动已有配置；那个配置不会自动拥有当前已连接的浏览器控制插件。不要把两个浏览器配置中的扩展安装状态混为一谈。

## 两条保存路线分别验证

- **浏览器 File System Access**：在普通本地测试页分别选择两个测试目录，写入、读回和整夹入库。句柄只属于本地网页来源，不能冒充扩展自身来源的权限或持久化结果。
- **本地辅助**：测试服务只接受绑定的 `draft` 和 `library`，提供写入、读回校验、整夹入库及 Explorer 打开请求。录制前需明确点击“启用辅助保存到测试目录”；不能静默更换保存路线。

辅助是本轮临时 loopback 验证服务，未注册 Native Messaging host 或系统服务。正式产品若采用原生辅助，需要另行设计安装、目录选择与可信通信。

## 视频试验

1. 点击“检查扩展连接和快捷键”，确认录制快捷键不为空。默认组合可能和已有功能冲突，应在 Edge 扩展快捷键设置中选择空闲组合。
2. 先在自制视频页测试，再测试 B站、YouTube、X 中可定位的普通视频。
3. 点击“进入选段”，设置 A/B；移动边界仅定位预览，不开始录制。
4. 使用真实的扩展快捷键开始，到 B 自动结束；同一快捷键可以提前结束。网页自动化发送的模拟键盘事件不能据此认定浏览器已经调用扩展命令。
5. 在测试草稿箱检查实际 WebM、描述、音视频轨和时长。文件必须解码成功，不能只凭界面“已保存”判定通过。

首次只点击页面内按钮可能因缺少当前标签的扩展调用授权被拒绝，这个实验入口专门用于记录该限制。

## 文件系统回归检查

```powershell
py -3.13 spikes/edge-local-capture/tests/test_scratch.py
node --test spikes/edge-local-capture/tests/offscreen.test.cjs
```

覆盖真实文件读回与校验、媒体和描述完整移动、跨磁盘复制、重名保护、复制损坏、源清理失败和无效路径。测试仅清理其自行创建且已检查位置的临时目录。

录制器回归检查使用仅含 `chrome.runtime` 的模拟 offscreen 环境，重放实际消息处理、停止、保存和资源释放流程。它能捕获错误调用 `chrome.storage` 及漏停 Canvas 视频轨的问题；不能代替真实浏览器音视频验收。

实际生成文件后再执行媒体验收：

```powershell
py -3.13 spikes/edge-local-capture/inspect_recordings.py
```

输出包含解码结果、视频与音轨、时长、实际与选定范围、采样画面变化和声音能量。没有实际录像时会失败退出，不把空集合判为通过。

## 输出与约束

- `.spike-data/browser-events.jsonl`：网页按钮产生的实际操作结果。
- `.spike-data/draft/`、`.spike-data/library/`：实际测试素材。
- `extension/runtime-config.js`：每次启动生成的本地会话配置，不提交。
- 浏览器配置、会话凭据、实际平台视频片段和临时输出均不提交 Git。
- 只允许既定本地来源与扩展来源，POST 需会话令牌；没有任意文件路径或任意系统命令接口。
- Canvas 裁剪的是标签页画面，网站自身的字幕、控制条和遮挡可能进入片段；不能承诺无损、逐帧剪辑或 DRM 内容支持。

实测结论与覆盖范围记录在仓库 `docs/technical-spike-results.md`；未实际完成的项目必须保持未验证状态。
