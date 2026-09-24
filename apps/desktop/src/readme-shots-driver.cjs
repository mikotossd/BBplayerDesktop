/* oxlint-disable no-console -- 截图驱动，以 stdout 输出进度 */
/**
 * README 截图驱动。
 *
 * ## 与 `ui-tour-driver.cjs` 的分工
 *
 * 那个驱动是**审计**用的：把每个视图、每个弹窗、每个空状态都截下来，
 * 顺序刻意从"空库"开始，尺寸固定 1440×940，产出 37 张供逐张核对。
 *
 * 这个驱动是**展示**用的：只截 README 表格里要用的那几张，每张都必须
 * 处在一个"能拿出去见人"的状态 ——
 *
 * * 先灌入真实数据（B 站合集），而不是空库；
 * * 先播放一首**能匹配到歌词**的曲子并停下，再截「正在播放」，
 *   否则右卡是「暂无歌词」—— 那会把歌词系统拍成没做完；
 * * 截之前等封面/歌词真的进 DOM（网络 + 匹配都是异步的）。
 *
 * ## 用法
 *
 * ```
 * node scripts/capture-readme-shots.mjs            # 浅色 -> assets/screenshots/
 * node scripts/capture-readme-shots.mjs --dark     # 深色 -> assets/screenshots/dark/
 * ```
 *
 * ## 为什么不复用 `ui-tour` 的产物
 *
 * 试过：巡检那 37 张里，「正在播放」那张右卡是空的（demo 合集里的曲子
 * 匹配不到歌词），而 README 要展示的正是歌词。展示态与审计态的要求不同，
 * 所以单独一个短序列，而不是给审计驱动加分支（那会动到已验收的那套）。
 */
const fs = require('node:fs')
const path = require('node:path')

/**** 仓库根（`apps/desktop/src` 往上三层） */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** 输出目录：默认仓库根的 `assets/screenshots`（README 引用它） */
const OUT_ROOT =
	process.env.BBPLAYER_README_SHOT_DIR ??
	path.join(REPO_ROOT, 'assets', 'screenshots')

/**
 * @type {{
 *   theme: string | null,
 *   shots: Array<{ name: string, note: string, file: string, width: number, height: number }>,
 *   problems: string[],
 * }}
 */
const report = { theme: null, shots: [], problems: [] }

/**
 * 展示用窗口尺寸。
 *
 * 比审计的 1440×940 略矮：README 表格里的缩略图是横向排的，
 * 太高的图在 GitHub 上会被压成一条。1440×900 是 16:10，缩略图比例舒服。
 */
const WINDOW = { width: 1440, height: 900 }

function shotDir(theme) {
	return theme === 'light' ? OUT_ROOT : path.join(OUT_ROOT, theme)
}

