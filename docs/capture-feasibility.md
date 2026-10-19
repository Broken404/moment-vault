# Edge 捕捉能力：v0.1 技术可行性笔记

核验日期：2026-10-19。范围：Windows 桌面 Edge、Manifest V3、本地资产草稿库。本文是官方文档核验与实现建议，**没有实现插件，也没有执行 Edge 实机捕捉测试**。下文的验收项均为待完成状态。

需求更新：用户已明确视频需要起终点可拖动、键盘调整、动态预览和整段预览的预录制选段模式，见 [视频选段交互草案](video-range-selection.md)。本文的“点击后短录屏”是底层采集技术试验，不能替代最终选段交互；区间回放、动态定位和所得片段范围一致性需要另行验收。

图片入口更新：用户已确认重点是图片收集入口，优先复用现有截图工具；入口形式和保存交互继续细化，见 [图片收集入口草案](image-intake.md)。内置网页截图/裁剪在下表保留为可行能力参考，暂不作为当前首版的前置功能。

最新产品原则：网页内悬浮球与快捷键作为入口；选好 A/B 后由用户按快捷键从 A 主动开始录制，到 B 自动结束，也可再次按快捷键提前结束，随后直接把实际视频文件保存到草稿箱，审核后进入资产库。不规划持续后台缓冲录制，选段与试播均不启动录制。此项更新此前开始和结束都必须手动的约定。

本地保存更新：用户已确定在设置中分别选择草稿箱和资产库的本地目录。下文的 IndexedDB 内容作为浏览器内部存储能力说明保留，不再代表媒体最终只存内部数据库。指定目录的授权、文件写入及重启后的访问另行验证，见 [设置草案](settings.md)。

## 结论

按当前建议，第一轮技术试验闭环三种输入：外部图片导入、普通 HTML 视频的时间戳、用户主动启动的短录屏。视频需验证快捷键从 A 启动、到 B 自动结束及快捷键提前结束，统一保存到本地草稿箱，并保留个人注释与可靠来源；视频草稿必须包含实际视频文件，外部图片来源可留空或由用户确认。先验证保存与查看链路，再增加 AI 整理，不规划持续后台缓冲。

资产内容方向不限。未来 AI 只能给出可撤销的标签、摘要、分类或取舍建议；“进入正式资产库”必须由人工确认，不能由模型评分自动晋级。

Microsoft 的官方兼容表明确列出桌面 Edge 支持 `tabs`、`scripting`、`downloads`、`tabCapture`，并支持 MV3 的 `offscreen`。这支持选择 Edge 作为起点；该表未给出各方法和组合行为的最低 Edge 版本，不能把 Chrome 示例当作 Edge 实测结果。[Edge API 支持表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)

## 文档已确认的能力与边界

