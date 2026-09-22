# 桌面端「卡片化」改造 · 进展

> 施工单在 [`DESKTOP_UI_PLAN_CARDS.md`](./DESKTOP_UI_PLAN_CARDS.md)。
> 本文件记**实际做了什么、每步的验证结果、踩到的坑**。
> 静态原型在 `prototype/`（用浏览器打开 `prototype/index.html`）。

---

## 已完成

### P0 · 静态原型（`prototype/`）

**为什么先做原型**：用户要求"先不加任何功能，用简洁的方式把各个页面的样式用
html 写一个出来我看看效果"。原型把 12 张草图 + 用户逐条确认的决定固化下来，
在动真代码之前就能看出对齐与重叠问题。

| 文件                              | 内容                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `prototype/index.html`            | 导航页 + 本次已落实决定的清单                              |
| `prototype/assets/proto.css`      | 全部样式：令牌、窗口壳、卡片、歌曲行、播放条、歌词流、弹层 |
| `prototype/pages/home.html`       | 主页：用户卡 / 歌单卡 / 内容卡 / 播放条                    |
| `prototype/pages/nowplaying.html` | 播放详情：唱片 + 歌词纯文字流                              |
| `prototype/pages/playlist.html`   | 歌单：页头 + 紧凑歌曲行 + 多选条                           |
| `prototype/pages/favorites.html`  | 收藏夹：卡片列表 + UID 工具条                              |
| `prototype/pages/library.html`    | 音乐库：搜索框 + 页签 + 歌单卡网格                         |
| `prototype/pages/search.html`     | 搜索结果（与歌单共用歌曲行）                               |
| `prototype/pages/dialog.html`     | 队列浮层 / 歌曲菜单 / 添加到歌单 / 新建歌单                |
| `prototype/pages/settings.html`   | 设置：分类列表 + 子页                                      |

**原型阶段落实的决定**（用户逐条给出）：

1. 播放模式**四档**（列表循环 / 单曲循环 / 随机播放 / 顺序播放）。
2. **没有音量滑块**（播放条与详情页都没有；用 `Ctrl + ←/→`）。
3. 搜索框**常驻内容卡顶部**（方案 A，不是独立目的地）。
4. 标题栏**完全自绘**。
5. **删除右侧栏**；队列走播放条「播放列表」按钮的浮层。
6. 收藏夹卡只显示 **N 个视频**。
7. 主页**播放历史是独立区块**。
8. 点击目标按**鼠标交互**设计（26–34px，不用 44px 触控尺寸）。
9. 歌词是**纯文字流**（不是卡片；只参考网易云参考图的歌词部分）。
10. 主题**默认中性浅色**（白底 + 深灰强调色，去掉粉/紫强调色）。
11. 封面全部指**拉取到的视频封面**（原型里用占位图）。
12. 听歌频率用 **GitHub 贡献墙**形式（53 周 × 7 天）。
13. 播放条在**所有页面底部固定**（窗口固定底行，换页不动）。

**两条结构性约束**（不是风格问题）：

- **播放条是窗口的第三行**：`.window` 是 flex column（标题栏 / 主体 / 播放条），
  主体内部滚动。这样"换页时播放条不动"是布局保证的，不靠巧合。
- **图标不依赖网络**：`.ic` 用内联 SVG 的 `mask`，`color` 即图标颜色。
  原型第一版用 Google Fonts 的 ligature，离线时图标退化成**文字**
  （`skip_previous` 直接渲染成字符串），把播放条挤成一团 —— 这个坑
  正是用户截图里看到的"文字挤在一起"。现在没有字体、没有网络请求。

### P1 · 播放模式改成四档（真代码）

**改了什么**