async function evaluate(window, expression) {
	return window.webContents.executeJavaScript(expression, true)
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 像素体检：这一帧到底有没有内容。
 *
 * 探针窗口是隐藏的（`main.cjs` 的 `createWindow`），隐藏窗口一旦被节流，
 * `capturePage()` 会返回**纯色空图**，而 DOM 层面的检查依然全绿。
 * 数一数不同颜色的个数是最便宜的分辨办法：正常界面几百种，
 * 空图只有一两种。
 */
function inspectFrame(image) {
	const bitmap = image.toBitmap()
	if (!bitmap || bitmap.length < 16) return { blank: true, distinctColors: 0 }
	const pixels = Math.floor(bitmap.length / 4)
	const step = Math.max(1, Math.floor(pixels / 4000)) * 4
	const colors = new Set()
	for (let i = 0; i + 3 < bitmap.length; i += step) {
		colors.add((bitmap[i + 2] << 16) | (bitmap[i + 1] << 8) | bitmap[i])
	}
	return { blank: colors.size <= 2, distinctColors: colors.size }
}

/**
 * 把两类**临时浮层**收起来。
 *
 * 截图之前必须做这一步：状态胶囊与 toast 都是**操作过程的回声**
 * （「已加载 24/24 首」「找到 17 个结果」「已暂停」），它们悬在内容上方，
 * 挡住的正好是名单 / 歌词这些要看的东西。
 *
 * ⚠️ 它们分属**两个**不同的机制，只清一个是不够的（第一版只清了 toast，
 * 截图里胶囊原样还在）：
 *
 *   * `[data-testid="status-host"]` —— `status.js` 的**长期状态行**。
 *     它的淡出只摘 `is-visible` 类名、**故意不清文本**（探针还要读，
 *     见 status.js 文件头）。所以这里也照它自己的做法摘类名，不动文本。
 *   * `[data-testid="toast-host"]` —— `components.js` 的一次性提示，
 *     4 秒后自己 `remove()`。这里提前摘掉。
 *
 * 两者做的都只是"再过几秒本来就会发生的事"，不改任何应用状态。
 */
async function hideTransientOverlays(window) {
	await evaluate(
		window,
		`(() => {
			const status = document.querySelector('[data-testid="status-host"]')
			if (status) status.classList.remove('is-visible')
			const toasts = document.querySelector('[data-testid="toast-host"]')
			if (toasts) toasts.textContent = ''
			return true
		})()`,
	)
}

/**
 * 等**两帧真的画出来**。
 *
 * `capturePage()` 抓的是已合成的帧；渲染进程刚做完 DOM 变更时合成器可能还
 * 没产出新帧，于是拿到上一屏的画面 —— 表现是"图是空的，但元素明明可见"。
 * 连续两次 `requestAnimationFrame` 能确保这一帧画完。
 */
async function twoFrames(window) {
	await evaluate(
		window,
		`new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
		)`,
	)
}

/** 截图并存盘 */
async function shot(window, name, note) {
	/*
	 * ⚠️ **清两次**，中间各等一帧。
	 *
	 * 第一次清完之后，视图自己的渲染仍可能再写一条（切到主页时 `refresh()`
	 * 结尾那句「已加载 N 条」就是），于是截图里又冒出来。清 → 画 → 再清 → 画，
	 * 最后抓到的才是干净那一帧。
	 *
	 * 实测过一次：只清一次时，音乐库那张的胶囊没了、正在播放那张还挂着
	 * 「已暂停」—— 因为两次之间又有人写了一条。
	 */
	await hideTransientOverlays(window)
	await twoFrames(window)
	await hideTransientOverlays(window)
	await twoFrames(window)

	const image = await window.webContents.capturePage()
	const frame = inspectFrame(image)
	const size = image.getSize()
	fs.mkdirSync(shotDir(report.theme), { recursive: true })
	const file = path.join(shotDir(report.theme), `${name}.png`)
	fs.writeFileSync(file, image.toPNG())
	if (frame.blank) {
		report.problems.push(
			`${name} 截图像是空图：只有 ${frame.distinctColors} 种颜色`,
		)
	}
	report.shots.push({
		name,
		note,
		// 记**相对路径**：清单要随截图一起提交，绝对路径既没用又泄露本机目录
		file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
		...size,
	})
	console.log(
		`  📷 ${name}  ${size.width}x${size.height}  ${note}` +
			(frame.blank ? '  ⚠ 空图' : `  ${frame.distinctColors}色`),
	)
	return file
}

async function click(window, selector) {
	const ok = await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.click()
			return true
		})()`,
	)
	if (!ok) report.problems.push(`点不到 ${selector}`)
	return ok
}

async function typeInto(window, selector, text) {
	const ok = await evaluate(
		window,
		`(() => {
			const input = document.querySelector(${JSON.stringify(selector)})
			if (!input) return false
			input.value = ${JSON.stringify(text)}
			input.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
	if (!ok) report.problems.push(`找不到输入框 ${selector}`)
	return ok
}

async function waitFor(window, expression, timeoutMs = 20_000, label = '') {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			if (await evaluate(window, `Boolean(${expression})`)) return true
		} catch {
			// 页面可能在导航中，继续等
		}
		await sleep(250)
	}
	report.problems.push(`等待超时：${label || expression}`)
	return false
}

