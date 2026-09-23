/**
 * 渲染进程的极简状态层。
 *
 * 刻意不引框架：桌面端 UI 的重写成本主要在这里，保持轻量便于迭代。
 * 采用「单一 store + 订阅」模式，与移动端的 Zustand 思路一致。
 */
;(function () {
	'use strict'

	const listeners = new Set()

	const state = {
		/**
		 * 当前视图：`library | search | collection | playlist | favorites`
		 *
		 * ⚠️ `favorites` 是卡片化阶段 7 加的：收藏夹的曲目列表现在也走
		 * **整页曲目渲染器**（与歌单详情同一条路径）。不把它区分出来的话，
		 * `view` 会停在 `'playlist'` —— 于是页头会去建"歌单页头卡"、
		 * 显示上一个歌单的封面与首数，而**返回按钮指向歌单列表**。
		 */
		view: 'library',
		/** 左栏选中的歌单 id（null 表示未选） */
		selectedPlaylistId: null,
		/** 当前视图的曲目列表 */
		tracks: [],
		/** 当前视图标题 */
		title: '音乐库',
		/** 播放队列（由 player 维护） */
		queue: [],
		queueIndex: -1,
		/** 最近一次搜索关键词 */
		lastQuery: '',
	}

	function get() {
		return state
	}

	/** 合并式更新，并通知订阅者 */
	function set(patch) {
		let changed = false
		for (const key of Object.keys(patch)) {
			if (state[key] !== patch[key]) {
				state[key] = patch[key]
				changed = true
			}
		}
		if (changed) emit()
	}

	function subscribe(fn) {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}

	function emit() {
		for (const fn of listeners) {
			try {
				fn(state)
			} catch (error) {
				// 单个订阅者出错不应影响其他订阅者
				console.error('[state] 订阅者抛错:', error)
			}
		}
	}

	window.bbState = { get, set, subscribe }
})()
