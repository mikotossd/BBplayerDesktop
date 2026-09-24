/* oxlint-disable no-console -- 截图脚本，以 stdout 输出 */
/**
 * 重新生成 README 用的桌面端截图。
 *
 * 产出直接落在仓库的 `assets/screenshots/`（README 的「屏幕截图」表引用它），
 * 所以这个脚本是**幂等**的：再跑一次就是重新拍一遍。
 *
 * ```
 * node scripts/capture-readme-shots.mjs            # 浅色
 * node scripts/capture-readme-shots.mjs --dark     # 深色 -> assets/screenshots/dark/
 * ```
 *
 * ## 为什么要单独起一个 Electron 进程
 *
 * 截图必须靠 `webContents.capturePage()`，只能在主进程里做。
 * 这里只负责：① 开一个**全新的数据目录**（空库起点一致，不污染你正在用的库）；
 * ② 把 Electron 起来、传 `--readme-shots` 与输出目录；③ 汇报结果与退出码。
 * 真正的操作序列在 `apps/desktop/src/readme-shots-driver.cjs`。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUT_DIR = path.join(ROOT, 'assets', 'screenshots')
const DARK = process.argv.includes('--dark')

function electronBinary() {
	const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
	const match = fs
		.readdirSync(pnpmDir)
		.find((name) => name.startsWith('electron@'))
	if (!match) throw new Error('找不到 electron 包，先跑 pnpm install')
	return path.join(
		pnpmDir,
		match,
		'node_modules',
		'electron',
		'dist',
		'electron.exe',
	)
}

// 全新数据目录：保证"空库 -> 灌入真实数据"这条序列每次起点一致
const dataDir = path.join(os.tmpdir(), `bbplayer-readme-${Date.now()}`)
fs.mkdirSync(dataDir, { recursive: true })

const args = ['.', '--readme-shots']
if (DARK) args.push('--dark')

console.log(`README 截图（${DARK ? '深色' : '浅色'}）`)
console.log(`  输出：${DARK ? path.join(OUT_DIR, 'dark') : OUT_DIR}`)
console.log(`  数据目录：${dataDir}\n`)

const child = spawn(electronBinary(), args, {
	cwd: DESKTOP,
	env: {
		...process.env,
		BBPLAYER_DATA_DIR: dataDir,
		BBPLAYER_README_SHOT_DIR: OUT_DIR,
	},
	stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.on('data', (chunk) => process.stdout.write(String(chunk)))
child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)))

// 上限 8 分钟：序列里有两次真实搜索 + 一次歌词匹配
const timer = setTimeout(() => {
	console.error('\n⚠ 截图超时，强制结束')
	child.kill('SIGKILL')
}, 480_000)

child.on('close', (code) => {
	clearTimeout(timer)
	const manifest = path.join(
		DARK ? path.join(OUT_DIR, 'dark') : OUT_DIR,
		'manifest.json',
	)
	let shots = 0
	let problems = []
	if (fs.existsSync(manifest)) {
		const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
		shots = data.shots.length
		problems = data.problems ?? []
	}
	console.log(`\n截图 ${shots} 张，问题 ${problems.length} 条（exit=${code}）`)
	process.exit(code === 0 && problems.length === 0 ? 0 : 1)
})