/** 搜索结果里双击首行播放（与界面上的操作同一条路径） */
async function playFirstRow(window) {
	const ok = await evaluate(
		window,
		`(() => {
			const row = document.querySelector('.song-row')
			if (!row) return false
			row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
			return true
		})()`,
	)
	if (!ok) report.problems.push('搜索结果里没有可双击的曲目行')
	return ok
}

/**
 * 让「正在播放」页右卡里真的有一份歌词。
 *
 * 三个必须按顺序做的理由（都踩过）：
 *  1. **先暂停**：播放中 `loadLyricsFor(track)` 是异步的，它会先
 *     `setLyrics([])` 清空面板 —— 手动 setLyrics 会被那次结果覆盖；
 *  2. 用**明确的元信息**去匹配，而不是让应用自己猜：demo 合集里的
 *     B 站视频标题（如「陈睿《让好内容发生》」）与任何歌词库都匹配不上，
 *     最佳分 0.18；这里要的是"匹配成功之后长什么样"；
 *  3. 匹配成功后还要 `setPosition` —— 不设位置就没有高亮行，
 *     截出来是一份"平"的歌词，看不出逐行高亮。
 */
async function loadLyrics(window, meta) {
	await evaluate(window, `window.bbPlayer.pause()`)
	await sleep(600)

	const result = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const p = window.bbUI.lyricsPanel()
				if (!p) return JSON.stringify({ ok: false, error: 'panel missing' })
				const r = await window.bbplayer.autoMatchLyrics(${JSON.stringify(meta)})
				if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
				if (!r.data.matched) {
					return JSON.stringify({
						ok: false,
						error: '未匹配到歌词（最佳分 ' + r.data.score + '）',
					})
				}
				p.setLyrics(r.data.lines)
				p.setPosition(60)
				const s = p.getState()
				const container = document.getElementById('lyrics-panel')
				return JSON.stringify({
					ok: true,
					score: r.data.score,
					lineCount: s.lineCount,
					activeIndex: s.activeIndex,
					liInContainer: container
						? container.querySelectorAll('li').length
						: -1,
				})
			})()`,
		),
	)

	if (!result.ok) {
		report.problems.push(`歌词没准备好：${result.error}`)
	} else if (result.liInContainer <= 0) {
		report.problems.push(
			`歌词状态是 ${result.lineCount} 行，但 DOM 里 0 个 li（面板没渲染）`,
		)
	} else {
		console.log(
			`  ✓ 歌词：匹配度 ${Number(result.score).toFixed(2)}，` +
				`${result.lineCount} 行，DOM ${result.liInContainer} 个 li，` +
				`高亮行 #${result.activeIndex}`,
		)
	}
	return result
}

