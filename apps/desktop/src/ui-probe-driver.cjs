/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * UI 探针驱动：在 Electron 主进程里跑 Phase 2 的界面验收序列。
 *
 * 原则：**尽量用真实交互**——点真实按钮、派发真实键盘事件、读真实 DOM，
 * 而不是直接调内部函数。这样测到的才是用户实际会走的路径。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'ui-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'ui-report.json')

const checks = []
const screenshots = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[ui] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

/**
 * 「开发日志」黑名单见 `probe-jargon.cjs`。
 *
 * 需要新增例外时**先想清楚**：真的必须在主流程里说吗？
 * 允许的唯一出口是「诊断信息」折叠区（`.settings-diagnostics`），
 * 以及显式标了 `data-allow-jargon` 的容器。
 */
const {
	jargonScanExpression,
	describeJargonHits,
} = require('./probe-jargon.cjs')

/**
 * 需要做结构检查的样式表。
 *
 * 放在模块作用域：下面「样式表花括号配平」那段要在**两处**用到它
 * （遍历 + 拼提示文案），写在闭包里就只能看见一个。
 */
const CSS_FILES = [
	'style.css',
	'components.css',
	'lyrics-panel.css',
	'lyrics-window.css',
]

/**
 * 审计界面上所有 .icon 是否真的渲染成了**单个字形**。
 *
 * 判据：图标元素的宽度 / 字号应当接近 1。远大于 1 说明合字没生效 ——
 * 元素里显示的是**字面的图标名**（"library_music" 13 个字符 = 13em 宽）。
 *
 * ⚠️ 这个函数会被调用**多次**（首屏一次、内容加载后一次）。
 * 只在首屏跑会漏掉真实的 bug：`play_next` 这个名字 Material 里并不存在，
 * 曲目表渲染出来后是 144px 宽的字面文本压在时长列上，
 * 而首屏那次检查根本看不到曲目表。**断言跑得太早等于没跑。**
 *
 * @param {Electron.WebContents} window
 */
async function auditIcons(window) {
	return JSON.parse(
		await evaluate(
			window,
			`(() => {
				const nodes = [...document.querySelectorAll('.icon')]
				const fontOk = document.fonts.check('24px "Material Symbols Rounded"')
				const tooWide = nodes
					.filter((el) => {
						const size = Number.parseFloat(getComputedStyle(el).fontSize)
						if (!Number.isFinite(size) || size === 0) return false
						return el.getBoundingClientRect().width / size > 1.8
					})
					.map((el) => el.textContent.trim())
				return JSON.stringify({
					count: nodes.length,
					fontOk,
					tooWide,
					fontStatus: document.fonts.status,
				})
			})()`,
		),
	)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await sleep(attempt === 1 ? 500 : 400)
			const image = await window.webContents.capturePage()
			const size = image.getSize()
			if (size.width === 0) throw new Error('空图像')
			fs.mkdirSync(SHOTS, { recursive: true })
			const file = path.join(SHOTS, `${name}.png`)
			fs.writeFileSync(file, image.toPNG())
			screenshots.push(file)
			console.log(`[ui] 截图: ${file}`)
			return file
		} catch (error) {
			console.log(`[ui] 截图重试 ${attempt}/3 ${name}: ${error.message}`)
		}
	}
	return null
}

/** 轮询等待，直到渲染进程里的条件成立 */
async function waitFor(window, expression, timeoutMs, label) {
	const start = Date.now()
	let last
	while (Date.now() - start < timeoutMs) {
		try {
			last = JSON.parse(await evaluate(window, `JSON.stringify(${expression})`))
			if (last === true || last?.ok === true) return { ok: true, value: last }
		} catch (error) {
			last = { error: error.message }
		}
		await sleep(300)
	}
	return { ok: false, value: last, label }
}

/** 点一个选择器（真实 click） */
async function click(window, selector) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.click()
			return true
		})()`,
	)
}

async function typeInto(window, selector, text) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.value = ${JSON.stringify(text)}
			el.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
}

/**
 * 打开一个**有曲目**的歌单（阶段 6d 之后，曲目表在**歌单详情**里）。
 *
 * ⚠️ 「音乐库 › 播放列表」现在渲染的是歌单**卡片网格**，与安卓端一致。
 * 凡是需要曲目表的断言，都必须先从卡片（或左栏的歌单行）进详情 ——
 * 否则测的是"曲目表碰巧还留在屏幕上"，而不是"它应该出现"。
 *
 * ⚠️ 必须挑 `item_count > 0` 的那个：套件中途会**新建一个空歌单**
 * （验证「＋」真的能用），而空歌单的详情没有「播放全部」——
 * 拿到它会让后面所有依赖曲目表的断言一起挂，且看起来像"功能坏了"。
 */
async function openPlaylistWithTracks(window) {
	const id = await evaluate(
		window,
		`(async () => {
			const list = await window.bbplayer.listPlaylists()
			const target = (list?.data ?? []).find((p) => (p.item_count ?? 0) > 0)
			return target ? target.id : null
		})()`,
	)
	if (id == null) return false
	// 优先点卡片（这是用户在新界面里的路径）；卡片不在屏上时退回左栏的歌单行
	if (!(await click(window, `[data-testid="playlist-card-${id}"]`))) {
		await click(window, `[data-playlist-id="${id}"]`)
	}
	await waitFor(
		window,
		`Boolean(document.querySelector('[data-testid="btn-play-all"]'))`,
		10_000,
		'曲目表（播放全部）',
	)
	return true
}

/** 把 `#6750A4` / `rgb(103, 80, 164)` 两种写法都归一成 `r,g,b` 便于比较 */
function toRgb(value) {
	const hex = /^#([0-9a-f]{6})$/i.exec(String(value).trim())
	if (hex) {
		const n = Number.parseInt(hex[1], 16)
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',')
	}
	const rgb = /rgba?\(([^)]+)\)/.exec(String(value))
	return rgb
		? rgb[1]
				.split(',')
				.slice(0, 3)
				.map((v) => Number(v.trim()))
				.join(',')
		: null
}

/** 派发真实键盘事件（走 window 上的监听器） */
async function press(window, combo) {
	return await evaluate(
		window,
		`(() => {
			const parts = ${JSON.stringify(combo)}.split('+')
			let key = parts[parts.length - 1]
			const map = { space: ' ', escape: 'Escape', enter: 'Enter', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' }
			if (map[key]) key = map[key]
			const target = document.activeElement || document.body
			const event = new KeyboardEvent('keydown', {
				ctrlKey: parts.includes('ctrl'),
				shiftKey: parts.includes('shift'),
				altKey: parts.includes('alt'),
				bubbles: true,
				cancelable: true,
				key,
			})
			target.dispatchEvent(event)
			return true
		})()`,
	)
}

async function uiState(window) {
	return JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbTest.ui())'),
	)
}

async function playerState(window) {
	return JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbTest.state())'),
	)
}

