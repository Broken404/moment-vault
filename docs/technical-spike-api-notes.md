# 技术试验补充：会影响架构的 API 边界

核验日期：2026-10-19。范围：Windows 桌面 Edge、Manifest V3。本文只记录本轮官方资料核验，以及据此提出的实验设计；**不是 Edge 实测记录，不能据此将 B站、YouTube 或 X 标成已支持**。基础能力与既有范围见 [capture-feasibility.md](capture-feasibility.md)。

## 先决定实验怎么拆

1. 本地读写先在扩展自身的顶层页面验证，句柄保存在扩展 IndexedDB。不要把网站 origin 的存储作为素材库设置的归属。
2. 整条素材文件夹入库先验证“复制、校验、删除源”的实现；不要把目录 `move()` 当成已交付能力。
3. “打开系统文件夹”单列实验。FSA 读写成功不代表能打开 Explorer；原生辅助程序是候选技术路线，尚非产品安装要求。
4. 录制优先试验 `chrome.commands` → worker → offscreen → `MediaRecorder`。页面内方向键只负责调整选区，不把普通网页键盘事件等同于扩展授权入口。
5. 先证明完整标签页音视频录制，再证明只保留目标播放器区域；二者分别验收。无需先把复杂悬浮球 UI 做完。

以上是工程建议，下面给出依据和需要实测的分界。

## 本地目录：句柄、权限和最终文件是三件事

`showDirectoryPicker({mode: 'readwrite'})` 返回目录句柄；可枚举和创建子目录/文件，通过 `createWritable()` 写入。句柄可序列化到 IndexedDB，但重开页面/浏览器后应查询 `queryPermission({mode:'readwrite'})`；句柄存在不等于权限仍有效。写流关闭前不能把文件保存标为完成。[Chrome File System Access 指南](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)

