# 原播放器进度条适配研究

日期：2026-10-20。状态：官方能力核查与工程建议，未实施，未验证 B 站、YouTube 或 X 的实际兼容性。本笔记没有进行网页操作，也不把已有示意预览作为平台适配证据。

同日另行完成三个公开页面的现场结构检查，记录于 [DOM 观察](evidence/native-timeline-dom-2026-10-20.json)。该检查在 in-app browser 中进行，只确认样本轨道结构与控件出现情况，不改变本篇“正式 Edge 集成尚未验证”的边界。

## 结论

建议把“在原进度条上拖动 A/B”列为三站普通视频的主要交付要求。一次查找失败只能触发重新定位和修复流程，不能直接视作该页面不支持。独立精调区继续作为长视频的精确输入补充；脱离原进度条的备用模式只在恢复路径确实失败后由用户选择。

建议采用“一个共用选段控制器 + 三个小型站点适配器”。适配器只负责找到当前视频、其播放器容器和真正的时间轴轨道，并报告轨道几何及可用状态；A/B、拖动、键盘、预览与恢复逻辑共用。此为工程选择，目的是让站点改版时只修对应适配器。

## 官方能力与边界

| 事项 | 已确认的浏览器能力 | 对本项目的含义与限制 |
| --- | --- | --- |
| 扩展操作网页 | 内容脚本能够读取和修改网页 DOM；隔离环境与网页共享 DOM，但不共享网页 JavaScript 变量。[Chrome 内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) | **建议**默认使用隔离内容脚本，把 A/B 覆盖层对齐真实轨道；不因“要叠在原进度条”而引入网页内部播放器 API。官方能力不证明三站存在某个固定选择器。 |
| 语义候选 | WAI-ARIA 的 slider 模式定义 `role="slider"` 及 `aria-valuemin`、`aria-valuemax`、`aria-valuenow` 等属性。[W3C Slider Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/) | **建议**以播放器内的语义属性与范围值作识别线索，再加站点限定选择器；不能把任意 slider 认成时间轴，因为音量等也可使用该角色。三站是否提供这些属性需逐站检查。 |
| 轨道定位 | `getBoundingClientRect()` 提供元素相对视口的位置和大小，滚动会改变其坐标；返回矩形包含边框和内边距。[MDN 几何 API](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect) | **建议**测真正可拖动的时间轨道，而非整排控制栏；适配器修正轨道内边距。不能用“播放器底部偏移若干像素”猜位置。 |
| 动态重建 | `MutationObserver` 可按配置观察节点增删及属性变化，并可限定子树、属性过滤、停止观察。[MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe) | **建议**监控已找到的播放器子树；节点移除、控制栏重建时解除旧绑定，再重新定位。发现阶段可短暂观察外层；不要永久高频扫描整页。 |
| 尺寸与位置更新 | `ResizeObserver` 报告元素尺寸变化；尺寸观察本身不等于位置观察。[MDN ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver) 视口另有 resize、scroll 事件。[MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) | **建议**合并播放器/轨道尺寸变化、页面及滚动容器滚动、窗口缩放、已验证的布局切换事件后重算。纯位置移动也要覆盖，不能只装一个 ResizeObserver。 |
| 拖动连续性 | `setPointerCapture()` 可把后续指针事件指定到同一元素，直到释放或结束捕获。[MDN Pointer Capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture) | **建议**按下 A/B 时捕获指针，支持拖出轨道仍连续；`pointerup`、`pointercancel`、丢失捕获、关闭模式均清理拖动。只由端点接管拖动，其他原生控件仍可操作。 |
| 时间与可定位范围 | `currentTime` 以秒表示，设置它可发起 seek；实际落点仍受媒体支持约束。[MDN currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime) `seekable` 表示当前可 seek 的时间范围，`buffered` 表示已缓冲范围。[MDN seekable](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seekable)、[MDN buffered](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered) | **建议**等媒体元数据有效后校验范围；未缓冲但可 seek 的位置仍能选择，显示定位中。不要把 A/B 数字更新、发起 seek 或毫秒显示当作准确画面已经就绪。 |

### 不能据此承诺的情况

