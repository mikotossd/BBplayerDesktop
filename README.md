<div align="center">
<h1>BBPlayer Desktop</h1>

Windows / Linux 桌面端 —— 播放 B 站音频、管理歌单、同步收藏夹、下载与 WebDAV 备份。

基于 [Electron](https://www.electronjs.org/)，与 [BBPlayer](https://github.com/bbplayer-app/BBPlayer) 移动端共享
[`packages/core`](./packages/core) 的平台无关逻辑，备份格式与数据库结构两端互通。

</div>

---

## 功能

- **播放**：播放 / 暂停、循环、随机、播放队列、响度均衡、断点续播、启动自动播放。
  音频由主进程经自定义协议 `bbplayer-audio://` 代理（B 站主线 CDN 强制校验 `Referer`，渲染进程设不上去）。
- **登录**：扫码 / 粘贴 Cookie / 密码三条路并存；凭据经 Electron `safeStorage` 加密落盘，cookie 从不到达渲染进程。
- **搜索**：BV / AV 号、`b23.tv` 短链解析，收藏夹与本地歌单内搜索。
- **歌单**：本地歌单增删改、收藏夹与 UP 合集同步、多选批量操作、跨端顺序互通（`sort_key`）。
- **歌词**：SPL / LRC 解析、逐字进度、罗马音与翻译、偏移量调整；另有**无边框透明置顶独立歌词窗口**。
- **外部歌单导入**：粘贴网易云歌单链接，逐首搜索、加权打分、负向词罚分后落库（QQ 音乐未做，接口需登录态签名）。
- **共享歌单**：把歌单分享到 [`apps/backend`](./apps/backend)，他人订阅后双向同步（LWW + outbox 增量）。
- **下载**：`.m4a` 落盘、HTTP `Range` 断点续传、完整性校验、备用地址回退。
- **备份**：ZIP + 原始 SQLite 快照，与移动端格式互通（含两处会静默毁数据的迁移表 / `sort_key` 差异处理）。
- **系统集成**：`navigator.mediaSession`（Windows SMTC / Linux MPRIS）、任务栏缩略图按钮（图标运行时零依赖生成）、可选硬件媒体键。
- **界面**：Material Design 3 语义色（令牌由 [`packages/design-tokens`](./packages/design-tokens) 生成）、浅色 / 深色、封面主色背景、可拖拽左栏、播放列表浮层、热力图。

## UI 参考

`assets/screenshots/` 下是**移动端**界面截图（1182×2560），保留在仓库里作为交互基线：
桌面端阶段 6 的既定方法论是「先读移动端怎么做 → 再决定桌面端怎么做 → 写明为什么」，
只在"鼠标 + 宽屏确实要求不同"的地方才改，不因为"桌面软件通常这样"就发明新惯例。

桌面端自身的截图巡检产物在 `apps/desktop/probe-output/`（不入库，由 `pnpm verify:desktop:tour` 生成）。

## 快速开始

```bash
pnpm install

# 国内网络首次安装需要下载 Electron 二进制（约 142 MB，懒下载）
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ pnpm install

pnpm --filter @bbplayer/desktop start      # 开窗口运行
```

```bash
pnpm lint          # oxlint --type-aware
pnpm type-check    # tsgo --build --noEmit
pnpm format        # oxfmt
pnpm check:core    # packages/core 平台无关性守卫
pnpm check:probes  # 探针脚本静态检查（已接 pre-commit）
```

打包：

```bash
pnpm --filter @bbplayer/desktop build:win     # NSIS + portable
pnpm --filter @bbplayer/desktop build:linux   # deb + rpm + AppImage
```

完整验证套件（21 个脚本、1000+ 条断言）见 [`apps/desktop/README.md`](./apps/desktop/README.md)。

## 仓库结构

```
apps/
  desktop/   Electron 桌面端（主进程 CJS + 无打包器的渲染进程）
  backend/   共享歌单后端（Cloudflare Worker + Hono + Drizzle + Postgres）
packages/
  core/          平台无关核心：DB schema / 迁移 / B 站与网易云 API / 歌词 / WebDAV / 备份格式
  splash/        歌词解析与转换（SPL / LRC）
  design-tokens/ Material Design 3 语义色与字阶
scripts/         验证套件、探针静态检查、core 纯度守卫
docs/            桌面端方案与各阶段施工图、进展与踩坑记录
prototype/       卡片化改造的静态 HTML 原型（`prototype/pages/home.html` 等）
assets/          移动端界面截图（交互对照用）
```

## 与上游 BBPlayer 的关系

本仓库是 [bbplayer-app/BBPlayer](https://github.com/bbplayer-app/BBPlayer) monorepo 中**桌面端部分的独立拆分**，
已剔除移动端（React Native）、文档站、热更新与发版工具等与桌面端无关的代码，历史也相应重写（已无上游 remote）。

因此代码注释与 `docs/` 里仍会看到 `apps/mobile` / `packages/orpheus` 这类**历史交叉引用** ——
它们记录的是"这件事在移动端是怎么做的"，是有效的设计依据，不是失效链接。

`apps/backend` 是桌面端「共享歌单」功能所依赖的服务端，与移动端共用同一套协议。

## 隐私

桌面端**不集成**任何统计或崩溃上报 SDK（移动端的 Firebase Analytics / Sentry 未带过来）。
数据只落在本机 `userData` 下；登录凭据交给 Electron `safeStorage`。
唯一的外部请求是 B 站 API、歌词来源（网易云 / QQ / 酷狗）、可自建的共享歌单后端，以及你自己配置的 WebDAV。

## 开源许可

本项目采用 MIT 许可，见 [LICENSE](./LICENSE)。
原始项目版权归 [BBPlayer](https://github.com/bbplayer-app/BBPlayer) 作者所有。