async function run(window) {
	const theme = process.argv.includes('--dark') ? 'dark' : 'light'
	report.theme = theme
	fs.mkdirSync(shotDir(theme), { recursive: true })

	await waitFor(window, 'window.__bbReady', 40_000, '渲染进程就绪')

	// 固定主题（"跟随系统"会让两套截图混在一起），固定窗口尺寸
	await evaluate(
		window,
		`window.bbplayer.settings.update({ theme: ${JSON.stringify(theme)} })`,
	)
	await sleep(900)
	window.setSize(WINDOW.width, WINDOW.height)
	await sleep(500)

	console.log('\n=== 1) 灌入真实数据（B 站合集）===')
	const seeded = await waitFor(
		window,
		`document.querySelector('[data-testid="btn-seed-demo"]')`,
		20_000,
		'欢迎视图的导入按钮',
	)
	if (seeded) {
		await click(window, '[data-testid="btn-seed-demo"]')
		await waitFor(
			window,
			'window.bbTest.ui().trackRows > 0',
			120_000,
			'曲目落库',
		)
		await sleep(2500)
	}
	// 导入结束落在**歌单详情**：这是"音乐库"最像样的一屏（曲目表 + 封面 + 时长）
	await shot(window, 'library', '音乐库 › 歌单详情')

	console.log('\n=== 2) 播一首库内曲目并结算（主页统计才有数）===')
	/*
	 * ⚠️ 这一步**必须用库内曲目**（demo 合集里的那批），不能用搜索结果。
	 *
	 * 播放历史只给**已经落库**的曲目开会话：`openPlaySession` 要拿 track 的
	 * DB id 当外键，搜索结果是"还没入库"的，`startSession` 会失败、`historyId`
	 * 一直是 null（`history-probe-driver` 里也有一条断言写着这件事：
	 * 「库外曲目查不到 id —— 历史只记录已落库曲目，避免外键报错」）。
	 *
	 * 于是"拿搜索结果直接播"这条最省事的路，最后拍到的主页永远是
	 * 「还没有播放记录 / 共 0 次播放」—— 两块统计看起来像没做完。
	 * 所以这里先正经播一首库内曲目、结算掉，再去拍播放页。
	 */
	await click(window, '[data-testid="btn-play-all"]')
	const playing = await waitFor(
		window,
		`(() => {
			const s = window.bbTest.state()
			return s.counters.playing > 0 || s.currentTime > 0.2
		})()`,
		60_000,
		'库内曲目开始播放',
	)
	if (playing) {
		// 播放会话每 10 秒才上报一次累计时长（`SESSION_REPORT_INTERVAL_MS`），
		// 播几秒就收尾的话主页统计是 0
		await sleep(11_000)
	}
	/*
	 * ⚠️ **趁会话还开着**结算它。
	 *
	 * 会话的关闭点只有两个：**切歌**与**自然播完**（见 renderer.js 的
	 * `closePlaySession` 调用点）—— 暂停**不**关会话。所以"先暂停再去结算"
	 * 会拿到 `historyId: null`（第一版就是这么错的）。顺序必须是：
	 * 播够 → 结算 → 再去做别的。
	 */
	const flushed = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const before = window.bbUI.playSession()
				await window.bbUI.flushPlaySession(false)
				return JSON.stringify({
					historyIdBefore: before?.historyId ?? null,
					historyIdAfter: window.bbUI.playSession()?.historyId ?? null,
				})
			})()`,
		),
	)
	console.log(
		`  ✓ 播放会话已结算（收尾前 historyId=${flushed.historyIdBefore}，` +
			`收尾后 ${flushed.historyIdAfter}）`,
	)
	if (flushed.historyIdBefore === null) {
		report.problems.push('结算时没有进行中的播放会话 —— 主页会拍到空统计')
	}

	console.log('\n=== 3) 搜索结果 ===')
	await evaluate(
		window,
		`(() => {
			document.getElementById('search-input')?.focus()
			return true
		})()`,
	)
	await sleep(600)
	await typeInto(window, '[data-testid="search-input"]', '周杰伦')
	await click(window, '[data-testid="search-button"]')
	const searched = await waitFor(
		window,
		`(() => {
			const ui = window.bbTest.ui()
			return ui.viewTitle.startsWith('搜索：') && ui.trackRows > 0
		})()`,
		60_000,
		'搜索结果',
	)
	await sleep(1200)
	if (searched) await shot(window, 'search', '搜索结果')

	console.log('\n=== 4) 正在播放（含歌词）===')
	/*
	 * 换一首**歌词库一定认得**的曲子来拍「正在播放」。
	 *
	 * 不拿 demo 合集里的曲子：那些是 B 站官方视频（访谈 / 宣传片），
	 * 与网易云 / QQ / 酷狗的曲库匹配不上（实测最佳分 0.18），
	 * 截图里右卡会是「暂无歌词」—— 而 README 要展示的正是歌词。
	 *
	 * 这一首**不入库**，所以它不会污染播放历史（没会话可开，正好）。
	 */
	await typeInto(
		window,
		'[data-testid="search-input"]',
		'Never Gonna Give You Up',
	)
	await click(window, '[data-testid="search-button"]')
	const found = await waitFor(
		window,
		`(() => {
			const ui = window.bbTest.ui()
			return ui.viewTitle.startsWith('搜索：') && ui.trackRows > 0
		})()`,
		60_000,
		'用于拍播放页的搜索结果',
	)
	if (found) {
		await sleep(1000)
		await playFirstRow(window)
		await waitFor(
			window,
			`(() => {
				const s = window.bbTest.state()
				return s.counters.playing > 0 || s.currentTime > 0.2
			})()`,
			60_000,
			'开始播放',
		)
		/*
		 * 让它播几秒再暂停：`loadLyricsFor(track)` 是随曲目加载异步跑的，
		 * 播一会儿之后再手动 setLyrics 才不会被它盖掉。
		 */
		await sleep(6000)
	}

	const lyrics = await loadLyrics(window, {
		title: 'Never Gonna Give You Up',
		artist: 'Rick Astley',
		duration: 213,
	})

	// 进「正在播放」：左卡大封面 + 主控，右卡歌词
	await click(window, '[data-testid="playbar-cover"]')
	await sleep(1500)
	/*
	 * 歌词是**异步**进 DOM 的（匹配 + 渲染两跳）。
	 * `loadLyrics` 已经确认过 li 数量，但视图切换之后面板会重新挂载 ——
	 * 所以这里再等一次"面板里真的有行"，而不是靠 sleep 猜。
	 */
	await waitFor(
		window,
		`document.querySelectorAll('#lyrics-panel li').length > 0`,
		20_000,
		'正在播放页的歌词行',
	)
	await sleep(800)
	if (lyrics.ok) {
		await shot(window, 'nowplaying', '正在播放（大封面 + 歌词高亮）')
	}

	console.log('\n=== 4) 播放列表浮层 ===')
	await click(window, '[data-testid="playbar-queue"]')
	await sleep(1000)
	await shot(window, 'queue', '从下方呼出的播放列表浮层')
	await evaluate(window, `window.bbUI.toggleQueuePopover(false)`)
	await sleep(600)

	console.log('\n=== 5) 主页 ===')
	/*
	 * 会话已经在第 3 步结算过了（必须趁它开着，见那里的注释）。
	 * 这里只等统计读回来，再清掉搜索框里的关键词 —— 它常驻在内容卡顶部，
	 * 不清的话主页那张图会带着上一次搜索的「Never Gonna Give You Up」，
	 * 看起来像"主页有个查询"。
	 */
	await sleep(1200)
	await evaluate(
		window,
		`(() => {
			const input = document.getElementById('search-input')
			if (input) {
				input.value = ''
				input.dispatchEvent(new Event('input', { bubbles: true }))
			}
			return true
		})()`,
	)
	await click(window, '[data-testid="sidebar-brand"]')
	await sleep(2500)
	/*
	 * 拍之前确认主页**真的有统计**，而不是一片「还没有播放记录」。
	 * 只截图不断言的话，"这一块看起来像没做完"要靠人眼发现 ——
	 * 而这里能机械地判：热力图那句汇总文案与最近播放的条数。
	 */
	const homeStats = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const text = document.body.innerText
				return JSON.stringify({
					emptyRecent: text.includes('还没有播放记录'),
					zeroPlays: /共 0 次播放/.test(text),
				})
			})()`,
		),
	)
	if (homeStats.emptyRecent || homeStats.zeroPlays) {
		report.problems.push(
			`主页统计是空的（最近播放空=${homeStats.emptyRecent}，共 0 次播放=${homeStats.zeroPlays}）`,
		)
	}
	await shot(
		window,
		'home',
		'主页（最近播放 / 听歌频率 / 最近更新 / 播放历史）',
	)

	console.log('\n=== 6) 设置 ===')
	await click(window, '[data-testid="sidebar-settings"]')
	await sleep(1200)
	await shot(window, 'settings', '设置（10 个分类）')

	// 收尾：把主题改回跟随系统，避免影响下一次真实启动
	await evaluate(window, `window.bbplayer.settings.update({ theme: 'system' })`)

	const manifest = path.join(shotDir(theme), 'manifest.json')
	fs.writeFileSync(
		manifest,
		JSON.stringify(
			{ capturedAt: new Date().toISOString(), ...report },
			null,
			2,
		),
	)
	console.log(
		`\n共 ${report.shots.length} 张，问题 ${report.problems.length} 条`,
	)
	for (const problem of report.problems) console.log(`  ⚠ ${problem}`)
	console.log(`清单位置：${manifest}`)
	return report
}

module.exports = { run }