| 文件                                        | 改动                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/player.js`       | `PLAY_MODES` 从 `['order','repeat-one','shuffle']` 改成 `['list-loop','repeat-one','shuffle','order']`；`MODE_LABEL` 补一档；默认模式改成 `list-loop` |
| 同上                                        | `nextIndex(auto)`：`order` 模式在**自动续播**走到队尾时返回 `-1`（停）；**手动**「下一首」仍然回绕                                                    |
| 同上                                        | 新增只读探针 `peekNextIndex(auto)` / `getModeLabel()` / `getModeIcon()`                                                                               |
| `apps/desktop/src/renderer/index.html`      | 两个模式按钮的初始 `title` 从「顺序播放」改成「列表循环」                                                                                             |
| `apps/desktop/scripts/icons.txt` + 字体子集 | 新增 `arrow_forward`（顺序播放的图标）                                                                                                                |
| `apps/desktop/src/ui-probe-driver.cjs`      | 新增 4 条断言                                                                                                                                         |

**为什么要拆语义**：改造前 `order` 的行为是"放完最后一首回到第一首" ——
它**实际上是列表循环**，却叫「顺序播放」。所以：

- 把原行为改名成 `list-loop`（列表循环），它成为默认（**行为不变**）；
- 新增 `order`（顺序播放）= 放完最后一首就停。

这样"改文案"与"改行为"是两件事，各自可验证。

**只读探针为什么必要**：`playNext()` 会真的换曲并 `play()`（发网络请求、等音频）。
断言四档语义如果走 `playNext`，一条断言要等好几秒。`peekNextIndex()` 与
`playNext()` **共用同一个 `nextIndex()`**，所以它返回什么，`playNext` 就会做什么
—— 只读、不播放、零副作用。

**验证**：`pnpm verify:desktop:ui` → **193 项全通过，0 失败**（electron exit=0）。
新增的 4 条：

```
✅ 顺序播放在队尾停住，手动下一首仍回绕 — 停在队尾=true，手动回绕=true
✅ 列表循环自动续播回到队首
✅ 单曲循环自动续播停在当前这首
✅ 循环按钮走完四档回到起点，每档名称与图标都不同
   — 名称 [列表循环 / 单曲循环 / 随机播放 / 顺序播放]
     图标 [repeat / repeat_one / shuffle / arrow_forward]
```

### P2 · 修掉图标字体构建脚本的两个真 bug（顺带）

改 `icons.txt` 之后**构建直接失败**，排查出两个与"图标名写错"无关的坑：

| #   | 现象                                                                       | 根因                                                                                                                                               | 修复                                                                                                                         |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | 整份清单（含中文注释）被拼进 `icon_names=`，Google Fonts 返回 **HTTP 400** | `icons.txt` 在 Windows 上是 **CRLF**，而 `/#.*$/` 在 `"...注释\r"` 上匹配不到（`$` 落不到 `\r` 之前）→ 注释行没被清掉。66 个真图标变成 76 个"名字" | `split(/\r?\n/)` 先归一化行尾                                                                                                |
| 2   | `fetch failed` / `ETIMEDOUT`，而 PowerShell 的 `Invoke-WebRequest` 正常    | 受限环境里 **Node 的 fetch/https 连不上 `fonts.gstatic.com`**，系统 HTTP 客户端可以                                                                | 新增 `BB_ICON_FONT_HTTP_DIR`（读本地缓存目录）+ `scripts/cache-http-response.mjs`（把系统客户端抓下来的响应按 URL 落进缓存） |

> 坑 1 的教训值得记：**失败信息（HTTP 400）与真实原因（行尾）毫无关系**。
> 如果只看到"400"就去改图标名，会一直改不对。

**产物**：`material-symbols.json` 从 65 → **66 个图标**，woff2 10.2 KB。

### P3 · 阶段 0：布局骨架（播放条进中栏）

**改了什么**