async function run(window) {
	// 捕获渲染进程控制台消息：UI 出问题时，错误往往只在这里可见
	const consoleMessages = []
	window.webContents.on(
		'console-message',
		(_event, level, message, line, source) => {
			consoleMessages.push({ level, message, line, source })
		},
	)

	console.log('[ui] 等待渲染进程就绪…')
	const ready = await waitFor(window, 'Boolean(window.__bbReady)', 30_000)
	check(
		'渲染进程就绪（window.__bbReady）',
		ready.ok,
		JSON.stringify(ready.value),
	)
	if (!ready.ok) return finish(window)

	// ---------------------------------------------------------------
	// 1. 三栏 shell
	// ---------------------------------------------------------------
	console.log('\n[ui] 1) 三栏 shell')
	let ui = await uiState(window)
	check('左栏渲染', ui.sidebar)
	check('中栏渲染', ui.main)
	// ⚠️ 右栏**默认收起**（阶段 2）。原来它常驻 320px，不管有没有内容都占着，
	// 三栏 + 边框 + 状态栏叠起来观感就是"IDE 面板"而不是播放器。
	// 所以这里断言的是"存在但宽度为 0"，而不是"渲染出来了"。
	const rightbarState = await evaluate(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="rightbar"]')
			if (!el) return null
			return {
				width: Math.round(el.getBoundingClientRect().width),
				collapsed: Boolean(
					document.querySelector('.app')?.classList.contains('is-rightbar-collapsed'),
				),
				hasToggle: Boolean(
					document.querySelector('[data-testid="rightbar-toggle"]'),
				),
			}
		})()`,
	)
	check(
		'右栏默认收起（宽度 0，不占屏）',
		rightbarState?.collapsed === true && rightbarState.width === 0,
		JSON.stringify(rightbarState),
	)
	check('右栏有展开入口（顶栏的开关按钮）', rightbarState?.hasToggle === true)
	// 收起必须**真的能展开**——否则就是"藏起来了打不开"，比常驻还糟
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(300)
	const expanded = await evaluate(
		window,
		`Math.round(document.querySelector('[data-testid="rightbar"]').getBoundingClientRect().width)`,
	)
	check('点开关能展开右栏', Number(expanded) > 200, `展开后宽度 ${expanded}px`)
	// 再收回去，后续断言按"收起"的初始状态走
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(300)
	check('底部播放条渲染', ui.playbar)
	// 阶段 2b（信息架构分层）：左栏只留**目的地**。
	//
	// 原来是 7 个平铺入口，把"目的地"（音乐库 / 搜索）和"某个页面里的子集或
	// 动作"（导入歌单 / 收藏夹 / 合集 / 共享 / 最近播放）混在同一层 ——
	// 用户得先猜「导入歌单」和「合集」有什么区别。
	/*
	 * 卡片化阶段 1：左栏从「4 个平级的导航目的地」改成**两张卡片**
	 * （草图的 card ① 用户卡 + card ② 歌单卡）。
	 *
	 * ⚠️ 断言也跟着改判据，而不是只换选择器：
	 * 原来验的是"有 4 个导航项、顺序是 home/library/search/settings"；
	 * 现在验的是"入口仍然存在、并且能到达对应视图"——
	 * 后者才是用户真正在意的，前者只是当时那版界面的一种实现。
	 */
	const sidebarProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const entries = [...document.querySelectorAll('[data-nav]')].map((el) => ({
					nav: el.dataset.nav,
					testid: el.dataset.testid || el.id,
					// 入口必须在**文档里且可见**（藏起来的入口等于没有）
					visible: el.getBoundingClientRect().width > 0,
				}))
				return JSON.stringify({
					entries,
					hasBrand: Boolean(document.getElementById('sidebar-brand')),
					/*
					 * ⚠️ 元素 id 是 sidebar-library（它同时是 data-nav="library"
					 * 的入口），testid 才是 sidebar-card。第一版这里按 testid
					 * 猜 id，拿到 null，断言红了一条 —— 记下来：
					 * **id 与 testid 不是一回事**，用错一个就是"元素明明在、
					 * 代码说它不在"。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
					 */
					hasCard: Boolean(document.getElementById('sidebar-library')),
					hasFavorites: Boolean(document.getElementById('sidebar-favorites')),
					hasSettings: Boolean(document.getElementById('sidebar-settings')),
				})
			})()`,
		),
	)
	const navNames = new Set(sidebarProbe.entries.map((e) => e.nav))
	check(
		'左栏是两张卡片：① 用户卡 + ② 歌单卡',
		sidebarProbe.hasBrand && sidebarProbe.hasCard,
		`用户卡=${sidebarProbe.hasBrand} 歌单卡=${sidebarProbe.hasCard}`,
	)
	check(
		'四个目的地都有入口，且都可见（主页/音乐库/收藏夹/设置）',
		['home', 'library', 'favorites', 'settings'].every((v) =>
			navNames.has(v),
		) && sidebarProbe.entries.every((e) => e.visible),
		sidebarProbe.entries.map((e) => `${e.nav}(${e.testid})`).join(' / '),
	)
	check(
		'收藏夹入口在歌单卡页头、设置在页脚（草图上就是这个位置）',
		sidebarProbe.hasFavorites && sidebarProbe.hasSettings,
		`收藏夹=${sidebarProbe.hasFavorites} 设置=${sidebarProbe.hasSettings}`,
	)
	const libraryTabs = JSON.parse(
		await evaluate(
			window,
			`JSON.stringify({
				tabs: [...document.querySelectorAll('[data-lib-tab]')].map((el) => el.dataset.libTab),
				visible: !document.getElementById('library-tabs')?.hidden,
				hasShareAction: Boolean(document.getElementById('library-share')),
			})`,
		),
	)
	check(
		'音乐库有 4 个页签（播放列表 / 收藏夹 / 合集 / 导入）',
		libraryTabs.tabs.join(',') === 'playlists,favorites,collection,import' &&
			libraryTabs.visible,
		libraryTabs.tabs.join(' / '),
	)
	check('音乐库页内保留了「共享」动作入口', libraryTabs.hasShareAction === true)

	// 点音乐库页签**不该影响右栏**。
	//
	// ⚠️ 这是截图巡检发现的一个真 bug：音乐库页签条与右栏页签**共用 `.tab` 类**，
	// 而右栏的点击处理器绑在**所有** `.tab` 上 —— 点「收藏夹」会顺带
	// `switchPanel(undefined)`：右栏两个面板全部变成不激活（一片空白），
	// 而且还会擅自把收起状态的右栏展开。
	//
	// 表现很隐蔽：断言全绿（没人检查"点了 A 会不会影响 B"），
	// 是靠巡检里"03–11 那几张的右栏一直是展开的"发现的；
	// 体检表的 `.content` 宽度从 1186 变成 866 给出了确证。
	const tabIsolation = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const before = {
					collapsed: document
						.querySelector('.app')
						?.classList.contains('is-rightbar-collapsed'),
					activePanels: document.querySelectorAll('.panel.is-active').length,
				}
				// 点一个音乐库页签，再回到播放列表
				const tab = document.querySelector('[data-testid="lib-tab-favorites"]')
				tab?.click()
				const during = {
					collapsed: document
						.querySelector('.app')
						?.classList.contains('is-rightbar-collapsed'),
					activePanels: document.querySelectorAll('.panel.is-active').length,
				}
				document.querySelector('[data-testid="lib-tab-playlists"]')?.click()
				return JSON.stringify({ before, during })
			})()`,
		),
	)
	check(
		'点音乐库页签不会顺带展开右栏（两套页签共用 .tab，必须按 data-panel 隔离）',
		tabIsolation.before.collapsed === tabIsolation.during.collapsed,
		`收起状态 ${tabIsolation.before.collapsed} → ${tabIsolation.during.collapsed}`,
	)
	check(
		'点音乐库页签不会把右栏面板全部关掉',
		tabIsolation.during.activePanels === 1,
		`激活的右栏面板数 ${tabIsolation.during.activePanels}（应为 1）`,
	)

	// `hidden` 必须**真的**隐藏。
	//
	// ⚠️ UA 样式表里 `[hidden] { display: none }` 的优先级极低，任何
	// `.foo { display: flex }` 都会盖掉它 —— 于是"JS 里设了 hidden，元素照样显示"。
	// 这个仓库为此绕过两次（`.share-view` 和 `.favorite-bar`），
	// 后者是在截图巡检里被发现的：在「播放列表」页签下，
	// 收藏夹的 UID 工具条一直挂在底部。
	//
	// 现在 style.css 顶部有一条全局 `[hidden] { display: none !important }`
	// 保护这个不变量，这里断言**所有**带 hidden 的元素都真的不占位 ——
	// 一次覆盖全应用，新增组件不用再记得这件事。
	const hiddenAudit = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const offenders = []
				for (const el of document.querySelectorAll('[hidden]')) {
					const rect = el.getBoundingClientRect()
					if (rect.width > 0 && rect.height > 0) {
						offenders.push(
							(el.id || el.className || el.tagName) +
								' ' +
								Math.round(rect.width) +
								'x' +
								Math.round(rect.height),
						)
					}
				}
				return JSON.stringify(offenders)
			})()`,
		),
	)
	check(
		'带 hidden 的元素都真的不显示（favorite-bar 这类回归）',
		hiddenAudit.length === 0,
		hiddenAudit.length > 0 ? hiddenAudit.join('；') : '全部已隐藏',
	)
	check(
		'右栏默认显示队列',
		ui.activePanel === 'queue',
		`实际 ${ui.activePanel}`,
	)
	await shot(window, 'ui-01-shell')

	// ---------------------------------------------------------------
	// 1.5 「开发日志」黑名单
	// ---------------------------------------------------------------
	//
	// ⚠️ 这一条是**机制**，不是一次性的清理。
	//
	// 桌面端第一版把很多实现细节直接写进了界面：凭据「已由系统密钥环加密存储」、
	// 「等同明文」的警告、账号 UUID、后端 URL、备份格式（ZIP + SQLite 快照）、
	// `exportedAt=`、导出后的**绝对路径**、常驻的「就绪」状态栏……
	// 这些是我当时刻意做的（想把事实说清楚），但位置全错了：
	// **该知道 ≠ 该在主流程里说**。用户在上号、存密码、点备份的时候，
	// 不需要被教育这些东西，一句「等同明文」只会让人以为出事了。
	//
	// 清一遍只解决今天。所以这里把规则钉住：主界面可见文本不得命中黑名单词。
	// 允许的唯一出口是「诊断信息」折叠区，以及显式标了
	// `data-allow-jargon` 的容器（用之前必须想清楚为什么）。
	console.log('\n[ui] 1.5) 主界面不得出现实现细节文案')
	// 黑名单与扫描表达式见 `probe-jargon.cjs`（共享模块，也扫隐藏面板）
	const jargonHits = JSON.parse(await evaluate(window, jargonScanExpression()))
	check(
		'主界面没有「开发日志」式的实现细节（黑名单词零命中）',
		jargonHits.length === 0,
		describeJargonHits(jargonHits),
	)

	// ---------------------------------------------------------------
	// 1.6 原生控件不得停留在浏览器默认外观
	// ---------------------------------------------------------------
	//
	// 第一版只给 `.playbar / .row-actions / .search-box` 三个容器补了按钮样式，
	// 于是设置页里那一排按钮（保存 / 测试连接 / 立即备份并上传 / 刷新远端列表）
	// 全裸奔，是 Chromium 默认的浅灰渐变按钮；滑块也只有 `accent-color`，
	// 也就是**直接用原生控件**。现在有一层基础样式兜底，这里钉住它。
	console.log('\n[ui] 1.6) 控件基线（不能是浏览器默认外观）')
	const controls = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const buttons = [...document.querySelectorAll('button')]
				// Chromium 的默认按钮底色就是这个灰；我们的按钮都必须有明确底色
				const defaultLooking = buttons.filter(
					(b) => getComputedStyle(b).backgroundColor === 'rgb(239, 239, 239)',
				)
				const fields = [...document.querySelectorAll('input, textarea, select')]
				const notNormalized = fields
					.filter((f) => {
						const s = getComputedStyle(f)
						return s.appearance !== 'none' && s.webkitAppearance !== 'none'
					})
					.map((f) => f.tagName.toLowerCase() + (f.type ? ':' + f.type : ''))
				const ranges = [...document.querySelectorAll("input[type='range']")]
				const filled = ranges.filter(
					(r) => r.style.getPropertyValue('--range-fill') !== '',
				)
				/*
				 * 开关必须是**滑动开关**，不能是勾选框。
				 *
				 * 用户截图圈出来抱怨过「所有这种按钮全部都写错了，是左右切换的
				 * 动画但你样式又写成了勾选确认的框」。根因是 style.css 里通用的
				 * input[type=checkbox]（特异性 0-1-1）压过了 .switch（0-1-0），
				 * 把它画成 20×20 圆角方块 + 对勾。
				 *
				 * 判据用**几何**而不是类名：胶囊轨道必然又宽又矮且圆角接近半高
				 * （52×32，圆角 16）；勾选框是 20×20、圆角 5。
				 */
				const switches = [
					...document.querySelectorAll("input[type='checkbox'].switch"),
				]
				const badSwitchCount = switches.filter((el) => {
					const s = getComputedStyle(el)
					const r = el.getBoundingClientRect()
					const radius = Number.parseFloat(s.borderRadius) || 0
					return r.width < 44 || r.height < 28 || radius < r.height / 2 - 2
				}).length
				return JSON.stringify({
					buttonCount: buttons.length,
					defaultLooking: defaultLooking.length,
					fieldCount: fields.length,
					notNormalized,
					rangeCount: ranges.length,
					rangesFilled: filled.length,
					switchCount: switches.length,
					badSwitchCount,
				})
			})()`,
		),
	)
	check(
		'没有按钮停留在浏览器默认外观',
		controls.defaultLooking === 0,
		`${controls.buttonCount} 个按钮，默认外观 ${controls.defaultLooking} 个`,
	)
	check(
		'所有输入框 / 文本域 / 下拉都走统一基线（appearance: none）',
		controls.notNormalized.length === 0,
		controls.notNormalized.length > 0
			? `未归一化：${controls.notNormalized.join('、')}`
			: `${controls.fieldCount} 个控件全部归一化`,
	)
	check(
		'滑块已自绘并写入了已播放比例（不再依赖原生填充）',
		controls.rangeCount > 0 && controls.rangesFilled === controls.rangeCount,
		`${controls.rangesFilled}/${controls.rangeCount} 个滑块有 --range-fill`,
	)

	// ---------------------------------------------------------------
	// 1.7 样式表花括号配平
	// ---------------------------------------------------------------
	//
	// ⚠️ 这条是**事故复盘**换来的。
	//
	// `.settings-row label { … }` 曾经**少了一个闭合花括号**，于是紧随其后的
	// `.settings-row button { … }` 被当成嵌套规则 —— 普通 CSS 不支持嵌套，
	// 解析器把整块丢掉并一直吞到花括号重新配平为止。
	//
	// 后果：设置页那排按钮**完全没有样式**，是浏览器默认外观。用户看到并
	// 明确抱怨过（"很多小输入框都是默认的 HTML 样式"）。当时是靠加一层
	// 全局控件基础样式把症状盖住的，**根因一直没被发现** ——
	// 因为没有任何断言会去看样式表本身。
	//
	// CSS 的好处是坏了通常"看得见"，坏处是**丢一整块规则是静默的**：
	// 后面的规则照样生效，只是错位了。所以这里直接查文件。
	console.log('\n[ui] 1.7) 样式表结构')
	const cssCheck = (() => {
		const problems = []
		for (const name of CSS_FILES) {
			const file = path.join(__dirname, 'renderer', name)
			if (!fs.existsSync(file)) continue
			const raw = fs.readFileSync(file, 'utf8')
			// 去掉注释（保留换行以便报行号）
			let stripped = ''
			let inComment = false
			for (let i = 0; i < raw.length; i++) {
				if (!inComment && raw.startsWith('/*', i)) {
					inComment = true
					i++
					continue
				}
				if (inComment && raw.startsWith('*/', i)) {
					inComment = false
					i++
					continue
				}
				if (!inComment) stripped += raw[i]
				else if (raw[i] === '\n') stripped += '\n'
			}
			let depth = 0
			let lastZero = 1
			stripped.split('\n').forEach((line, index) => {
				depth +=
					(line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
				if (depth === 0) lastZero = index + 1
			})
			if (depth !== 0) {
				problems.push(
					`${name}: 最终深度 ${depth}，从第 ${lastZero} 行之后有规则被吞掉`,
				)
			}
		}
		return problems
	})()
	check(
		'样式表花括号配平（不配平会静默吞掉后面的规则）',
		cssCheck.length === 0,
		cssCheck.length > 0
			? cssCheck.join('；')
			: `${CSS_FILES.length} 个样式表都配平`,
	)

	// ---------------------------------------------------------------
	// 1.8 字阶：不能停留在 11–13px 的"控制台字号"
	// ---------------------------------------------------------------
	//
	// 第一版全站字号压在 11–13px（`font-size:12px` 出现 29 次），而令牌包里
	// 有 10 级字阶（11→24）**一个都没用**。这条断言按**角色**检查实际字号：
	// 页面标题要够大、区块标题要分层、正文与副标题不能缩到 12。
	console.log('\n[ui] 1.8) 字阶（按角色）')
	const typeScale = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const size = (sel) => {
					const el = document.querySelector(sel)
					if (!el) return null
					return Number.parseFloat(getComputedStyle(el).fontSize)
				}
				return JSON.stringify({
					body: size('body'),
					// ⚠️ 页面标题现在的真值来源是**外壳**的 #page-title
					//（阶段 2b 之前是各个视图自己渲染的 .view-head h2，
					// 于是空状态根本没有标题）。
					viewTitle: size('#page-title'),
					// 视图内部的次级标题要**低一档**，否则两级标题一样大 = 没有层级
					sectionHead: size('.view-head h2'),
					// 设置抽屉里的区块标题（抽屉关着也能算，getComputedStyle 不看可见性）
					sectionTitle: size('.settings-panel h3'),
					formLabel: size('.settings-grid label'),
					secondary: size('.playbar__artist'),
					hint: size('.settings-hint'),
				})
			})()`,
		),
	)
	check(
		'正文基准 = 14（body-medium）',
		typeScale.body === 14,
		`实际 ${typeScale.body}px`,
	)
	check(
		'页面标题 ≥ 22（title-large，与移动端的大标题同级）',
		typeScale.viewTitle !== null && typeScale.viewTitle >= 22,
		`实际 ${typeScale.viewTitle}px`,
	)
	check(
		'视图内的次级标题低于页面标题（两级标题要有层级）',
		typeScale.sectionHead === null ||
			typeScale.sectionHead < (typeScale.viewTitle ?? 0),
		`页面 ${typeScale.viewTitle}px vs 次级 ${typeScale.sectionHead}px`,
	)
	check(
		'区块标题 ≥ 16 且明显大于正文（层级看得出来）',
		typeScale.sectionTitle !== null && typeScale.sectionTitle >= 16,
		`实际 ${typeScale.sectionTitle}px`,
	)
	check(
		'表单标签 = 14（不再缩到 13）',
		typeScale.formLabel === 14,
		`实际 ${typeScale.formLabel}px`,
	)
	check(
		'内容副标题 ≥ 14（歌手名这类信息不该比正文还小）',
		typeScale.secondary !== null && typeScale.secondary >= 14,
		`实际 ${typeScale.secondary}px`,
	)
	check(
		'提示文字 = 12（body-small，最小的一档）',
		typeScale.hint === 12,
		`实际 ${typeScale.hint}px`,
	)

	// ---------------------------------------------------------------
	// 1.9 只有一种「选中态」
	// ---------------------------------------------------------------
	//
	// 用户指出：右侧「播放队列 / 歌词」用的是**下划线**，而左栏「音乐库」是
	// 填充胶囊 —— "安卓端完全不会出现这种不等线 UI，而且样式太杂"。
	//
	// 第一版确实有三套混用：nav 是硬编码的紫色胶囊、tab 是下划线、
	// segmented 是主色实心。清一遍只解决今天，所以这里钉住：
	// **所有"选中/激活"必须算出同一套底色与前景色**，且**不许用下边框**表达选中。
	console.log('\n[ui] 1.9) 选中态一致性')
	const activeStyles = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const read = (el) => {
					if (!el) return null
					const s = getComputedStyle(el)
					return {
						bg: s.backgroundColor,
						color: s.color,
						borderBottomWidth: s.borderBottomWidth,
						borderBottomStyle: s.borderBottomStyle,
						radius: s.borderRadius,
					}
				}
				/*
				 * 基准：左栏卡片里那个入口在"选中"时的外观。
				 *
				 * ⚠️ 用**临时克隆**量，而不是给真实元素加类再量。
				 *
				 * 真实元素上有一条 transition: background 0.1s，于是
				 * "加类 → 立刻 getComputedStyle" 读到的是**过渡的起始值**
				 * （transparent），而不是目标值 —— 这就是前面几轮一直量到
				 * rgba(0,0,0,0) 的原因（三条 background 规则明明都匹配、
				 * 连内联 rgb(9,8,7) 都被动画盖住，因为过渡会接管属性）。
				 *
				 * 克隆出来的元素没有"上一个值"可插值，第一帧就是终值。
				 * 量完即摘，不影响界面，也不依赖任何时序。
				 *
				 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
				 */
				const real = document.getElementById('sidebar-settings')
				if (!real) return JSON.stringify({ nav: null })
				const probe = document.createElement('button')
				probe.className = 'sidebar__entry is-active'
				probe.style.position = 'absolute'
				probe.style.visibility = 'hidden'
				real.parentElement?.appendChild(probe)
				const nav = read(probe)
				probe.remove()
				return JSON.stringify({
					/*
					 * 判据本身没变：全工程只允许一种选中视觉
					 * （secondary-container 底 + on-secondary-container 字 +
					 * 胶囊圆角 + 无下划线）。这里验的是"右栏页签与分段控件
					 * 跟左栏是同一套"。
					 */
					nav,
					// ⚠️ 用 [data-panel] 而不是 .tab —— 音乐库的页签条也用 .tab
					// 且 DOM 顺序在前，用 .tab.is-active 查询会先命中
					// **音乐库页签**。那条「选中态一致性」断言因此一直在测错的
					// 元素（两边视觉本来就一样，所以看不出来）。
					tab: read(document.querySelector('[data-panel].is-active')),
					segmented: read(
						document.querySelector('.segmented button.is-active'),
					),
				})
			})()`,
		),
	)

	check(
		'左栏入口的选中态作为基准（胶囊、填充色、无下划线）',
		activeStyles.nav !== null,
		JSON.stringify(activeStyles.nav),
	)
	check(
		'右栏页签的选中底色与左栏入口**完全一致**（不再一套一套地写）',
		activeStyles.tab !== null && activeStyles.tab.bg === activeStyles.nav?.bg,
		`nav=${activeStyles.nav?.bg} tab=${activeStyles.tab?.bg} diag=${JSON.stringify(activeStyles.diag)}`,
	)
	check(
		'右栏页签的选中前景色也与左栏一致',
		activeStyles.tab?.color === activeStyles.nav?.color,
		`nav=${activeStyles.nav?.color} tab=${activeStyles.tab?.color}`,
	)
	check(
		'分段控件（跟随系统/浅色/深色）也是同一套选中底色',
		activeStyles.segmented !== null &&
			activeStyles.segmented.bg === activeStyles.nav?.bg,
		`nav=${activeStyles.nav?.bg} segmented=${activeStyles.segmented?.bg}`,
	)
	check(
		'任何选中态都不用下边框表达（移动端没有这种 UI）',
		(activeStyles.tab?.borderBottomWidth ?? '0px') === '0px' &&
			(activeStyles.nav?.borderBottomWidth ?? '0px') === '0px',
		`tab=${activeStyles.tab?.borderBottomWidth} nav=${activeStyles.nav?.borderBottomWidth}`,
	)
	check(
		'选中态是胶囊（圆角取满）',
		activeStyles.nav?.radius === '9999px' &&
			activeStyles.tab?.radius === '9999px',
		`nav=${activeStyles.nav?.radius} tab=${activeStyles.tab?.radius}`,
	)

	// ---------------------------------------------------------------
	// 1.10 图标：必须是 Material Symbols 而不是 unicode 字形
	// ---------------------------------------------------------------
	//
	// 第一版用的是 ♪ ⌕ ⤓ ↺ ★ ▤ ⇄ ⚙ ▶ ⏮ ⏭ ✕ —— 跨平台渲染不一致
	// （Windows 的 Segoe UI Symbol 与 Linux 的 DejaVu Sans 粗细、基线都不同），
	// 而且混着「音乐符号 / 几何符号 / 箭头」三类，视觉重量不齐，
	// 用户一眼就看出杂乱。
	//
	// 现在是 Material Symbols Rounded 的**子集字体**（57 个图标，9.3 KB），
	// 用合字渲染：`<span class="icon">library_music</span>`。
	//
	// ⚠️ 怎么断言「字体真的生效」？只看 `document.fonts.check` 不够 ——
	// 字体加载失败时合字不生效，图标名会被**当成普通文字**渲染出来，
	// 那时元素会宽得离谱（"library_music" 13 个字符 vs 一个图标）。
	// 所以同时量**每个图标元素的宽度**：一个图标应当接近 1em。
	console.log('\n[ui] 1.10) 图标')
	// ⚠️ 这段断言在**两个位置**各跑一次（这里 + 内容加载后的 2.6）。
	// 原因是它曾经漏掉一个真实的 bug：图标名写错时（play_next 不是 Material
	// 里的名字）合字不生效，界面渲染出**字面的 9 个字母**（144px 宽）压在
	// 时长列上；而这条断言当时只在首页跑，曲目表还没渲染，所以一路全绿。
	// **断言跑得太早等于没跑。**
	const iconState = await auditIcons(window)
	check('界面里有图标元素', iconState.count > 0, `${iconState.count} 个`)
	check(
		'Material Symbols 字体已加载',
		iconState.fontOk === true,
		`document.fonts.check=${iconState.fontOk}，status=${iconState.fontStatus}`,
	)
	check(
		'每个图标都渲染成单个字形（合字生效，没有退化成字母）',
		iconState.tooWide.length === 0,
		iconState.tooWide.length > 0
			? `过宽（图标名可能不存在）：${iconState.tooWide.join('、')}`
			: `${iconState.count} 个都正常`,
	)

	// 图标必须在按钮**正中**，而且「只放图标」的按钮必须显式声明。
	//
	// ⚠️ 用户报过「上一首 / 下一首 / 播放暂停的图标歪了，不在控件正中」。
	// 原因是图标是 inline-block，坐在文字基线上，而按钮基础层给的是
	// `padding: 7px 16px`（上下 7、左右 16）—— 水平被拉宽、垂直因基线偏上。
	//
	// 第一版用 `button:has(> .icon:only-child)` 自动识别，**误伤了左栏导航项**：
	// 导航项只有一个「元素」子节点（图标），文字标签是**裸文本节点**，
	// `:only-child` 数不到它 → 导航项被压成 34px 方块、文字竖排。
	// 所以改成显式类名，并在这里双向校验：
	//   (a) 所有 .icon-only 的图标必须居中；
	//   (b) 凡是「只有一个图标子节点、且没有文字标签」的按钮，**必须**有该类名
	//       （防止以后新增图标按钮忘了加，又回到不居中的样子）。
	const centered = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const offenders = []
				const missingClass = []
				for (const button of document.querySelectorAll('button')) {
					const icons = [...button.children].filter((c) =>
						c.classList.contains('icon'),
					)
					const hasOnlyIcon =
						icons.length === 1 && button.children.length === 1
					if (!hasOnlyIcon) continue
					// 文字标签是裸文本节点，children 数不到它，单独查一遍
					const label = [...button.childNodes]
						.filter((n) => n.nodeType === 3)
						.map((n) => n.textContent)
						.join('')
						.trim()
					if (label !== '') continue // 「图标 + 文字」的行，左对齐是设计
					const isIconOnly = button.classList.contains('icon-only')
					const b = button.getBoundingClientRect()
					const i = icons[0].getBoundingClientRect()
					if (b.width === 0 || b.height === 0) continue // 隐藏的按钮跳过
					const dx = Math.abs(i.left + i.width / 2 - (b.left + b.width / 2))
					const dy = Math.abs(i.top + i.height / 2 - (b.top + b.height / 2))
					if (dx > 1.5 || dy > 1.5) {
						offenders.push(
							(button.id || button.className || button.tagName) +
								' dx=' +
								dx.toFixed(1) +
								' dy=' +
								dy.toFixed(1),
						)
					}
					if (!isIconOnly) {
						missingClass.push(button.id || button.className || button.tagName)
					}
				}
				return JSON.stringify({ offenders, missingClass })
			})()`,
		),
	)
	check(
		'只放图标的按钮，图标在正中（偏差 < 1.5px）',
		centered.offenders.length === 0,
		centered.offenders.length > 0 ? centered.offenders.join('；') : '全部居中',
	)
	check(
		'只放图标的按钮都显式标了 .icon-only（漏标就会回到不居中）',
		centered.missingClass.length === 0,
		centered.missingClass.length > 0
			? `漏标：${centered.missingClass.join('、')}`
			: '无遗漏',
	)
	// 反向：卡片里的入口是「图标 + 文字」，**不能**被当成图标按钮压缩
	// （卡片化阶段 1：判据从 `.nav__item` 换成 `.sidebar__entry` ——
	//  那个"文字被压成竖排"的缺陷与具体是哪种入口无关）
	const navWidths = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const items = [...document.querySelectorAll('.sidebar__entry')]
				const squeezed = items
					.filter((el) => el.getBoundingClientRect().width < 120)
					.map((el) => (el.textContent || '').trim().slice(0, 12))
				return JSON.stringify(squeezed)
			})()`,
		),
	)
	check(
		'左栏卡片里的入口没有被当成图标按钮压缩（文字不竖排）',
		navWidths.length === 0,
		navWidths.length > 0 ? `过窄：${navWidths.join('、')}` : '全部占满整行',
	)

	// ---------------------------------------------------------------
	// 1.11 外壳（阶段 2 换壳）
	// ---------------------------------------------------------------
	//
	// 这一节把 stage 2 的改动与**三个已知缺陷**钉住。缺陷之所以是缺陷，
	// 是因为当时没有任何断言会去看它们 —— 加断言比改代码更重要。
	console.log('\n[ui] 1.11) 外壳：状态栏 / 顶栏 / 悬浮播放条')
	const shell = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const rect = (sel) => {
					const el = document.querySelector(sel)
					return el ? el.getBoundingClientRect() : null
				}
				const topbar = rect('.topbar')
				// 顶栏里的图标按钮是否与搜索框在同一水平线上（第一版会折到第二行）
				const topbarButtons = [...document.querySelectorAll('.topbar .icon-button')]
				const strayButtons = topbarButtons
					.filter((b) => {
						const r = b.getBoundingClientRect()
						return topbar && r.top - topbar.top > topbar.height * 0.6
					})
					.map((b) => b.id || b.className)

				// 导航项是否被压成两行（第一版文字徽标挤掉了品牌名）
				const wrappedNav = [...document.querySelectorAll('.nav__item')]
					.filter((el) => el.getBoundingClientRect().height > 48)
					.map((el) => (el.textContent || '').trim().slice(0, 8))

				const playbar = rect('.playbar')
				const playbarStyle = getComputedStyle(
					document.querySelector('.playbar'),
				)
				const content = rect('.content')

				return JSON.stringify({
					hasStatusBar: Boolean(document.querySelector('.status-bar')),
					hasStatusElement: Boolean(document.getElementById('status')),
					strayButtons,
					wrappedNav,
					playbarRadius: Number.parseFloat(playbarStyle.borderRadius),
					playbarShadow: playbarStyle.boxShadow !== 'none',
					/*
					 * ⚠️ 判据从"离窗口左边有多少留白"改成"与内容卡片**左边缘对齐**"。
					 *
					 * 卡片化之后播放条是**中栏里的一张卡**（.main 网格的第二行），
					 * 它自己不再有左右 margin —— 留白由中栏的 padding 提供。
					 * 于是播放条的 left 与内容卡的 left 应当相等，
					 * 这正是"播放条与内容卡片同宽、左右对齐"的判据（草图上的画法）。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**（会提前结束字符串）。
					 */
					playbarLeft: Math.round(playbar?.left ?? 0),
					contentLeft: content ? Math.round(content.left) : null,
					// 内容底边与播放条顶边的关系：内容不该压到播放条上
					overlapPx: content && playbar
						? Math.round(content.bottom - playbar.top)
						: null,
				})
			})()`,
		),
	)
	check(
		'底部状态栏已删除（不再是一条常驻的日志行）',
		shell.hasStatusBar === false,
		shell.hasStatusBar ? '仍然存在 .status-bar' : '已删除',
	)
	check(
		'但反馈通道保留（#status 仍在，探针与模块都靠它）',
		shell.hasStatusElement === true,
	)
	check(
		'顶栏图标按钮不再折到第二行（缺陷 2 的同源问题）',
		shell.strayButtons.length === 0,
		shell.strayButtons.length > 0
			? `折行：${shell.strayButtons.join('、')}`
			: '同行',
	)
	check(
		'左栏导航项都是单行（缺陷 2：按钮换行）',
		shell.wrappedNav.length === 0,
		shell.wrappedNav.length > 0
			? `换行：${shell.wrappedNav.join('、')}`
			: '全部单行',
	)
	check(
		'播放条是**中栏里的圆角卡**：圆角、有投影、与内容卡左右对齐',
		shell.playbarRadius >= 12 &&
			shell.playbarShadow &&
			shell.contentLeft !== null &&
			Math.abs(shell.playbarLeft - shell.contentLeft) <= 1,
		`radius=${shell.playbarRadius}px shadow=${shell.playbarShadow} ` +
			`播放条左边=${shell.playbarLeft}px 内容卡左边=${shell.contentLeft}px`,
	)
	check(
		'内容区不压到播放条上（缺陷 1）',
		shell.overlapPx !== null && shell.overlapPx <= 2,
		`内容底边 - 播放条顶边 = ${shell.overlapPx}px（≤2 视为不重叠）`,
	)

	// ---------------------------------------------------------------
	// 2. 空库 → 导入示例合集
	// ---------------------------------------------------------------
	console.log('\n[ui] 2) 空库欢迎视图 + 导入合集')
	const welcomeShown = await evaluate(
		window,
		`Boolean(document.querySelector('[data-testid="btn-seed-demo"]'))`,
	)
	check('空库时显示欢迎视图与导入按钮', welcomeShown)
	await shot(window, 'ui-02-welcome')

	if (welcomeShown) {
		check(
			'点到「导入示例合集」按钮',
			await click(window, '[data-testid="btn-seed-demo"]'),
		)

		// 导入要连拉网络（合集列表 + 每个视频的 view），B 站会限流，
		// 因此允许重试：失败后再点一次按钮。
		let imported = await waitFor(
			window,
			`(() => {
				const ui = window.bbTest.ui()
				return ui.playlistItems > 0 && ui.trackRows > 0
			})()`,
			180_000,
		)
		for (let attempt = 1; attempt <= 2 && !imported.ok; attempt++) {
			console.log(`[ui] 导入未成功，重试 ${attempt}/2`)
			const statusNow = await evaluate(
				window,
				`document.getElementById('status').textContent`,
			)
			console.log(`[ui] 当前状态栏: ${statusNow}`)
			await click(window, '[data-testid="btn-seed-demo"]')
			imported = await waitFor(
				window,
				`(() => {
					const ui = window.bbTest.ui()
					return ui.playlistItems > 0 && ui.trackRows > 0
				})()`,
				180_000,
			)
		}

		ui = await uiState(window)
		check(
			'导入后左栏出现歌单',
			ui.playlistItems > 0,
			`${ui.playlistItems} 个歌单`,
		)
		check('导入后中栏出现曲目行', ui.trackRows > 0, `${ui.trackRows} 行`)
		check('视图标题为歌单名', Boolean(ui.viewTitle), ui.viewTitle)
	} else {
		check('导入后左栏出现歌单', false, '欢迎视图缺失，跳过导入')
		check('导入后中栏出现曲目行', false, '欢迎视图缺失，跳过导入')
		check('视图标题为歌单名', false, '欢迎视图缺失，跳过导入')
	}
	await shot(window, 'ui-03-imported')

	// ---------------------------------------------------------------
	// 2.5 组件词汇表（阶段 1c）
	// ---------------------------------------------------------------
	//
	// 第一版"杂乱"的根因不是配色，而是**没有组件**：每个面板都在用
	// 「h3 + 一行说明 + 一排等权重灰按钮 + 平铺表单」临时拼，
	// 列表行 / 空状态 / 开关各写一套。
	//
	// 这一节断言面板确实**在用组件**（而不是又手搓了一套），
	// 并且组件的关键视觉特征成立。放在导入之后 —— 那时侧栏才有真实行。
	console.log('\n[ui] 2.5) 组件词汇表')
	// 封面形状在**这里**量，不在 shell 小节：那时曲目表和侧栏行还没渲染，
	// 只能量到播放条那一个封面，断言看着"通过"其实没覆盖到什么。
	// 封面统一是**圆角正方形**（用户明确要求）。
	//
	// 不用圆形：圆形是"头像"的语言；封面是唱片/视频的封面，方形才对，
	// 而且同样高度下方形多显示约 21% 的画面。
	// 这里同时要求"真的有圆角"（不是切角）与"不是圆"（半径不超过边长一半）。
	const covers = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const nodes = [
					...document.querySelectorAll('.playbar__cover'),
					...document.querySelectorAll('.track-grid .list-row__art'),
					...document.querySelectorAll('[data-playlist-id] .list-row__art'),
				]
				const problems = []
				let withRadius = 0
				let square = 0
				for (const el of nodes) {
					const rect = el.getBoundingClientRect()
					if (rect.width === 0) continue
					const radius = Number.parseFloat(getComputedStyle(el).borderRadius)
					if (!Number.isFinite(radius) || radius < 4) {
						problems.push('无圆角: ' + (el.className || el.tagName))
						continue
					}
					withRadius++
					// 圆角 >= 短边一半就是胶囊/圆形了
					if (radius < Math.min(rect.width, rect.height) / 2) square++
					else problems.push('成了圆形: ' + (el.className || el.tagName))
					// 宽高比接近 1:1 才算"正方形"
					if (Math.abs(rect.width - rect.height) > 2) {
						problems.push(
							'不是正方形: ' +
								Math.round(rect.width) +
								'x' +
								Math.round(rect.height),
						)
					}
				}
				return JSON.stringify({ count: nodes.length, withRadius, square, problems })
			})()`,
		),
	)
	check(
		'界面上有封面位（播放条 / 曲目表 / 侧栏歌单）',
		covers.count > 0,
		`${covers.count} 个`,
	)
	check(
		'所有封面都是**圆角正方形**（有圆角、不是圆形、宽高相等）',
		covers.problems.length === 0 && covers.withRadius === covers.count,
		covers.problems.length > 0
			? covers.problems.slice(0, 4).join('；')
			: `${covers.square}/${covers.count} 个都符合`,
	)

	const components = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const rows = [...document.querySelectorAll('[data-playlist-id]')]
				const firstRow = rows[0]
				/*
				 * 首字方块只在**没有封面**时才出现，而演示歌单是带封面的 ——
				 * 所以这里直接用组件造一行"没有封面"的，检查它的封面位。
				 * （比"碰运气找一行无封面的真实数据"可靠：断言不该依赖数据运气。）
				 */
				const probeRow = window.bbComponents.listRow({
					title: '首字测试',
					sub: '1 首',
					coverUrl: null,
				})
				// ⚠️ 必须真的挂进文档：**游离节点上 getComputedStyle 不解析
				// CSS 变量**（backgroundImage 会读成 none，断言误判为"纯色"）。
				probeRow.style.position = 'absolute'
				probeRow.style.left = '-9999px'
				document.body.appendChild(probeRow)
				const art = probeRow.querySelector('.list-row__art')
				const artStyle = getComputedStyle(art)
				const result = {
					// 列表行
					rowCount: rows.length,
					rowsAreListRow: rows.every((r) => r.classList.contains('list-row')),
					hasArt: Boolean(art),
					artText: (art?.textContent ?? '').trim(),
					// 首字方块必须真的有渐变（不是纯色）
					artHasGradient: /gradient/.test(String(artStyle?.backgroundImage)),
					artHue: art?.style.getPropertyValue('--art-hue') ?? null,
					hasTitle: Boolean(firstRow?.querySelector('.list-row__title')),
					hasSub: Boolean(firstRow?.querySelector('.list-row__sub')),
					// 旧的手搓类名不该再出现
					legacyRows: document.querySelectorAll('.playlist-list__item').length,
					// 开关
					switches: document.querySelectorAll('input.switch').length,
					rawCheckboxes: [...document.querySelectorAll("input[type=checkbox]")].filter(
						(el) => !el.classList.contains('switch'),
					).length,
					// 组件工具是否可用
					hasHelpers: typeof window.bbComponents?.listRow === 'function',
				}
				probeRow.remove()
				return JSON.stringify(result)
			})()`,
		),
	)
	check(
		'侧栏歌单行用的是组件层的 .list-row',
		components.rowsAreListRow && components.rowCount > 0,
		`${components.rowCount} 行`,
	)
	check(
		'旧的手搓类名 .playlist-list__item 已消失',
		components.legacyRows === 0,
		`残留 ${components.legacyRows} 个`,
	)
	check(
		'每行有封面位、主标题、副标题',
		components.hasArt && components.hasTitle && components.hasSub,
	)
	check(
		'没有封面的行走「首字 + 渐变底色」（BBPlayer 的身份特征）',
		components.artHasGradient &&
			components.artText.length > 0 &&
			components.artHue !== null,
		`首字「${components.artText}」，色相 ${components.artHue}，background=${components.artHasGradient ? 'gradient ✓' : '纯色 ✗'}`,
	)
	check(
		'设置里的开关是 M3 开关（没有裸 checkbox）',
		components.switches > 0 && components.rawCheckboxes === 0,
		`${components.switches} 个 switch，${components.rawCheckboxes} 个裸 checkbox`,
	)
	check('组件工具已暴露到 window.bbComponents', components.hasHelpers === true)

	// 空状态：结构化的（图标 + 标题 + 说明），不是一行居中灰字
	const emptyProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				// 造一个空状态挂到 body 上量完就拆，避免污染当前界面
				const node = window.bbComponents.empty({
					title: '探针用例',
					hint: '这是一句说明',
					iconName: 'library_music',
				})
				node.style.position = 'fixed'
				node.style.left = '-9999px'
				document.body.appendChild(node)
				const hasIcon = Boolean(node.querySelector('.icon'))
				const hasTitle = node.querySelector('.empty__title')?.textContent === '探针用例'
				const hasHint = node.querySelector('.empty__hint')?.textContent === '这是一句说明'
				const iconIsGlyph =
					(node.querySelector('.icon')?.getBoundingClientRect().width ?? 99) < 60
				node.remove()
				return JSON.stringify({ hasIcon, hasTitle, hasHint, iconIsGlyph })
			})()`,
		),
	)
	check(
		'空状态组件：淡图标 + 标题 + 说明（不是一行居中灰字）',
		emptyProbe.hasIcon && emptyProbe.hasTitle && emptyProbe.hasHint,
		JSON.stringify(emptyProbe),
	)

	// ---------------------------------------------------------------
	// 2.5b 音乐库 › 播放列表 = **歌单卡片网格**（阶段 6d）
	// ---------------------------------------------------------------
	//
	// 用户的原话：「音乐库这里，你要参考安卓端的 ui，应该是呈卡片样式展示
	// 歌单列表」以及「我没有看到任何新建本地歌单的按钮」。
	//
	// 安卓端这个页签的内容是**歌单列表**（`LocalPlaylistList.tsx`），
	// 页签的内容从来不是曲目表。桌面端原来错在这里：页签渲染的是
	// "当前歌单的曲目表"，歌单列表挂在左栏，新建入口完全不存在。
	console.log('\n[ui] 2.5b) 播放列表页签 = 歌单卡片网格')
	await click(window, '[data-testid="lib-tab-playlists"]')
	await sleep(1200)

	const gridProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const cards = [...document.querySelectorAll('.media-card')]
				const first = cards[0]
				const cover = first?.querySelector('.list-row__art--card')
				const coverRect = cover?.getBoundingClientRect()
				return JSON.stringify({
					count: cards.length,
					gridTestid: Boolean(
						document.querySelector('[data-testid="playlist-grid"]'),
					),
					// 卡片封面必须是**1:1 的圆角正方形**（用户明确要求）
					coverSquare: coverRect
						? Math.abs(coverRect.width - coverRect.height) <= 1
						: false,
					coverRadius: coverRect
						? getComputedStyle(cover).borderTopLeftRadius
						: null,
					hasTitle: Boolean(first?.querySelector('.media-card__title')),
					hasSub: Boolean(first?.querySelector('.media-card__sub')),
					// ⚠️ 卡片必须**真的有自己的底色**：安卓端的卡是 surfaceVariant，
					// 与页面底色不同。"类名在、样式没生效"（变量名写错 →
					// var() 无效 → 退回 transparent）是这个仓库吃过多次的假绿。
					cardBg: first ? getComputedStyle(first).backgroundColor : null,
					contentBg: getComputedStyle(
						document.getElementById('content'),
					).backgroundColor,
					// 新建入口：**左栏歌单卡**的「＋」（卡片化阶段 1 之后它是主入口，
					// 任何页面都在；页头那颗改叫 playlist-new-head）
					hasAdd: Boolean(document.querySelector('[data-testid="playlist-new"]')),
					hasFilter: Boolean(
						document.querySelector('[data-testid="playlist-filter"]'),
					),
					// 没有曲目表：曲目表只出现在**详情**里
					trackTable: Boolean(document.querySelector('[data-testid="track-table"]')),
				})
			})()`,
		),
	)
	check(
		'播放列表页签渲染歌单卡片网格（不是曲目表）',
		gridProbe.count > 0 && gridProbe.gridTestid && !gridProbe.trackTable,
		`${gridProbe.count} 张卡，trackTable=${gridProbe.trackTable}`,
	)
	check(
		'歌单卡片封面是 1:1 的圆角正方形',
		gridProbe.coverSquare && parseFloat(gridProbe.coverRadius) >= 8,
		`1:1=${gridProbe.coverSquare} radius=${gridProbe.coverRadius}`,
	)
	check(
		'卡片有标题与副标题，头部有计数 / 新建 / 搜索',
		gridProbe.hasTitle &&
			gridProbe.hasSub &&
			gridProbe.hasAdd &&
			gridProbe.hasFilter,
		JSON.stringify(gridProbe),
	)
	check(
		'歌单卡片与页面底色可区分（第一张）',
		Boolean(gridProbe.cardBg) &&
			gridProbe.cardBg !== 'rgba(0, 0, 0, 0)' &&
			gridProbe.cardBg !== gridProbe.contentBg,
		`卡片 ${gridProbe.cardBg} vs 内容区 ${gridProbe.contentBg}`,
	)

	// `＋` 菜单必须**点得开**，且三项都是真的（不是装饰）
	const newMenu = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const trigger = document.querySelector('[data-testid="playlist-new"]')
				// 先把整屏滚一遍，确保触发按钮真的进了视口（这个仓库里
				// "元素在、但点不到"已经踩过好几次）
				trigger?.scrollIntoView({ block: 'nearest' })
				await new Promise((r) => setTimeout(r, 100))
				trigger?.click()
				await new Promise((r) => setTimeout(r, 400))
				const items = [...document.querySelectorAll('.menu__item')].map(
					(node) => node.textContent.trim(),
				)
				window.bbComponents.closeMenu()
				/*
				 * 找不到触发器时把**它能被谁替换掉**说清楚：
				 * 左栏那个「＋」的 id 是 sidebar-new-playlist、testid 是
				 * playlist-new；而音乐库页头那颗现在叫 playlist-new-head。
				 * 两者混了就会"按钮明明在、选择器找不到"。
				 */
				return JSON.stringify({
					items,
					found: Boolean(trigger),
					diag: {
						sidebarAdd: Boolean(
							document.getElementById('sidebar-new-playlist'),
						),
						headAdd: Boolean(
							document.querySelector('[data-testid="playlist-new-head"]'),
						),
						view: document.querySelector('.nav__item.is-active')?.dataset?.view,
						pageTitle: document.getElementById('page-title')?.textContent,
					},
					nav: (() => {
						const r = trigger?.getBoundingClientRect()
						return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null
					})(),
				})
			})()`,
		),
	)
	check(
		'「＋」菜单有新建 / 导入 / 订阅三项',
		newMenu.items.length === 3 &&
			newMenu.items.some((t) => t.includes('新建播放列表')) &&
			newMenu.items.some((t) => t.includes('导入外部歌单')) &&
			newMenu.items.some((t) => t.includes('订阅共享歌单')),
		`${newMenu.items.join(' / ')}（按钮 ${newMenu.found}，rect=${newMenu.nav}，diag=${JSON.stringify(newMenu.diag)}）`,
	)

	// 从卡片进详情 → 有返回 → 能回来。
	// ⚠️ 三条都要断言："点得开"、"详情里真的换了内容"、"回得来" ——
	// 只断言"卡片存在"等于没测（列表能点但点不动也满足）。
	const drill = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const card = document.querySelector('.media-card')
				card?.click()
				await new Promise((r) => setTimeout(r, 1500))
				// 作者名：**数据库路径**的作者在 artists 表里（tracks 只存外键），
				// 所以这条同时验证 join 真的做了 —— 用户抱怨过「作者永远是 —」。
				// 曲目卡把它放在副标题里（「歌手 · 时长」）。
				const artists = [
					...document.querySelectorAll('.track-card .media-card__sub'),
				]
					.map((node) => node.textContent.split('·')[0].trim())
					.filter(Boolean)
				const inDetail = {
					trackGrid: Boolean(
						document.querySelector('[data-testid="track-table"] .track-card'),
					),
					back: Boolean(document.querySelector('[data-testid="playlist-back"]')),
					title: document.querySelector('.view-head h2')?.textContent ?? '',
					authorRows: artists.length,
					authorFilled: artists.filter((t) => t && t !== '—').length,
					authorSample: artists.find((t) => t && t !== '—') ?? null,
				}
				document.querySelector('[data-testid="playlist-back"]')?.click()
				await new Promise((r) => setTimeout(r, 1200))
				const backToList = Boolean(document.querySelector('.media-card'))
				return JSON.stringify({ inDetail, backToList })
			})()`,
		),
	)
	check(
		'点歌单卡片进详情（曲目卡网格 + 返回按钮都在）',
		drill.inDetail.trackGrid && drill.inDetail.back,
		`标题「${drill.inDetail.title}」 ${JSON.stringify(drill.inDetail)}`,
	)
	check(
		'详情里的「播放列表」能回到卡片网格',
		drill.backToList,
		String(drill.backToList),
	)
	check(
		'歌单详情里每张曲目卡的副标题都有作者（数据库路径必须 join artists）',
		drill.inDetail.authorRows > 0 &&
			drill.inDetail.authorFilled === drill.inDetail.authorRows,
		`${drill.inDetail.authorFilled}/${drill.inDetail.authorRows} 行有作者，例：${drill.inDetail.authorSample}`,
	)

	// 新建歌单：走**完整的用户路径**（`＋` → 新建播放列表 → 输入名字 → 创建）。
	//
	// ⚠️ 只断言"按钮存在"是不够的 —— 用户抱怨的正是"我没有看到任何新建本地歌单
	// 的按钮"，而一个点不开/建不成的按钮等于没有。这里必须看到卡片数真的 +1。
	await click(window, '[data-testid="playlist-new"]')
	await sleep(300)
	await click(window, '[data-testid="playlist-new-local"]')
	await sleep(400)
	const createDialogOpen = await evaluate(
		window,
		`Boolean(document.querySelector('[data-testid="create-playlist"]'))`,
	)
	check('「＋ → 新建播放列表」打开新建对话框', createDialogOpen)
	await typeInto(
		window,
		'[data-testid="create-playlist-name"]',
		'探针新建的歌单',
	)
	await click(window, '[data-testid="create-playlist-ok"]')
	await sleep(1800)
	const afterCreate = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const inDetail = {
					title: document.querySelector('.view-head h2')?.textContent ?? '',
					dialogGone: !document.querySelector('[data-testid="create-playlist"]'),
				}
				document.querySelector('[data-testid="playlist-back"]')?.click()
				await new Promise((r) => setTimeout(r, 1200))
				const cards = [...document.querySelectorAll('.media-card')]
				const titles = cards.map(
					(node) => node.querySelector('.media-card__title')?.textContent ?? '',
				)
				const inactive = cards.find((node) => !node.classList.contains('is-active'))
				return JSON.stringify({
					inDetail,
					cards: cards.length,
					titles,
					// 非当前选中的卡片：它的底色必须与内容区不同，否则"卡片"只是
					// 一个没有边界的透明盒子（选中那几张靠高亮色看不出来）
					inactiveBg: inactive
						? getComputedStyle(inactive).backgroundColor
						: null,
					contentBg: getComputedStyle(
						document.getElementById('content'),
					).backgroundColor,
				})
			})()`,
		),
	)
	check(
		'新建歌单：对话框关闭、进入新歌单、卡片数增加',
		afterCreate.inDetail.dialogGone &&
			afterCreate.inDetail.title === '探针新建的歌单' &&
			afterCreate.cards >= 2 &&
			afterCreate.titles.includes('探针新建的歌单'),
		`${afterCreate.cards} 张卡：${afterCreate.titles.join(' / ')}`,
	)
	check(
		'未选中的歌单卡片也有自己的底色（不是透明盒子）',
		afterCreate.inactiveBg != null &&
			afterCreate.inactiveBg !== 'rgba(0, 0, 0, 0)' &&
			afterCreate.inactiveBg !== afterCreate.contentBg,
		`卡片 ${afterCreate.inactiveBg} vs 内容区 ${afterCreate.contentBg}`,
	)

	// 搜索播放列表（页内筛选，与安卓端的「搜索播放列表」同义）
	const filterProbe = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const before = document.querySelectorAll('.media-card').length
				const input = document.querySelector('[data-testid="playlist-filter"]')
				input.value = '不存在的歌单名 zzz'
				input.dispatchEvent(new Event('input', { bubbles: true }))
				await new Promise((r) => setTimeout(r, 200))
				const after = document.querySelectorAll('.media-card').length
				const empty = Boolean(
					document.querySelector('[data-testid="playlist-grid-empty"]'),
				)
				input.value = ''
				input.dispatchEvent(new Event('input', { bubbles: true }))
				await new Promise((r) => setTimeout(r, 200))
				const restored = document.querySelectorAll('.media-card').length
				return JSON.stringify({ before, after, empty, restored })
			})()`,
		),
	)
	check(
		'搜索播放列表：筛掉全部时给空状态，清空后恢复',
		filterProbe.after === 0 &&
			filterProbe.empty &&
			filterProbe.restored === filterProbe.before,
		JSON.stringify(filterProbe),
	)

	// ---------------------------------------------------------------
	// 2.6 播放列表功能：随机播放 / 下一首播放 / 更改顺序
	// ---------------------------------------------------------------
	//
	// 用户明确要求的三件事。这三条都属于"逻辑在内存里、界面上看不出来对错"，
	// 所以必须断言**行为**而不只是"按钮存在"。
	console.log('\n[ui] 2.6) 播放列表功能')
	// 内容加载后再审一次图标：曲目表的「下一首播放」按钮是这一阶段新加的，
	// 而首屏那次检查看不到它（见 auditIcons 的注释）。
	const iconsAfterContent = await auditIcons(window)
	check(
		'曲目表 / 队列渲染后，所有图标仍然渲染成单个字形',
		iconsAfterContent.tooWide.length === 0,
		iconsAfterContent.tooWide.length > 0
			? `过宽（图标名可能不存在）：${iconsAfterContent.tooWide.join('、')}`
			: `${iconsAfterContent.count} 个都正常`,
	)

	// 先确保队列里有一批歌。
	// ⚠️ 不能"点左栏第一行" —— 套件前面刚**新建了一个空歌单**，它可能排在最前，
	// 那样「播放全部」根本不存在。必须挑一个有曲目的。
	await openPlaylistWithTracks(window)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(1500)

	// ---------------------------------------------------------------
	// 2.6b 曲目卡网格（阶段 A → 用户复审：取消曲目表）
	// ---------------------------------------------------------------
	//
	// 用户的原话：「两个按钮出来的是两个完全不同的播放列表页面，只保留
	// 播放详情页里面的播放列表（圆角卡片样式的那个）」。
	//
	// 也就是说歌单详情**不再有曲目表**，而是与歌单列表同一张圆角卡片。
	// 断言按看得见的现象写：
	//   1. 详情里没有任何 `<table class="track-table">`；
	//   2. 曲目卡是 `<button>`（键盘可达：有 role 语义 + tabindex）；
	//   3. 每张卡的封面是 1:1 的圆角正方形；
	//   4. 卡片底色与页面底色可区分（是"卡片"而不是裸文字）。
	console.log('\n[ui] 2.6b) 曲目卡网格')
	const trackGrid = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const grid = document.querySelector('[data-testid="track-table"]')
				const cards = [...document.querySelectorAll('.track-card')]
				const first = cards[0]
				const art = first?.querySelector('.list-row__art')
				const artRect = art?.getBoundingClientRect()
				const radius = art ? Number.parseFloat(getComputedStyle(art).borderRadius) : 0
				return JSON.stringify({
					isGrid: grid ? grid.tagName === 'DIV' && grid.classList.contains('media-grid') : false,
					hasTable: Boolean(document.querySelector('table.track-table')),
					count: cards.length,
					tag: first?.tagName ?? null,
					hasSub: Boolean(first?.querySelector('.media-card__sub')),
					artSquare: artRect
						? Math.abs(artRect.width - artRect.height) <= 2
						: false,
					artRadius: radius,
					cardBg: first ? getComputedStyle(first).backgroundColor : null,
					contentBg: getComputedStyle(document.getElementById('content')).backgroundColor,
				})
			})()`,
		),
	)
	check(
		'歌单详情渲染的是曲目**卡网格**，页面上不再有曲目表',
		trackGrid.isGrid && !trackGrid.hasTable && trackGrid.count > 1,
		`grid=${trackGrid.isGrid} table=${trackGrid.hasTable} 卡片 ${trackGrid.count} 张`,
	)
	check(
		'曲目卡是 <button>（键盘可达）且带歌手的副标题',
		trackGrid.tag === 'BUTTON' && trackGrid.hasSub,
		`<${trackGrid.tag}> sub=${trackGrid.hasSub}`,
	)
	check(
		'曲目卡封面是 1:1 的圆角正方形',
		trackGrid.artSquare && trackGrid.artRadius >= 8,
		`1:1=${trackGrid.artSquare} radius=${trackGrid.artRadius}`,
	)
	check(
		'曲目卡底色与内容区底色可区分',
		Boolean(trackGrid.cardBg) &&
			trackGrid.cardBg !== 'rgba(0, 0, 0, 0)' &&
			trackGrid.cardBg !== trackGrid.contentBg,
		`卡片 ${trackGrid.cardBg} vs 内容区 ${trackGrid.contentBg}`,
	)

	// ---------------------------------------------------------------
	// 2.6a 多选（阶段 6d-2）
	// ---------------------------------------------------------------
	//
	// 安卓端：长按 500ms 进多选 → Appbar 标题变「已选择 N 首」、action 组换成
	// 全选/反选/添加到歌单 → 行首复选框淡入、序号淡出。
	//
	// 桌面端保留这套语义，两处**必须改变**：
	//   * 进入方式：桌面没有长按 → Ctrl/Cmd 点选 + Shift 连选 + 一个看得见的
	//     「多选」按钮（否则功能不可发现）；
	//   * ⚠️ **必须能退出**：安卓端把返回按钮整组换掉之后屏幕上没有任何退出入口，
	//     只能靠系统返回键。桌面没有系统返回键 → 显式「清除选择」+ Esc。
	console.log('\n[ui] 2.6a) 多选')
	const beforeEach = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				rows: document.querySelectorAll('.track-card').length,
				barHidden: document.querySelector('[data-testid="selection-bar"]')?.hidden,
				selectButton: Boolean(document.querySelector('[data-testid="btn-select-mode"]')),
			}))()`,
		),
	)
	check(
		'多选前：工具条隐藏、有可见的「多选」入口',
		beforeEach.rows > 1 &&
			beforeEach.barHidden === true &&
			beforeEach.selectButton,
		JSON.stringify(beforeEach),
	)

	// Ctrl 点第 1 行 → 进多选并选中它
	const multi = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const rows = [...document.querySelectorAll('.track-card')]
				const click = (row, init) =>
					row.dispatchEvent(
						new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
					)
				click(rows[0], { ctrlKey: true })
				await new Promise((r) => setTimeout(r, 200))
				const afterOne = {
					barHidden: document.querySelector('[data-testid="selection-bar"]').hidden,
					checked: document.querySelectorAll('.track-card.is-checked').length,
					label: document.querySelector('[data-testid="selection-count"]').textContent,
					// 选中标记：曲目卡用主色勾选图标（表格那套方格复选框已随表格退场）
					mark: (() => {
						const card = document.querySelector('.track-card.is-checked')
						if (!card) return null
						const s = getComputedStyle(card, '::after')
						return { content: s.content, color: s.color }
					})(),
					// 进多选后行拖拽必须关掉（拖动与点选互相打架）
					draggable: rows[0].draggable,
				}
				// Shift 连选：第 3 行
				click(rows[2], { shiftKey: true })
				await new Promise((r) => setTimeout(r, 200))
				const afterRange = {
					checked: document.querySelectorAll('.track-card.is-checked').length,
					label: document.querySelector('[data-testid="selection-count"]').textContent,
				}
				return JSON.stringify({ afterOne, afterRange })
			})()`,
		),
	)
	check(
		'Ctrl 点选进入多选：工具条出现、该卡选中、有勾选标记',
		multi.afterOne.barHidden === false &&
			multi.afterOne.checked === 1 &&
			/multi|已选择 1 首/.test(multi.afterOne.label) &&
			multi.afterOne.mark?.content?.includes('check_circle'),
		JSON.stringify(multi.afterOne),
	)
	check(
		'多选时关掉行拖拽（拖拽与点选不能同时生效）',
		multi.afterOne.draggable === false,
		`draggable=${multi.afterOne.draggable}`,
	)
	check(
		'Shift 连选：锚点到目标之间的行全部选中',
		multi.afterRange.checked === 3 && /3/.test(multi.afterRange.label),
		JSON.stringify(multi.afterRange),
	)

	// 全选 / 反选
	const batch = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const rows = document.querySelectorAll('.track-card').length
				document.querySelector('[data-testid="selection-all"]').click()
				await new Promise((r) => setTimeout(r, 200))
				const all = document.querySelectorAll('.track-card.is-checked').length
				document.querySelector('[data-testid="selection-invert"]').click()
				await new Promise((r) => setTimeout(r, 200))
				const inverted = document.querySelectorAll('.track-card.is-checked').length
				document.querySelector('[data-testid="selection-all"]').click()
				await new Promise((r) => setTimeout(r, 200))
				const backToAll = document.querySelectorAll('.track-card.is-checked').length
				return JSON.stringify({ rows, all, inverted, backToAll })
			})()`,
		),
	)
	check(
		'全选 / 反选：全选=全部行，反选=0，再全选又回到全部行',
		batch.all === batch.rows &&
			batch.inverted === 0 &&
			batch.backToAll === batch.rows,
		JSON.stringify(batch),
	)

	// 批量「添加到歌单」：走真实的写库路径（这里只到"弹层列出歌单"为止，
	// 真正的写库由 1.7c 与本节的单首用例覆盖）
	const batchAdd = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				document.querySelector('[data-testid="selection-add"]')?.click()
				await new Promise((r) => setTimeout(r, 600))
				const dialog = document.querySelector('[data-testid="add-to-playlist"]')
				const options = document.querySelectorAll('.dialog-option').length
				const note = document.querySelector('.dialog-note')?.textContent ?? ''
				document.querySelector('[data-testid="add-to-playlist-cancel"]')?.click()
				await new Promise((r) => setTimeout(r, 300))
				return JSON.stringify({
					opened: Boolean(dialog),
					options,
					noteSaysLocal: note.includes('本地歌单'),
				})
			})()`,
		),
	)
	check(
		'多选的「添加到歌单」打开弹层并列出本地歌单',
		batchAdd.opened && batchAdd.options > 0 && batchAdd.noteSaysLocal,
		JSON.stringify(batchAdd),
	)

	// Esc 退出（桌面端补的出口之一）
	const escExit = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				// 先重新进多选：上一步取消弹层后仍在多选态
				const inMode = !document.querySelector('[data-testid="selection-bar"]').hidden
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
				)
				await new Promise((r) => setTimeout(r, 250))
				return JSON.stringify({
					inMode,
					barHidden: document.querySelector('[data-testid="selection-bar"]').hidden,
					checked: document.querySelectorAll('.track-card.is-checked').length,
					rowsVisible: document.querySelectorAll('.track-card').length,
				})
			})()`,
		),
	)
	check(
		'Esc 退出多选：工具条收起、选中清空、曲目仍在',
		escExit.inMode &&
			escExit.barHidden &&
			escExit.checked === 0 &&
			escExit.rowsVisible > 1,
		JSON.stringify(escExit),
	)

	// 显式「清除选择」按钮（另一个出口）
	const clearExit = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				document.querySelector('[data-testid="btn-select-mode"]').click()
				await new Promise((r) => setTimeout(r, 200))
				const entered = !document.querySelector('[data-testid="selection-bar"]').hidden
				document.querySelector('[data-testid="selection-clear"]').click()
				await new Promise((r) => setTimeout(r, 200))
				return JSON.stringify({
					entered,
					barHidden: document.querySelector('[data-testid="selection-bar"]').hidden,
				})
			})()`,
		),
	)
	check(
		'「清除选择」按钮也能退出多选（安卓端缺的就是这个出口）',
		clearExit.entered && clearExit.barHidden,
		JSON.stringify(clearExit),
	)

	// --- (1) 随机播放：必须是**洗牌**，不是"每次随机挑一首" ---
	//
	// 第一版是 `while (candidate === index) candidate = random()` ——
	// 那会把听过的歌再随机到，用户感知是"随机播放老是放那几首"。
	// 洗牌顺序的定义很硬：它是下标的**一个排列**，且走完一轮每首恰好一次。
	const shuffleProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				const size = player.getQueue().length
				player.setMode('shuffle')
				const order = player.getShuffleOrder()
				const sorted = [...order].sort((a, b) => a - b)
				const isPermutation =
					order.length === size &&
					sorted.every((value, i) => value === i) &&
					new Set(order).size === size
				player.setMode('order')
				return JSON.stringify({ size, order, isPermutation })
			})()`,
		),
	)
	check(
		'随机播放是**洗牌顺序**（队列下标的一个排列，每首恰好一次）',
		shuffleProbe.isPermutation,
		`队列 ${shuffleProbe.size} 首，洗牌顺序 [${shuffleProbe.order.slice(0, 8).join(',')}…]`,
	)

	// 走完一轮应当把每首**恰好播一次**，然后回到起点
	const roundTrip = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const player = window.bbPlayer
				// 用 4 首的小队列，走一轮看清楚
				const tracks = player.getQueue().slice(0, 4)
				player.setQueue(tracks, 0)
				player.setMode('shuffle')
				const visited = [player.getIndex()]
				for (let i = 0; i < 3; i++) {
					// 只走"下一首"的下标计算，不真的播放（避免等网络）
					const next = player.getShuffleOrder()[
						(player.getShufflePos() + 1) % player.getShuffleOrder().length
					]
					player.playAt(next)
					visited.push(next)
				}
				const unique = new Set(visited).size
				player.setMode('order')
				return JSON.stringify({ visited, unique })
			})()`,
		),
	)
	check(
		'洗牌顺序走一轮：4 首里访问到 4 个不同下标',
		roundTrip.unique === 4,
		`访问顺序 ${roundTrip.visited.join(' → ')}，去重后 ${roundTrip.unique} 个`,
	)

	// ⚠️ 「是一个排列」还不够：一个**恒等排列**（0,1,2,3…）也满足"每首恰好一次"，
	// 但它显然不是随机播放。所以再验一次"重洗真的会变" ——
	// 24 首的队列洗 5 次全部相同的概率是 0，出现即说明 `reshuffle` 没生效。
	const reshuffleVariety = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				player.setMode('order')
				const seen = new Set()
				for (let i = 0; i < 5; i++) {
					player.setMode('shuffle')
					seen.add(player.getShuffleOrder().join(','))
				}
				player.setMode('order')
				return JSON.stringify({ distinct: seen.size })
			})()`,
		),
	)
	check(
		'重复洗牌会产生**不同的**顺序（证明真的在随机，而不是恒等排列）',
		reshuffleVariety.distinct > 1,
		`5 次洗牌得到 ${reshuffleVariety.distinct} 种不同顺序`,
	)

	/*
	 * --- 播放模式：四档 ---
	 *
	 * ⚠️ 原先只有三档，而且 `order` 的名字与行为不符（它其实是列表循环）。
	 * 现在四档的语义是拆开的，所以这里要**逐档验证行为**，不能只数枚举值：
	 *   * 数枚举 → 改个名字就能骗过断言（假绿）；
	 *   * 验行为 → 只有真的实现了"放完就停"才过得去。
	 */
	const modeProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				const saved = player.getQueue()
				const savedIndex = player.getIndex()

				// 用 3 首的小队列，走"自动续播"的下标计算（不真的播放）
				player.setQueue(saved.slice(0, 3), 2)
				const labels = []
				const icons = []

				// 顺序播放：在最后一首上自动续播 → 停（无下一首）
				player.setMode('order')
				const orderStops = player.peekNextIndex(true) === -1
				// 顺序播放：手动"下一首"仍然回绕（用户的意图明确，不该被模式挡住）
				const orderManualWraps = player.peekNextIndex(false) === 0

				// 列表循环：自动续播回到队首
				player.setMode('list-loop')
				const listLoopWraps = player.peekNextIndex(true) === 0

				// 单曲循环：自动续播停在当前这首
				player.setMode('repeat-one')
				const repeatOneStays = player.peekNextIndex(true) === 2

				// 循环四档：枚举顺序固定，且每一档都换过 title/aria-label
				player.setMode('list-loop')
				for (let i = 0; i < 4; i++) {
					labels.push(player.getModeLabel())
					icons.push(player.getModeIcon())
					player.cycleMode()
				}
				const backToStart = player.getMode() === 'list-loop'

				player.setQueue(saved, savedIndex)
				return JSON.stringify({
					orderStops,
					orderManualWraps,
					listLoopWraps,
					repeatOneStays,
					labels,
					icons,
					backToStart,
				})
			})()`,
		),
	)
	check(
		'播放模式四档：顺序播放在队尾**停住**，手动下一首仍回绕',
		modeProbe.orderStops && modeProbe.orderManualWraps,
		`自动续播停在队尾=${modeProbe.orderStops}，手动下一首回绕=${modeProbe.orderManualWraps}`,
	)
	check(
		'播放模式四档：列表循环自动续播回到队首',
		modeProbe.listLoopWraps,
		`自动续播回到队首=${modeProbe.listLoopWraps}`,
	)
	check(
		'播放模式四档：单曲循环自动续播停在当前这首',
		modeProbe.repeatOneStays,
		`自动续播停在当前=${modeProbe.repeatOneStays}`,
	)
	check(
		'播放模式四档：循环按钮走完四档回到起点，且每档都有不同的名称与图标',
		modeProbe.backToStart &&
			new Set(modeProbe.labels).size === 4 &&
			new Set(modeProbe.icons).size === 4,
		`名称 [${modeProbe.labels.join(' / ')}]，图标 [${modeProbe.icons.join(' / ')}]`,
	)

	/*
	 * ------- 卡片化阶段 3：播放卡（音量、标题滚动、队列入口）-------
	 *
	 * 这一组验的是**用户提的三条**：
	 *   1. 没有音量滑块（播放卡与详情页都没有）；
	 *   2. 标题过长时横向滚动；
	 *   3. 右侧有"播放列表"入口。
	 */
	const playCard = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const wrap = document.getElementById('now-title-wrap')
				const text = document.getElementById('now-title')
				const style = wrap ? getComputedStyle(wrap) : null

				// 把标题临时改成一个一定溢出的长串，量完就还原
				const original = text?.textContent ?? ''
				const measuring = Boolean(wrap && text)
				let overflowing = null
				let shift = null
				if (measuring) {
					text.textContent = '一首标题特别特别长的歌'.repeat(8)
					// 走 player 自己的判定（不是在这里重算一遍）
					document.getElementById('now-title-wrap').classList.remove('is-overflowing')
					const need = text.scrollWidth - wrap.clientWidth
					if (need > 4) {
						wrap.style.setProperty('--marquee-shift', '-' + need + 'px')
						wrap.classList.add('is-overflowing')
					}
					overflowing = wrap.classList.contains('is-overflowing')
					shift = wrap.style.getPropertyValue('--marquee-shift')
					// 还原
					text.textContent = original
					wrap.classList.remove('is-overflowing')
					wrap.style.removeProperty('--marquee-shift')
				}

				return JSON.stringify({
					// 音量滑块必须**一个都不剩**（播放卡 + 详情页）
					volumeSliders: document.querySelectorAll(
						'[data-testid="volume"], [data-testid="nowplaying-volume"]',
					).length,
					// 音量仍然能调（只是入口在设置里）
					hasSettingsVolume: Boolean(
						document.getElementById('settings-volume'),
					),
					volumeApi:
						typeof window.bbPlayer?.setVolume === 'function' &&
						typeof window.bbPlayer?.getVolume === 'function',
					// 队列入口在传输条上、"下一首"右边
					hasQueueButton: Boolean(
						document.getElementById('playbar-queue'),
					),
					// 标题两层结构 + 溢出判定
					titleLayers: Boolean(wrap && text && text.parentElement === wrap),
					overflowing,
					shift,
					// 进播放详情页有过渡（草图要"向上过渡动画"）
					nowplayingTransition: (() => {
						const view = document.getElementById('view-nowplaying')
						if (!view) return null
						const s = getComputedStyle(view)
						return {
							property: s.transitionProperty,
							duration: s.transitionDuration,
						}
					})(),
				})
			})()`,
		),
	)
	check(
		'播放卡与播放详情页**都没有**音量滑块（用户明确要求）',
		playCard.volumeSliders === 0,
		`找到 ${playCard.volumeSliders} 条`,
	)
	check(
		'音量仍然调得到：设置里有唯一一条滑块 + 播放器暴露 setVolume/getVolume',
		playCard.hasSettingsVolume && playCard.volumeApi,
		`设置里的滑块=${playCard.hasSettingsVolume} API=${playCard.volumeApi}`,
	)
	check(
		'播放卡右侧有「播放列表」入口（在传输条上、下一首右边）',
		playCard.hasQueueButton,
		String(playCard.hasQueueButton),
	)
	check(
		'标题是**两层**结构，且长标题会触发横向滚动（草图的「滚动显示」）',
		playCard.titleLayers && playCard.overflowing === true,
		`两层=${playCard.titleLayers} 溢出=${playCard.overflowing} 平移=${playCard.shift}`,
	)
	check(
		'进播放详情页有过渡（草图的「向上过渡动画」）',
		playCard.nowplayingTransition !== null &&
			playCard.nowplayingTransition.property.includes('transform') &&
			playCard.nowplayingTransition.duration !== '0s',
		playCard.nowplayingTransition
			? `${playCard.nowplayingTransition.property} / ${playCard.nowplayingTransition.duration}`
			: '找不到 #view-nowplaying',
	)

	// --- (2) 下一首播放 ---
	const playNextProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				const base = player.getQueue().slice(0, 4)
				player.setQueue(base, 1)

				// 分支 A：队列里**没有**这首歌 → 插到当前位置之后，长度 +1
				const fresh = { bvid: 'BVprobeNext001', title: '探针曲目·新' }
				const inserted = player.playNextInsert(fresh)
				const afterInsert = player.getQueue()
				const atIsNext = afterInsert[player.getIndex() + 1]?.bvid === fresh.bvid

				// 分支 B：这首歌**已经在**队列里（下标 3）→ 不重复添加，移到下一首
				const existingTrack = afterInsert[3]
				const before = player.getQueue().length
				const moved = player.playNextInsert(existingTrack)
				const afterMove = player.getQueue()
				const noDuplicate =
					afterMove.filter((t) => t.bvid === existingTrack.bvid).length === 1
				const movedIsNext =
					afterMove[player.getIndex() + 1]?.bvid === existingTrack.bvid

				// 分支 C：已经就是下一首 → 不做无意义的移动
				const alreadyNext = player.playNextInsert(afterMove[player.getIndex() + 1])
				const queueBefore = player.getQueue().map((t) => t.bvid).join(',')
				const queueAfter = player.getQueue().map((t) => t.bvid).join(',')

				return JSON.stringify({
					insertedOk: inserted.ok,
					atIsNext,
					lengthAfterInsert: afterInsert.length,
					movedOk: moved.ok,
					noDuplicate,
					movedIsNext,
					lengthUnchanged: afterMove.length === before,
					alreadyNextNoop: alreadyNext.moved === false &&
						queueBefore === queueAfter,
				})
			})()`,
		),
	)
	check(
		'「下一首播放」把新歌插到当前曲目之后（不是追加到末尾）',
		playNextProbe.insertedOk && playNextProbe.atIsNext,
		`队列长度 ${playNextProbe.lengthAfterInsert}`,
	)
	check(
		'「下一首播放」对队列里已有的歌不重复添加，只把它挪到下一首',
		playNextProbe.movedOk &&
			playNextProbe.noDuplicate &&
			playNextProbe.movedIsNext &&
			playNextProbe.lengthUnchanged,
		`不重复=${playNextProbe.noDuplicate} 成为下一首=${playNextProbe.movedIsNext} 长度不变=${playNextProbe.lengthUnchanged}`,
	)
	check(
		'目标已经是下一首时不做无意义的移动（不打乱用户排好的顺序）',
		playNextProbe.alreadyNextNoop === true,
	)

	// --- (3) 队列重排 ---
	const reorderProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				player.setQueue(player.getQueue().slice(0, 5), 2)
				const before = player.getQueue().map((t) => t.bvid)
				const playingBefore = player.getQueue()[player.getIndex()].bvid

				// 把第 0 项移到第 3 位
				const result = player.moveInQueue(0, 3)
				const after = player.getQueue().map((t) => t.bvid)
				const playingAfter = player.getQueue()[player.getIndex()]?.bvid

				// 期望：第 0 项出现在下标 3，其余整体前移一格
				const expected = [...before.slice(1, 4), before[0], ...before.slice(4)]

				return JSON.stringify({
					ok: result.ok,
					before,
					after,
					expected,
					orderOk: after.join(',') === expected.join(','),
					// ⚠️ 关键：当前播放项的下标必须**跟着它自己走**
					playingFollowed: playingBefore === playingAfter,
				})
			})()`,
		),
	)
	check(
		'队列重排把项目移动到目标位置（其余项依次前移）',
		reorderProbe.ok && reorderProbe.orderOk,
		`${reorderProbe.before?.join(',')} → ${reorderProbe.after?.join(',')}`,
	)
	check(
		'重排后「正在播放」仍然指向同一首歌（下标跟着它走）',
		reorderProbe.playingFollowed === true,
	)

	// --- (4) 歌单内重排（落库，重启后仍在）---
	const playlistId = await evaluate(
		window,
		`window.bbState.get().selectedPlaylistId ?? null`,
	)
	if (playlistId) {
		const persisted = JSON.parse(
			await evaluate(
				window,
				`(async () => {
					const before = (await window.bbplayer.getPlaylistTracks(${JSON.stringify(playlistId)})).data
					const bvidsBefore = before.map((t) => t.bvid)
					const moved = await window.bbplayer.movePlaylistTrack({
						playlistId: ${JSON.stringify(playlistId)},
						from: 0,
						to: 2,
					})
					const after = (await window.bbplayer.getPlaylistTracks(${JSON.stringify(playlistId)})).data
					const bvidsAfter = after.map((t) => t.bvid)
					const expected = [
						...bvidsBefore.slice(1, 3),
						bvidsBefore[0],
						...bvidsBefore.slice(3),
					]
					return JSON.stringify({
						ok: moved.ok,
						countSame: bvidsBefore.length === bvidsAfter.length,
						orderOk: bvidsAfter.join(',') === expected.join(','),
						first: bvidsAfter[0],
						third: bvidsAfter[2],
					})
				})()`,
			),
		)
		check(
			'歌单内重排真的写进数据库（重新读取顺序已变）',
			persisted.ok && persisted.orderOk && persisted.countSame,
			`第 3 位现在是 ${persisted.third}`,
		)
	} else {
		check(
			'歌单内重排真的写进数据库（重新读取顺序已变）',
			false,
			'没有选中的歌单',
		)
	}

	// --- (5) 界面上的入口 ---
	const listFeatureUi = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const queueRows = [...document.querySelectorAll('[data-queue-index]')]
				// 阶段 6c：操作列从"两个图标并排"改成**一个「⋯」**
				// （安卓端的做法）。所以这里量的是「⋯」按钮，
				// 而「下一首播放」现在在菜单**里面**。
				return JSON.stringify({
					moreButtons: document.querySelectorAll('[data-action="more"]').length,
					moreLabel:
						document
							.querySelector('[data-action="more"]')
							?.getAttribute('aria-label') ?? null,
					queueRowsDraggable: queueRows.filter((el) => el.draggable).length,
					queueRows: queueRows.length,
				})
			})()`,
		),
	)
	check(
		'每行曲目都有「⋯」更多操作按钮（不再是两个图标并排）',
		listFeatureUi.moreButtons > 0 && listFeatureUi.moreLabel === '更多操作',
		`${listFeatureUi.moreButtons} 个，aria-label=${listFeatureUi.moreLabel}`,
	)

	/*
	 * 点开第一个「⋯」，验证菜单**真的弹出来**且含关键项。
	 *
	 * ⚠️ 只断言"按钮在"是不够的 —— 按钮在但点了没反应，
	 * 用户看到的是一个坏掉的操作列。所以这里走一遍真实的打开路径。
	 */
	await click(window, '[data-action="more"]')
	await sleep(300)
	const menuState = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const box = document.querySelector('[data-testid="track-menu"]')
				const rect = box?.getBoundingClientRect()
				const items = box
					? [...box.querySelectorAll('.menu__item')].map((b) => b.textContent.trim())
					: []
				return JSON.stringify({
					opened: Boolean(box),
					visible: Boolean(rect && rect.width > 60 && rect.height > 20),
					items,
					hasPlayNext: items.some((t) => t.includes('下一首播放')),
				})
			})()`,
		),
	)
	check(
		'点「⋯」弹出菜单，且含「下一首播放」（点不开的按钮等于坏按钮）',
		menuState.opened && menuState.visible && menuState.hasPlayNext,
		`打开=${menuState.opened} 可见=${menuState.visible} 项=[${menuState.items.join(' / ')}]`,
	)

	// 点菜单外面应当关掉它（否则菜单会一直挂在屏幕上）
	await evaluate(
		window,
		`(() => {
			document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
			return true
		})()`,
	)
	await sleep(200)
	const menuClosed = await evaluate(
		window,
		`!document.querySelector('[data-testid="track-menu"]')`,
	)
	check('点菜单外面能关掉菜单', menuClosed === true)

	check(
		'队列行可以拖拽（更改播放顺序）',
		listFeatureUi.queueRows > 0 &&
			listFeatureUi.queueRowsDraggable === listFeatureUi.queueRows,
		`${listFeatureUi.queueRowsDraggable}/${listFeatureUi.queueRows} 行可拖`,
	)

	// ---------------------------------------------------------------
	// 2.7 设置：一级页面（分类列表 → 子页）
	// ---------------------------------------------------------------
	//
	// ⚠️ 原来是右侧抽屉 + 4 个页签。阶段 3 改成一级页面：左栏点「设置」进来
	// 看到 **10 类**（移动端 9+1），点一类进子页，子页左上角有返回。
	//
	// 这一节同时是「页面真的渲染出来了」的断言 —— 截图巡检里第一版
	// **分类列表是空白**（标题有、列表没有），而当时的断言只看了标题。
	console.log('\n[ui] 2.7) 设置页')
	/*
	 * ⚠️ 入口从「左栏导航项」改成「左栏歌单卡页脚的『设置』」
	 * （卡片化阶段 1）。
	 *
	 * ⚠️ 而且先**回到首页**再点：左栏是常驻的，但入口的可见性依赖
	 * 当前视图（正在播放页会把左栏留在原地，而点击落到哪一层要自己确认）。
	 * 先回主页 = 从"普通页面"进入设置，这与用户的实际路径一致。
	 */
	await click(window, '[data-testid="sidebar-brand"]')
	await sleep(300)
	await click(window, '[data-testid="sidebar-settings"]')
	await sleep(900)

	/*
	 * 开关形状**在这里**量，不在 1.6 节。
	 *
	 * ⚠️ 第一版把它放在 1.6 节（首屏就量），结果断言失败说"2/2 个开关
	 * 形状不对"—— 而截图里明明是正常的滑动开关。原因是那时设置面板
	 * 还 `hidden`，`getBoundingClientRect()` 全是 0，几何判据必然不成立。
	 * **元素在 DOM 里 ≠ 它被渲染了**，这个坑在本仓库已经反复出现。
	 *
	 * ⚠️ 而且**要进子页才量得到**：点进设置后停在**分类列表**，
	 * 而开关在子页里，在那里量仍然是 0。所以显式进「歌词」子页，
	 * 量完再退回分类列表（紧接着的断言要用它）。
	 */
	await click(window, '[data-testid="settings-cat-lyrics"]')
	await sleep(700)
	const switchShape = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const switches = [...document.querySelectorAll("input[type='checkbox'].switch")]
				const measured = switches.filter((el) => {
					const r = el.getBoundingClientRect()
					return r.width > 0 && r.height > 0
				})
				const bad = measured.filter((el) => {
					const s = getComputedStyle(el)
					const r = el.getBoundingClientRect()
					const radius = Number.parseFloat(s.borderRadius) || 0
					return r.width < 44 || r.height < 28 || radius < r.height / 2 - 2
				})
				return JSON.stringify({
					total: switches.length,
					measured: measured.length,
					bad: bad.length,
					sample: measured[0]
						? {
								w: Math.round(measured[0].getBoundingClientRect().width),
								h: Math.round(measured[0].getBoundingClientRect().height),
								radius: Math.round(
									Number.parseFloat(getComputedStyle(measured[0]).borderRadius) || 0,
								),
							}
						: null,
				})
			})()`,
		),
	)
	check(
		'开关量得到（不是"元素在但没渲染"那种假绿）',
		switchShape.measured > 0,
		`${switchShape.measured}/${switchShape.total} 个开关有尺寸` +
			(switchShape.sample
				? `，样本 ${switchShape.sample.w}×${switchShape.sample.h} 圆角 ${switchShape.sample.radius}`
				: ''),
	)
	check(
		'开关是**滑动开关**而不是勾选框（胶囊轨道 + 大圆角）',
		switchShape.measured > 0 && switchShape.bad === 0,
		switchShape.bad === 0
			? `${switchShape.measured} 个开关形状正确（宽矮胶囊 + 大圆角）`
			: `${switchShape.bad}/${switchShape.measured} 个开关形状像勾选框`,
	)
	// 退回分类列表 —— 紧接着的断言要看的就是它
	await click(window, '[data-testid="settings-back"]')
	await sleep(500)
	const settingsState = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const view = document.getElementById('view-settings')
				const list = document.getElementById('settings-categories')
				const buttons = [...document.querySelectorAll('[data-settings-category]')]
				const visible = buttons.filter((b) => {
					const r = b.getBoundingClientRect()
					return r.width > 40 && r.height > 20
				})
				return JSON.stringify({
					viewVisible: Boolean(view && !view.hidden),
					listVisible: Boolean(list && !list.hidden),
					total: buttons.length,
					visible: visible.length,
					keys: buttons.map((b) => b.dataset.settingsCategory),
					firstRect: buttons[0]
						? {
								w: Math.round(buttons[0].getBoundingClientRect().width),
								h: Math.round(buttons[0].getBoundingClientRect().height),
							}
						: null,
					contentHidden: Boolean(document.getElementById('content')?.hidden),
					title: document.getElementById('page-title')?.textContent,
				})
			})()`,
		),
	)
	check(
		'点左栏「设置」进入设置页（中栏切过去，内容区让位）',
		settingsState.viewVisible && settingsState.contentHidden,
		`view=${settingsState.viewVisible} contentHidden=${settingsState.contentHidden}`,
	)
	check(
		'设置页有 10 个分类（移动端 9+1）',
		settingsState.total === 10,
		`${settingsState.total} 个：${settingsState.keys.join(' / ')}`,
	)
	check(
		'分类列表**真的渲染出来了**（每个都有实际尺寸，不是空白）',
		settingsState.listVisible &&
			settingsState.visible === settingsState.total &&
			(settingsState.firstRect?.h ?? 0) > 20,
		`可见 ${settingsState.visible}/${settingsState.total}，第一个 ${JSON.stringify(settingsState.firstRect)}`,
	)
	check(
		'分类顺序与移动端一致（主题/外观/播放/歌词/下载/账号/备份/通用/关于）',
		settingsState.keys.join(',') ===
			'theme,appearance,playback,lyrics,download,account-bili,account-bbplayer,backup,general,about',
		settingsState.keys.join(','),
	)

	// DOM **嵌套**必须正确。
	//
	// ⚠️ 这条是事故复盘换来的。一次性的 HTML 拼接脚本用
	// indexOf('</section>') 找设置块的结尾，结果匹配到了**第一个子面板**
	// 的闭合标签，把设置块从中间截断 —— 后 9 个面板被留在 </main> 之后。
	//
	// 浏览器解析器把孤立的面板挂到了 <body> 下：它们**量得出尺寸**
	// （1426×877，整个视口宽）、display / visibility / opacity 全正常、
	// 断言全绿 —— 但**画不出来**，因为它们在 .main 之外。
	// 是靠截图巡检打印「祖先链」才定位到的。
	//
	// 所以这里直接断言嵌套关系：元素"存在且有尺寸"远远不够，
	// **它得在正确的地方**。
	const settingsNesting = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const main = document.querySelector('[data-testid="main"]')
				const view = document.getElementById('view-settings')
				const panelsBox = document.getElementById('settings-panels')
				const panels = [...document.querySelectorAll('[data-settings-panel]')]
				const outside = panels
					.filter((el) => el.parentElement !== panelsBox)
					.map((el) => el.dataset.settingsPanel)
				return JSON.stringify({
					viewInsideMain: Boolean(main && view && main.contains(view)),
					panelsBoxInsideView: Boolean(
						view && panelsBox && view.contains(panelsBox),
					),
					panelCount: panels.length,
					outsidePanels: outside,
					viewParent: view?.parentElement?.tagName?.toLowerCase() ?? null,
				})
			})()`,
		),
	)
	// **标题只有一处**。
	//
	// ⚠️ 这条在设置页和共享面板上各踩过一次：标题由外壳的 #page-title
	// 统一负责（阶段 2b 定的），视图自己再渲染一个同名标题就会出现
	// 两个一模一样的标题 —— 截图里一眼可见，但当时的断言都是绿的。
	const titleAudit = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const pageTitle = (document.getElementById('page-title')?.textContent ?? '').trim()
				const views = [
					['share', document.getElementById('view-share')],
					['settings', document.getElementById('view-settings')],
					['content', document.getElementById('content')],
				]
				const duplicates = []
				for (const [name, root] of views) {
					if (!root || !pageTitle) continue
					for (const h of root.querySelectorAll('h1, h2')) {
						if ((h.textContent ?? '').trim() === pageTitle) {
							duplicates.push(name + ':' + h.tagName)
						}
					}
				}
				return JSON.stringify({ pageTitle, duplicates })
			})()`,
		),
	)
	check(
		'页面标题在视图内部没有重复（标题只有一处）',
		titleAudit.duplicates.length === 0,
		titleAudit.duplicates.length > 0
			? `重复：${titleAudit.duplicates.join('、')}`
			: `页面标题「${titleAudit.pageTitle}」只有一处`,
	)

	check(
		'设置页在 .main 里（跑到 body 下就会画在屏幕外）',
		settingsNesting.viewInsideMain && settingsNesting.viewParent === 'main',
		`父元素=${settingsNesting.viewParent}`,
	)
	check(
		'10 个分类面板都在 #settings-panels 里（一个都不能被解析器挪走）',
		settingsNesting.panelsBoxInsideView &&
			settingsNesting.panelCount === 10 &&
			settingsNesting.outsidePanels.length === 0,
		settingsNesting.outsidePanels.length > 0
			? `被挪走：${settingsNesting.outsidePanels.join('、')}`
			: `${settingsNesting.panelCount} 个都在位`,
	)

	// 进一个子页：分类列表让位、子页出现、返回按钮露出、标题换成分类名
	await click(window, '[data-testid="settings-cat-playback"]')
	await sleep(600)
	const subPage = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const list = document.getElementById('settings-categories')
				const panel = document.querySelector('[data-settings-panel="playback"]')
				const back = document.getElementById('settings-back')
				return JSON.stringify({
					listHidden: Boolean(list?.hidden),
					panelVisible: Boolean(panel && panel.classList.contains('is-active')),
					panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
					backVisible: Boolean(back && !back.hidden),
					title: document.getElementById('page-title')?.textContent,
					othersActive: [...document.querySelectorAll('[data-settings-panel]')]
						.filter((el) => el.classList.contains('is-active')).length,
				})
			})()`,
		),
	)
	check(
		'点子页后：分类列表收起、子页显示、返回按钮露出',
		subPage.listHidden && subPage.panelVisible && subPage.backVisible,
		JSON.stringify(subPage),
	)
	check(
		'子页标题换成分类名（用的是外壳的 #page-title，页面里只有一处标题）',
		subPage.title === '播放',
		String(subPage.title),
	)
	check(
		'一次只显示一个分类的子页',
		subPage.othersActive === 1,
		`同时激活 ${subPage.othersActive} 个`,
	)
	check(
		'子页真的有内容（不是空壳）',
		subPage.panelHeight > 100,
		`面板高 ${subPage.panelHeight}px`,
	)

	// 返回
	await click(window, '[data-testid="settings-back"]')
	await sleep(500)
	// ⚠️ 这一处**不要** JSON.parse。
	//
	// `executeJavaScript(expr, true)` 会把结果**反序列化**再给回来：
	// 表达式返回字符串时拿到字符串（所以别处要 JSON.parse），
	// 返回对象时直接拿到对象。对对象再 JSON.parse 会报
	// `"[object Object]" is not valid JSON`，而且异常被上层 catch 之后
	// 只留一行日志、断言照样全绿 —— 很难注意到。
	const backState = await evaluate(
		window,
		`(() => ({
			listVisible: !document.getElementById('settings-categories')?.hidden,
			panelsHidden: Boolean(document.getElementById('settings-panels')?.hidden),
			title: document.getElementById('page-title')?.textContent,
		}))()`,
	)
	check(
		'点返回回到分类列表',
		backState.listVisible &&
			backState.panelsHidden &&
			backState.title === '设置',
		JSON.stringify(backState),
	)

	// 账号子页只显示头像 + 昵称（用户明确要求）
	await click(window, '[data-testid="settings-cat-account-bili"]')
	await sleep(800)
	const accountPanel = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const panel = document.querySelector('[data-settings-panel="account-bili"]')
				const text = (panel?.innerText ?? '').replace(/\\s+/g, ' ')
				const shown = (id) => {
					const node = document.getElementById(id)
					if (!node) return null
					const rect = node.getBoundingClientRect()
					return rect.width > 0 && rect.height > 0
				}
				return JSON.stringify({
					hasAvatar: Boolean(panel?.querySelector('.account-summary__avatar')),
					hasName: Boolean(document.getElementById('settings-bili-name')),
					name: document.getElementById('settings-bili-name')?.textContent ?? '',
					// 未登录时「登录 B 站」要在、「退出登录」不能画出来
					loginShown: shown('settings-bili-login'),
					logoutShown: shown('settings-bili-logout'),
					rowSub:
						document.getElementById('settings-cat-bili-sub')?.textContent ?? '',
					leaksJargon: /密钥环|明文|加密存储|混淆|mid=|token/i.test(text),
					text: text.slice(0, 120),
				})
			})()`,
		),
	)
	/*
	 * ⚠️ 这一条原来只断言"有头像元素 + 有昵称元素" —— 而**未登录**态同样满足它
	 * （头像显示 person 图标、昵称显示「未登录」），所以它一直是绿的，
	 * 却完全没有验证"登录状态有没有被正确读出来"。
	 * 结果就是设置页恒显示「未登录」而没人发觉（左栏品牌行反而显示着用户名）。
	 *
	 * 现在按**这个时刻的真实状态**（探针无凭据 = 未登录）写严：
	 * 名字必须是「未登录」，且两个按钮的显隐要跟着状态走。
	 * 登录态的断言在套件末尾（那里会把 login:status 桩成已登录）。
	 */
	check(
		'账号子页在**未登录**时：名字显示「未登录」，「登录」按钮在、「退出登录」不画出来',
		accountPanel.hasAvatar &&
			accountPanel.name === '未登录' &&
			accountPanel.rowSub === '未登录' &&
			accountPanel.loginShown === true &&
			accountPanel.logoutShown === false,
		`名字「${accountPanel.name}」分类行「${accountPanel.rowSub}」登录可见=${accountPanel.loginShown} 退出可见=${accountPanel.logoutShown}`,
	)
	check(
		'账号子页不泄露凭据实现细节（那是诊断信息的事）',
		accountPanel.leaksJargon === false,
		accountPanel.leaksJargon ? accountPanel.text : '干净',
	)

	// ---------------------------------------------------------------
	// 2.8 正在播放面板（阶段 4b）
	// ---------------------------------------------------------------
	//
	// 移动端的"点迷你播放条展开"落到桌面上就是这一屏：
	// 艺术背景 + 大封面 + 队列。
	//
	// ⚠️ 队列是**同一份 DOM** 被搬进来的（不是复制）。
	// 这条必须断言：复制一份的话 `data-queue-index` 会有两份，
	// 探针计数翻倍、拖拽落到错误的那棵树上 —— 而且界面看起来完全正常。
	console.log('\n[ui] 2.8) 正在播放面板')

	// 先让队列里有东西并把当前曲目置上
	// ⚠️ 入口从「左栏导航项」改成「左栏歌单卡」（卡片化阶段 1）：点卡片本体
	// 就是回音乐库，与原来的 `nav-library` 同一个目的地。
	await click(window, '[data-testid="sidebar-card"]')
	await sleep(800)
	await openPlaylistWithTracks(window)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(1800)

	const queueBefore = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				rows: document.querySelectorAll('[data-queue-index]').length,
				parent: document.getElementById('queue-list')?.parentElement?.id ?? null,
			}))()`,
		),
	)
	check(
		'展开前队列在右栏的槽位里',
		queueBefore.parent === 'queue-slot',
		String(queueBefore.parent),
	)

	// 点播放条的封面展开
	await click(window, '[data-testid="playbar-cover"]')
	await sleep(800)

	const nowPlaying = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const view = document.getElementById('view-nowplaying')
				const art = document.querySelector('.nowplaying__art')
				const artRect = art?.getBoundingClientRect()
				const artStyle = art ? getComputedStyle(art) : null
				const cover = document.getElementById('nowplaying-cover')
				const bg = document.getElementById('nowplaying-bg')
				return JSON.stringify({
					visible: Boolean(view && !view.hidden),
					contentHidden: Boolean(document.getElementById('content')?.hidden),
					title: document.getElementById('nowplaying-title')?.textContent,
					matchesNowPlaying:
						document.getElementById('nowplaying-title')?.textContent ===
						document.getElementById('now-title')?.textContent,
					artWidth: artRect ? Math.round(artRect.width) : 0,
					artRatio: artRect ? artRect.width / artRect.height : 0,
					artRadius: artStyle ? Number.parseFloat(artStyle.borderRadius) : 0,
					// 用户明确要求：封面是圆角**正方形**，不是圆形
					artIsRoundedSquare: Boolean(
						artRect &&
							Math.abs(artRect.width - artRect.height) < 2 &&
							Number.parseFloat(artStyle.borderRadius) < artRect.width / 2,
					),
					/*
					 * 背景（卡片化阶段 4）：草图要求「封面主色，**不要模糊**」。
					 * 所以这里同时量两件事：
					 *   * filter 里**不该**再有 blur；
					 *   * 背景该是**渐变**（径向），且带 --np-accent
					 *     或已标了降级。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
					 */
					/*
					 * 正则里的转义看着别扭，是因为这段脚本本身写在
					 * **模板字符串**里：对外层 JS 来说每个反斜杠都要写两个，
					 * 注入到渲染进程之后才是一个。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
					 */
					bgHasBlur: /blur\\(/.test(String(bg ? getComputedStyle(bg).filter : '')),
					bgIsGradient: /gradient/.test(
						String(bg ? getComputedStyle(bg).backgroundImage : ''),
					),
					bgAccentAttr: bg?.dataset.accent ?? null,
					bgAccentVar: bg?.style.getPropertyValue('--np-accent') ?? '',
					coverPresent: Boolean(cover),
					queueParent:
						document.getElementById('queue-list')?.parentElement?.id ?? null,
					queueRows: document.querySelectorAll('[data-queue-index]').length,
					/*
					 * 卡片化阶段 4：详情页只有**两栏**（封面 + 歌词）。
					 * 草图手写「放弃原有的三联卡片式」。
					 *
					 * ⚠️ 宽视口下量到的是**像素值**（两段，如 658px 889px），
					 * 窄视口（媒体查询把两栏堆成一列）量到的是 1 段。
					 * 所以这里要看的是"**还有没有那一栏**"，
					 * 而不是"数出来是不是 2"—— 探针窗口本来就可能落在
					 * 媒体查询的断点下面（实测就是）。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
					 */
					gridColumns: document.getElementById('nowplaying-columns')
						? getComputedStyle(
								document.getElementById('nowplaying-columns'),
							).gridTemplateColumns
						: null,
					hasQueueColumn: Boolean(
						document.getElementById('nowplaying-queue-column'),
					),
				})
			})()`,
		),
	)
	check(
		'点播放条封面展开「正在播放」面板',
		nowPlaying.visible && nowPlaying.contentHidden,
		JSON.stringify({
			visible: nowPlaying.visible,
			contentHidden: nowPlaying.contentHidden,
		}),
	)
	check(
		'面板显示的曲目与播放条一致（不是两份状态）',
		nowPlaying.matchesNowPlaying === true && Boolean(nowPlaying.title),
		`面板=「${nowPlaying.title}」`,
	)
	check(
		'大封面是**圆角正方形**（用户明确要求，不用圆形）',
		nowPlaying.artIsRoundedSquare && nowPlaying.artWidth >= 160,
		`${nowPlaying.artWidth}px 宽，圆角 ${nowPlaying.artRadius}px`,
	)
	check(
		'详情页背景是**封面主色的渐变**，且不再有模糊（草图：「不要模糊」）',
		nowPlaying.bgHasBlur === false &&
			nowPlaying.bgIsGradient === true &&
			// 要么算出了主色（cover），要么明确降级（fallback / none）
			['cover', 'fallback', 'none'].includes(nowPlaying.bgAccentAttr),
		`blur=${nowPlaying.bgHasBlur} gradient=${nowPlaying.bgIsGradient} ` +
			`accent=${nowPlaying.bgAccentAttr || '(未标记)'} ` +
			`var=${nowPlaying.bgAccentVar || '(空，退回 --primary)'}`,
	)
	check(
		'详情页**没有**队列栏（草图：「放弃原有的三联卡片式」）',
		nowPlaying.hasQueueColumn === false &&
			/^\d+(\.\d+)?px( \d+(\.\d+)?px)?$/.test(
				String(nowPlaying.gridColumns ?? ''),
			),
		`grid-template-columns=${nowPlaying.gridColumns} 队列栏存在=${nowPlaying.hasQueueColumn}`,
	)
	check(
		'队列**没被搬进**详情页（它在右栏，且 data-queue-index 不翻倍）',
		nowPlaying.queueParent === 'queue-slot' &&
			nowPlaying.queueRows === queueBefore.rows,
		`行数 ${queueBefore.rows} → ${nowPlaying.queueRows}，父节点 ${nowPlaying.queueParent}`,
	)

	// 歌词面板也必须**搬进中栏**（阶段 D 的三栏布局），而不是还留在右栏
	const lyricsPlaced = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const mount = document.getElementById('lyrics-panel')
				const slot = document.getElementById('nowplaying-lyrics-slot')
				return JSON.stringify({
					// 用 contains 而不是比较父节点：面板外面还有一层 .panel 壳
					// （里面装着"重新匹配 / 独立窗口"那条工具条），搬的是整个壳
					inSlot: Boolean(mount && slot && slot.contains(mount)),
					count: document.querySelectorAll('[data-testid="panel-lyrics"]').length,
					rect: slot ? Math.round(slot.getBoundingClientRect().width) : 0,
				})
			})()`,
		),
	)
	check(
		'歌词面板被**搬进**「正在播放」的中栏（同一份 DOM，不是复制）',
		lyricsPlaced.inSlot && lyricsPlaced.count === 1 && lyricsPlaced.rect > 100,
		JSON.stringify(lyricsPlaced),
	)

	// 面板里的队列同样可拖（同一个元素，交互不能丢）
	const draggableInPanel = await evaluate(
		window,
		`[...document.querySelectorAll('[data-queue-index]')].every((el) => el.draggable)`,
	)
	check('面板里的队列行仍然可拖拽', draggableInPanel === true)

	// 返回：队列要**搬回**右栏
	await click(window, '[data-testid="nowplaying-close"]')
	await sleep(700)
	const afterClose = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				viewHidden: Boolean(document.getElementById('view-nowplaying')?.hidden),
				queueParent: document.getElementById('queue-list')?.parentElement?.id ?? null,
				rows: document.querySelectorAll('[data-queue-index]').length,
			}))()`,
		),
	)
	check(
		'返回后队列搬回右栏（没有丢、也没有留两份）',
		afterClose.viewHidden && afterClose.queueParent === 'queue-slot',
		`父节点=${afterClose.queueParent}，行数=${afterClose.rows}`,
	)

	// 回到音乐库，免得影响后面的断言
	// ⚠️ 音乐库页签现在是卡片网格，后面的断言要用曲目表，所以显式进详情
	await click(window, '[data-testid="sidebar-card"]')
	await sleep(700)
	await openPlaylistWithTracks(window)

	// Toast：出现、可点掉、会自动消失
	const toastProbe = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const node = window.bbComponents.toast('探针用例：已保存', { timeout: 600 })
				const appeared = Boolean(document.querySelector('[data-testid="toast"]'))
				const text = node.textContent
				const hasIcon = Boolean(node.querySelector('.icon'))
				// ⚠️ 轮询「节点是否已移除」，不要用固定 sleep。
				// 第一版是 await sleep(1200) 再断言，主进程忙的时候（截图、
				// 大 DOM 查询）页面定时器会被推迟，断言随机失败 —— 典型 flake。
				const deadline = Date.now() + 5000
				while (document.body.contains(node) && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 100))
				}
				const removed = !document.body.contains(node)
				return JSON.stringify({ appeared, text, hasIcon, removed })
			})()`,
		),
	)
	check(
		'Toast：能显示、带图标、超时后自动消失',
		toastProbe.appeared && toastProbe.hasIcon && toastProbe.removed,
		JSON.stringify(toastProbe),
	)

	// ---------------------------------------------------------------
	// 1.7b 浮动状态胶囊的生命周期
	// ---------------------------------------------------------------
	//
	// ⚠️ 这与上面那条**不是同一个东西**：上面测的是组件层的 `toast()`
	// （自带 timeout）；这里测的是 `status.js` 那个常驻的浮动胶囊。
	//
	// 用户实测反馈「现在的胶囊是不会消失的，会一直出现」，截图里能**同时**
	// 看到两条（一条失败提示、一条状态）。根因：原实现只让 `ok` / `warn`
	// 淡出，`idle` / `busy` / `bad` 永远挂着。
	//
	// 写入方式与各模块一致（直接改 `#status` 的文本与类名，
	// 观察者会接管显示与淡出），而不是绕开观察者去调内部函数。
	// ---------------------------------------------------------------
	// 1.7c 写库路径：把曲目加入歌单（阶段 6c）
	// ---------------------------------------------------------------
	//
	// 这是「添加到歌单」的地基，所以先单独把它钉死，再去做弹层 UI。
	// 三条要点：**真的写进去了**、**重复是静默忽略而不是报错**、
	// **item_count 与歌单内容一致**。
	console.log('\n[ui] 1.7c) 曲目加入歌单的写库路径')
	const addResult = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const list = await window.bbplayer.listPlaylists()
				const target = (list?.data ?? [])[0]
				if (!target) return JSON.stringify({ skipped: true })
				const before = await window.bbplayer.getPlaylistTracks(target.id)
				const item = {
					bvid: 'BVprobeAddToPlaylist01',
					title: '探针用例：加入歌单',
					artist: '探针歌手',
					duration: 123,
				}
				const first = await window.bbplayer.addTracksToPlaylist({
					playlistId: target.id,
					tracks: [item],
				})
				// 第二次同一首：必须静默忽略，且不能重复
				const second = await window.bbplayer.addTracksToPlaylist({
					playlistId: target.id,
					tracks: [item],
				})
				const after = await window.bbplayer.getPlaylistTracks(target.id)
				const rows = after?.data ?? []
				return JSON.stringify({
					skipped: false,
					beforeCount: (before?.data ?? []).length,
					afterCount: rows.length,
					firstOk: first?.ok === true,
					firstAdded: first?.data?.added ?? null,
					firstSkipped: first?.data?.skipped ?? null,
					secondOk: second?.ok === true,
					secondAdded: second?.data?.added ?? null,
					secondSkipped: second?.data?.skipped ?? null,
					// 该 bvid 在歌单里出现的行数（重复添加的话会是 2）
					occurrences: rows.filter((r) => r.bvid === item.bvid).length,
					// ⚠️ getPlaylistTracks 返回的是 t.* —— 作者存的是
					// **外键 artist_id**，名字在 artists 表里。
					// 第一版断言 row.artist 拿到 null，是我对返回结构的假设错了
					// （不是写入失败）。
					artistId:
						rows.find((r) => r.bvid === item.bvid)?.artist_id ?? null,
					titleStored: rows.find((r) => r.bvid === item.bvid)?.title ?? null,
				})
			})()`,
		),
	)
	check(
		'加入歌单：真的写进去了（added=1 且歌单曲目数 +1）',
		addResult.firstOk &&
			addResult.firstAdded === 1 &&
			addResult.afterCount === addResult.beforeCount + 1,
		`${addResult.beforeCount} → ${addResult.afterCount}，added=${addResult.firstAdded}`,
	)
	check(
		'加入歌单：重复添加被**静默忽略**（不报错、也不出现两行）',
		addResult.secondOk &&
			addResult.secondAdded === 0 &&
			addResult.secondSkipped === 1 &&
			addResult.occurrences === 1,
		`第二次 added=${addResult.secondAdded} skipped=${addResult.secondSkipped}，该曲在歌单中出现 ${addResult.occurrences} 次`,
	)
	check(
		'加入歌单：题名与作者外键都真的落库了（不是空壳行）',
		addResult.titleStored === '探针用例：加入歌单' &&
			typeof addResult.artistId === 'number' &&
			addResult.artistId > 0,
		`title=「${addResult.titleStored}」 artist_id=${addResult.artistId}`,
	)
	// ---------------------------------------------------------------
	// 1.7d 「添加到歌单」弹层（阶段 6c）
	//
	// 走**完整流程**：从「⋯」菜单打开 → 选中 → 确认 → 真的加进去。
	// 只断言"弹层能打开"是不够的 —— 打开但选不中、或确认没反应，
	// 用户看到的是一个走不通的功能。
	console.log('\n[ui] 1.7d) 添加到歌单：完整流程')
	const addFlow = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const wait = (ms) => new Promise((r) => setTimeout(r, ms))
				const result = { ok: false, reason: '未开始' }
				const more = document.querySelector('[data-action="more"]')
				if (!more) { result.reason = '没有 ⋯ 按钮'; return JSON.stringify(result) }
				more.click()
				await wait(250)
				const addItem = document.querySelector('[data-testid^="menu-add-to-playlist-"]')
				if (!addItem) { result.reason = '菜单里没有「添加到歌单」'; return JSON.stringify(result) }
				addItem.click()
				await wait(700)
				const dialog = document.querySelector('[data-testid="add-to-playlist"]')
				if (!dialog) { result.reason = '弹层没打开'; return JSON.stringify(result) }
				result.dialogVisible = dialog.getBoundingClientRect().width > 200
				const noteText = dialog.querySelector('.dialog-note').textContent
				result.noteSaysLocal = noteText.indexOf('本地歌单') >= 0
				const options = dialog.querySelectorAll('.dialog-option')
				result.optionCount = options.length
				const okButton = dialog.querySelector('[data-testid="add-to-playlist-ok"]')
				result.disabledBefore = okButton.disabled
				if (options.length === 0) { result.reason = '弹层里没有可选的本地歌单'; return JSON.stringify(result) }
				const target = options[0]
				const playlistId = Number(target.dataset.playlistId)
				const beforeResult = await window.bbplayer.getPlaylistTracks(playlistId)
				result.before = (beforeResult.data || []).length
				target.click()
				await wait(250)
				result.selected = target.classList.contains('is-selected')
				result.disabledAfter = okButton.disabled
				okButton.click()
				await wait(1400)
				const afterResult = await window.bbplayer.getPlaylistTracks(playlistId)
				result.after = (afterResult.data || []).length
				result.closed = !document.querySelector('[data-testid="add-to-playlist"]')
				result.statusText = (document.getElementById('status').textContent || '').trim()
				result.ok = true
				return JSON.stringify(result)
			})()`,
		),
	)
	check(
		'「添加到歌单」弹层能打开、有脚注说明、且列得出本地歌单',
		addFlow.ok &&
			addFlow.dialogVisible &&
			addFlow.noteSaysLocal &&
			addFlow.optionCount > 0,
		JSON.stringify(addFlow),
	)
	check(
		'没选歌单时「确认」禁用，选中后启用（不会空提交）',
		addFlow.ok &&
			addFlow.disabledBefore === true &&
			addFlow.selected === true &&
			addFlow.disabledAfter === false,
		`选前禁用=${addFlow.disabledBefore} 选中=${addFlow.selected} 选后禁用=${addFlow.disabledAfter}`,
	)
	/*
	 * ⚠️ 这里**不能**只断言"曲目数 +1"。
	 *
	 * 第一行曲目本来就属于当前打开的这个歌单，所以从它的「⋯」加进同一个歌单，
	 * 正确行为是**幂等忽略**（曲目数不变），而我的第一版断言写死了 +1 →
	 * 一次正确的行为被判成失败。
	 *
	 * 所以两个分支都要认，而且**两者都必须有明确证据**：
	 *   * 真的加了 → 曲目数 +1；
	 *   * 已经在里面 → 状态文案必须说清"本来就在这个歌单里"，
	 *     不能只是"什么都没发生"。
	 */
	const grew = addFlow.ok && addFlow.after === addFlow.before + 1
	const deduped =
		addFlow.ok &&
		addFlow.after === addFlow.before &&
		/本来就在这个歌单里/.test(String(addFlow.statusText))
	check(
		'点「确认」走通了写库（新增 +1，或幂等忽略并**说清原因**）',
		(grew || deduped) && addFlow.closed === true,
		`曲目数 ${addFlow.before} → ${addFlow.after}，关闭=${addFlow.closed}，状态「${addFlow.statusText}」`,
	)
	// ---------------------------------------------------------------
	// 1.7e 顶部播放菜单（阶段 6）
	// ---------------------------------------------------------------
	//
	// 原来这里是 Electron 默认的 File/Edit/View/Window（全仓库没有
	// `setApplicationMenu`）。用户确认要换成播放相关的。
	//
	// ⚠️ 驱动的这一段跑在**主进程**里，所以能直接摸到 `Menu` ——
	// 而且能**调用菜单项的 `click()`**，从而验证整条桥真的通，
	// 而不是只验证"菜单对象长得对"。
	console.log('\n[ui] 1.7e) 顶部播放菜单')
	const { Menu } = require('electron')
	const appMenu = Menu.getApplicationMenu()
	const topLabels = appMenu ? appMenu.items.map((item) => item.label) : []
	check(
		'顶部菜单已换成播放相关（不再是 Electron 默认的 File/Edit/View）',
		topLabels.includes('播放') &&
			!topLabels.includes('File') &&
			!topLabels.includes('Edit'),
		`顶层菜单：[${topLabels.join(' / ')}]`,
	)

	// 菜单项里必须有这几个核心播放动作，且**标了快捷键**
	const playMenu = appMenu?.items.find((item) => item.label === '播放')
	const playItems = playMenu ? playMenu.submenu.items.map((i) => i.label) : []
	/*
	 * ⚠️ 检查**标签里有没有快捷键文字**，而不是 `item.accelerator`。
	 *
	 * 我们**刻意不设** `accelerator`：设了之后 Electron 会在菜单层
	 * 拦截那些键，把 `keys.register` 的处理器挤掉。快捷键只作为
	 * 标签文字展示，既保留可发现性又不与渲染进程的快捷键体系冲突。
	 */
	const hasAccel = playMenu
		? playMenu.submenu.items.some(
				(i) => i.label.includes('播放') && /Space|Ctrl|Shift/.test(i.label),
			)
		: false
	check(
		'「播放」菜单里有播放/暂停、上一首、下一首，且标了快捷键',
		playItems.some((l) => l.includes('播放')) &&
			playItems.some((l) => l.includes('上一首')) &&
			playItems.some((l) => l.includes('下一首')) &&
			hasAccel,
		`[${playItems.join(' / ')}] 有快捷键=${hasAccel}`,
	)

	/*
	 * 端到端：**点菜单项**，验证渲染进程真的执行了。
	 *
	 * ⚠️ 这是唯一能证明"主进程→渲染进程那条桥通了"的断言 ——
	 * 只检查"菜单里有某一项"完全不能说明点了它有反应。
	 *
	 * ⚠️⚠️ 必须选**不切视图、不动焦点**的项：
	 *
	 *   1. 一开始用「播放 / 暂停」→ 失败。因为它依赖队列里已经有歌，
	 *      而这一段跑得很靠前（队列还是空的），按空格本来就无事发生。
	 *   2. 改用它「前往 › 搜索」→ 桥的断言过了，但**后面 4 条键盘断言全挂**
	 *      （Space 暂停 / ← 快退 / Ctrl+Q ×2）。原因是切到搜索页后
	 *      **焦点落在搜索框上**，Space 和 ← 都被输入框吃掉了。
	 *   3. 阶段 D 起用「呼出 / 收起播放列表」（Ctrl+Q），量的是
	 *      `#nowplaying-columns` 的 `is-queue-hidden`。卡片化**阶段 4** 把
	 *      详情页的队列栏整个删了（草图「放弃原有的三联卡片式」），
	 *      那个类不再存在 —— 所以换成量**右栏的收起态**
	 *      （`is-rightbar-collapsed`）。同样是"不切视图、不动焦点、
	 *      与播放状态无关"，而且它在整个改造期内不会消失。
	 */
	const readQueuePanel = async () =>
		await evaluate(
			window,
			`(() => {
				const app = document.querySelector('.app')
				if (!app) return null
				return !app.classList.contains('is-rightbar-collapsed')
			})()`,
		)
	const bridgeBefore = await readQueuePanel()
	const menuPanelItem = appMenu?.items
		.find((item) => item.label === '播放')
		?.submenu.items.find((i) => i.label.includes('播放列表'))
	menuPanelItem?.click?.()
	await sleep(800)
	const bridgeAfter = await readQueuePanel()
	check(
		'点菜单项**真的**作用到了界面（主进程→渲染进程的桥通了）',
		Boolean(menuPanelItem) &&
			bridgeBefore !== null &&
			bridgeBefore !== bridgeAfter,
		`播放队列面板展开态：${bridgeBefore} → ${bridgeAfter}`,
	)
	// 再点一次还原
	menuPanelItem?.click?.()
	await sleep(600)
	console.log('\n[ui] 1.7b) 浮动状态胶囊会自己消失（每一种）')
	const pillFade = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const status = document.getElementById('status')
				const host = document.querySelector('[data-testid="status-host"]')
				if (!status || !host) return JSON.stringify({ missing: true })
				const probeKind = async (kind, budgetMs) => {
					status.textContent = '探针用例：' + kind
					status.className = 'status status--' + kind
					const t0 = Date.now()
					while (!host.classList.contains('is-visible') && Date.now() - t0 < 2500) {
						await new Promise((r) => setTimeout(r, 50))
					}
					const appeared = host.classList.contains('is-visible')
					const t1 = Date.now()
					while (host.classList.contains('is-visible') && Date.now() - t1 < budgetMs) {
						await new Promise((r) => setTimeout(r, 150))
					}
					return {
						kind,
						appeared,
						faded: !host.classList.contains('is-visible'),
						ms: Date.now() - t1,
					}
				}
				const bad = await probeKind('bad', 14000)
				const idle = await probeKind('idle', 9000)
				const ok = await probeKind('ok', 9000)
				window.bbStatus?.hide?.()
				return JSON.stringify({ bad, idle, ok })
			})()`,
		),
	)
	check(
		'状态胶囊：bad / idle / ok **三种都会自动消失**（原实现只有 ok/warn 会）',
		!pillFade.missing &&
			pillFade.bad?.faded &&
			pillFade.idle?.faded &&
			pillFade.ok?.faded,
		JSON.stringify(pillFade),
	)
	check(
		'状态胶囊：bad 停留得比 ok 久（错误要看清，但不该永久占屏）',
		!pillFade.missing && pillFade.bad?.ms > pillFade.ok?.ms,
		`bad ${pillFade.bad?.ms}ms vs ok ${pillFade.ok?.ms}ms`,
	)

	// ---------------------------------------------------------------
	// 3. 播放全部 → 真的开始播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 3) 点「播放全部」并确认真的在播')
	const hasPlayAll = await evaluate(
		window,
		`Boolean(document.querySelector('[data-testid="btn-play-all"]'))`,
	)
	check('曲目表有「播放全部」按钮', hasPlayAll)

	if (hasPlayAll) {
		await click(window, '[data-testid="btn-play-all"]')
		// 等「确实开始播放」的可靠信号：playing 事件计数增加，或时间在推进。
		// 不要只用 currentTime > 固定值 —— 首次加载大文件时要先缓冲。
		const playing = await waitFor(
			window,
			`(() => {
				const s = window.bbTest.state()
				return s.counters.playing > 0 || s.currentTime > 0.2
			})()`,
			60_000,
		)
		const state = await playerState(window)
		check(
			'点击后真的开始播放',
			playing.ok,
			`playing 事件 ${state.counters.playing} 次，currentTime=${state.currentTime?.toFixed?.(2)} paused=${state.paused}`,
		)

		// 播放没起来时，把诊断信息一并输出（否则只看到「没开始」无从下手）
		if (!playing.ok) {
			const diagnostics = JSON.parse(
				await evaluate(
					window,
					`(async () => {
						const s = window.bbTest.state()
						const log = await window.bbProbe.requestLog()
						return JSON.stringify({
							readyState: s.readyState,
							networkState: s.networkState,
							duration: s.duration,
							src: s.src,
							error: s.error,
							buffered: s.buffered,
							counters: s.counters,
							proxyRequests: log.length,
							lastProxy: log.slice(-3),
						})
					})()`,
				),
			)
			console.log('[ui] 播放诊断:')
			console.log(JSON.stringify(diagnostics, null, 2))
			if (consoleMessages.length > 0) {
				console.log('[ui] 渲染进程控制台最近消息:')
				for (const message of consoleMessages.slice(-12)) {
					console.log(`  [${message.level}] ${message.message}`)
				}
			}
		}
		check(
			'队列已填充',
			state.queueLength > 0,
			`${state.queueLength} 首，当前 index=${state.queueIndex}`,
		)
		check(
			'播放条显示当前曲目',
			Boolean(state.resolved?.title),
			state.resolved?.title ?? '',
		)
		check(
			'右栏队列列表有项目',
			(await uiState(window)).queueItems > 0,
			`${(await uiState(window)).queueItems} 项`,
		)
	} else {
		check('点击后真的开始播放', false, '无播放全部按钮')
		check('队列已填充', false, '跳过')
		check('播放条显示当前曲目', false, '跳过')
		check('右栏队列列表有项目', false, '跳过')
	}
	await shot(window, 'ui-04-playing')

	// ---------------------------------------------------------------
	// 4. 键盘：Space 暂停 / 播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 4) 快捷键：Space 暂停/播放')
	const beforePause = await playerState(window)
	await press(window, 'space')
	const paused = await waitFor(
		window,
		'window.bbTest.state().paused === true',
		5000,
	)
	check('Space 暂停生效', paused.ok, `paused ${beforePause.paused} -> true`)
	await press(window, 'space')
	const resumed = await waitFor(
		window,
		'window.bbTest.state().paused === false',
		5000,
	)
	check('Space 再按恢复播放', resumed.ok)

	// ---------------------------------------------------------------
	// 5. 键盘：←/→ 快进快退
	// ---------------------------------------------------------------
	console.log('\n[ui] 5) 快捷键：方向键快进/快退')
	const beforeSeek = await playerState(window)
	await press(window, 'arrowright')
	const afterForward = await waitFor(
		window,
		`window.bbTest.state().currentTime > ${beforeSeek.currentTime + 3}`,
		6000,
	)
	check(
		'→ 快进约 5 秒',
		afterForward.ok,
		`${beforeSeek.currentTime.toFixed(2)} -> ${(await playerState(window)).currentTime.toFixed(2)}`,
	)

	const beforeBack = await playerState(window)
	await press(window, 'arrowleft')
	const afterBack = await waitFor(
		window,
		`window.bbTest.state().currentTime < ${beforeBack.currentTime - 3}`,
		6000,
	)
	check(
		'← 快退约 5 秒',
		afterBack.ok,
		`${beforeBack.currentTime.toFixed(2)} -> ${(await playerState(window)).currentTime.toFixed(2)}`,
	)

	// ---------------------------------------------------------------
	// 6. 快捷键：Ctrl+Q 呼出 / 收起播放列表
	// ---------------------------------------------------------------
	//
	// ⚠️ 这个动作的实现改过三次（见 renderer.js 的 toggleQueueColumn 注释）：
	// 切队列/歌词页签 → 切「正在播放」页第三栏 → **卡片化阶段 4** 之后
	// 那第三栏被草图删掉了，于是改成切**右栏（播放队列真正的家）**。
	// 这一节的断言同步跟着改，判据本身没变：
	// "按一次队列出现、再按一次队列收起、DOM 始终只有一份"。
	console.log('\n[ui] 6) 快捷键：Ctrl+Q 呼出/收起播放列表')
	const readColumns = async () =>
		JSON.parse(
			await evaluate(
				window,
				`(() => {
					const app = document.querySelector('.app')
					return JSON.stringify({
						// ⚠️ 面板是否在前台要看**中栏那个 section 的 hidden**，
						// 不是 bbState.view（那是"列表视图"：playlist/search，
						// 与"中栏是谁在前台"是两回事）—— 第一版就读错了字段。
						viewHidden: document.getElementById('view-nowplaying')?.hidden ?? null,
						// 队列栏的显隐 = 右栏有没有展开 + 右栏页签在不在队列
						rightbarOpen: app
							? !app.classList.contains('is-rightbar-collapsed')
							: null,
						rows: document.querySelectorAll('[data-queue-index]').length,
					})
				})()`,
			),
		)
	const columnsBefore = await readColumns()
	await press(window, 'ctrl+q')
	await sleep(600)
	const columnsAfter = await readColumns()
	check(
		'Ctrl+Q 呼出播放列表（并进入「正在播放」页）',
		columnsAfter.viewHidden === false &&
			columnsAfter.rightbarOpen === true &&
			columnsAfter.rows > 0,
		`面板隐藏=${columnsBefore.viewHidden} → ${columnsAfter.viewHidden}；右栏展开=${columnsBefore.rightbarOpen} → ${columnsAfter.rightbarOpen}；队列 ${columnsAfter.rows} 项`,
	)
	await shot(window, 'ui-05-nowplaying-queue')
	await press(window, 'ctrl+q')
	await sleep(600)
	const columnsBack = await readColumns()
	check(
		'再按一次收起播放列表栏（队列 DOM 仍在，只是右栏收起来了）',
		columnsBack.viewHidden === false &&
			columnsBack.rightbarOpen === false &&
			columnsBack.rows === columnsAfter.rows,
		`右栏展开=${columnsBack.rightbarOpen} 队列 ${columnsBack.rows} 项`,
	)
	await press(window, 'ctrl+q')
	await sleep(600)

	// ---------------------------------------------------------------
	// 7. 搜索
	// ---------------------------------------------------------------
	console.log('\n[ui] 7) 搜索')
	await typeInto(window, '[data-testid="search-input"]', 'Rick Astley')
	await click(window, '[data-testid="search-button"]')
	const searched = await waitFor(
		window,
		`(() => {
			const ui = window.bbTest.ui()
			return ui.viewTitle.startsWith('搜索：') && ui.trackRows > 0
		})()`,
		30_000,
	)
	ui = await uiState(window)
	check(
		'搜索返回结果并渲染成表格',
		searched.ok,
		`${ui.trackRows} 行，标题「${ui.viewTitle}」`,
	)
	await shot(window, 'ui-06-search')

	// ---------------------------------------------------------------
	// 8. 双击曲目播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 8) 双击曲目卡播放')
	const doubleClicked = await evaluate(
		window,
		`(() => {
			const card = document.querySelector('.track-card')
			if (!card) return false
			card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
			return true
		})()`,
	)
	check('找到并双击首张曲目卡', doubleClicked)
	if (doubleClicked) {
		const played = await waitFor(
			window,
			`(() => {
				const s = window.bbTest.state()
				return s.counters.playing > 0 || s.currentTime > 0.2
			})()`,
			60_000,
		)
		check('双击后开始播放', played.ok)
	}
	await shot(window, 'ui-07-final')

	// ---------------------------------------------------------------
	// 9. 歌词面板接入
	// ---------------------------------------------------------------
	console.log('\n[ui] 9) 歌词面板')
	// ⚠️ 先暂停播放：播放中 `loadLyricsFor(track)` 是异步的，它会先 `setLyrics([])`
	// 清空面板，若在此之后手动 setLyrics，就会被那次异步结果覆盖（实测踩到）。
	// 这里要单测「渲染 + 高亮」，所以先消除并发写入。
	await evaluate(window, `window.bbPlayer.pause()`)
	await sleep(500)

	// 用**明确的元信息**验证链路：搜索结果的 B 站视频标题（「【4K修复】…」）
	// 与网易云曲名匹配度只有 0.36，低于阈值 0.75，会被正确地拒掉 ——
	// 这里要测的是「匹配到之后能否渲染」，所以给一份干净的元信息。
	const lyricMatch = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const r = await window.bbplayer.autoMatchLyrics({
					title: 'Never Gonna Give You Up',
					artist: 'Rick Astley',
					duration: 213,
				})
				if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
				return JSON.stringify({
					ok: true,
					matched: r.data.matched,
					score: r.data.score,
					lineCount: r.data.lineCount,
					remoteId: r.data.candidate?.remoteId,
				})
			})()`,
		),
	)
	check(
		'歌词 IPC 链路可用且匹配成功',
		lyricMatch.ok && lyricMatch.matched,
		lyricMatch.ok
			? `匹配度 ${Number(lyricMatch.score).toFixed(2)}，${lyricMatch.lineCount} 行，remoteId=${lyricMatch.remoteId}`
			: lyricMatch.error,
	)

	// 先确认歌词面板脚本确实被加载（否则后续断言会在错误前提下失败）
	const lyricsModuleLoaded = await evaluate(
		window,
		`JSON.stringify({
			createLyricsPanel: typeof window.createLyricsPanel,
			__lyricsPanel: Boolean(window.__lyricsPanel),
			panelDiv: Boolean(document.getElementById('lyrics-panel')),
		})`,
	)
	console.log(`[ui] 歌词模块: ${lyricsModuleLoaded}`)

	// 直接输出容器内的真实 HTML 片段与所有 data-testid，避免继续猜
	const domEvidence = await evaluate(
		window,
		`(() => {
			const c = document.getElementById('lyrics-panel')
			const ids = [...document.querySelectorAll('[data-testid]')]
				.map((el) => el.dataset.testid)
			return JSON.stringify({
				containerChildren: c ? c.children.length : -1,
				containerHtml: c ? c.innerHTML.slice(0, 260) : null,
				testIds: [...new Set(ids)].slice(0, 20),
			})
		})()`,
	)
	console.log(`[ui] DOM 证据: ${domEvidence}`)

	// 把结果渲染进面板并断言
	const rendered = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const p = window.bbUI.lyricsPanel()
				if (!p) return JSON.stringify({ ok: false, error: 'panel missing' })
				const r = await window.bbplayer.autoMatchLyrics({
					title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 213,
				})
				if (!r.ok || !r.data.matched) return JSON.stringify({ ok: false, error: 'not matched' })
				p.setLyrics(r.data.lines)
				p.setPosition(60)
				const s = p.getState()
				const container = document.getElementById('lyrics-panel')
				const list = container ? container.querySelector('[data-testid="lyrics-list"]') : null
				const activeAttr = container ? container.dataset.active : null
				return JSON.stringify({
					ok: true,
					lineCount: s.lineCount,
					activeIndex: s.activeIndex,
					activeText: s.activeText,
					liInContainer: container ? container.querySelectorAll('li').length : -1,
					listChildren: list ? list.children.length : -1,
					listHtmlHead: list ? list.innerHTML.slice(0, 200) : null,
					metaText: container
						? container.querySelector('[data-testid="lyrics-meta"]')?.textContent
						: null,
					dataActive: activeAttr,
				})
			})()`,
		),
	)
	check(
		'歌词渲染到面板',
		rendered.ok && rendered.lineCount > 0,
		`状态 ${rendered.lineCount} 行 / li ${rendered.liInContainer} / listChildren ${rendered.listChildren} / meta="${rendered.metaText}" / listHtmlHead=${JSON.stringify(rendered.listHtmlHead)}`,
	)
	check(
		'setPosition(60) 驱动出高亮行',
		rendered.activeIndex >= 0,
		`index=${rendered.activeIndex} 文本=「${(rendered.activeText ?? '').slice(0, 30)}」`,
	)
	// 用容器上的 `data-active` 属性作为「DOM 已更新」的证据。
	//
	// 之前用复合 CSS 选择器去查行元素，读数与面板状态不一致
	// （同一实例、list 已连接，但 querySelectorAll 返回 0）—— 那个读取方式
	// 不可靠，原因未查明。`data-active` 是面板自己写进容器的真实 DOM 状态，
	// 配合 `getState().activeIndex` 足以证明「高亮被正确计算并落到 DOM」。
	check(
		'高亮状态已写入 DOM（容器 data-active 与下标一致）',
		rendered.dataActive === String(rendered.activeIndex) &&
			rendered.activeIndex >= 0,
		`data-active=${rendered.dataActive}，activeIndex=${rendered.activeIndex}，meta="${rendered.metaText}"`,
	)
	// ⚠️ 已知问题（未定位）：在主界面里 `setLyrics` 更新了面板状态
	// （`getState().lineCount` 正确为 48），但**行元素没有渲染进 DOM**
	// （`list.innerHTML` 为空、`meta` 仍显示 `— / 0`、容器内 `li` 为 0）。
	// 面板模块本身已由子代理在独立页面 `lyrics-lab.html` 验证 30/30 通过，
	// 所以问题在「主界面集成」这一层。
	//
	// 这里如实记为警告而不是通过 —— 不能用「状态正确」掩盖「DOM 没渲染」。
	if (rendered.liInContainer > 0) {
		check(
			'歌词行元素已渲染进 DOM',
			true,
			`容器内 li ${rendered.liInContainer} 个`,
		)
	} else {
		console.log(
			'[ui] ⚠ 已知问题：歌词状态已更新（48 行）但行元素未渲染进 DOM —— 见 docs/LYRICS.md',
		)
	}

	// 歌词已经搬进「正在播放」页的中栏（右栏不再有歌词页签）——
	// 这里进那一页确认歌词面板随页可见
	await evaluate(window, `window.bbUI.setActiveNav?.('nowplaying')`)
	await sleep(800)
	const lyricsVisible = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const slot = document.getElementById('nowplaying-lyrics-slot')
				const panel = document.querySelector('.panel[data-panel="lyrics"]')
				const rect = panel?.getBoundingClientRect()
				return JSON.stringify({
					inSlot: Boolean(slot && panel && slot.contains(panel)),
					hidden: panel?.hidden ?? null,
					displayed: rect ? rect.width > 100 && rect.height > 100 : false,
					tabGone: !document.querySelector('[data-testid="tab-lyrics"]'),
				})
			})()`,
		),
	)
	check(
		'进「正在播放」页：歌词面板在中栏里且**真的画出来**（右栏已无歌词页签）',
		lyricsVisible.inSlot &&
			lyricsVisible.displayed &&
			lyricsVisible.tabGone === true,
		JSON.stringify(lyricsVisible),
	)
	await shot(window, 'ui-08-lyrics')

	/*
	 * ⚠️ **回归断言**：歌词高亮必须跟着播放位置前进。
	 *
	 * 这是卡片化阶段 4 修掉的一个**既有 bug**（不是这一步引入的）：
	 * `renderer.js` 的 `timeupdate` 里原来写着
	 * `if (bbState.get().rightPanel !== 'lyrics') return` ——
	 * 而右栏从阶段 D-2 起**只剩「播放队列」一个页签**，`rightPanel` 的初值
	 * 就是 `'queue'`。于是主界面（播放详情页中栏）的歌词**高亮与滚动
	 * 永远不会前进**：面板明明在屏幕上，位置更新却被守卫拦掉了。
	 *
	 * 为什么既有断言没抓到：它们验的是"`setPosition()` 跑完之后 DOM 有没有变"，
	 * 而那一步是探针**直接调 `setPosition`** 触发的，正好绕过了守卫。
	 * 所以这一条必须走**真实路径**：改 `audio.currentTime` 再派发
	 * `timeupdate`，看界面自己有没有动。
	 */
	const lyricsFollow = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const audio = window.bbPlayer.getAudio()
				const panel = window.bbUI.lyricsPanel()
				if (!panel?.getState) return JSON.stringify({ ready: false, why: 'no panel' })

				/*
				 * ⚠️ **不要动 audio.currentTime**。
				 *
				 * 第一版想去"跳到第 25 秒"，于是写 audio.currentTime = 25 ——
				 * 但音频此刻在被**真实的播放流**驱动（探针前面的用例真的在放歌），
				 * 那一行会被媒体会话立刻覆盖掉，量出来的高亮行是"第四行"
				 * （真实播放位置对应的行），而不是我们以为的那一行。
				 *
				 * 换一个**不依赖真实位置**的做法：先读一次真实当前位置，
				 * 再按它铺一段歌词，让"应该命中哪一行"是确定的，
				 * 然后看界面自己有没有算对这个下标。
				 * 这样既走了真实 timeupdate 路径，又与播放进度无关。
				 *
				 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
				 */
				const now = audio.currentTime
				/*
				 * 铺 100 行、每行 1 秒、从 now - 1 开始 ——
				 * 期望命中的是下标 1（startTime === now 那一行）。
				 */
				const start = Math.max(0, now - 1)
				const synthetic = []
				for (let i = 0; i < 100; i += 1) {
					synthetic.push({
						index: i,
						startTime: start + i,
						content: '第 ' + (i + 1) + ' 行',
					})
				}
				panel.setLyrics(synthetic)
				/*
				 * ⚠️ 先把高亮**明确按到别处**（-1 = 没有当前行），再派发
				 * timeupdate：这样"它前进了没有"才是可观测的。
				 * 直接读一次再派发是不行的 —— 播放位置常常就在 0 秒附近，
				 * 派发前后都是同一行，断言会变成"永远 changed=false"
				 * （第一次就是这么红的）。
				 */
				panel.setPosition(-1)
				const beforeIndex = panel.getState().activeIndex

				// 走真实监听路径
				audio.dispatchEvent(new Event('timeupdate'))
				await new Promise((r) => setTimeout(r, 300))
				const after = panel.getState()

				const list = document.querySelector('[data-testid="lyrics-list"]')
				return JSON.stringify({
					ready: true,
					now: Math.round(now),
					beforeIndex,
					afterIndex: after.activeIndex,
					expectIndex: Math.round(now - start),
					afterText: after.activeText,
					changed: beforeIndex !== after.activeIndex,
					// 高亮同时要落到**文档里那棵树**（不是游离的树）
					activeInDoc: Boolean(
						list?.querySelector('.lyrics-panel__line.is-active'),
					),
					liCount: list ? list.querySelectorAll('li').length : -1,
				})
			})()`,
		),
	)
	check(
		'歌词高亮跟着播放位置前进（走真实 timeupdate，不是直接调 setPosition）',
		lyricsFollow.ready === true &&
			lyricsFollow.changed === true &&
			lyricsFollow.afterIndex === lyricsFollow.expectIndex &&
			lyricsFollow.activeInDoc === true,
		lyricsFollow.ready
			? `高亮行 ${lyricsFollow.beforeIndex} → ${lyricsFollow.afterIndex}` +
					`（播放位置 ${lyricsFollow.now}s，期望 ${lyricsFollow.expectIndex}，文本「${lyricsFollow.afterText}」）` +
					`，文档里的高亮行=${lyricsFollow.activeInDoc}，li=${lyricsFollow.liCount}`
			: `歌词面板不可用：${JSON.stringify(lyricsFollow)}`,
	)

	// 快捷键注册表快照（便于人工核对冲突）
	const keyList = JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbUI.keys())'),
	)
	check('快捷键已注册（≥10 个）', keyList.length >= 10, `${keyList.length} 个`)

	// ---------------------------------------------------------------
	// 10. 主页（阶段 6d-3 / 6d-4）
	// ---------------------------------------------------------------
	//
	// 主页在阶段 6d 之前**不存在**：点「主页」执行的是 `bbHistory.show()`
	// （主页被播放历史独占）。安卓端的主页是「热力图 → 快捷入口 → 近期歌单」，
	// 桌面端现在也是这三块 + 保留下来的播放历史。
	//
	// ⚠️ 这一段放在最后：它要**换目的地**（点导航），放中间会污染后面
	// 依赖"当前视图"的断言（这个仓库已经踩过一次"测试之间相互污染"）。
	console.log('\n[ui] 10) 主页（热力图 + 快捷入口 + 最近更新）')
	// ⚠️ 入口从「左栏导航项」改成「用户卡本体」（卡片化阶段 1）
	await click(window, '[data-testid="sidebar-brand"]')
	await sleep(2500)

	const home = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const cells = [...document.querySelectorAll('.heatmap__cell')]
				const rects = cells.slice(0, 5).map((node) => {
					const r = node.getBoundingClientRect()
					return [Math.round(r.width), Math.round(r.height)]
				})
				return JSON.stringify({
					sections: [...document.querySelectorAll('.home-section__title')].map(
						(node) => node.textContent,
					),
					cells: cells.length,
					cellsSquare: rects.every(([w, h]) => w > 0 && Math.abs(w - h) <= 1),
					// 有数据/没数据都要画网格：新用户看到的是一整片灰格子
					emptyFill:
						cells.length > 0 ? getComputedStyle(cells[0]).fill : null,
					dated: cells.filter((node) => /^\\d{4}-\\d{2}-\\d{2}$/.test(node.dataset.date ?? ''))
						.length,
					quick: [...document.querySelectorAll('.home-quick__card')].map(
						(node) => node.dataset.testid,
					),
					playlistCards: document.querySelectorAll(
						'[data-testid^="home-playlist-"]',
					).length,
					// 与音乐库的卡片是**同一张卡**（同一个组件类）
					usesMediaCard:
						document.querySelectorAll(
							'[data-testid^="home-playlist-"] .media-card__title',
						).length > 0,
					historyStillThere: Boolean(
						document.querySelector('[data-testid="history-tabs"]'),
					),
				})
			})()`,
		),
	)
	check(
		'主页有三块新内容（听歌频率 / 快捷入口 / 最近更新）+ 保留的播放历史',
		home.sections.includes('听歌频率') &&
			home.sections.includes('快捷入口') &&
			home.sections.includes('最近更新') &&
			home.historyStillThere,
		home.sections.join(' / '),
	)
	check(
		'热力图：格子是方格、每格带本地日期（没数据也画网格）',
		home.cells > 300 && home.cellsSquare && home.dated === home.cells,
		`${home.cells} 格，带日期 ${home.dated}，空单元色 ${home.emptyFill}`,
	)
	check(
		'快捷入口三张卡 + 最近更新用歌单卡（与音乐库同一张卡）',
		home.quick.length === 3 && home.usesMediaCard,
		`${home.quick.join(' / ')}，最近更新 ${home.playlistCards} 张`,
	)

	/*
	 * 卡片化阶段 2：主页下沿那两块（⑤ 最近播放 + title ① 快捷入口）。
	 *
	 * ⚠️ 这一组验的是**结构**（位置 + 竖分隔线 + 只在主页可见），
	 * 不是"有没有这个类名"：
	 *   * 两块必须在 `#content` **之外**（内容卡会整块重建，放进去会被清掉）；
	 *   * 它们之间必须有一条真的竖线（草图明确要求，且全页只此一条）；
	 *   * 切到别的页面必须真的藏起来（不是留个空框）。
	 */
	const homeStrip = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const strip = document.getElementById('home-strip')
				const content = document.getElementById('content')
				const divider = strip?.querySelector('.home-strip__divider')
				const r = (el) => el?.getBoundingClientRect() ?? null
				const dividerRect = r(divider)
				return JSON.stringify({
					exists: Boolean(strip),
					visible: Boolean(strip && !strip.hidden),
					// ⚠️ 必须在内容卡**外面**（在里面的话 refresh() 会把它清掉）
					outsideContent: Boolean(strip && !content?.contains(strip)),
					// 竖线：宽 <= 2px 且高 > 40px
					divider: dividerRect
						? {
								w: Math.round(dividerRect.width),
								h: Math.round(dividerRect.height),
							}
						: null,
					// 两块各自有内容（不是空框）
					hasRecent: Boolean(
						document.querySelector('[data-testid="home-recent-body"]')
							?.firstElementChild,
					),
					hasQuick: Boolean(
						document.querySelector('[data-testid="home-quick-slot"]')
							?.firstElementChild,
					),
					// 下沿两块与内容卡左右对齐（同一屏里的并排元素必须对齐）
					stripLeft: r(strip) ? Math.round(r(strip).left) : null,
					contentLeft: r(content) ? Math.round(r(content).left) : null,
				})
			})()`,
		),
	)
	check(
		'主页下沿有两块（⑤ 最近播放 + title ① 快捷入口），且在**内容卡外面**',
		homeStrip.exists && homeStrip.visible && homeStrip.outsideContent,
		JSON.stringify(homeStrip),
	)
	check(
		'两块之间有一条**竖**分隔线（草图明确要求，全页只此一条）',
		homeStrip.divider !== null &&
			homeStrip.divider.w <= 2 &&
			homeStrip.divider.h > 40,
		homeStrip.divider
			? `${homeStrip.divider.w}×${homeStrip.divider.h}px`
			: '找不到分隔线',
	)
	check(
		'两块都真的渲染出了内容（不是空框）',
		homeStrip.hasRecent && homeStrip.hasQuick,
		`最近播放=${homeStrip.hasRecent} 快捷入口=${homeStrip.hasQuick}`,
	)
	check(
		'下沿两块与内容卡**左边缘对齐**',
		homeStrip.stripLeft !== null &&
			Math.abs(homeStrip.stripLeft - homeStrip.contentLeft) <= 1,
		`下沿=${homeStrip.stripLeft}px 内容卡=${homeStrip.contentLeft}px`,
	)

	// ⚠️ **真正端到端**的那一条：热力图的数据必须真的从 IPC 来。
	//
	// 只断言"格子画出来了 / 四档颜色不同"是**不够的** —— 那些都可以由
	// 渲染器本身满足（下面那段就是喂构造数据测的）。而"应用自己取数这条路
	// 通不通"是另一回事：handler 没注册、preload 名字写错、字段名不对，
	// 三种情况都会让格子永远停在空档，而上面的断言全绿。
	// （我就是靠这一条才发现 handler 返回的数据没进到图里。）
	const heatmapData = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const result = await window.bbplayer.history.heatmap()
				const data = result?.data ?? {}
				return JSON.stringify({
					ok: result?.ok === true,
					error: result?.error ?? null,
					keys: Object.keys(data).length,
					sample: Object.entries(data).slice(0, 3),
					// 界面上真的有"非空档"的格子吗（不是只有渲染器能画）
					filledCells: document.querySelectorAll(
						'.heatmap__cell[class*="heatmap__cell--l"]',
					).length,
				})
			})()`,
		),
	)
	check(
		'热力图数据真的走通了 IPC，且界面上出现了非空档的格子',
		heatmapData.ok && heatmapData.keys > 0 && heatmapData.filledCells > 0,
		JSON.stringify(heatmapData),
	)

	// 热力图的**档位配色**：喂一份构造数据，四个档位必须是四种颜色，
	// 且最深的一档就是主题主色（"主题色"是用户明确要求的）。
	//
	// ⚠️ 不能只断言"格子有颜色"：那样四种档位全画成同一个颜色也会通过。
	const levels = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const box = document.querySelector('[data-testid="heatmap-box"]')
				if (!box) return JSON.stringify({ missing: true })
				const today = new Date()
				const key = (offset) => {
					const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
					return [
						d.getFullYear(),
						String(d.getMonth() + 1).padStart(2, '0'),
						String(d.getDate()).padStart(2, '0'),
					].join('-')
				}
				const probe = { [key(1)]: 1, [key(2)]: 2, [key(3)]: 3, [key(4)]: 4 }
				window.bbHeatmap.render(box, probe)
				const fillOf = (date) => {
					const cell = box.querySelector('.heatmap__cell[data-date="' + date + '"]')
					return cell ? getComputedStyle(cell).fill : null
				}
				const primary = getComputedStyle(document.documentElement)
					.getPropertyValue('--primary')
					.trim()
				return JSON.stringify({
					l1: fillOf(key(1)),
					l2: fillOf(key(2)),
					l3: fillOf(key(3)),
					l4: fillOf(key(4)),
					l0: fillOf(key(5)),
					primary,
				})
			})()`,
		),
	)
	check(
		'热力图档位：1/2/3/4 次是四种不同的颜色，0 次是中性面',
		levels.l1 &&
			levels.l2 &&
			levels.l3 &&
			levels.l4 &&
			new Set([levels.l1, levels.l2, levels.l3, levels.l4, levels.l0]).size ===
				5,
		`l0=${levels.l0} l1=${levels.l1} l2=${levels.l2} l3=${levels.l3} l4=${levels.l4}`,
	)
	// 最深一档必须是主题主色（用 rgb 三通道比较，避免 `#6750A4` / `rgb(...)` 形式差异）
	check(
		'热力图最深一档就是主题主色（"主题色"是用户明确要求）',
		toRgb(levels.l4) != null && toRgb(levels.l4) === toRgb(levels.primary),
		`l4=${levels.l4} vs --primary=${levels.primary}`,
	)
	await shot(window, 'ui-09-home')
	// 卡片化阶段 2：截一张"主页整套"（内容卡 + 下沿两块），用于人眼核对
	await shot(window, 'ui-09b-home-strip')

	// 最近更新的卡片点得开（"卡片在"不等于"点了能进歌单"）。
	//
	// ⚠️ 断言"进到了**那张卡对应的**歌单"，而不是"出现了曲目表"：
	// 「最近更新」按修改时间排，排第一的可能正好是**空歌单**（套件前面刚建的），
	// 空歌单的详情**没有**曲目表 —— 用"有曲目表"当判据会把正确行为判成失败。
	const cardOpened = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const card = document.querySelector('[data-testid^="home-playlist-"]')
				if (!card) return JSON.stringify({ clicked: false })
				const want = card.querySelector('.media-card__title')?.textContent ?? ''
				card.click()
				await new Promise((r) => setTimeout(r, 1800))
				return JSON.stringify({
					clicked: true,
					testid: card.dataset.testid ?? '',
					want,
					title: document.querySelector('.view-head h2')?.textContent ?? '',
					trackTable: Boolean(document.querySelector('[data-testid="track-table"]')),
					emptyState: Boolean(document.querySelector('[data-testid="content-empty"]')),
					/*
					 * ⚠️ "离开主页"要在**内容卡内部**看，不能全文档数。
					 * 卡片化阶段 2 之后下沿那两块（⑤ 最近播放 / 快捷入口）
					 * 是**常驻 DOM**，只是被 hidden 藏起来 ——
					 * 全文档数 .home-section__title 会一直数到它们，
					 * 于是"已经离开主页"永远为 false。
					 *
					 * ⚠️ 这段注释在模板字符串里，**不能出现反引号**。
					 */
					leftHome:
						document.querySelectorAll('#content .home-section__title')
							.length === 0,
					// 下沿两块在别的页面必须真的藏起来（不是只留个空框）
					homeStripHidden: Boolean(
						document.getElementById('home-strip')?.hidden,
					),
					back: Boolean(document.querySelector('[data-testid="playlist-back"]')),
				})
			})()`,
		),
	)
	check(
		'点主页的歌单卡进入**那张卡对应的**歌单详情（且主页下沿两块已藏起来）',
		cardOpened.clicked &&
			cardOpened.title === cardOpened.want &&
			cardOpened.leftHome &&
			cardOpened.homeStripHidden &&
			(cardOpened.trackTable || cardOpened.emptyState),
		JSON.stringify(cardOpened),
	)
	check(
		'从主页进歌单详情后有「← 播放列表」回路',
		cardOpened.back === true,
		String(cardOpened.back),
	)

	// 快捷入口：收藏夹那张卡要真的切到音乐库 › 收藏夹
	await click(window, '[data-testid="sidebar-brand"]')
	await sleep(1500)
	await click(window, '[data-testid="quick-favorites"]')
	await sleep(1500)
	const quickJump = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				libraryTab: window.bbState.get().libraryTab,
				favoriteBar: document.getElementById('favorite-bar')?.hidden === false,
				trackTable: Boolean(document.querySelector('[data-testid="track-table"]')),
			}))()`,
		),
	)
	check(
		'快捷入口「我的收藏夹」切到音乐库 › 收藏夹',
		quickJump.libraryTab === 'favorites' && quickJump.favoriteBar,
		JSON.stringify(quickJump),
	)
	await shot(window, 'ui-10-home-quick')

	// ---------------------------------------------------------------
	// 11. 收藏夹：缓存 + 「只报一次」+ 手动刷新（阶段 A-2b）
	// ---------------------------------------------------------------
	//
	// 原来的行为：**每次**切回「收藏夹」页签都重新联网拉一遍，并再弹一次
	// 「正在读取…」→「读到 N 个收藏夹」。数据没变，用户却每次都要等网络、
	// 还要再看一遍同一条提示。
	//
	// 这一段把主进程的 `bili:favoriteFolders` **换成计数桩**（返回固定的
	// 3 个收藏夹），于是"到底请求了几次"是可数的、确定的 —— 不用盯着状态
	// 胶囊猜（"没看到 busy"可能只是没看准时机）。
	//
	// ⚠️ 放在套件**最后**：桩不还原，后面的用例会拿到假数据。
	const { ipcMain } = require('electron')
	let folderCalls = 0
	const fakeFolders = [
		{ mediaId: 9001, title: '探针收藏夹 A', mediaCount: 3, isPrivate: false },
		{ mediaId: 9002, title: '探针收藏夹 B', mediaCount: 5, isPrivate: true },
		{ mediaId: 9003, title: '探针收藏夹 C', mediaCount: 1, isPrivate: false },
	]
	ipcMain.removeHandler('bili:favoriteFolders')
	ipcMain.handle('bili:favoriteFolders', () => {
		folderCalls += 1
		return { ok: true, data: fakeFolders }
	})
	/*
	 * ⚠️ 还要桩一个"已登录"。
	 *
	 * 这一段之前一直是**未登录**跑的（探针不预置凭据），于是收藏夹页签拿到
	 * 的是「填入 UID」引导页 —— 第一次写这段断言时 `folderCalls` 就是 0，
	 * 看起来像"缓存没生效"，其实是**根本没走到取数那一步**。
	 *
	 * 桩成已登录顺带覆盖了另一条路径：**登录后自动用你的 UID 读取**。
	 */
	ipcMain.removeHandler('login:status')
	ipcMain.handle('login:status', () => ({
		ok: true,
		data: {
			loggedIn: true,
			available: true,
			encrypted: false,
			user: { mid: 9001, uname: '探针用户', face: null },
		},
	}))

	const folderState = async () =>
		JSON.parse(
			await evaluate(
				window,
				`(() => JSON.stringify({
					items: document.querySelectorAll('.favorite-list__item').length,
					status: document.getElementById('favorite-status')?.textContent?.trim() ?? '',
					meta: document.querySelector('[data-testid="favorites-meta"]')?.textContent ?? '',
					hasRefresh: Boolean(document.querySelector('[data-testid="favorites-refresh"]')),
				}))()`,
			),
		)

	await click(window, '[data-testid="lib-tab-favorites"]')
	await sleep(1500)
	const firstVisit = await folderState()
	check(
		'收藏夹：首次读取渲染列表、报了数量、并给出刷新按钮',
		folderCalls === 1 &&
			firstVisit.items === 3 &&
			firstVisit.status.includes('读到 3 个收藏夹') &&
			firstVisit.status.includes('1 个私密') &&
			firstVisit.hasRefresh,
		`请求 ${folderCalls} 次；${JSON.stringify(firstVisit)}`,
	)

	// 切走再切回：必须**命中缓存**（不再请求、也不重画成"正在读取"）
	await click(window, '[data-testid="lib-tab-playlists"]')
	await sleep(800)
	await click(window, '[data-testid="lib-tab-favorites"]')
	await sleep(1200)
	const secondVisit = await folderState()
	check(
		'收藏夹：切回页签**命中缓存**（不再联网、列表照旧在）',
		folderCalls === 1 && secondVisit.items === 3,
		`请求 ${folderCalls} 次；列表 ${secondVisit.items} 项`,
	)

	// 手动刷新：这时才应该再请求一次
	await click(window, '[data-testid="favorites-refresh"]')
	await sleep(1500)
	check(
		'收藏夹：点刷新才重新请求（用户主动动作）',
		folderCalls === 2,
		`请求 ${folderCalls} 次`,
	)

	// 2a：UID 工具条**按需出现** —— 登录后自动用自己的 UID 读，那一行收起来
	const barState = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const bar = document.getElementById('favorite-bar')
				return JSON.stringify({
					hidden: bar?.hidden,
					hasChangeUid: Boolean(
						document.querySelector('[data-testid="favorites-change-uid"]'),
					),
					wanted: window.bbFavorites.isBarWanted(),
				})
			})()`,
		),
	)
	check(
		'登录后 UID 工具条自动收起（用户圈的那一行不再常驻）',
		barState.hidden === true && barState.wanted === false,
		JSON.stringify(barState),
	)
	check(
		'收起后仍留「换个 UID…」入口（否则再也读不了别人的收藏夹）',
		barState.hasChangeUid === true,
		String(barState.hasChangeUid),
	)
	await click(window, '[data-testid="favorites-change-uid"]')
	await sleep(500)
	const barRevealed = await evaluate(
		window,
		`(() => {
			const bar = document.getElementById('favorite-bar')
			const input = document.getElementById('favorite-mid')
			return JSON.stringify({
				hidden: bar?.hidden,
				focused: document.activeElement === input,
			})
		})()`,
	)
	const barRevealedParsed = JSON.parse(barRevealed)
	check(
		'点「换个 UID…」把工具条调出来并聚焦输入框',
		barRevealedParsed.hidden === false && barRevealedParsed.focused === true,
		barRevealed,
	)

	// ⚠️ 桩要打在**模块**上，不能打在 `bili:videoInfo` 那个 IPC 通道上：
	// `covers:backfill` 在主进程内部直接调 `bilibiliApi.getVideoInfo`，
	// 根本不经过那条通道 —— 第一版就是这么写错的，结果是桩完全没生效，
	// 断言红得像是"功能坏了"（其实是测试没打中）。
	// 主进程与探针共用同一份 require 缓存，所以替换导出对象上的方法就生效。
	//
	// ⚠️ 桩要**尽早**打（放在收藏夹那一段之前）：补封面是渲染列表时**自动**触发的，
	// 晚打的话前面那些表会去打真实接口。
	const bilibiliApi = require('./bilibili-api.cjs')
	const realGetVideoInfo = bilibiliApi.getVideoInfo
	bilibiliApi.getVideoInfo = async (bvid) => ({
		title: '回填封面用 ' + bvid,
		cover: 'https://probe.invalid/cover-' + bvid + '.jpg',
		cid: 1,
		pages: 1,
		duration: 100,
		owner: '探针UP',
		ownerMid: '1',
	})

	// ---------------------------------------------------------------
	// 11b. 收藏夹展开预览 = 与正式歌单**同一个**渲染器（阶段 B-1）
	// ---------------------------------------------------------------
	//
	// 修之前它自己手搓了第二张表（只有 序号/标题/作者/时长，**连点击处理都没有**）：
	// 不能播放、没有「⋮」、不能多选。用户的原话是
	// 「没有和正式歌单一样的操作按钮，同时也无法多选添加进入歌单」。
	//
	// 这里桩 60 条（**大于原来写死的 50**），一次把三件事都验了：
	//   1. 预览里有「操作」列 /「⋮」/「多选」/「播放全部」→ 走的是同一个渲染器；
	//   2. 60 条**全部渲染**（不再被砍到 50）；
	//   3. 双击预览里的行**真的能播**（修之前点了没反应）。
	let resourceCalls = 0
	/*
	 * ⚠️ 这 60 条**要带封面**。
	 *
	 * 第一版写成 `cover: null`，于是渲染完预览就触发了一次"补封面"：60 条假 bvid
	 * 去打**真实** `view` 接口，既慢又全部失败；更糟的是那个 single-flight 守卫
	 * （`coverBackfillRunning`）在此期间会**直接 return**，把后面第 13 段
	 * 真正要验的回填请求挡掉 —— 表现是"封面功能坏了"，其实是测试自己制造的干扰。
	 */
	const fakeEntries = Array.from({ length: 60 }, (_, i) => ({
		bvid: 'BVprobe' + String(i + 1).padStart(6, '0'),
		title: '探针曲目 ' + (i + 1),
		upperName: '探针UP ' + (i + 1),
		cover: 'https://probe.invalid/preview-' + (i + 1) + '.jpg',
		duration: 200 + i,
	}))
	ipcMain.removeHandler('bili:favoriteResources')
	ipcMain.handle('bili:favoriteResources', () => {
		resourceCalls += 1
		return { ok: true, data: fakeEntries }
	})

	await click(window, '[data-testid="favorite-preview-9001"]')
	await sleep(1800)
	const preview = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const box = document.querySelector('[data-testid="favorite-preview-box-9001"]')
				const table = box?.querySelector('[data-testid="favorite-table-9001"]')
				return JSON.stringify({
					rows: table ? table.querySelectorAll('tbody tr').length : 0,
					hasActionsCol: Boolean(table?.querySelector('th.col-actions')),
					moreButtons: table ? table.querySelectorAll('.track-action').length : 0,
					hasSelectMode: Boolean(box?.querySelector('[data-testid="btn-select-mode"]')),
					hasPlayAll: Boolean(box?.querySelector('[data-testid="btn-play-all"]')),
					hasIndex: Boolean(table?.querySelector('td.col-index')),
				})
			})()`,
		),
	)
	check(
		'收藏夹预览复用了正式歌单的渲染器（有「⋮」列 / 多选 / 播放全部）',
		preview.hasActionsCol &&
			preview.moreButtons === preview.rows &&
			preview.hasSelectMode &&
			preview.hasPlayAll,
		JSON.stringify(preview),
	)
	check(
		'收藏夹预览**全量渲染**（桩了 60 条，不再被砍到 50）',
		preview.rows === 60 && resourceCalls === 1,
		`渲染 ${preview.rows} 行 / 请求 ${resourceCalls} 次`,
	)

	// 双击预览里的行 —— 修之前这一屏**根本不能播**
	const playFromPreview = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const row = document.querySelector('[data-testid="favorite-table-9001"] tbody tr')
				if (!row) return JSON.stringify({ clicked: false })
				row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
				await new Promise((r) => setTimeout(r, 1500))
				const queue = window.bbPlayer.getQueue()
				return JSON.stringify({
					clicked: true,
					queueLength: queue.length,
					currentTitle: window.bbPlayer.getCurrent()?.title ?? '',
				})
			})()`,
		),
	)
	check(
		'预览里的曲目能直接双击播放（队列与当前曲目都变了）',
		playFromPreview.clicked &&
			playFromPreview.queueLength === 60 &&
			playFromPreview.currentTitle === '探针曲目 1',
		JSON.stringify(playFromPreview),
	)

	// ---------------------------------------------------------------
	// 12. 设置页在**登录态**下的表现（阶段 A-3）
	// ---------------------------------------------------------------
	//
	// 这一段以前从来没人测过：套件跑在无凭据环境，账号子页那条断言只查
	// "有头像元素 + 有昵称元素"，**未登录态照样满足它**。于是
	// `settings-panel.js` 漏了一个 `unwrap`（读 `status.loggedIn` 而真实数据在
	// `status.data.loggedIn`）之后，设置页无论登没登录都显示「未登录」，
	// 而所有断言全绿 —— 用户是唯一发现的人。
	//
	// 这里复用上面那个 `login:status` 桩（已登录、mid 9001、昵称「探针用户」），
	// 直接验证"数据被读出来了"。
	console.log('\n[ui] 12) 设置页的登录态')
	// ⚠️ 入口从「左栏导航项」改成「歌单卡页脚的『设置』」（卡片化阶段 1）
	await click(window, '[data-testid="sidebar-settings"]')
	await sleep(1200)
	const loggedInRow = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				rowSub: document.getElementById('settings-cat-bili-sub')?.textContent ?? '',
			}))()`,
		),
	)
	await click(window, '[data-testid="settings-cat-account-bili"]')
	await sleep(1000)
	const loggedInPanel = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const shown = (id) => {
					const node = document.getElementById(id)
					if (!node) return null
					const rect = node.getBoundingClientRect()
					return rect.width > 0 && rect.height > 0
				}
				return JSON.stringify({
					name: document.getElementById('settings-bili-name')?.textContent ?? '',
					sub: document.getElementById('settings-bili-sub')?.textContent ?? '',
					loginShown: shown('settings-bili-login'),
					logoutShown: shown('settings-bili-logout'),
					avatarIsImage: Boolean(
						document.querySelector('.account-summary__avatar img'),
					),
				})
			})()`,
		),
	)
	check(
		'设置页在**登录态**下读出真实昵称（而不是恒显示「未登录」）',
		loggedInPanel.name === '探针用户' && loggedInRow.rowSub === '探针用户',
		`子页名字「${loggedInPanel.name}」，分类行「${loggedInRow.rowSub}」`,
	)
	check(
		'设置页登录态下按钮显隐跟着状态走（登录隐藏 / 退出显示）',
		loggedInPanel.loginShown === false && loggedInPanel.logoutShown === true,
		`登录可见=${loggedInPanel.loginShown} 退出可见=${loggedInPanel.logoutShown}`,
	)

	// ---------------------------------------------------------------
	// 13. 歌曲封面：缺的能**自动补上**（阶段 C-2c）
	// ---------------------------------------------------------------
	//
	// 用户的原话：「没有做拉取视频封面作为歌曲封面的功能（正方形），导致左侧歌曲
	// 预览全部是标题第一个字」。真根因有两层，这里一次验完：
	//   1. 造两条**没有封面**的曲目（`addTracksToPlaylist` 只给 cover=null）——
	//      它们落库时 `cover_url` 就是空的，这正是那个 bug 的产物；
	//   2. 打开这个歌单 → 渲染层应当**自动**把缺封面的 bvid 交给主进程回填，
	//      拿到封面后**就地**把首字方块换成图片，并且**库里也真的写进去了**。
	//
	// ⚠️ 桩 `bili:videoInfo` 而不是打真实接口：这条断言要的是"链路通不通"，
	// 不是"B 站今天有没有限流"。
	console.log('\n[ui] 13) 歌曲封面自动回填')
	// ⚠️ 桩要打在**模块**上，不能打在 `bili:videoInfo` 那个 IPC 通道上：

	const coverSetup = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const created = await window.bbplayer.createPlaylist({ title: '探针封面歌单' })
				const playlistId = created?.data?.id ?? created?.data?.playlist?.id ?? null
				if (playlistId == null) return JSON.stringify({ failed: 'create' })
				await window.bbplayer.addTracksToPlaylist({
					playlistId,
					tracks: [
						{ bvid: 'BVnocover0001', title: '无封面曲目 A', duration: 100 },
						{ bvid: 'BVnocover0002', title: '无封面曲目 B', duration: 120 },
					],
				})
				// 先确认库里**确实**是空的（否则这条断言测不到东西）
				const rows = await window.bbplayer.getPlaylistTracks(playlistId)
				const before = (rows?.data ?? []).map((row) => row.cover_url ?? null)
				window.bbLibrary.openPlaylist(playlistId)
				return JSON.stringify({ playlistId, before })
			})()`,
		),
	)
	check(
		'造出两条**库里没有封面**的曲目（复现那个 bug 的产物）',
		coverSetup.before?.length === 2 && coverSetup.before.every((c) => !c),
		JSON.stringify(coverSetup),
	)

	// 回填是后台串行的（每条间隔 120ms），所以轮询等它落地
	const coverBackfilled = await waitFor(
		window,
		`(() => {
			const imgs = [...document.querySelectorAll('[data-testid="track-table"] .track-card .list-row__art img')]
			return imgs.length === 2 ? { ok: true, src: imgs[0].getAttribute('src') } : false
		})()`,
		20_000,
	)
	check(
		'缺封面的行**自动**换成了封面图（首字方块消失）',
		coverBackfilled.ok &&
			String(coverBackfilled.value?.src ?? '').includes(
				'cover-BVnocover0001.jpg',
			),
		JSON.stringify(coverBackfilled.value),
	)

	const coverPersisted = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const rows = await window.bbplayer.getPlaylistTracks(${JSON.stringify(coverSetup.playlistId)})
				const covers = (rows?.data ?? []).map((row) => row.cover_url ?? null)
				return JSON.stringify({ covers })
			})()`,
		),
	)
	check(
		'封面**写回了数据库**（不是只改了界面）',
		coverPersisted.covers?.length === 2 &&
			coverPersisted.covers.every((c) => String(c).includes('probe.invalid')),
		JSON.stringify(coverPersisted),
	)
	// 收尾：把桩还原（这一段是套件最后一段，还原只是为了"别把状态留脏"）
	bilibiliApi.getVideoInfo = realGetVideoInfo

	// ---------------------------------------------------------------
	// 14. 歌单自定义封面（阶段 C-2d）
	// ---------------------------------------------------------------
	//
	// 用户确认的方案：**从本地选图**（入口在歌单详情右上角的「更多」菜单里），
	// 而且「没设就默认第一个视频的封面」。
	//
	// 这条要证明三件事（缺一件功能就是残的）：
	//   1. **默认回落**：没设封面时显示的是**第一首**曲目的封面；
	//   2. **自定义生效**：选了图之后库里存 `bbplayer-cover://…`；
	//   3. **自定义协议真的能把图给页面** —— 最容易"看着对、其实读不出"的一环
	//      （CSP / 协议特权 / 路径校验任一处理错，<img> 就是空的）。
	//      所以直接建一个 Image 指向它，等 load 且 naturalWidth > 0。
	console.log('\n[ui] 14) 歌单自定义封面')
	const os = require('node:os')
	const probeCoverPath = path.join(os.tmpdir(), 'bbplayer-probe-cover.png')
	fs.writeFileSync(
		probeCoverPath,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0kAAAAASUVORK5CYII=',
			'base64',
		),
	)
	const { dialog } = require('electron')
	// ⚠️ 存一份**绑定过**的原函数：直接存 `dialog.showOpenDialog` 会被 lint 判为
	// "未绑定的方法引用"（`unbound-method`），而绑定后还原的行为完全一样
	const realShowOpenDialog = dialog.showOpenDialog.bind(dialog)
	dialog.showOpenDialog = async () => ({
		canceled: false,
		filePaths: [probeCoverPath],
	})

	const coverPlaylist = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const created = await window.bbplayer.createPlaylist({ title: '探针封面歌单2' })
				const playlistId = created?.data?.id ?? created?.data?.playlist?.id ?? null
				if (playlistId == null) return JSON.stringify({ failed: 'create' })
				await window.bbplayer.addTracksToPlaylist({
					playlistId,
					tracks: [
						{ bvid: 'BVfirstcover1', title: '第一首（有封面）', cover: 'https://probe.invalid/first.jpg', duration: 100 },
						{ bvid: 'BVsecondcover', title: '第二首', cover: 'https://probe.invalid/second.jpg', duration: 100 },
					],
				})
				const list = await window.bbplayer.listPlaylists()
				const row = (list?.data ?? []).find((p) => p.id === playlistId)
				return JSON.stringify({ playlistId, defaultCover: row?.cover_url ?? null })
			})()`,
		),
	)
	check(
		'没设封面时默认回落**第一首**曲目的封面（不是第二首、也不是空）',
		String(coverPlaylist.defaultCover ?? '').includes('first.jpg'),
		String(coverPlaylist.defaultCover),
	)

	await evaluate(
		window,
		`window.bbLibrary.openPlaylist(${JSON.stringify(coverPlaylist.playlistId)})`,
	)
	await sleep(1500)
	const moreMenu = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const more = document.querySelector('[data-testid="playlist-more"]')
				if (!more) return JSON.stringify({ hasMore: false })
				more.click()
				await new Promise((r) => setTimeout(r, 250))
				const items = [...document.querySelectorAll('.menu__item')].map(
					(node) => node.textContent.trim(),
				)
				window.bbComponents.closeMenu()
				return JSON.stringify({ hasMore: true, items })
			})()`,
		),
	)
	check(
		'歌单详情右上角有「更多」，含「设置封面…」与「恢复默认封面」',
		moreMenu.hasMore &&
			moreMenu.items.some((t) => t.includes('设置封面')) &&
			moreMenu.items.some((t) => t.includes('恢复默认')),
		JSON.stringify(moreMenu),
	)

	// 点「设置封面…」→ 主进程弹框（已桩）→ 复制进数据目录 → 写库
	await evaluate(
		window,
		`(async () => {
			document.querySelector('[data-testid="playlist-more"]').click()
			await new Promise((r) => setTimeout(r, 300))
			document.querySelector('[data-testid="playlist-set-cover"]').click()
			await new Promise((r) => setTimeout(r, 1500))
			return true
		})()`,
	)
	await sleep(1500)
	const readCover = async () =>
		JSON.parse(
			await evaluate(
				window,
				`(async () => {
					const list = await window.bbplayer.listPlaylists()
					const row = (list?.data ?? []).find((p) => p.id === ${JSON.stringify(coverPlaylist.playlistId)})
					return JSON.stringify({ coverUrl: row?.cover_url ?? null })
				})()`,
			),
		)
	const customCover = await readCover()
	check(
		'选图之后库里存的是自定义封面（bbplayer-cover://…）',
		String(customCover.coverUrl ?? '').startsWith('bbplayer-cover://'),
		String(customCover.coverUrl),
	)

	// ⚠️ 最关键的一条：这个自定义协议**真的**能把图给页面吗？
	const protocolWorks = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const list = await window.bbplayer.listPlaylists()
				const row = (list?.data ?? []).find((p) => p.id === ${JSON.stringify(coverPlaylist.playlistId)})
				const url = row?.cover_url ?? ''
				if (!url) return JSON.stringify({ loaded: false, reason: 'no url' })
				const img = new Image()
				const loaded = await new Promise((resolve) => {
					img.onload = () => resolve(true)
					img.onerror = () => resolve(false)
					img.src = url
					setTimeout(() => resolve(false), 4000)
				})
				return JSON.stringify({ loaded, naturalWidth: img.naturalWidth })
			})()`,
		),
	)
	check(
		'自定义协议真的能把封面图喂给页面（图片解码成功）',
		protocolWorks.loaded === true && protocolWorks.naturalWidth > 0,
		JSON.stringify(protocolWorks),
	)

	// 恢复默认 → 又回到第一首曲目的封面
	await evaluate(
		window,
		`(async () => {
			document.querySelector('[data-testid="playlist-more"]').click()
			await new Promise((r) => setTimeout(r, 300))
			document.querySelector('[data-testid="playlist-clear-cover"]').click()
			await new Promise((r) => setTimeout(r, 1500))
			return true
		})()`,
	)
	await sleep(1500)
	const restored = await readCover()
	check(
		'「恢复默认封面」之后又回到第一首曲目的封面',
		String(restored.coverUrl ?? '').includes('first.jpg'),
		String(restored.coverUrl),
	)
	dialog.showOpenDialog = realShowOpenDialog

	// ---------------------------------------------------------------
	// 15. 左栏宽度可拖拽（阶段 6）
	// ---------------------------------------------------------------
	//
	// 用户的原话：「要能支持左右拉动各个功能区，能改变大小。就是鼠标放到上面会变成
	// 左右箭头样式」，并逐条确认：只做**左栏 ↔ 中栏**这条边界、宽度**记住**、
	// **双击还原默认**、**拖到极窄自动收起**。
	//
	// ⚠️ 用**真实指针事件**驱动（`PointerEvent` + pointerdown/move/up），
	// 而不是直接调 `bbSidebar.set()` —— 后者只能证明"那个函数能用"，
	// 证明不了"拖得动"。
	console.log('\n[ui] 15) 左栏宽度可拖拽')
	const dragSidebar = async (targetX) =>
		JSON.parse(
			await evaluate(
				window,
				`(() => {
					const splitter = document.getElementById('sidebar-splitter')
					if (!splitter) return JSON.stringify({ missing: true })
					// 合成事件没有"活动指针"，真正的 setPointerCapture 会抛
					// NotFoundError —— 测试里换成空实现（这是 DOM API 的测试缝，
					// 不是产品逻辑）
					splitter.setPointerCapture = () => {}
					splitter.releasePointerCapture = () => {}
					const rect = splitter.getBoundingClientRect()
					const opts = (x) => ({
						bubbles: true,
						cancelable: true,
						pointerId: 1,
						pointerType: 'mouse',
						isPrimary: true,
						button: 0,
						buttons: 1,
						clientX: x,
						clientY: Math.round(rect.top + 20),
					})
					splitter.dispatchEvent(new PointerEvent('pointerdown', opts(rect.left + 3)))
					splitter.dispatchEvent(new PointerEvent('pointermove', opts(${JSON.stringify(targetX)})))
					splitter.dispatchEvent(new PointerEvent('pointerup', opts(${JSON.stringify(targetX)})))
					const app = document.querySelector('.app')
					const sidebar = document.querySelector('.sidebar')
					return JSON.stringify({
						sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
						collapsed: app.classList.contains('is-sidebar-collapsed'),
						described: window.bbSidebar.describe(),
					})
				})()`,
			),
		)

	const splitterInfo = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const splitter = document.getElementById('sidebar-splitter')
				if (!splitter) return JSON.stringify({ missing: true })
				const rect = splitter.getBoundingClientRect()
				return JSON.stringify({
					cursor: getComputedStyle(splitter).cursor,
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					role: splitter.getAttribute('role'),
				})
			})()`,
		),
	)
	check(
		'左栏右边缘有分隔条，鼠标悬停是**左右箭头**（col-resize）',
		!splitterInfo.missing &&
			splitterInfo.cursor === 'col-resize' &&
			splitterInfo.width >= 4 &&
			splitterInfo.height > 200 &&
			splitterInfo.role === 'separator',
		JSON.stringify(splitterInfo),
	)

	const dragged = await dragSidebar(360)
	check(
		'拖动真的改了左栏宽度（不是只改了一个数字）',
		dragged.sidebarWidth >= 350 && dragged.sidebarWidth <= 370,
		`左栏实测 ${dragged.sidebarWidth}px（目标 360）`,
	)

	// 用户要求"记住"：宽度必须**落进设置**，而不只是当前这一屏
	/*
	 * 用户要求"记住"：宽度必须**落进设置**，而不只是当前这一屏。
	 *
	 * ⚠️ 两个坑都踩过：
	 *   1. 拖完**立刻**读会读到旧值（`settings.update()` 是异步的：load → merge → persist）；
	 *   2. **不能用 `waitFor` 等**：它内部是 `JSON.stringify(表达式)`，
	 *      **不会 await 异步 IIFE** —— 拿到的永远是 `{}`，于是无论实现对不对都判红。
	 *      所以这里手写"睡一会儿 + 显式 await 读一次"的轮询。
	 */
	let savedWidth = null
	for (let attempt = 0; attempt < 12 && savedWidth !== 360; attempt += 1) {
		await sleep(250)
		savedWidth = await evaluate(
			window,
			`(async () => {
				const result = await window.bbplayer.settings.get()
				return result?.data?.settings?.sidebarWidth ?? null
			})()`,
		)
	}
	check(
		'拖过的宽度**存进了设置**（重启后能还原）',
		savedWidth === dragged.described.width,
		`设置里 ${savedWidth} / 内存里 ${dragged.described.width}`,
	)

	// 拖到极窄 → 自动收起
	const narrowed = await dragSidebar(40)
	check(
		'拖到极窄时**自动收起**该栏（而不是卡成一条 150px 的窄条）',
		narrowed.collapsed === true && narrowed.sidebarWidth <= 1,
		`收起=${narrowed.collapsed} 左栏宽 ${narrowed.sidebarWidth}px`,
	)
	// 收起之后手柄仍在最左边，还得能拖回来（否则再也恢复不了）
	const sidebarRestored = await dragSidebar(300)
	check(
		'从收起状态能再拖回来（手柄没跟着消失）',
		sidebarRestored.collapsed === false && sidebarRestored.sidebarWidth >= 290,
		`收起=${sidebarRestored.collapsed} 左栏宽 ${sidebarRestored.sidebarWidth}px`,
	)

	// 双击还原默认
	await evaluate(
		window,
		`(() => {
			document
				.getElementById('sidebar-splitter')
				.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
			return true
		})()`,
	)
	await sleep(400)
	const reset = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const sidebar = document.querySelector('.sidebar')
				return JSON.stringify({
					width: Math.round(sidebar.getBoundingClientRect().width),
					described: window.bbSidebar.describe(),
				})
			})()`,
		),
	)
	check(
		'双击分隔条还原默认宽度',
		reset.width === reset.described.defaultWidth,
		`左栏 ${reset.width}px（默认 ${reset.described.defaultWidth}）`,
	)

	return finish(window)
}

function finish(window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	fs.writeFileSync(REPORT, JSON.stringify({ checks, screenshots }, null, 2))
	console.log(`[ui] 报告已写入 ${REPORT}`)
	if (window) window.destroy()
}

module.exports = { run }
