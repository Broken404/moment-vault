# 开发与版本管理

实施依据为 docs/formal-plan.md；实际完成状态与未通过项记录在 docs/implementation-status.md。软件代码、实验、模拟检查和真实平台证据分别保存。

- main 保留已整合基线；当前首版开发在 codex/v1-implementation，保留原 codex/technical-spike 历史。
- 按独立职责提交 docs、feat、fix、test、build；提交说明写清实际变更，不补写虚构开发历史，不改写已共享提交。
- 前端改动运行 npm run check；本地文件与协议改动运行原生检查，必要时运行真实进程及跨卷检查。真实 Edge 功能不能由 DOM、模拟事件或文件名代替验收。
- 提交锁文件和构建说明。不要提交 node_modules、SDK、bin/obj、dist、实际素材、浏览器配置、凭据、本机目录配置或临时日志。
- 使用普通分支推送，不强制推送或直接覆盖 main。发布标签与安装包要等对应真实验收完成；当前开发版本不打正式发布标签。

构建和自用开发加载见 docs/development.md。