| 文件                            | 改动                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                    | `<footer class="playbar">` 从 `.app` 的直接子项**移进 `<main>`**（成为中栏网格的第二行）。**所有 id/testid 一个没改**                                                                               |
| `style.css` `.app`              | 网格从"两行三列"改成"一行三列"（`grid-template-areas: 'sidebar main rightbar'`）                                                                                                                    |
| `style.css` `.main`             | 从 flex column 改成**两行网格**（`minmax(0,1fr) auto`），自己安排内容区与播放卡                                                                                                                     |
| `style.css` `.sidebar`          | 补 `grid-row: 1 / 3` —— 左栏仍然通高                                                                                                                                                                |
| `style.css` `.rightbar`         | `grid-area: rightbar` → **`grid-column: 3`**（见下面的坑）                                                                                                                                          |
| `style.css` `.playbar`          | 去掉 `grid-area: playbar`，加 `grid-column: 1 / -1`；列从 `48px 240px auto minmax(0,1fr) auto` 改成 `44px minmax(160px,1fr) auto minmax(120px,1fr) auto`；`margin` 与 `.content` 取同一个 `--sp-md` |
| `style.css` `.sidebar-splitter` | `bottom: 72px` → `bottom: 0`（播放条不再占窗口底行）                                                                                                                                                |
| `ui-probe-driver.cjs`           | "悬浮圆角卡（左右留白）"断言改写为**"与内容卡左右对齐"**                                                                                                                                            |

**验证**：`pnpm verify:desktop:ui` → **193 项全通过**。
新判据的输出：`radius=16px shadow=true 播放条左边=256px 内容卡左边=256px`。

#### 这一步踩的三个坑（都由现象倒推出来，值得记）

1. **`.rightbar` 的 `grid-area` 失效**。`grid-template-areas` 里去掉 `rightbar`
   之后，`grid-area: rightbar` 变成一个**不存在的命名区域**，元素被自动放进
   下一个空单元格。表现是"右栏跑到别处去了"，而 CSS 看着完全正常。
   → 改成显式 `grid-column: 3`。

2. **播放条的列数必须等于直接子元素个数**。可见子元素是
   封面 / 信息 / 传输 / 进度 / 模式+音量 = **5 个**，而我第一版按草图的
   "传输与进度同格"写了 4 列 —— 第 5 个子元素落到**隐式的第二行**，
   播放条被撑高一倍、内容区被挤扁。截图里一眼能看到"模式 + 音量"掉到下面。
   → 写 5 列。**这类错误不会报错，只会让布局悄悄变形。**

3. **`.main` 加水平 padding 会让播放条与内容卡错位 16px**。
   内容区自己带 `margin: … var(--sp-md) …`，播放卡也带 → 两者天然对齐；
   中栏再加 padding 就正好差一个 padding。断言直接把这个差量打出来了
   （`播放条左边=256 内容卡左边=272`），一眼定位。
   → 中栏只留纵向 padding。

### P4 · 工具链：为什么"用 PowerShell 改写文本文件"会毁掉文件

**踩到的**：用 `[System.IO.File]::ReadAllText/WriteAllText + UTF8Encoding`
改写 `style.css` 之后，文件里的中文注释**整段变成乱码**，而且
`oxfmt` 直接报"code style"错误 —— 因为乱码把注释和代码行粘在了一起。
`style.css` 从 2978 行变成 2699 行。

**根因**：这类"读进来再写回去"的操作会**按当前编码重新解释整份文件**。
只要文件的实际编码与 `UTF8Encoding` 不一致（或反之），非 ASCII 部分就会被
逐字节损坏，而且**是不可逆的**（原文已经被覆盖）。

**处置**：`git checkout --` 恢复，再用 `edit` 工具按字面替换重新做一遍。

**纪律（这一轮之后必须遵守）**：

- **改文本文件只用 `edit` / `write` / `read` 工具**，不用 PowerShell 做
  "读全文 → 改 → 写全文"。
- 需要在 PowerShell 里处理文本时，**只读不写**；确实要写就用
  `Set-Content -Encoding` 明确编码，并且在改之前 `git diff --stat` 记下
  行数，改完立刻核对行数与 `\uFFFD` 计数。
- 排查 DOM/样式问题时，**不要"加临时 CSS → 跑探针 → 删临时 CSS"** ——
  那正是上面这条错误的温床。改用只读的方式：`--dump-dom` 抓真实 DOM，
  或在临时副本上做实验。

