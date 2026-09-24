# BBPlayer Desktop

BBPlayer Desktop 是基于 Electron 的 B 站音频桌面播放器（Windows / Linux）。
本仓库是从 BBPlayer monorepo 拆分出的**桌面端独立仓库**，整个仓库为 pnpm monorepo。

## 命令

注意，所有命令都应当在项目根目录运行

```bash
pnpm install        # Only pnpm — npm/yarn breaks workspace resolution
pnpm lint           # oxlint --type-aware
pnpm lint:fix       # Auto-fix
pnpm format         # oxfmt
pnpm type-check     # tsgo --build --noEmit
pnpm check:core     # packages/core 平台无关性守卫
pnpm check:probes   # 探针脚本静态检查（已接 pre-commit）
```

桌面端应用的运行与打包：

```bash
pnpm --filter @bbplayer/desktop start          # 开窗口运行
pnpm --filter @bbplayer/desktop build:prepare  # 打 core / splash / tokens 的 CJS bundle
pnpm --filter @bbplayer/desktop build:win      # NSIS + portable
pnpm --filter @bbplayer/desktop build:linux    # deb + rpm + AppImage
```

## 最佳实践

### 运行检查和构建

如果任务涉及 TypeScript / JavaScript，你应当在每个任务完成后都**在项目根目录**运行一次 `pnpm type-check` 与 `pnpm lint`，检查是否引入了新的错误。

如果任务涉及 `packages/core`，还要跑一次 `pnpm check:core` —— core 必须保持平台无关（不 import 任何渲染层 / 原生模块）。

如果任务涉及 Electron 主进程或渲染进程，跑对应的探针套件（见 `apps/desktop/README.md` 的验证套件清单）；
**跑 Electron 类验证前先清掉遗留进程**，否则探针会静默失败：

```powershell
Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 搜索文件和 symbol

用 `glob` / `grep` 找文件与符号。

### 阅读历史

`docs/` 里有各阶段的施工图、进展与**踩坑记录**（`DESKTOP_PLAN.md`、`DESKTOP_UI_PLAN*.md`），
`apps/desktop/README.md` 顶部有"几条会导致返工的约定"。动手改界面前先读它们 —— 里面记录的形状
都是踩过一次才知道的。代码注释里的 `apps/mobile` / `packages/orpheus` 等是本仓库拆分前的
**历史交叉引用**（说明"这件事在移动端怎么做"），不是失效链接。

## 仓库结构

### /apps

- desktop - Electron 桌面端。主进程是 CJS（`apps/desktop/src/*.cjs`），渲染进程是**无打包器的普通 `<script>`**
  （`apps/desktop/src/renderer/*.js`，每个文件用 `;(function(){…})()` 包起来，模块间靠全局对象通信）。
  生产构建时 `scripts/build-core.mjs` 把 core / splash / design-tokens 打成 CJS 单文件。
- backend - 共享歌单后端（技术栈：Hono + ArkType + Drizzle ORM + Cloudflare Worker + Postgres）

### /packages

- core — 平台无关核心：DB schema 与迁移、B 站 / 网易云 API 客户端、歌词候选、WebDAV、备份格式、`sort_key` 约定。
  由移动端与桌面端共用，因此**不许** import React / Expo / React Native / 原生模块。
- design-tokens — Material Design 3 语义色与字阶；桌面端主进程用它生成 CSS 变量下发给渲染进程。
- splash — 歌词转换与解析库（SPL / LRC）。桌面端只用到 `src/parser/merge.ts`。

### 其它

- `scripts/` — 验证套件与守卫脚本（`verify-desktop*.mjs` 走 Electron 探针，`verify-*.mts` 走 tsx）
- `docs/` — 桌面端方案、各阶段施工图与进展记录
- `prototype/` — 卡片化改造的静态 HTML 原型（改主页/播放页前先看它）
- `assets/screenshots/` — 移动端界面截图，作为交互对照基线
