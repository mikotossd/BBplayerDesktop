/* oxlint-disable no-console -- CLI 脚本，以 stdout 为输出 */

import { createHash } from 'node:crypto'
/**
 * 把"已经抓下来的 HTTP 响应"按 URL 落进 build-icon-font.mjs 的缓存目录。
 *
 * 用途：受限环境里 Node 出不去网、但系统 HTTP 客户端可以（实测 Node 侧
 * `fetch failed` / `ETIMEDOUT`，PowerShell 的 `Invoke-WebRequest` 正常）。
 * 于是流程拆成两步：
 *
 *   1. `node scripts/build-icon-font.mjs --dry-run` 打印出 CSS URL，
 *      再用系统 HTTP 客户端把它抓成临时文件；
 *   2. 跑本脚本，把临时文件按 URL 搬进缓存目录；
 *   3. 从 CSS 里解析出 woff2 URL，重复第 1–2 步；
 *   4. `BB_ICON_FONT_HTTP_DIR=<缓存目录> node scripts/build-icon-font.mjs`
 *
 * 用法：
 *   node scripts/cache-http-response.mjs <缓存目录> <URL> <本地文件>
 *
 * 缓存路径规则与 build-icon-font.mjs 的 `cachePathFor()` **逐字对应**：
 *   `<dir>/<host>/<pathname>/<sha1(url)>.bin`
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** 与 build-icon-font.mjs 的 cachePathFor() 必须一致 */
function cachePathFor(dir, url) {
	const parsed = new URL(url)
	const digest = createHash('sha1').update(url).digest('hex')
	const sub = path.join(dir, parsed.host, parsed.pathname.replace(/^\//, ''))
	return path.join(sub, `${digest}.bin`)
}

const [cacheDir, url, sourceFile] = process.argv.slice(2)
if (!cacheDir || !url || !sourceFile) {
	console.error(
		'用法：node scripts/cache-http-response.mjs <缓存目录> <URL> <本地文件>',
	)
	process.exit(1)
}

const target = cachePathFor(path.resolve(cacheDir), url)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(path.resolve(sourceFile), target)
console.log(`  ✓ ${target}`)