---

### P5 · 阶段 1：左栏 = ① 用户卡 + ② 歌单卡

**改了什么**

| 文件                  | 改动                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`          | `.sidebar` 换成两张卡片：① 用户卡（品牌 + 用户名 + 账号按钮，整卡去主页）② 歌单卡三段式（页头「收藏夹」/ 中段「本地歌单 + ＋ + `#playlist-list`」/ 页脚「设置」）。**删掉 `<nav>` 与 4 个 `.nav__item`** |
| 同上                  | 所有可点入口加 `data-nav="home\|library\|favorites\|settings"`；`#sidebar-new-playlist` 的 testid 定为 `playlist-new`（任意页面都在的主入口），音乐库页头那颗改名 `playlist-new-head`                    |
| `renderer.js`         | `setActiveNav` 改按 `[data-nav]` 高亮；新增 `activateNav()` 统一跳转（`favorites` 走 `setLibraryTab` 而不是 `openView`）；对非 `<button>` 的卡片补 `role=button` + Enter/Space                           |
| 同上                  | `Ctrl+1/2` 不再点 `[data-view=…]`（那些元素已删除），改为直接调 `openView()`                                                                                                                             |
| `library.js`          | 抽出 `openNewPlaylistMenu(anchor)` 给两个「＋」共用；在 `init` 里绑左栏那颗（绑在 `showPlaylistsTab` 里的话，用户在主页点「＋」会毫无反应）                                                              |
| `style.css`           | `.sidebar` / `.sidebar__card`（三段式）/ `.sidebar__entry`（卡片里的胶囊入口）/ `.sidebar__count`                                                                                                        |
| `ui-probe-driver.cjs` | 11 处 `nav-*` 点击换成新的入口；两条断言改写判据（不是换选择器）                                                                                                                                         |

**断言改写的原则**（这一步最重要的一件事）

原来有两条断言写的是"左栏有 4 个导航项、顺序是 home/library/search/settings"。
卡片化之后左栏没有"导航项"了，但**用户在意的东西没变**：
"四个目的地都有入口、都点得到"。所以判据改成：

```
左栏是两张卡片：① 用户卡 + ② 歌单卡
四个目的地都有入口，且都可见（主页/音乐库/收藏夹/设置）
收藏夹入口在歌单卡页头、设置在页脚（草图上就是这个位置）
```

**探针基线变化**：193 → **194 项**（多的一条见下面 P6）。

#### 这一步踩的四个坑（每一个的表现都与原因相距很远）

1. **`getElementById('sidebar-card')` 拿到 null，而元素明明在**。
   实际 id 是 `sidebar-library`（它同时是 `data-nav="library"` 的入口），
   `sidebar-card` 只是 testid。教训：**id 与 testid 不是一回事**，
   按 testid 猜 id 就会得到"元素在、代码说它不在"。

2. **点击冒泡把"最内层入口"覆盖掉**。
   歌单卡本体是 `data-nav="library"`，页头「收藏夹」是 `data-nav="favorites"`、
   页脚「设置」是 `data-nav="settings"` —— 三者嵌套。点收藏夹会先切收藏夹、
   紧接着被卡片的 handler 切回音乐库，表现是**"点了没反应"**。
   修法：`activateNav` 里判 `event.target !== event.currentTarget` 就返回
   （只有真正被点的那个元素生效）。

3. **`transition` 会接管属性，导致"加类后立刻量"读到的是起始值**。
   探针里一直在量 `#sidebar-settings` 的选中背景，始终是 `rgba(0,0,0,0)`：
   三条 `background` 规则都匹配、连内联 `rgb(9,8,7)` 都被盖住。
   真因是那条元素上有 `transition: background 0.1s` ——
   `getComputedStyle` 返回的是**过渡中的当前值**，而加类那一瞬间它是 transparent。
   修法：**量临时克隆出来的元素**（没有"上一个值"可插值，第一帧就是终值）。
   顺带发现：同类的"缺注释开头"（`/* 用户名 */` 变成 ` * 用户名 */`）
   会让后面整段规则被解析器吞掉 —— 那次是 `.sidebar__user` 的规则。