FSA 规范对选目录和重新申请权限要求用户激活；跨源子框架不能直接取得新授权。扩展嵌入网站的 iframe 不能仅凭能访问扩展 IndexedDB，就推断其中的目录选择器或权限弹窗一定可用。因此最小试验在顶层 `chrome-extension://` 页面先完成目录选择与授权，再测试从悬浮入口转交保存操作；扩展上下文的实际表现仍须 Edge 验证。[FSA 规范：权限与上下文](https://wicg.github.io/file-system-access/)

扩展页面、worker 和 offscreen 可访问扩展 origin 的存储；内容脚本使用 Web Storage API 时属于宿主页面的存储上下文。存储隔离规则不能用来推导 FSA 授权规则。[Chrome 扩展存储说明](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)

最小验收需要分别记录：两个目录的读写授权、文件落盘后重新读取的校验值、扩展页重新打开后句柄恢复、浏览器重启后的权限状态，以及目录删除/权限失效时能否如实报错。只在工作区下新建隔离试验目录，不对用户真实草稿或资产执行破坏性实验。

## 素材文件夹入库：不要依赖目录原子移动

Chrome 指南明确：`FileSystemHandle.move()` 已支持 OPFS 内文件；用户可见文件系统之间的文件移动仍有功能标记限制，目录尚不支持该方法。`removeEntry(name, {recursive:true})` 可删除已获授权目录中的子树。[FSA 移动与删除限制](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#renaming_and_moving_files_and_folders)

因此，纯扩展的候选方案是：为本次入库生成唯一目标目录 → 复制媒体和描述 → 关闭每个写流 → 校验目标内容与源内容 → 再删除源素材目录。**这不是一个跨文件、跨目录的原子事务。** 同盘和跨盘都必须测试中断恢复；复制失败时保留源，目标完成但源清理失败时报告“已复制，待清理”，不能误报完整移动成功。该流程为工程设计，仍需实现验证。

验证时避免修改源文件：比较复制前后校验值，在源于复制期间发生变化时终止清理；不覆盖已有目标目录。批量选择的单位是一条素材目录，而不是分别选媒体和描述文件。

## 打开 Explorer：Downloads API 不能泛化为任意文件夹

`chrome.downloads.show(downloadId)` 展示已记录的下载文件所在目录；`showDefaultFolder()` 打开默认下载目录。`download()` 的 `filename` 是相对下载目录的路径，不能用任意绝对路径。这些接口不提供“传一个 FSA 目录句柄，打开 Explorer”的能力。[Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)

Edge 的 Native Messaging 可以调用已安装 Win32 host；host 不由 Edge 自动安装或管理，Windows 的 host manifest 需登记在注册表，并限制允许连接的扩展 origin。[Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)

据此推断：若产品坚持一键打开用户任意选择的两个本地目录，轻量原生 host 是应验证的路线。只允许打开已配置目录，不把网页消息变成任意命令执行。宿主命令、独立安装、权限说明和故障提示都需另外设计；本次资料核验不执行安装或注册。用 `file://` 页显示目录、复制路径或打开下载目录，均不能作为“Explorer 打开指定目录已通过”的证据。

## 录制授权入口与 MV3 会话归属

`activeTab` 的明确入口包含扩展 action、扩展菜单项、`chrome.commands` 快捷键和 omnibox 建议。普通网页 `keydown` 或内容脚本注入按钮的点击没有列为独立授权入口；将消息发给 worker 不应被当作自动获得授权。[activeTab 入口](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

Chromium 当前 `tab_capture_api.cc` 对 `getMediaStreamId` 检查该标签的 `kTabCaptureForTab` 授权。该源码属于 Chromium 主分支，**不是本机 Edge 版本的行为证明**；它进一步说明主机权限或页面点击不应被直接当成标签录制许可。[Chromium tabCapture 源码](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/tab_capture/tab_capture_api.cc)

试验应从清洁会话开始分别测试：首次使用命令快捷键、首次只点网页按钮、先调用 action 后再点网页按钮。不要因为 action 预先授过权，误判网页按钮自身足以授权。`commands.getAll()` 可检查快捷键是否成功注册；操作系统或其他扩展冲突可能导致未绑定。裸方向键不满足扩展命令要求，适合在选段编辑器获焦且开启时作为局部 DOM 按键处理。[Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)

官方 Chrome 路径为用户调用后，worker 获取 stream ID，再由 offscreen 使用 `getUserMedia()` 消费并录制；Chrome 116 起允许该组合。Edge API 表列出 `tabCapture`、`offscreen` 支持，但不证明每个组合在当前 Edge 上通过。[Chrome 录制指南](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)、[Edge API 表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)

实验应在用户按下开始快捷键后才创建捕捉流，不为预览常驻录制。音频流取得后需要验证用户仍可听到声音；标签捕捉会改变直接音频播放，官方示例通过 `AudioContext` 回送输出。offscreen 持有媒体流和 recorder；worker 只协调状态及消息。[Tab Capture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)

## A/B 时间区间与画面区域必须分别验证

设置源 `<video>.currentTime = A` 属于异步 seek；应等待实际定位完成，确认仍为同一个播放器/作品，再启动回放。到 B 的停止判断应依据源视频时间，不能只按墙钟等待 `B-A` 秒；缓冲、暂停和倍速会让两者不同。HTML 的 `timeupdate` 不是逐帧定时器，不能据此承诺精确到帧。[HTML 媒体规范](https://html.spec.whatwg.org/multipage/media.html)

`MediaRecorder.stop()` 后最终数据通过异步事件返回；应等最终 `dataavailable` 和 `stop`，再保存完整 Blob。分块 Blob 不保证各自独立可播放；不能丢掉初始化块后把末尾块当成完整片段。[W3C MediaStream Recording 工作草案](https://www.w3.org/TR/mediastream-recording/)

以下是三条不同媒体路径，不应混为一项“录制通过”：

| 路径 | 核验发现 | 最小实验含义 |
| --- | --- | --- |
| 源播放器 `captureStream()` | DOM 媒体捕捉草案要求保护跨源内容；不可访问的音视频可能静音/不再产帧。Canvas 也不得捕捉非 origin-clean 内容。[W3C DOM 媒体捕捉草案](https://w3c.github.io/mediacapture-fromelement/) | 可作为专项探测，不能因为读得到 `<video>` 和时间就认定能导出其源画面/声音。 |
| 标签页捕捉后矩形裁剪 | 工程候选：offscreen 把已授权标签流接入 `<video>`，按播放器矩形绘入 canvas，canvas 视频轨加标签音轨交 recorder。 | 实测 CSS 坐标与捕捉分辨率映射、页面缩放、滚动、窗口变化；播放器被遮挡或控制条出现时会进入成片。该方案未经本文实测。 |
| Region Capture / Element Capture | 官方两份指南当前都要求 self-capture；`cropTo`/`restrictTo` 方法存在不代表当前轨道可用。Region Capture 仍保留遮挡像素；Element Capture 另有目标元素资格要求。[Region Capture](https://developer.chrome.com/docs/web-platform/region-capture)、[Element Capture](https://developer.chrome.com/docs/web-platform/element-capture) | offscreen 扩展文档捕捉第三方标签的流，不能直接假定满足 self-capture。应实际调用并检查结果，不作为首轮唯一裁剪依赖。 |

选区开始与录制器开始之间、源 B 与最终编码停止之间有消息和编码延迟。自有带画面计时器的视频应记录实际首尾画面、文件时长与音画同步；先量出误差，再决定是否需要后处理。录制器成功产出文件不等于 A/B 区间已准确兑现。

## 三个平台只能逐站确认

此次官方资料只能确认浏览器 API 路径。B站、YouTube、X 的当前 DOM、广告切换、播放器替换、可回看区间和登录条件，都必须由真实页面测试来确认。推荐先以普通、可回看、非受保护内容，各完成一段自动 B 停止和一段快捷键提前停止；之后再加 Shorts、多 P、时间线多视频等覆盖。

每一条通过记录至少保留：Edge 完整版本、页面 URL/测试时间、登录状态、目标播放器、A/B、启动入口、采集路径、画面尺寸、文件编码、实际首尾和声音检查结果。页面不可达、无法登录或未安装试验扩展应标为“未验证/受阻”，不能推断成平台录制失败或已成功。