- 浏览器自带媒体控件由用户代理提供，标准规定其行为而未提供统一可访问的“进度条 DOM 节点”接口；其交互也可由浏览器抑制页面鼠标事件。[HTML 标准：媒体界面](https://html.spec.whatwg.org/multipage/media.html#user-interface) **因此推断**：站点自绘控件和浏览器原生 controls 必须区别处理，不能承诺后者也能按站点 DOM 方案绑定。
- 页面创建的 closed Shadow DOM 的 `shadowRoot` 返回 `null`，部分内建元素的用户代理 shadow root 对脚本封闭。[MDN shadowRoot](https://developer.mozilla.org/en-US/docs/Web/API/Element/shadowRoot) **因此建议**：可访问的 open shadow root 可纳入查找；不能把切到 MAIN 当作访问已存在 closed root 的通行证。
- 内容脚本注入到子 frame 仍受各 frame 的 URL 匹配要求约束，`all_frames` 不等于任意子 frame 均获准注入。[Chrome frame 注入说明](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#specify-frames) **建议**在拥有匹配权限的目标 frame 内定位和绘制，跨 frame 只传必要状态；先确认目标 frame，不能把主页面“找不到视频”当作整页不可适配。
- `MAIN` 是与网页 JavaScript 共用的执行环境，`ISOLATED` 是扩展专属环境。[Chrome scripting ExecutionWorld](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld) **建议**仅在实测证明某项必要能力只能由页面对象提供、且找到具体稳定入口时，单独论证最小桥接；桥接只传结构化的必要数值并验证消息。现在没有证据要求它，不纳入默认架构，也不承诺存在稳定私有播放器 API。

## 提议的识别与交互方法

以下均为待实施工程设计，并非三站现状描述。

1. **先确认视频，再找它的轨道。** 排除推荐卡片、广告、隐藏或已移除的旧播放器；综合当前可见播放器、媒体元数据、轨道所属容器和时间范围检查。多视频页面无法唯一确定时，让用户点当前播放器，不随便取页面第一个 `video`。
2. **每站有两种以上有限识别线索。** 先检查已知结构/语义属性，再使用站点限定选择器；候选必须通过所属关系、有效几何和时间映射检查。不能单靠本地化“进度条”文字，也不能只靠易变 class 名。记录命中版本与失败原因，便于修复。
3. **覆盖层与原轨道同位。** A/B 和选区高亮绘在原轨道对应位置，不复制另一根时间条，不改写网站现有节点的 HTML。优先将自有覆盖层挂在稳定播放器外壳，避免跟着易重建控件一起丢失；自行隔离样式，避免影响网站按钮。
4. **隐藏控制栏属于正常状态。** 先区分“轨道存在但隐藏”“控件尚未生成”“播放器确已换掉”。对已验证可行的站点，可在选段模式中临时保持对应时间轴可见；只能做局部、可撤销的适配，不用全站样式覆盖，也不以模拟鼠标事件能触发真实 hover 为前提。退出恢复。具体可见性机制需逐站验证。
5. **只在轨道可信时允许拖动。** 对普通有限时长、正向横向轨道，设有效轨道左端为 `left`、宽为 `width`、时间域为 `[start,end]`，则 `ratio = clamp((clientX-left)/width,0,1)`，`time = start + ratio*(end-start)`。方向、非零起点及边距由适配器明确提供；不盲用 `0..duration`。这是建议算法，需用真实轨道左、中、右位置校准。失去可信几何时保留 A/B，暂停拖动，避免旧坐标误改时间。
6. **端点只有一个数据源。** 原轨道标记、精调和时间输入都改同一份 A/B。约束 A < B；选中哪端只移动哪端。两小时视频的 5 秒选段在普通宽度下会挤在一起，因此沿用上下错开的端点和精调补充，不能只靠放大端点命中区宣称能精确到帧。

## 备用方式之前必须经过的恢复顺序

这是建议实施顺序；产品门槛由正式方案确定。

1. 等播放器元数据、对应控件挂载或真实鼠标进入后重试，显示简短“正在连接进度条”；区分暂未准备与结构不支持。
2. 在同一目标播放器内按该站有限的候选规则重新识别；尝试语义候选与已维护的站点结构候选，并重新验证。
3. 对已验证的 hover 隐藏机制，仅在选段期间维持原时间轴可见；若只是大小/位置变化，重新测量后恢复原轨道标记。
4. SPA 跳转、清晰度切换、播放器或控制栏重建时重新绑定；只有确认还是同一视频才保留 A/B，否则以新视频重新初始化，禁止旧视频状态串入新视频。
5. 检查是否位于可注入的 frame 或可访问的 open shadow root；权限不足、closed root、浏览器原生控件或确已改版分别给出原因。
6. 在上述路径失败且视频仍可定位时，保留选段数据，提示“原进度条暂不可连接”，提供“重新连接”和“临时使用精调”。**不自动把用户切成备用布局，不把备用通过记成主流程验收通过。** 若实际媒体本身也不可定位，则不能声称精调可解决。

## 真正需要通过的验收

以下是后续真实 Edge 中的验收清单，当前均未执行。

| 场景 | 必须留下的证据与通过条件 |
| --- | --- |
| 三站基本路径 | 每站记录 URL、页面类型、登录状态、Edge/扩展版本、适配器版本和视频时长；原轨道上的 A/B 确实能拖动，独立窗能对照有效边界画面，绝非仅展示静态覆盖层。 |
| 轨道校准与误认 | 左端、中点、右端映射与播放器实际时间一致；音量、广告和推荐视频不被误当主时间轴；没有唯一目标时不会修改任意视频。 |
| 隐藏、重建与布局 | 自动隐藏控件后仍能重新显示并操作；滚动、窗口缩放、浏览器 80%/100%/125%/150% 缩放、剧场布局切换、SPA 切视频、清晰度切换后位置与目标保持正确，未出现重复覆盖层或已脱离轨道的标记。 |
| 指针与键盘 | A/B 接近和重叠投影仍能分别选择；拖出区域、松手、取消、切标签和关闭模式不残留拖动；原播放器其他按钮仍可用；原轨道、精调、输入、箭头同步且不跨越另一端。 |
| 长短与缓存 | 长视频选 5 秒、片头片尾、短于默认选区、已缓冲/未缓冲快速往返、A/B 快速切换均不串旧帧；等待画面不会锁住端点数值。记录交互延迟、最终 seek/有效画面耗时与内存，不用固定演示延时作性能证明。 |
| 失败与恢复 | 暂时隐藏或重建不会立即进入备用；人为移除有效轨道后能重连；确实不可连接时保留同视频 A/B，给出原因且由用户选择临时精调。 |
| 退出与录制 | 任意时刻关闭能清掉自有覆盖层和临时样式，恢复已约定观看位置/状态；录制中无端点编辑，成品不包含扩展界面。分别验证正常结束、快捷键提前结束、手动关闭后的界面与文件结果。 |

平台登录、网络不可达或仅有截图/DOM 检查时，必须标为受限检查；不能登记为完成端点拖动、预览缓存或真实录制验收。
