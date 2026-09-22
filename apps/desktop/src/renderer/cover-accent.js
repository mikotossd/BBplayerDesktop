/**
 * 从封面里取**主色**（卡片化阶段 4）。
 *
 * ## 为什么需要它
 *
 * 草图（播放详情页那一张）明确写着「背景模糊封面主色，**不要模糊**」——
 * 也就是原来那层"封面铺满 + `blur(64px)`"要换成**从封面算出来的一个颜色**。
 *
 * `packages/image-theme-colors` 在移动端是**原生模块**，桌面端没有对应实现
 * （渲染进程只有 Chromium 的能力）。所以这里用 Canvas 自己算 ——
 * 不需要任何依赖，也不需要主进程配合。
 *
 * ## 两步走，都不阻塞渲染
 *
 * 1. **降采样**：把封面画到 24×24（576 个像素），逐像素转 HSL，
 *    按"饱和度高 + 明度居中"加权投票选一个色相桶；取该色相桶的**平均
 *    饱和度/明度**，再夹到"能当背景"的区间。
 * 2. **失败回退**：跨域图（B 站封面是 `https:`，不带 CORS 头）会让 canvas
 *    被污染 —— `getImageData` 抛 `SecurityError`。那时**回退到 `--primary`**，
 *    并在元素上留 `data-accent="fallback"`，探针据此断言"确实降级了，
 *    而不是画出一个错误的颜色"。
 *
 * ⚠️ **绝不 await 阻塞**：封面解码是异步的，`refreshNowPlayingView()` 每次换曲
 * 都会调它。它自己内部异步算完再写变量，调用方拿到的永远是"当前值"。
 */
