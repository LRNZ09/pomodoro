import { expect, test } from 'bun:test'
import {
	type CheckIn,
	type Effect,
	initial,
	logged,
	MINUTE,
	type Settings,
	type State,
	step,
	type Timer,
	today,
} from './index'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * MINUTE
const SETTINGS = {
	workMinutes: 25,
	breakMinutes: 5,
	moveSeconds: 1,
	sound: true,
	checkIn: true,
	emoji: true,
}

// A tick each minute up to `minutes`, with the stored timer carried over as an agent does, and the system's idle time
// at each minute; the state at the end, and each minute's effects.
function ticks(
	minutes: number,
	idleMs: (minute: number) => number = () => 0,
	settings: Settings = SETTINGS,
) {
	let state = initial
	let timer: Timer = {}
	const effects: Effect[][] = []
	for (let m = 0; m <= minutes; m++) {
		const next = step(
			state,
			{ type: 'tick', now: T0 + m * MINUTE, timer, systemIdleMs: idleMs(m) },
			settings,
		)
		state = next.state
		for (const effect of next.effects)
			if (effect.type === 'persist') timer = effect.timer
		effects.push(next.effects)
	}
	return { state, effects }
}

const labels = (effects: Effect[]) =>
	effects.flatMap((effect) => (effect.type === 'show' ? [effect.label] : []))

test('alerts at the block end, then every break length while there is no break', () => {
	const { effects } = ticks(31)
	const alerted = effects.flatMap((at, minute) =>
		at.some((effect) => effect.type === 'alert') ? [minute] : [],
	)
	expect(alerted).toEqual([25, 30])
	expect(effects[25]).toContainEqual({
		type: 'alert',
		text: '25 minutes without a break. Stand up and look away from the screen for 5.',
		mark: '🍅 ',
		sound: true,
	})
	expect(effects[25]).toContainEqual({
		type: 'show',
		label: '🍅 25/25m',
		warning: '🍅 25m, time for a break',
	})
})

test('a break clears the check-in due', () => {
	expect(ticks(26).state.due?.key).toBe(T0 + 25 * MINUTE)
	const away = ticks(31, (minute) => Math.max(0, minute - 26) * MINUTE)
	expect(away.state.due).toBeUndefined()
	expect(labels(away.effects.at(-1) ?? [])).toEqual(['🍅 on a break'])
})

test('a gap with no tick starts a new block', () => {
	const after = (seenAgo: number) =>
		labels(
			step(
				initial,
				{
					type: 'tick',
					now: T0,
					timer: { blockStart: T0 - 20 * MINUTE, seenAt: T0 - seenAgo },
					systemIdleMs: 0,
				},
				SETTINGS,
			).effects,
		)
	expect(after(MINUTE)).toEqual(['🍅 20/25m'])
	expect(after(5 * MINUTE)).toEqual(['🍅 0/25m'])
})

test("a mouse jiggler's nudge doesn't count, a key counts at once, and a second of movement counts", () => {
	const seen = (lines: string[], settings: Settings = SETTINGS) =>
		lines.reduce(
			(state, line) => step(state, { type: 'input', line }, settings).state,
			initial,
		).lastInputThatCounts
	// The first line is the input before the watcher started.
	expect(seen(['1000', '61000', '61080'])).toBe(1000)
	expect(
		seen(['1000', '61000', '61080'], { ...SETTINGS, moveSeconds: 0 }),
	).toBe(61080)
	expect(seen(['1000', 'k61000'])).toBe(61000)
	expect(seen(['1000', '61000', '61500', '62000'])).toBe(62000)
	const ended = step(
		{ ...initial, lastInputThatCounts: 1000 },
		{ type: 'watcherEnded' },
		SETTINGS,
	)
	expect(ended.state.lastInputThatCounts).toBeUndefined()
})

test('one check-in per work period, on a main-loop tool result, held back for git, and forced in a headless run', () => {
	let state: State = ticks(26).state
	const toolResult = (isMain = true) => {
		const next = step(state, { type: 'toolResult', isMain }, SETTINGS)
		state = next.state
		return next.effects.map((effect) =>
			effect.type === 'checkIn' ? effect.key : effect.type,
		)
	}
	expect(toolResult(false)).toEqual([])
	expect(toolResult()).toEqual([T0 + 25 * MINUTE])
	expect(toolResult()).toEqual([])

	state = ticks(26).state
	expect(toolResult()).toEqual([T0 + 25 * MINUTE])
	state = step(
		state,
		{ type: 'checkInHeld', key: T0 + 25 * MINUTE },
		SETTINGS,
	).state
	expect(toolResult()).toEqual([T0 + 25 * MINUTE])
	// A hold that comes back after a later check-in was given leaves that one sent.
	state = step(state, { type: 'checkInHeld', key: 0 }, SETTINGS).state
	expect(toolResult()).toEqual([])

	state = step(
		initial,
		{ type: 'forceDue', afterToolResults: 3 },
		SETTINGS,
	).state
	expect([toolResult(false), toolResult(), toolResult(), toolResult()]).toEqual(
		[[], [], [], [0]],
	)
	expect(toolResult()).toEqual([])

	const off = { ...SETTINGS, checkIn: false }
	expect(ticks(26, () => 0, off).state.due).toBeUndefined()
	expect(
		step(initial, { type: 'forceDue', afterToolResults: 1 }, off).state
			.evalCheckInIn,
	).toBe(0)
})

test("the log drops entries 14 days old and cuts long answers, and today lists only today's, by repository", () => {
	const log: CheckIn[] = [
		{ at: T0 - 15 * DAY, repo: '/code/app', text: 'Old.' },
		{ at: T0 - 2 * DAY, repo: null, text: 'Two days ago.' },
	]
	const kept = logged(log, {
		at: T0,
		repo: '/code/app',
		text: 'x'.repeat(5_000),
	})
	expect(kept.map((c) => c.text.length)).toEqual([13, 4_000])
	expect(today([], T0)).toBe('No check-ins today.')
	expect(
		today(
			[...kept, { at: T0 + 1, repo: null, text: 'Line one.\nLine two.' }],
			T0,
		),
	).toMatch(
		/^app\n {2}\d\d:\d\d {2}x{4000}\n\nno repository\n {2}\d\d:\d\d {2}Line one\.\n {9}Line two\.$/,
	)
})