4. **testid 改名漏了一处**。左栏「＋」我写成了 `sidebar-new-playlist`（跟 id 同名），
   而探针找的是 `playlist-new` —— 于是"按钮明明在、选择器找不到"，
   连带三条断言（菜单三项 / 打开新建对话框 / 卡片数增加）一起红。

### P6 · 你要的两件事：自绘标题栏 + 默认中性浅色

**自绘标题栏**（`main.cjs` / `ipc-handlers.cjs` / `preload.cjs` / `index.html` / `style.css`）

- `BrowserWindow` 加 `titleBarStyle: 'hidden'`（macOS 用 `hiddenInset`，
  **保留红绿灯** —— 那是 macOS 的惯例，不该自绘掉）；
- 新增四个 IPC：`window:minimize` / `toggleMaximize` / `close` / `isMaximized`；
  preload 暴露 `bbplayer.window.*`；
- 渲染层画 `.titlebar`（品牌 + 当前页面名 + 三颗按钮），
  拖拽靠 CSS 的 `-webkit-app-region: drag`，按钮上必须 `no-drag`；
- `.app` 高度从 `100vh` 改成 `calc(100vh - var(--titlebar-h))` ——
  标题栏是文档流里的真实一行，不减掉底部会被挤出窗口。

⚠️ **双击标题栏最大化不要自己实现**：`-webkit-app-region: drag` 的区域
由 Chromium 按系统手势处理，Windows 上双击本来就会最大化/还原；
自己再监听 `dblclick` 会变成"切两次"，反而切回原状。

⚠️ **图标名写错会让整个图标构建失败**：我一开始把"还原"的图标写成
`filter_none`（Material Symbols 里没有这个名字），Google Fonts 对
**不认识的 icon_names 是整批返回 400**，不是只丢那一个。
最后两态共用 `crop_square`，只换 `title` / `aria-label`。

**默认中性浅色**（`settings.cjs` + `packages/design-tokens/src/accent.ts`）

- `theme` 默认从 `'system'` 改成 `'light'`；`accentMode` 从 `'system'` 改成
  `'custom'`、`accentColor` 从 `'#6750A4'` 改成 `'#FFFFFF'`。
- **顺带修掉一个真 bug**：`deriveSchemeFromAccent` 原来无条件给饱和度加下限
  `max(s, 0.18)`，理由是"太灰的种子派生出来一片灰"。但 `rgbToHsl` 对灰色
  返回的色相是 **0°（红）**，于是"白色"被派生成**淡红色** `#785454` ——
  用户会看到"我选了白色，界面却是粉的"。
  修法：种子饱和度低于 0.04 时走**无彩色分支**，色相与饱和度都不参与派生。
  现在 `#FFFFFF` 派生出来是纯灰（`--primary: #666666`，
  `--secondary-container: #E6E6E6`）。
- 验证：探针里"热力图最深一档就是主题主色"的输出已经是
  `l4=rgb(102,102,102) vs --primary=#666666`。

**结果**：`pnpm verify:desktop:ui` → **194 项全通过，0 失败**。

**全量回归（这一批改动的验收）**

| 套件                      | 结果                         |
| ------------------------- | ---------------------------- |
| `verify:desktop:ui`       | **194 / 0**                  |
| `verify:desktop:settings` | **88 / 0**（2 项待人工核对） |
| `verify:desktop:history`  | **31 / 0**                   |
| `verify:desktop:import`   | **25 / 0**（2 项待人工核对） |
| `check:probes`            | 62 个脚本语法正确            |
| `oxlint`（改动的 JS）     | 0 错                         |

顺带修掉了一批**指向已删除导航项**的探针（它们会静默点空）：
`settings-probe-driver` 3 处、`ui-probe-driver` 1 处、`history-probe-driver` 4 处、
`ui-tour-driver` 7 处。其中两条断言的真实失败原因与断言名字**完全无关**：