;(function () {
	'use strict'

	/** 采样边长：24×24 = 576 个像素足够代表一张封面的主色调 */
	const SAMPLE = 24
	/** 取样后每个色相桶的粒度（度）。15° 一桶 → 24 个桶 */
	const HUE_BUCKET = 15
	/** 低于这个饱和度的像素太"灰"，不参与主色投票 */
	const MIN_SATURATION = 0.12
	/** 取样时忽略过暗/过亮的像素（纯黑/纯白不代表封面配色） */
	const MIN_LIGHTNESS = 0.12
	const MAX_LIGHTNESS = 0.92

	/** 最近一次算出来的主色（`#RRGGBB`），供探针读取 */
	let lastAccent = null
	/** 同一个 src 只算一次（换曲才重算） */
	let lastSrc = null
	let pending = null

	function hslToHex(h, s, l) {
		const c = (1 - Math.abs(2 * l - 1)) * s
		const hp = (((h % 360) + 360) % 360) / 60
		const x = c * (1 - Math.abs((hp % 2) - 1))
		const [r1, g1, b1] =
			hp < 1
				? [c, x, 0]
				: hp < 2
					? [x, c, 0]
					: hp < 3
						? [0, c, x]
						: hp < 4
							? [0, x, c]
							: hp < 5
								? [x, 0, c]
								: [c, 0, x]
		const m = l - c / 2
		const to = (v) =>
			Math.round(Math.max(0, Math.min(255, (v + m) * 255)))
				.toString(16)
				.padStart(2, '0')
		return `#${to(r1)}${to(g1)}${to(b1)}`
	}

	/** RGB(0–255) → HSL（h 0–360，s/l 0–1） */
	function rgbToHsl(r, g, b) {
		const rn = r / 255
		const gn = g / 255
		const bn = b / 255
		const max = Math.max(rn, gn, bn)
		const min = Math.min(rn, gn, bn)
		const l = (max + min) / 2
		const d = max - min
		if (d === 0) return { h: 0, s: 0, l }
		const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
		let h
		if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
		else if (max === gn) h = ((bn - rn) / d + 2) * 60
		else h = ((rn - gn) / d + 4) * 60
		return { h, s, l }
	}

	/**
	 * 从像素数据里挑主色。
	 *
	 * 做法是**按色相投票**而不是"取平均色"：平均色会把互补的两块（比如
	 * 一半蓝一半橙）混成灰。按色相分桶之后取票数最高的那一桶，
	 * 再对该桶内的像素取平均饱和度/明度。
	 */
	function pickAccent(pixels) {
		const buckets = new Map()
		for (let i = 0; i < pixels.length; i += 4) {
			// 全透明像素跳过
			if (pixels[i + 3] < 128) continue
			const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2])
			if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) {
				continue
			}
			const key = Math.floor(h / HUE_BUCKET)
			const bucket = buckets.get(key) ?? { count: 0, s: 0 }
			bucket.count += 1
			// 饱和度参与加权：越鲜艳的像素对"主色"的贡献越大
			bucket.s += s * (0.5 + s)
			buckets.set(key, bucket)
		}
		if (buckets.size === 0) return null
		let best = null
		for (const [key, bucket] of buckets) {
			if (!best || bucket.count > best.bucket.count) {
				best = { key, bucket }
			}
		}
		const hue = best.key * HUE_BUCKET + HUE_BUCKET / 2
		// 归一：s 是加权和，要除以权重（这里用 count 近似，够用）
		const s = best.bucket.s / best.bucket.count
		/*
		 * 夹到"能当背景"的区间：
		 *   * 饱和度太低的封面（灰度图）取出来会是一片灰，稍微抬一点；
		 *   * 明度**固定 0.42**（深色一侧），这样不管封面是亮是暗，
		 *     背景都不会亮到让前景文字看不清。
		 * 具体强度再由 CSS 的 `opacity` 兜一层。
		 */
		return hslToHex(hue, Math.max(0.22, Math.min(0.55, s)), 0.42)
	}

	/**
	 * 异步算一张图的主色。
	 *
	 * ⚠️ 必须 `crossOrigin = 'anonymous'`：否则跨域封面会把 canvas 标记为污染，
	 * `getImageData` 直接抛 `SecurityError`。
	 * ⚠️ 有些图床**不带 CORS 头**，这时 `crossOrigin` 反而让图片**加载失败** ——
	 * 所以失败路径要干净地回退（返回 null），不是抛出去。
	 */
	async function computeAccent(url) {
		const image = new Image()
		image.crossOrigin = 'anonymous'
		image.decoding = 'async'
		await new Promise((resolve, reject) => {
			// ⚠️ 用 addEventListener 而不是 `image.onload = …`：
			// `Image` 是单次使用的临时对象，两种写法等价，但后者
			// 会被 lint 规则拦下（"on 属性会覆盖已注册的处理器"）。
			image.addEventListener('load', () => resolve(), { once: true })
			image.addEventListener('error', () => reject(new Error('封面加载失败')), {
				once: true,
			})
			image.src = url
		})
		const canvas = document.createElement('canvas')
		canvas.width = SAMPLE
		canvas.height = SAMPLE
		const ctx = canvas.getContext('2d', { willReadFrequently: true })
		if (!ctx) return null
		ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE)
		// 跨域未授权时这一行抛 SecurityError
		const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data
		return pickAccent(data)
	}

	/**
	 * 把主色写进 `--np-accent`（播放详情页的背景用它）。
	 *
	 * @param {string|null} coverUrl 当前封面（带 `bbplayer-cover://` 或 `https:`）
	 * @param {HTMLElement|null} background 承载背景的元素（`#nowplaying-bg`）
	 */
	async function apply(coverUrl, background) {
		if (!background) return null
		if (!coverUrl) {
			background.style.removeProperty('--np-accent')
			background.dataset.accent = 'none'
			lastAccent = null
			lastSrc = null
			return null
		}
		// 同一张封面不重算（换曲、切页都会调到这里）
		if (coverUrl === lastSrc && lastAccent) {
			background.style.setProperty('--np-accent', lastAccent)
			background.dataset.accent = 'cover'
			return lastAccent
		}
		// 并发保护：同一张封面同时被调两次时复用同一个 Promise
		if (pending && pending.src === coverUrl) return await pending.promise
		const promise = (async () => {
			try {
				const accent = await computeAccent(coverUrl)
				if (!accent) throw new Error('没有可用的主色')
				lastAccent = accent
				lastSrc = coverUrl
				background.style.setProperty('--np-accent', accent)
				background.dataset.accent = 'cover'
				return accent
			} catch {
				/*
				 * ⚠️ 回退**不是错误**：跨域封面拿不到像素是常态。
				 * 这里清掉 `--np-accent`，让 CSS 退回 `--primary` 的渐变，
				 * 并留一个 `data-accent="fallback"` 让探针能断言"确实降级了"。
				 */
				background.style.removeProperty('--np-accent')
				background.dataset.accent = 'fallback'
				lastAccent = null
				lastSrc = coverUrl
				return null
			}
		})()
		pending = { src: coverUrl, promise }
		const result = await promise
		pending = null
		return result
	}

	window.bbCoverAccent = {
		apply,
		/** 供探针读"当前算出来的主色"（没算出来时 null） */
		current: () => lastAccent,
		/** 纯函数的两个内部实现，探针可以单独验它们（不依赖真实图片） */
		_internal: { pickAccent, rgbToHsl, hslToHex, SAMPLE },
	}
})()
