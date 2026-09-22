/**
 * 播放器：`<audio>` + 队列 + 模式（顺序 / 单曲 / 随机）。
 *
 * 音频源始终是 `bbplayer-audio://track/<bvid>`（主进程代理，注入 Referer、
 * 透传 Range），而不是直连 CDN —— 原因见 docs/DESKTOP_PLAN.md §2.3。
 *
 * 同时暴露 `window.bbTest`，供自动化验证脚本做「点击级」断言
 * （见 scripts/verify-desktop.mjs 与 apps/desktop/src/probe-driver.cjs）。
 */
;(function () {
	'use strict'

	/**
	 * 生成一个 Material Symbols 图标节点的 HTML。
	 *
	 * 图标名是字体的**合字**（ligature），所以写的是 `play_arrow` 这样的名字，
	 * 字体把它渲染成图形 —— HTML 里读起来是语义，不是乱码。
	 * 字体来自 `scripts/build-icon-font.mjs`（子集，9.3 KB，随源码提交）。
	 */
	function icon(name, extraClass = '') {
		return `<span class="icon ${extraClass}">${name}</span>`
	}

	/**
	 * 播放模式（四档）。
	 *
	 * ⚠️ 原先只有三档（order / repeat-one / shuffle），而 order 的行为是
	 * "放完最后一首回到第一首" —— 也就是说它**实际上是列表循环**，却叫「顺序播放」。
	 * 用户确认要四档，于是把语义拆开：
	 *
	 *   list-loop  列表循环：自动续播，队尾回到队首（＝原 order 的行为）
	 *   repeat-one 单曲循环：自动续播只重播当前这一首
	 *   shuffle    随机播放：按洗牌序走，走到末尾重洗
	 *   order      顺序播放：**放完最后一首就停**（新增行为）
	 */
	const PLAY_MODES = ['list-loop', 'repeat-one', 'shuffle', 'order']
	/**
	 * 播放模式的图标与无障碍名。
	 *
	 * 第一版这里是一个**文字按钮**（顺序 / 单曲 / 随机），在一排图标按钮里
	 * 显得格格不入 —— 移动端用的是图标。	itle / ria-label 保留文字，
	 * 所以鼠标悬停与读屏仍然能知道当前是什么模式。
	 */
	const MODE_ICON = {
		'list-loop': 'repeat',
		'repeat-one': 'repeat_one',
		shuffle: 'shuffle',
		order: 'arrow_forward',
	}
	const MODE_LABEL = {
		'list-loop': '列表循环',
		'repeat-one': '单曲循环',
		shuffle: '随机播放',
		order: '顺序播放',
	}

	const els = {
		audio: document.getElementById('audio'),
		play: document.getElementById('play'),
		prev: document.getElementById('prev'),
		next: document.getElementById('next'),
		progress: document.getElementById('progress'),
		/*
		 * ⚠️ `volume` 与 `npVolume` 两条滑块在卡片化改造里**去掉了**
		 * （用户要求播放卡与详情页都没有音量）。`els` 表里不再有它们 ——
		 * 留着死引用会让人以为界面里还有两条滑块。
		 */
		mode: document.getElementById('mode'),
		timeCurrent: document.getElementById('time-current'),
		timeTotal: document.getElementById('time-total'),
		title: document.getElementById('now-title'),
		/** 标题的裁剪层（两层结构的外层，卡片化阶段 3） */
		titleWrap: document.getElementById('now-title-wrap'),
		artist: document.getElementById('now-artist'),
		cover: document.getElementById('now-cover'),
		coverPlaceholder: document.getElementById('now-cover-placeholder'),
		queueList: document.getElementById('queue-list'),
		queueEmpty: document.getElementById('queue-empty'),
		status: document.getElementById('status'),
		// ── 正在播放卡片（与底部播放条是同一组状态的第二触发点）──
		npPlay: document.getElementById('nowplaying-play'),
		npPrev: document.getElementById('nowplaying-prev'),
		npNext: document.getElementById('nowplaying-next'),
		npMode: document.getElementById('nowplaying-mode'),
		/** 详情页那颗"音量（在设置里调）"图标按钮 */
		npVolumeOpen: document.getElementById('nowplaying-volume-open'),
		npProgress: document.getElementById('nowplaying-progress'),
		npTimeCurrent: document.getElementById('nowplaying-time-current'),
		npTimeTotal: document.getElementById('nowplaying-time-total'),
	}

	/** 事件计数：自动化脚本靠它断言「确实发生过网络/解码活动」 */
	const counters = {
		loadstart: 0,
		loadedmetadata: 0,
		canplay: 0,
		playing: 0,
		pause: 0,
		seeking: 0,
		seeked: 0,
		waiting: 0,
		stalled: 0,
		error: 0,
		ended: 0,
	}

	const state = {
		queue: [],
		index: -1,
		/*
		 * 默认「列表循环」。⚠️ 这是**用户可见的行为**：打开应用点「播放全部」后，
		 * 播到最后一首会回到第一首，而不是停下。默认值从 `order` 改成 `list-loop`
		 * 是为了保持改造前 `order` 的实际行为不变（见上面 PLAY_MODES 的注释）。
		 */
		mode: 'list-loop',
		/** 随机播放的洗牌顺序（队列下标的排列）与当前所处位置 */
		shuffleOrder: [],
		shufflePos: -1,
	}

	const listeners = new Set()
	const on = (fn) => {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}
	const emit = (event) => {
		for (const fn of listeners) {
			try {
				fn(event)
			} catch (error) {
				console.error('[player] 监听器抛错:', error)
			}
		}
	}

	// ---------------------------------------------------------------
	// 工具
	// ---------------------------------------------------------------

	function formatTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
		const total = Math.floor(seconds)
		const m = Math.floor(total / 60)
		const s = total % 60
		return `${m}:${String(s).padStart(2, '0')}`
	}

	function setStatus(text, kind) {
		if (!els.status) return
		els.status.textContent = text
		els.status.className = `status status--${kind || 'idle'}`
	}

	function describeError() {
		const error = els.audio.error
		if (!error) return null
		const names = {
			1: 'MEDIA_ERR_ABORTED',
			2: 'MEDIA_ERR_NETWORK',
			3: 'MEDIA_ERR_DECODE',
			4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
		}
		/*
		 * ⚠️ 给用户看的是一句**中文**，不是 `MEDIA_ERR_SRC_NOT_SUPPORTED`。
		 *
		 * 原来直接把枚举名拼进状态胶囊，用户看到的是"播放失败：
		 * MEDIA_ERR_SRC_NOT_SUPPORTED"。技术细节留给 title/诊断，
		 * 界面上只留人能读的那半句。
		 */
		const human = {
			1: '播放被中断',
			2: '网络错误，拉流失败',
			3: '音频解码失败',
			4: '这个音源无法播放（可能已下架或需要登录）',
		}
		return {
			code: error.code,
			name: names[error.code] || `UNKNOWN(${error.code})`,
			human: human[error.code] || '未知的播放错误',
			message: error.message || null,
		}
	}

	function bufferedRanges() {
		const ranges = []
		try {
			for (let i = 0; i < els.audio.buffered.length; i++) {
				ranges.push([els.audio.buffered.start(i), els.audio.buffered.end(i)])
			}
		} catch {
			// 未就绪时读取 buffered 可能抛错
		}
		return ranges
	}

	const proxyUrlFor = (track) =>
		`bbplayer-audio://track/${encodeURIComponent(track.bvid)}`

	// ---------------------------------------------------------------
	// 队列
	// ---------------------------------------------------------------

	function setQueue(tracks, startIndex) {
		state.queue = tracks.slice()
		state.index = Number.isInteger(startIndex) ? startIndex : 0
		// 换了队列就重新洗牌（沿用旧顺序会把下标对错歌）
		state.shuffleOrder = []
		if (state.mode === 'shuffle') reshuffle()
		renderQueue()
		emit({ type: 'queue-changed' })
	}

	function playAt(index) {
		if (index < 0 || index >= state.queue.length) return false
		state.index = index
		// 用户直接点了某一首：洗牌位置要跳到它在洗牌顺序里的位置，
		// 否则「下一首」会从旧位置继续走，表现成"点了这首之后下一首不对"
		const pos = state.shuffleOrder.indexOf(index)
		if (pos >= 0) state.shufflePos = pos
		const track = state.queue[index]
		if (!track) return false

		els.audio.src = proxyUrlFor(track)
		els.audio.load()
		updateNowPlaying()
		renderQueue()
		emit({ type: 'track-changed', track })
		return true
	}

	/**
	 * 随机播放的**洗牌顺序**（队列下标的一个排列）。
	 *
	 * ⚠️ 第一版的随机是"每次都随机挑一个、避开当前这首"。那**不是**随机播放 ——
	 * 它会重复播已经听过的歌，也可能很久碰不到某一首；用户感知就是
	 * "随机播放老是放那几首"。
	 *
	 * 真正的随机播放是**洗牌**：把队列打乱成一个顺序，然后按这个顺序走一遍，
	 * 走完再重洗。附带两个好处：
	 *   * 「上一首」有确定含义（洗牌顺序里的前一个），而不是又随机一首；
	 *   * 每首歌在一个循环里**恰好播一次**。
	 *
	 * `shufflePos` 记录"当前曲目在洗牌顺序里的位置"，前进/后退都按它走。
	 */
	function reshuffle() {
		const order = state.queue.map((_, index) => index)
		// Fisher–Yates：每个排列等概率。用 `sort(() => Math.random() - 0.5)`
		// 是常见的错法 —— 它的分布不均匀（引擎的排序实现会影响结果）。
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			;[order[i], order[j]] = [order[j], order[i]]
		}
		state.shuffleOrder = order
		state.shufflePos = order.indexOf(state.index)
	}

	/** 队列变化后（换歌单、插入、删除、重排）让洗牌顺序跟上 */
	function syncShuffle() {
		if (state.mode !== 'shuffle') return
		// 保留了原来的相对顺序、只补上新出现的下标，避免"每加一首就整个重洗"
		const known = new Set(state.shuffleOrder)
		const kept = state.shuffleOrder.filter(
			(index) => index < state.queue.length,
		)
		const added = state.queue
			.map((_, index) => index)
			.filter((index) => !known.has(index))
		state.shuffleOrder = [...kept, ...added]
		state.shufflePos = state.shuffleOrder.indexOf(state.index)
	}

	function nextIndex(auto) {
		const { queue, index, mode } = state
		if (queue.length === 0) return -1
		if (mode === 'repeat-one' && auto) return index
		if (mode === 'shuffle') {
			if (queue.length === 1) return index
			if (state.shuffleOrder.length !== queue.length) reshuffle()
			// 走到洗牌顺序的末尾就重洗一轮（对应"列表循环"的回到队首）
			const nextPos = (state.shufflePos + 1) % state.shuffleOrder.length
			if (nextPos === 0) reshuffle()
			return state.shuffleOrder[nextPos]
		}
		/*
		 * 顺序播放：自动续播走到**最后一首就停**（返回 -1）。
		 * 手动点「下一首」仍然回绕 —— 用户的意图明确，不该被模式挡住。
		 * 其余模式（list-loop）保持原有的 `%` 回绕。
		 */
		if (mode === 'order' && auto && index >= queue.length - 1) return -1
		return (index + 1) % queue.length
	}

	function prevIndex() {
		const { queue, index, mode } = state
		if (queue.length === 0) return -1
		if (mode === 'shuffle') {
			if (state.shuffleOrder.length !== queue.length) reshuffle()
			const prevPos =
				(state.shufflePos - 1 + state.shuffleOrder.length) %
				state.shuffleOrder.length
			return state.shuffleOrder[prevPos]
		}
		return (index - 1 + queue.length) % queue.length
	}

	// ---------------------------------------------------------------
	// 播放控制
	// ---------------------------------------------------------------

	async function play() {
		/*
		 * ⚠️ 队列为空时必须**直接拒绝**，不要让 `<audio>` 去 play() 一个空 src。
		 *
		 * 空库时点两次播放条上的 ▶：第一次是静默 no-op（但 `audio.paused`
		 * 已经翻成 false），第二次 Chromium 抛
		 * `The play() request was interrupted by a call to pause()` —— 那条
		 * **英文原文 + goo.gl 短链**会被原样打进红色胶囊给用户看（用户实测截图）。
		 */
		if (state.queue.length === 0) {
			setStatus('先从音乐库选一首歌吧', 'idle')
			return false
		}
		try {
			await els.audio.play()
			return true
		} catch {
			// 失败原因统一走 describeError()（`<audio>.error` 里有 code），
			// **不**直接展示 Chromium 的英文原文（用户实测看到过 goo.gl 短链）
			setStatus(`播放失败：${describeError()?.human ?? '音源无法播放'}`, 'bad')
			// 播放失败时按钮必须回到「播放」，否则图标停在暂停上，
			// 用户以为正在放（点一下反而是"暂停"）
			syncPlayButtons()
			return false
		}
	}

	/**
	 * 把播放/暂停图标同步到**实际**的 `audio.paused`。
	 *
	 * 之前图标只在 `playing` / `pause` 两个事件里更新：`error` 分支与
	 * `play()` 的拒绝路径都不动它 —— 于是加载失败的曲目会让按钮**永久停在
	 * 暂停图标**上。
	 */
	function syncPlayButtons() {
		const name = els.audio.paused ? 'play_arrow' : 'pause'
		if (els.play) els.play.innerHTML = icon(name)
		if (els.npPlay) els.npPlay.innerHTML = icon(name)
	}

	function pause() {
		els.audio.pause()
	}

	function toggle() {
		if (els.audio.paused) return play()
		pause()
		return Promise.resolve(true)
	}

	/**
	 * **把一首歌插到「下一首播放」**（用户明确要求的功能）。
	 *
	 * 与「加入队列」的区别：加入队列是**追加到末尾**，这个是插到**当前曲目
	 * 之后**，下一首就播它 —— 用户说"我现在就要听这首"时用的是后者。
	 *
	 * 三个边界：
	 *   * 队列为空 → 直接当成"开始播放这一首"；
	 *   * 已经在队列里 → **不重复添加**，而是把它挪到当前位置之后
	 *     （"下一首播放"的语义是"下一个播它"，不是"列表里出现两次"）；
	 *   * 不在队列里 → 插到 index + 1。
	 *
	 * @param {object} track 曲目（要有 bvid）
	 */
	function playNextInsert(track) {
		if (!track?.bvid) return { ok: false, reason: 'no-bvid' }

		if (state.queue.length === 0) {
			setQueue([track], 0)
			void play()
			return { ok: true, at: 0, started: true }
		}

		const playingBvid = state.queue[state.index]?.bvid ?? null
		const target = state.index + 1
		const existing = state.queue.findIndex((item) => item.bvid === track.bvid)

		if (existing === target) {
			// 已经就是下一首 —— 不做无意义的移动，否则会打乱用户刚排好的顺序
			return { ok: true, at: existing, moved: false }
		}

		let at = target
		if (existing >= 0) {
			const [moved] = state.queue.splice(existing, 1)
			// 移走的那首原本在插入点之前时，插入点要往前挪一格
			at = existing < target ? target - 1 : target
			state.queue.splice(at, 0, moved)
		} else {
			state.queue.splice(at, 0, track)
		}

		// 当前播放项的下标可能被动过，按 bvid 重新定位（不能假设它没变）
		state.index = playingBvid
			? state.queue.findIndex((entry) => entry.bvid === playingBvid)
			: state.index
		syncShuffle()
		renderQueue()
		emit({ type: 'queue-changed' })
		return { ok: true, at, moved: existing >= 0 }
	}

	/**
	 * 在队列里移动一项（**更改播放顺序**）。
	 *
	 * 拖拽与键盘都走这里，保证两条路径行为完全一致。
	 *
	 * @param {number} from 原下标
	 * @param {number} to 目标下标（移动后该项所在的位置）
	 */
	function moveInQueue(from, to) {
		const { queue } = state
		if (from < 0 || from >= queue.length) return { ok: false, reason: 'from' }
		if (to < 0 || to >= queue.length) return { ok: false, reason: 'to' }
		if (from === to) return { ok: true, moved: false, index: state.index }

		const playingBvid = queue[state.index]?.bvid ?? null
		const [item] = queue.splice(from, 1)
		queue.splice(to, 0, item)

		// ⚠️ 当前播放项的下标必须**跟着它自己走**，不能保持不变 ——
		// 否则拖动别人的行会让"正在播放"跳到另一首歌上（而且很难发现，
		// 因为列表看起来是对的）。
		state.index = playingBvid
			? queue.findIndex((entry) => entry.bvid === playingBvid)
			: -1
		syncShuffle()
		renderQueue()
		emit({ type: 'queue-changed' })
		return { ok: true, moved: true, index: state.index }
	}

	/** 键盘重排：把当前播放项上移 / 下移一位 */
	function nudgeCurrent(delta) {
		if (state.index < 0) return { ok: false, reason: 'no-current' }
		return moveInQueue(state.index, state.index + delta)
	}

	async function playNext(auto) {
		const index = nextIndex(auto)
		if (index < 0) return false
		playAt(index)
		return await play()
	}

	async function playPrev() {
		const index = prevIndex()
		if (index < 0) return false
		playAt(index)
		return await play()
	}

	function seekTo(seconds) {
		els.audio.currentTime = seconds
	}

	function seekBy(delta) {
		const target = Math.max(0, els.audio.currentTime + delta)
		const duration = els.audio.duration
		els.audio.currentTime = Number.isFinite(duration)
			? Math.min(target, duration)
			: target
	}

	/**
	 * 把滑块已播放的比例写进 `--range-fill`。
	 *
	 * 滑块改成自绘（`appearance: none`）之后，进度不能再靠 Chromium 原生的
	 * 填充着色，需要自己给轨道上色 —— CSS 用这个变量把轨道分成
	 * 「已播放（主色）」与「剩余（surface-3）」两段。这样不用加任何 DOM。
	 */
	function syncRangeFill(input, percent) {
		if (!input) return
		const clamped = Math.max(0, Math.min(100, percent))
		input.style.setProperty('--range-fill', `${clamped}%`)
	}

	/**
	 * 音量（卡片化改造之后**唯一**的实现）。
	 *
	 * ⚠️ 原来 `setVolume` 还要同步两条滑块（播放卡的 `#volume` 与播放详情页的
	 * `#nowplaying-volume`）。用户明确要求那两处都不放音量滑块，于是：
	 *   * 滑块只剩「设置 › 播放」里的一条（由 `settings-panel.js` 自己 wire）；
	 *   * 这里只负责写 `audio.volume` 并**广播** `volume-changed`，
	 *     谁需要跟着更新（设置里的滑块、静音按钮的文案）自己订阅。
	 *
	 * 为什么用事件而不是让调用方直接改滑块：`Ctrl+←/→`、设置滑块、
	 * 以后可能的媒体键都会走这一条路 —— 让"谁改的音量"与"谁显示音量"解耦，
	 * 否则又是"两条滑块互相同步"那种会漂的结构。
	 */
	function setVolume(percent) {
		const clamped = Math.max(0, Math.min(100, percent))
		els.audio.volume = clamped / 100
		emit({ type: 'volume-changed', volume: clamped })
		return clamped
	}

	/**
	 * 播放卡标题的横向滚动（卡片化阶段 3）。
	 *
	 * 草图：「标题如果过长，滚动显示」。做法是**两层的 CSS 动画**：
	 * 外层 `.playbar__title` 裁剪，内层 `.playbar__title-text` 按
	 * `--marquee-shift` 平移（见 style.css 的 `@keyframes bb-marquee`）。
	 *
	 * ⚠️ 只有**真的溢出**才加 `.is-overflowing`。不加判断的话：
	 *   * 短标题也会一直微微地动（`translateX(0px)` 的动画看起来像抖动）；
	 *   * 每一个字都要跟着合成器跑，纯浪费。
	 *
	 * `scrollWidth - clientWidth` 就是"需要平移多少才看得完"。
	 */
	function syncTitleMarquee() {
		if (!els.titleWrap || !els.title) return
		els.titleWrap.classList.remove('is-overflowing')
		els.titleWrap.style.removeProperty('--marquee-shift')
		// 先摘类再量 —— 带着动画类量出来的 scrollWidth 不可靠
		const shift = els.title.scrollWidth - els.titleWrap.clientWidth
		if (shift <= 4) return
		els.titleWrap.style.setProperty('--marquee-shift', `-${shift}px`)
		els.titleWrap.classList.add('is-overflowing')
	}

	function syncModeButtons() {
		for (const btn of [els.mode, els.npMode]) {
			if (!btn) continue
			btn.innerHTML = icon(MODE_ICON[state.mode])
			btn.title = MODE_LABEL[state.mode]
			btn.setAttribute('aria-label', MODE_LABEL[state.mode])
		}
	}

	function cycleMode() {
		const i = PLAY_MODES.indexOf(state.mode)
		state.mode = PLAY_MODES[(i + 1) % PLAY_MODES.length]
		// 切到随机就洗一副新牌；切走就清掉（下次进来重新洗）
		if (state.mode === 'shuffle') reshuffle()
		else state.shuffleOrder = []
		syncModeButtons()
		emit({ type: 'mode-changed', mode: state.mode })
		return state.mode
	}

	/**
	 * 直接设定播放模式（循环按钮之外的另一条路径）。
	 *
	 * 有它才能**确定性地**测随机播放：`cycleMode()` 要按 3 次才轮到，
	 * 断言里就得写"按三次"，一旦模式顺序变了测试就静默测错东西。
	 */
	function setMode(mode) {
		if (!PLAY_MODES.includes(mode)) return state.mode
		state.mode = mode
		if (mode === 'shuffle') reshuffle()
		else state.shuffleOrder = []
		syncModeButtons()
		emit({ type: 'mode-changed', mode })
		return state.mode
	}

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	/**
	 * 刷新「正在播放」面板（阶段 4b）。
	 *
	 * 大封面 / 标题 / 歌手 / 从封面派生的模糊背景。
	 * 面板**不持有**播放状态 —— 它只是把 `state.queue[state.index]`
	 * 换一种更大的排版显示出来，避免两份状态漂移。
	 */
	function refreshNowPlayingView() {
		const track = state.queue[state.index] ?? null
		const title = document.getElementById('nowplaying-title')
		const artist = document.getElementById('nowplaying-artist')
		const count = document.getElementById('nowplaying-count')
		const cover = document.getElementById('nowplaying-cover')
		const placeholder = document.getElementById('nowplaying-placeholder')
		const background = document.getElementById('nowplaying-bg')

		if (title) title.textContent = track?.title ?? '未在播放'
		if (artist)
			artist.textContent = track
				? track.artist || track.artist_name || '—'
				: '—'
		if (count) count.textContent = String(state.queue.length)

		const coverUrl = window.bbComponents.coverSrc(
			track?.cover ?? track?.coverUrl ?? track?.cover_url ?? null,
		)
		/*
		 * ⚠️ 面板封面必须和播放条封面一样接 load / error。
		 *
		 * 只设 src 的话：HTML 上那个 hidden 属性永远摘不掉 ——
		 * 于是"有封面 URL、但封面永远是隐藏的"，只剩一个空方块；
		 * 而占位图标因为"有封面"也被藏起来了，两头都空。
		 * 巡检体检表里 coverHidden=true 而 coverSrc 有值，一眼就能看出。
		 */
		if (cover && !cover.dataset.wired) {
			cover.dataset.wired = '1'
			cover.addEventListener('load', () => {
				cover.hidden = false
				if (placeholder) placeholder.hidden = true
			})
			cover.addEventListener('error', () => {
				cover.hidden = true
				if (placeholder) placeholder.hidden = false
			})
		}
		if (cover) {
			if (coverUrl) cover.src = coverUrl
			else {
				cover.hidden = true
				cover.removeAttribute('src')
			}
		}
		if (placeholder) placeholder.hidden = Boolean(coverUrl)

		/*
		 * 背景：**从封面取主色**（卡片化阶段 4）。
		 *
		 * ⚠️ 原来是"同一张封面铺满 + `blur(64px)`"。草图明确写着
		 * 「背景模糊封面主色，**不要模糊**」—— 两张图叠在一起再糊掉，
		 * 观感是一团脏色；而从封面算出来的**一个颜色**才是要的东西。
		 *
		 * 取色在 `cover-accent.js`（Canvas 降采样 + 按色相投票）。
		 * ⚠️ 它**是异步的、并且可能失败**（跨域封面拿不到像素）——
		 * 失败时清掉 `--np-accent`，CSS 退回 `--primary` 的柔和渐变，
		 * 同时留 `data-accent="fallback"` 给探针。
		 * **绝不 await 阻塞这里**：换曲要立刻出画面。
		 */
		if (background) {
			void window.bbCoverAccent?.apply?.(coverUrl, background)
		}
	}

	function updateNowPlaying() {
		const track = state.queue[state.index]
		if (els.title) els.title.textContent = track ? track.title : '未在播放'
		syncTitleMarquee()
		if (els.artist)
			els.artist.textContent = track
				? track.artist || track.artist_name || '—'
				: '—'
		refreshNowPlayingView()

		// 封面缩略图：有就显示，加载失败就退回占位图标。
		// ⚠️ 不能只设 `src` 不管失败 —— 封面域名偶尔会 403，
		// 那时浏览器会显示一个"破图"图标，比不显示还难看。
		// ⚠️ 封面字段在不同来源里名字不一样：搜索结果是 `cover`，
		// 核心层的歌单曲目是 `coverUrl`（数据库列 `cover_url`）。
		// 三个都认，不然"搜索进来的有封面、从歌单进来的没有"——
		// 这种不一致很难一眼看出来。
		const coverUrl = window.bbComponents.coverSrc(
			track?.cover ?? track?.coverUrl ?? track?.cover_url ?? null,
		)
		if (els.cover) {
			if (coverUrl && els.cover.getAttribute('src') !== coverUrl) {
				els.cover.hidden = true
				els.cover.src = coverUrl
			}
			if (!coverUrl) {
				els.cover.hidden = true
				els.cover.removeAttribute('src')
			}
		}
		if (els.coverPlaceholder) els.coverPlaceholder.hidden = Boolean(coverUrl)
	}

	// 封面**加载成功才显示**，失败就退回占位 —— 否则会留一个破图图标，
	// 比不显示还难看（封面域名偶尔 403）。
	if (els.cover && !els.cover.dataset.wired) {
		els.cover.dataset.wired = '1'
		els.cover.addEventListener('load', () => {
			els.cover.hidden = false
			if (els.coverPlaceholder) els.coverPlaceholder.hidden = true
		})
		els.cover.addEventListener('error', () => {
			els.cover.hidden = true
			if (els.coverPlaceholder) els.coverPlaceholder.hidden = false
		})
	}

	function renderQueue() {
		if (!els.queueList) return
		els.queueList.textContent = ''
		if (els.queueEmpty) els.queueEmpty.hidden = state.queue.length > 0
		// 面板上的计数也跟着走（队列只有一份数据，两个地方显示）
		/*
		 * 队列条数。
		 *
		 * ⚠️ 卡片化阶段 4 删掉了「正在播放」页的第三栏（`#nowplaying-count`
		 * 跟着没了）；阶段 5 起这个数字显示在**播放列表浮层**的标题右边。
		 * 两个 id 都查一次，是为了让"队列容器搬到哪儿"与"数字在哪儿"
		 * 互不绑定 —— 少一个不影响渲染。
		 */
		const countText = String(state.queue.length)
		for (const id of ['nowplaying-count', 'queue-popover-count']) {
			const node = document.getElementById(id)
			if (node) node.textContent = countText
		}

		state.queue.forEach((track, index) => {
			const li = document.createElement('li')
			li.className = 'queue-list__item'
			if (index === state.index) li.classList.add('is-playing')
			li.dataset.index = String(index)
			// 语义属性：探针计数用它，改视觉类名不会让它失效（见 ui() 里的注释）
			li.dataset.queueIndex = String(index)
			li.dataset.testid = `queue-item-${index}`
			li.title = track.artist ? `${track.title} — ${track.artist}` : track.title

			/*
			 * 队列行 = **序号 + 曲绘封面 + 标题/歌手 + 时长 + 拖拽把手**（阶段 D-1b）。
			 *
			 * 原来是"序号 + 一行纯文字"。用户给的参考图里队列行有封面、歌手、时长；
			 * 而且我们自己的组件约定就是"列表行 = 曲绘封面 + 主标题 + 副标题"
			 * （阶段 1c 定的），队列这一处一直是个例外。
			 */
			li.appendChild(
				window.bbComponents.art({
					title: track.title,
					coverUrl: track.cover ?? track.coverUrl ?? track.cover_url ?? null,
					tag: 'span',
					extraClass: 'queue-list__art',
				}),
			)

			const main = document.createElement('span')
			main.className = 'queue-list__main'
			const title = document.createElement('span')
			title.className = 'queue-list__title'
			title.textContent = track.title
			main.appendChild(title)

			const artist = document.createElement('span')
			artist.className = 'queue-list__artist'
			artist.textContent =
				track.artist ||
				track.artist_name ||
				track.upperName ||
				track.author ||
				'—'
			main.appendChild(artist)
			li.appendChild(main)

			const time = document.createElement('span')
			time.className = 'queue-list__time mono'
			time.textContent = formatTime(track.duration)
			li.appendChild(time)

			li.addEventListener('click', () => {
				playAt(index)
				void play()
			})

			// **队列内拖动重排**（用户明确要求的功能：更改列表顺序）。
			// 与歌单内的拖拽同一套交互：按鼠标在行的上半/下半决定插在前还是后。
			wireQueueDrag(li, index)
			els.queueList.appendChild(li)
		})
	}

	/**
	 * 队列行的拖拽重排。
	 *
	 * ⚠️ 队列是**内存里**的顺序（跟着这次播放走），歌单拖拽是写数据库的 ——
	 * 两者刻意分开：把队列顺序写回歌单会让"临时插一首"变成永久改动。
	 */
	function wireQueueDrag(li, index) {
		li.draggable = true

		li.addEventListener('dragstart', (event) => {
			event.dataTransfer.effectAllowed = 'move'
			event.dataTransfer.setData('text/plain', String(index))
			li.classList.add('is-dragging')
		})

		li.addEventListener('dragend', () => {
			li.classList.remove('is-dragging')
			for (const other of els.queueList.querySelectorAll(
				'.is-drop-before, .is-drop-after',
			)) {
				other.classList.remove('is-drop-before', 'is-drop-after')
			}
		})

		li.addEventListener('dragover', (event) => {
			event.preventDefault()
			event.dataTransfer.dropEffect = 'move'
			const rect = li.getBoundingClientRect()
			const after = event.clientY > rect.top + rect.height / 2
			li.classList.toggle('is-drop-before', !after)
			li.classList.toggle('is-drop-after', after)
		})

		li.addEventListener('dragleave', () => {
			li.classList.remove('is-drop-before', 'is-drop-after')
		})

		li.addEventListener('drop', (event) => {
			event.preventDefault()
			const from = Number(
				event.dataTransfer.getData('text/plain') || li.dataset.index,
			)
			const rect = li.getBoundingClientRect()
			const after = event.clientY > rect.top + rect.height / 2
			let to = index + (after ? 1 : 0)
			if (from < to) to -= 1
			li.classList.remove('is-drop-before', 'is-drop-after')
			if (!Number.isInteger(from) || from < 0 || from === to) return
			moveInQueue(from, to)
		})
	}

	function updateProgress() {
		const { currentTime, duration } = els.audio
		if (els.timeCurrent) els.timeCurrent.textContent = formatTime(currentTime)
		if (els.timeTotal) els.timeTotal.textContent = formatTime(duration)
		if (els.npTimeCurrent)
			els.npTimeCurrent.textContent = formatTime(currentTime)
		if (els.npTimeTotal) els.npTimeTotal.textContent = formatTime(duration)
		if (els.progress && Number.isFinite(duration) && duration > 0) {
			// 拖动中不要覆盖用户的手动位置
			if (!isScrubbing) {
				els.progress.value = String(Math.round((currentTime / duration) * 1000))
				syncRangeFill(els.progress, (currentTime / duration) * 100)
			}
		}
		if (els.npProgress && Number.isFinite(duration) && duration > 0) {
			if (!isNpScrubbing) {
				els.npProgress.value = String(
					Math.round((currentTime / duration) * 1000),
				)
				syncRangeFill(els.npProgress, (currentTime / duration) * 100)
			}
		}
	}

	// ---------------------------------------------------------------
	// 事件绑定
	// ---------------------------------------------------------------

	for (const name of Object.keys(counters)) {
		els.audio.addEventListener(name, () => {
			counters[name] += 1
			if (name === 'error') {
				const error = describeError()
				setStatus(`播放失败：${error ? error.human : '未知'}`, 'bad')
			} else if (name === 'playing') {
				setStatus('正在播放', 'ok')
				if (els.play) els.play.innerHTML = icon('pause')
				if (els.npPlay) els.npPlay.innerHTML = icon('pause')
			} else if (name === 'pause') {
				setStatus('已暂停', 'idle')
				if (els.play) els.play.innerHTML = icon('play_arrow')
				if (els.npPlay) els.npPlay.innerHTML = icon('play_arrow')
			} else if (name === 'ended') {
				// 自动续播
				void playNext(true)
			}
			updateProgress()
		})
	}

	els.audio.addEventListener('timeupdate', updateProgress)

	let isScrubbing = false
	/** 正在播放卡片进度条的拖动状态（与 isScrubbing 同理） */
	let isNpScrubbing = false
	if (els.progress) {
		els.progress.addEventListener('input', () => {
			isScrubbing = true
			const duration = els.audio.duration
			// 拖动过程中也要跟着重画已播放段，否则滑块看着像没动
			syncRangeFill(els.progress, Number(els.progress.value) / 10)
			if (Number.isFinite(duration) && duration > 0) {
				const target = (Number(els.progress.value) / 1000) * duration
				if (els.timeCurrent) els.timeCurrent.textContent = formatTime(target)
			}
		})
		els.progress.addEventListener('change', () => {
			const duration = els.audio.duration
			if (Number.isFinite(duration) && duration > 0) {
				seekTo((Number(els.progress.value) / 1000) * duration)
			}
			isScrubbing = false
		})
		// 初始状态（value 默认是 0，所以这里是 0%，但显式设一次更稳）
		syncRangeFill(els.progress, Number(els.progress.value) / 10)
	}

	if (els.play) els.play.addEventListener('click', () => void toggle())
	if (els.next) els.next.addEventListener('click', () => void playNext(false))
	if (els.prev) els.prev.addEventListener('click', () => void playPrev())
	if (els.mode) els.mode.addEventListener('click', cycleMode)
	/*
	 * ⚠️ 这里原来 wire 的是播放卡上的音量滑块。卡片化改造把两条滑块都去掉了
	 * （用户要求播放卡与详情页都没有音量），音量只剩「设置 › 播放」里那一条
	 * —— 它由 `settings-panel.js` 通过 `bbPlayer.setVolume()` 写入。
	 */

	// ── 正在播放卡片（同一组状态的第二触发点）──────────────────────
	// 按钮全部转调到底部播放条已经 wire 好的动作 —— 不在这里复制逻辑。
	if (els.npPlay) els.npPlay.addEventListener('click', () => void toggle())
	if (els.npNext)
		els.npNext.addEventListener('click', () => void playNext(false))
	if (els.npPrev) els.npPrev.addEventListener('click', () => void playPrev())
	if (els.npMode) els.npMode.addEventListener('click', cycleMode)
	if (els.npVolumeOpen) {
		// 详情页那颗音量图标按钮 → 去「设置 › 播放」那一行
		els.npVolumeOpen.addEventListener('click', () => {
			window.bbSettings?.switchCategory?.('playback')
		})
	}
	if (els.npProgress) {
		els.npProgress.addEventListener('input', () => {
			isNpScrubbing = true
			const duration = els.audio.duration
			syncRangeFill(els.npProgress, Number(els.npProgress.value) / 10)
			if (Number.isFinite(duration) && duration > 0) {
				const target = (Number(els.npProgress.value) / 1000) * duration
				if (els.npTimeCurrent)
					els.npTimeCurrent.textContent = formatTime(target)
			}
		})
		els.npProgress.addEventListener('change', () => {
			const duration = els.audio.duration
			if (Number.isFinite(duration) && duration > 0) {
				seekTo((Number(els.npProgress.value) / 1000) * duration)
			}
			isNpScrubbing = false
		})
		syncRangeFill(els.npProgress, Number(els.npProgress.value) / 10)
	}

	// ---------------------------------------------------------------
	// 对外接口
	// ---------------------------------------------------------------

	window.bbPlayer = {
		on,
		setQueue,
		playAt,
		play,
		pause,
		toggle,
		playNext,
		playPrev,
		seekTo,
		seekBy,
		/**
		 * 音量（0–100）。卡片化改造之后**这是唯一的实现**：
		 * 滑块只剩「设置 › 播放」一条，`Ctrl+←/→` 与它共用这里。
		 */
		setVolume,
		getVolume: () => Math.round(els.audio.volume * 100),
		cycleMode,
		/** 直接设定模式（确定性测试用；顺序循环用 cycleMode） */
		setMode,
		/** 插到「下一首播放」（不是追加到末尾） */
		playNextInsert,
		/** 队列重排（拖拽与键盘共用） */
		moveInQueue,
		/** 键盘重排：把当前项上移/下移一位 */
		nudgeCurrent,
		/** 随机播放的洗牌顺序（供自动化断言"每首恰好播一次"） */
		getShuffleOrder: () => state.shuffleOrder.slice(),
		getShufflePos: () => state.shufflePos,
		/** 刷新「正在播放」面板（阶段 4b） */
		refreshNowPlayingView,
		getQueue: () => state.queue.slice(),
		getIndex: () => state.index,
		getCurrent: () => state.queue[state.index] || null,
		getMode: () => state.mode,
		/** 当前模式的显示名与图标名（探针断言"四档都不同"用） */
		getModeLabel: () => MODE_LABEL[state.mode] ?? '',
		getModeIcon: () => MODE_ICON[state.mode] ?? '',
		/**
		 * **只看**自动/手动续播会落到哪个下标，不改任何状态、不播放。
		 *
		 * 有这个只读探针，断言才能在不发网络请求、不等音频的前提下验证四档语义
		 * （`playNext` 会真的换曲并 `play()`，在探针里代价太大）。
		 * 返回值与 `playNext()` 实际会用的完全一致 —— 两者共用 `nextIndex()`。
		 */
		peekNextIndex: (auto = false) => nextIndex(auto),
		getAudio: () => els.audio,
		describeError,
		bufferedRanges,
		counters,
		formatTime,
	}

	// ---------------------------------------------------------------
	// 自动化验证接口（保持与既有探针兼容）
	// ---------------------------------------------------------------

	const waitFor = (predicate, timeoutMs) =>
		new Promise((resolve) => {
			const start = Date.now()
			const tick = () => {
				let ok = false
				try {
					ok = Boolean(predicate())
				} catch {
					ok = false
				}
				if (ok) return resolve(true)
				if (Date.now() - start > timeoutMs) return resolve(false)
				setTimeout(tick, 100)
			}
			tick()
		})

	window.bbTest = {
		state() {
			const track = state.queue[state.index]
			return {
				readyState: els.audio.readyState,
				networkState: els.audio.networkState,
				duration: els.audio.duration,
				currentTime: els.audio.currentTime,
				paused: els.audio.paused,
				ended: els.audio.ended,
				src: els.audio.src,
				error: describeError(),
				buffered: bufferedRanges(),
				counters: { ...counters },
				mode: state.mode,
				queueLength: state.queue.length,
				queueIndex: state.index,
				resolved: track
					? {
							bvid: track.bvid,
							title: track.title,
							proxyUrl: proxyUrlFor(track),
						}
					: null,
				status: els.status ? els.status.textContent : '',
			}
		},

		/** 把一个 bvid 解析、加载并**开始播放**，验证代理链路 */
		async load(bvid) {
			counters.error = 0
			const resolved = await window.bbplayer.resolveAudio(bvid)
			if (!resolved.ok) return { ok: false, error: resolved.error }

			// 造一个临时队列，便于走统一的播放路径
			setQueue(
				[
					{
						bvid,
						title: resolved.data.title,
						artist: '',
						duration: resolved.data.duration,
					},
				],
				0,
			)
			playAt(0)

			const metaOk = await waitFor(() => els.audio.readyState >= 1, 15000)
			// 元数据就绪后开始播放：`load()` 的语义是「加载**并可播放**」，
			// 只 load 不 play 会让调用方以为已开始（实测踩过）。
			if (metaOk) await play()

			return {
				ok: metaOk,
				readyState: els.audio.readyState,
				duration: els.audio.duration,
				error: describeError(),
			}
		},

		async play() {
			await play()
			const ok = await waitFor(
				() => !els.audio.paused && els.audio.currentTime > 0,
				15000,
			)
			return {
				ok,
				currentTime: els.audio.currentTime,
				paused: els.audio.paused,
				error: describeError(),
			}
		},

		pause() {
			pause()
			return { paused: els.audio.paused }
		},

		async seek(seconds) {
			const before = els.audio.currentTime
			const seekedBefore = counters.seeked
			seekTo(seconds)
			const ok = await waitFor(() => counters.seeked > seekedBefore, 10000)
			return {
				ok,
				before,
				after: els.audio.currentTime,
				seekedEvents: counters.seeked - seekedBefore,
				error: describeError(),
			}
		},

		async advance(ms) {
			const start = els.audio.currentTime
			await new Promise((resolve) => setTimeout(resolve, ms))
			return {
				start,
				end: els.audio.currentTime,
				advanced: els.audio.currentTime - start,
			}
		},

		buttons() {
			return [...document.querySelectorAll('button')].map(
				(button) => button.textContent.trim() || button.title,
			)
		},

		log() {
			const el = document.getElementById('log')
			return el ? el.textContent : ''
		},

		/** 面板/视图的可见状态，供 UI 断言 */
		ui() {
			const visible = (selector) => {
				const el = document.querySelector(selector)
				if (!el) return false
				const rect = el.getBoundingClientRect()
				return rect.width > 0 && rect.height > 0
			}
			return {
				sidebar: visible('[data-testid="sidebar"]'),
				main: visible('[data-testid="main"]'),
				rightbar: visible('[data-testid="rightbar"]'),
				playbar: visible('[data-testid="playbar"]'),
				navItems: document.querySelectorAll('.nav__item').length,
				// ⚠️ 用**语义属性**而不是视觉类名来计数。
				// 侧栏歌单行原来叫 `.playlist-list__item`，阶段 1c 换成组件层的
				// `.list-row` 之后，这条断言就永远是 0 —— 探针会一直等一个
				// 永远不会满足的条件，表现为**整个套件卡死到超时**
				// （不是失败，是挂住，更难查）。
				// `data-playlist-id` 是行本身带的数据，与外观无关，改样式不会碰它。
				playlistItems: document.querySelectorAll('[data-playlist-id]').length,
				// ⚠️ 曲目列表的两种形态：整页卡片（`.track-card`）与内嵌表行。
				// 只认表格会让探针在"卡片刻"永远读到 0，表现为**整套挂到超时**。
				trackRows: document.querySelectorAll(
					'[data-testid^="track-row-"], .track-table tbody tr',
				).length,
				queueItems: document.querySelectorAll('[data-queue-index]').length,
				activePanel: document.querySelector('.panel.is-active')?.dataset.panel,
				activeView: document
					.querySelector('.nav__item.is-active')
					?.getAttribute('data-view'),
				viewTitle:
					document.querySelector('.pl-head__title, .view-head h2')
						?.textContent || '',
			}
		},
	}
})()
