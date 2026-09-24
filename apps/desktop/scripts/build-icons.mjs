/* oxlint-disable no-console -- 构建脚本，以 stdout 输出 */
/**
 * 把应用图标放到 electron-builder 要找的位置（`build/icon.png`）。
 *
 * ## 图标是**上游的原始素材**，不是这里画出来的
 *
 * 第一版这个脚本是"用代码画一个图标"（M3 圆角方块 + 播放三角，用的还是
 * `thumbar-icons.cjs` 那个零依赖 PNG 编码器）。那是一张**看起来像默认
 * Electron 图标**的占位图，用户要求换成 BBPlayer 本来的图标。
 *
 * 品牌 mark 不该用代码画 —— 画出来的和真的就是两个东西。所以现在：
 *
 *   * **真图**随源码提交在 `assets/icon.png`（512×512、透明底），
 *     就是上游 [bbplayer-app/BBPlayer](https://github.com/bbplayer-app/BBPlayer)
 *     `apps/mobile/assets/images/icon_large.png` 那一张，**版权归原作者**；
 *   * 这个脚本只负责把它**校验 + 复制**到 `build/icon.png`
 *     （`build/` 是 gitignore 的，electron-builder 只认那里）。
 *
 * 于是 `assets/icon.png` 是唯一来源：README 的 logo 与三端图标产物都指向它，
 * 换图标就是换那一个文件，不会再出现"README 上一张、exe 里另一张"。
 *
 * ## 校验到什么程度（以及没校验什么）
 *
 * PNG 没有内置解码器，纯 Node 只能读文件头，所以这里能验的是：
 *   * magic 正确；
 *   * IHDR 里的尺寸**是正方形**且 ≥ 256（electron-builder 生成 `.ico`
 *     至少要 256×256）；
 *   * IHDR 的 color type 是 6（RGBA，**带 alpha 通道**）——
 *     任务栏在深色模式下是深色底，不带 alpha 的图会变成一个白/黑方块。
 *
 * ⚠️ **验不了"四个角真的是透明的"** —— 那要逐像素解码。这里的 color type
 * 检查只能保证"这张图**有** alpha 通道"，不保证它被用上了。别把这条读成
 * "透明度已确认"。
 *
 * 用法：node scripts/build-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUT_DIR = path.join(DESKTOP, 'build')

/** 唯一来源：上游的原始图标（随源码提交） */
const SOURCE_ICON = path.join(ROOT, 'assets', 'icon.png')
/** electron-builder 读的位置（`electron-builder.yml` 的 `win.icon` / `linux.icon`） */
const OUT_ICON = path.join(OUT_DIR, 'icon.png')

/** `.ico` 生成至少要 256×256；上游给的是 512×512 */
const MIN_SIZE = 256

/** PNG 的 color type：6 = RGBA（带 alpha），2 = RGB（不带） */
const COLOR_TYPE_RGBA = 6

function readIhdr(png) {
	const magicOk = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
	// IHDR 是第一个 chunk：8 字节签名 + 4 长度 + 4 类型，数据从 16 开始
	return {
		magicOk,
		width: png.readUInt32BE(16),
		height: png.readUInt32BE(20),
		bitDepth: png[24],
		colorType: png[25],
	}
}

function main() {
	if (!fs.existsSync(SOURCE_ICON)) {
		throw new Error(
			`找不到图标源文件：${SOURCE_ICON}\n` +
				'它是上游 BBPlayer 的原始图标（apps/mobile/assets/images/icon_large.png），' +
				'随源码提交。可从上游取回：\n' +
				'  https://raw.githubusercontent.com/bbplayer-app/BBPlayer/dev/apps/mobile/assets/images/icon_large.png',
		)
	}

	const png = fs.readFileSync(SOURCE_ICON)
	const { magicOk, width, height, bitDepth, colorType } = readIhdr(png)

	if (!magicOk) throw new Error(`${SOURCE_ICON} 不是 PNG（magic 不对）`)
	if (width !== height) {
		throw new Error(`图标必须是正方形，实际 ${width}x${height}`)
	}
	if (width < MIN_SIZE) {
		throw new Error(
			`图标太小：${width}x${height}，至少要 ${MIN_SIZE}x${MIN_SIZE}（生成 .ico 的要求）`,
		)
	}
	if (colorType !== COLOR_TYPE_RGBA) {
		throw new Error(
			`图标的 color type 是 ${colorType}，不是 ${COLOR_TYPE_RGBA}（RGBA）—— ` +
				'没有 alpha 通道的图在深色任务栏上会是一个方块',
		)
	}

	fs.mkdirSync(OUT_DIR, { recursive: true })
	// 字节级复制：不重新编码，避免 README 的 logo 与 exe 里的图标出现差异
	fs.writeFileSync(OUT_ICON, png)

	// 复制之后再看一眼目标真的是我们要的那份字节
	const copied = fs.readFileSync(OUT_ICON)
	if (!copied.equals(png)) {
		throw new Error(`复制到 ${OUT_ICON} 之后字节不一致`)
	}

	console.log('=== 应用图标 ===\n')
	console.log(`  ✓ 源：${SOURCE_ICON}`)
	console.log(
		`  ✓ 出：${OUT_ICON}（${width}x${height}，${bitDepth} 位，RGBA，` +
			`${(png.length / 1024).toFixed(1)} KB）`,
	)
	console.log(
		'\nelectron-builder 会用它生成 Windows 的 .ico 与 Linux 的多尺寸 PNG；' +
			'\n主进程也直接加载它当窗口图标（见 main.cjs 的 `icon`）。',
	)
}

main()