- 「关闭按钮隐藏抽屉」其实是**入口不存在**（点 `nav-library` 落空，设置页没关）；
- 「换种子色后主色真的变了」其实是**点的色块不在预设列表里**
  （`#0078d4` 从来不存在），它以前能过是因为默认种子色恰好与预设不同 ——
  改成中性默认色之后"两次量到同一个颜色"才暴露出来。

**提交**：`142485a`，已 push 到 `origin/dev`（未 merge、未动其它分支）。

---

## 下一步

### 下一件：阶段 2 · 主页卡片化

**基线**：`verify:desktop:ui` = **194 项全通过**。

**具体改动**

1. `history.js` 的 `refresh()` 拆开：热力图 / 快捷入口 / 最近更新 / 播放历史
   四处，搬进各自该在的容器（现在四个都挤在 `#content` 一个流里）。
   ⚠️ 失败态目前会**替换整个 `#content`**（`:566-582`）—— 拆开之后只能替换内容卡，
   不能吃掉 ⑤ 与快捷入口卡。
2. 主页加 `#home-recent-card`（⑤ 最近播放，数据取 `history.resume(1)` 第一条）
   与 `#home-quick-card`（title ① + area ①），两者之间一条竖分隔线。
3. **搜索框从顶栏移进内容卡顶部**（`#search-input` / `#search-button` 保留）。
4. ⚠️ `history.js:390` 的 `scrollIntoView` 与 `:625` 的 `getRowCount()`
   **硬依赖** `[data-testid="history-tabs"]` 与 `history-table tbody tr`，不能删。
5. ⚠️ **热力图 `clientWidth` 陷阱**：`heatmap.js:109-122` 用
   `container.clientWidth || 900`，而 `history.js:328` 在 `heatmap-box` **挂进
   DOM 之前**就同步画了占位网格 → 拿到 900 兜底。若新结构把热力图放进
   `hidden` 或懒挂载容器，它会**永久停在兜底尺寸**。
   探针要加"格子尺寸 != 兜底值"。
6. 新增断言：主页三张卡且**互不重叠**（施工单 §5.4 的通用检查）；
   ⑤ 的内容 = `history.resume(1)[0]`；热力图格子尺寸非兜底。

### 之后（按施工单顺序）

阶段 3（播放卡：marquee 标题、去掉音量滑块、队列按钮改弹浮层）→
阶段 4（播放详情两栏 + 封面主色背景 + **修"歌词不滚动"的既有 bug**）→
阶段 5（队列浮层，单一 DOM 三槽位）→
阶段 6（歌单详情行卡）→
阶段 7（收藏夹卡片化 + 删掉内嵌表格渲染器）→
阶段 8（清理死 CSS、图标尺寸两套真相收敛、reduced-motion 补齐、文档）。

### 已完成（本文件 P0–P6）

原型（`prototype/`）· 播放模式四档 · 图标构建脚本两个 bug ·
阶段 0（播放条进中栏）· 阶段 1（左栏两张卡）· 自绘标题栏 + 默认中性浅色。

### 每一步都要守的纪律

1. **改 DOM 之前先跑一遍"未改探针"的回归并记下数字** ——
   不变的绿说明探针压根没在看那个东西（假绿）。
2. 每阶段结束跑全套：`verify:desktop:ui` / `:settings` / `:history` / `:import` /
   `:media` / `:login` / `:shared` / `:tour`（浅+深）/ `:icons` / `:lyrics-win` /
   `:packaged` + 改动文件的 `oxlint`。
3. 已知环境性失败（不是回归）：依赖真实 B 站音频的用例偶发 `Range 502` 与
   `seek 生效` 失败。
4. `pnpm lint` 在**仓库根**有 14 个**既有**错误（来自移动端包缺
   `expo-module-scripts/tsconfig.base` 等），与桌面端改动无关；判断是否引入新问题时
   只 lint 改动的文件。
5. **不要用 PowerShell 做"读全文 → 改 → 写全文"**（见上面 P4）。