| 能力 | 官方依据 | 对产品的含义 |
| --- | --- | --- |
| 可见区域截图（可选） | `tabs.captureVisibleTab()` 返回当前活动标签页可见区域；要求 `activeTab` 或 `<all_urls>`。Chrome 文档限制每秒最多两次调用。[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab) | 如后续启用内置截图，优先用户主动触发的 `activeTab`。这是网页视口截图，不是整页长截图、桌面截图或视频录制。 |
| 截图框选（可选） | Canvas 的 `drawImage()` 支持从图像中取源矩形。[MDN drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage) | 如后续启用，建议先捕捉一张静态截图，再在预览中框选裁剪，避免框选遮罩进入截图。按实际位图尺寸映射预览坐标；缩放和高 DPI 需实测。 |
| 视频时间戳 | `HTMLMediaElement.currentTime` 是播放位置秒数；设置它会尝试跳转，但直播的过期片段可能无法回看，读数也不等于逐帧精确定位。[MDN currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime) | 时间戳是来源定位数据，不会自动生成片段文件；通用页面 URL 也未必支持打开即跳到该秒。 |
| 读取页面播放器 | 内容脚本能访问页面 DOM；程序注入需 `scripting` 及对应主机权限，可用临时 `activeTab`。默认注入主框架。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) | v0.1 限定可访问的普通 `<video>`；多个播放器让用户选择。跨源 iframe、封闭组件、自定义播放器分别列为未支持/待适配，失败时允许手填时间戳。 |
| 标签页音视频流 | `tabCapture` 需要用户调用扩展；获取流后原标签页声音不再直接播放，可用 `AudioContext` 接回输出。stream ID 只能用一次且会很快过期。[Tab Capture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) | 不应安装后自动录制。必须有开始、录制中、停止与失败状态；实测录到声音的同时用户仍听得到声音。 |
| MV3 后台录制路径 | Chrome 116 起，service worker 可在用户操作后取 stream ID，交给 offscreen document 的 `getUserMedia()`，再录制；官方也提供独立录制页替代路径。[Chrome 录制指南](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) | 推荐试验架构是 action → worker → offscreen → `MediaRecorder`。Edge 组合行为仍待实测；若失败，先用可见扩展录制页验证媒体链路。不要让 popup 持有录制会话，popup 关闭会中断这种做法。 |
| offscreen 的职责 | offscreen 可使用 DOM，但只支持 `runtime` 扩展 API；单个扩展同一常规配置下只能有一个。创建时需说明 reason/justification，录制示例使用 `USER_MEDIA`。[Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) | 录制器、媒体流和音频回放由 offscreen 持有；下载等扩展 API 由消息转交 worker。停止后释放轨道、音频上下文与文档。不要将“无固定 reason 时限”理解为永不终止。 |
| worker 生命周期 | Chrome 通常在空闲约 30 秒后终止 worker；全局变量随之丢失。[Service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | 不能把录制状态与唯一媒体副本只放在 worker 内存。状态需可恢复；浏览器关闭或崩溃不能承诺继续录制。 |
| 编码与输出 | `MediaRecorder` 从 `MediaStream` 录制并通过事件产出 Blob；`isTypeSupported()` 检查当前运行环境的 MIME 支持。[MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) | 首版运行时探测编码，保存实际 MIME 类型；先交付原生可播放格式，不预先承诺 MP4、无损原画质或精准剪辑。 |

## “刚才的转场”需要单独设计

以下为基于上述实时流/录制接口的工程判断：

- **点击后开始录**：成本与隐私负担最低，但无法得到点击前已经发生的画面。对可回看的普通视频，可由用户回退后重新播放并录制；这依赖播放器允许回看。
- **保留过去 N 秒**：技术上需要事先持续捕捉并维护缓冲。本项目只在用户按快捷键主动开始后录制，不规划此类后台缓冲；此处只解释技术区别，不作为第二轮默认计划。
- `MediaRecorder` 的 `timeslice` 不是精确计时器，事件可能延迟，不能用“第几个 chunk”计算片段时长。[MDN dataavailable](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event) 仅保留最后若干 Blob，也不能在未验证容器、初始化信息和关键帧的情况下承诺可独立播放或精确裁切；需单独做原型验证。

源视频时间 `sourceTimeSeconds`、录制开始/结束的实际时间、文件回放时长应分开存。暂停、跳转或倍速时，它们不再相等。这是数据模型建议，不是 API 自动保证。

## 受保护媒体

Microsoft 说明 DRM 内容使用安全播放管线防止不当复制。[Edge DRM 说明](https://learn.microsoft.com/en-au/legal/microsoft-edge/privacy#digital-rights-management-and-media-licenses) 这不足以证明任何特定电影平台在 `tabCapture` 下的具体结果，因此首版**不承诺受保护电影可截取**，也不能从普通视频成功推断所有站点成功。遇到失败、空白或黑画面，允许保留页面链接、手填时间戳和个人分析；不提供绕过保护的实现。受保护内容的实际表现仍未知。

## 本地媒体、容量与备份

IndexedDB 支持结构化数据和文件/Blob，可用于索引、句柄、设置与必要临时数据。[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) 浏览器内部数据库建议由扩展自己的 origin 持有，不把素材数据库写入宿主网页的存储；最终素材文件按用户选择的本地目录保存。Chrome 文档确认扩展页、worker 和 offscreen 共享扩展 origin；内部存储默认仍受配额约束，可用 `navigator.storage.estimate()` 检查估值；`unlimitedStorage` 和 `persist()` 有不同的配额/驱逐作用。[扩展存储说明](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)

实际可用空间不能按理论配额承诺。配额满时 IndexedDB 写入可抛出 `QuotaExceededError`；Edge/Chrome 的持久化申请也可能自动被拒绝。[MDN 配额与驱逐](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) v0.1 应有单片时长上限、总容量展示、保存失败后的下载保底；禁止静默删除已入库内容。`storage.local` 只放设置，不能把它的默认 10 MB 当作整个 IndexedDB 的配额。[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

**建议的资产包格式**：`manifest.json` + 原始媒体文件，包含 schemaVersion、资产 ID、来源页 URL/标题、采集时间、视频时间戳、个人注释、人工标签、审核状态和内容校验值。导出与恢复均纳入首版，不能把“本地保存”当作备份。可通过扩展页生成文件，再使用下载 API；该 API 需要 `downloads` 权限。[Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) ZIP 打包、文件导入、版本迁移和重复 ID 策略属于待实现的产品逻辑。

## 最小技术试验及通过门槛

范围建议：一个 MV3 扩展、一页本地草稿箱；先不用云端、AI 服务或 Codex 连接。初始权限候选为 `activeTab`、`scripting`、`tabCapture`、`offscreen`、`downloads`；有设置时再加 `storage`。是否增加 `unlimitedStorage`，根据媒体容量试验结果决定。

所有验收需记录 Windows/Edge 完整版本、权限、测试 URL/自有测试素材、步骤、结果与失败日志。

| 门槛 | 最小可复现实验 | 通过条件 |
| --- | --- | --- |
| G1 图片导入 | 现有截图工具复制图片后粘贴；拖入与选择本地文件；无图片的剪贴板 | 原图可预览与保存，非图片输入不生成空草稿；来源不被错误绑定；保存失败可重试。内置截图和缩放裁剪测试暂作为可选专项。 |
| G2 时间戳 | 自有普通 HTML 视频，暂停、播放、多播放器、无播放器 | 选中正确播放器，保存时间与画面相符；读取失败可手填；不伪造自动定位成功。 |
| G3 10–30 秒录屏 | 自有非 DRM 视频，带可视计时器与音频；选定 A/B 后按快捷键启动，到 B 自动结束；另测快捷键提前结束、长按与重复按键、关 popup 和切标签页 | 从 A 开始，正常结束与提前结束的实际范围和文件相符；文件画面/声音可回放；用户录制时仍能听到；状态与实际流一致；不重复启动或保存；停止后释放捕捉。 |
| G4 生命周期 | worker 休眠后再打开界面；关闭源标签页；重启浏览器 | 现有草稿完整；界面不残留假录制状态；中断被明确标记；不把残缺录制标成成功。 |
| G5 存储失败 | 制造写入失败或较低测试容量上限 | 不显示“已保存”；已有资产不丢失；当前媒体可下载保留；容量信息可见。 |
| G6 导出恢复 | 含截图、时间戳、短片的资产包导出；在新测试配置中导入 | 数量、媒体校验值、来源、注释、标签、审核状态一致，原片可回放；损坏包拒绝导入且不覆盖原库。 |

G1/G2 可以先验收。G3 是视频功能的准入门槛，失败时应先修链路或收窄公开支持范围，不能在 README 标成“支持 Edge 录屏”。所有门槛通过前，状态为“文档可行，实机未验证”。

## 首批站点的专项验收要求

用户选择的首批来源是 Bilibili、YouTube、X/Twitter。下面均为**设计和实测要求，不是已确认的站点兼容性结论**；一个普通 `<video>` 测试成功不能替代这些验收。

| 站点 | 需覆盖的情境 | 资产来源必须关联到什么 |
| --- | --- | --- |
| Bilibili | 普通视频、多 P 切换、剧集切换、嵌入式播放器、多播放器或广告出现、SPA 跳转后再次采集 | 当前作品、当前分 P/剧集及对应播放时间；切换后不可沿用前一集身份或时间。 |
| YouTube | 普通视频、Shorts、广告/正片切换、页面内跳转后再次采集 | 当前作品与当前播放上下文；不能把广告时间写成正片时间，Shorts 需关联正确作品。 |
| X/Twitter | 时间线含多个帖子/卡片和视频、帖子详情页、SPA 跳转、视频在滚动时继续播放 | 用户实际选择的帖子/卡片和其媒体；不能直接把整个时间线 URL 当作精确来源，也不能默认第一个 `<video>` 是目标。 |

页面识别不确定时显示候选来源让人确认；保留“来源待确认”状态，不能静默绑定。站点适配记录还需包括登录/未登录、普通/全屏、可回看/直播等实际覆盖条件。首轮优先验证可访问的非 DRM 内容；其余情境可明确列为未支持。
