import { expect, test } from 'bun:test'
import plugin from '../../packages/claude/.claude-plugin/plugin.json'
import {
	type CheckIn,
	DEFAULTS,
	type Effect,
	initial,
	logged,
	MINIMUM,
	MINUTE,
	type Settings,
	type State,
	settingsFrom,
	step,
	summary,
	type Timer,
	today,
} from './index'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * MINUTE
const SETTINGS = DEFAULTS

// Claude Code checks its settings against plugin.json, and both agents go through settingsFrom, which must agree.
test("plugin.json's defaults and minimums are settingsFrom's", () => {
	const fields = Object.entries(plugin.userConfig)
	expect(
		Object.fromEntries(fields.map(([key, f]) => [key, f.default])),
	).toEqual(DEFAULTS)
	expect(
		Object.fromEntries(
			fields.flatMap(([key, f]) => ('min' in f ? [[key, f.min]] : [])),
		),
	).toEqual(MINIMUM)
	expect(settingsFrom({})).toEqual(DEFAULTS)
	for (const [key, field] of fields)
		if ('min' in field) {
			expect(settingsFrom({ [key]: field.min })).toEqual({
				...DEFAULTS,
				[key]: field.min,
			})
			expect(settingsFrom({ [key]: field.min - 0.5 })).toEqual({
				problems: [`${key} must be at least ${field.min}`],
			})
		}
})

test('settingsFrom names every value of the wrong kind, takes an empty one as left out, and ignores keys it has no use for', () => {
	expect(
		settingsFrom({ workMinutes: '50', sound: 1, breakMinutes: 10 }),
	).toEqual({
		problems: ['workMinutes must be a number', 'sound must be a boolean'],
	})
	// JSON's 1e999.
	expect(settingsFrom({ breakMinutes: Infinity })).toEqual({
		problems: ['breakMinutes must be a number'],
	})
	for (const json of [[], null, 25])
		expect(settingsFrom(json)).toEqual({
			problems: ['the file must hold a JSON object'],
		})
	expect(settingsFrom({ breakMinutes: '', sound: '' })).toEqual(DEFAULTS)
	expect(settingsFrom({ breakMinutes: 10, theme: 'dark' })).toEqual({
		...DEFAULTS,
		breakMinutes: 10,
	})
})

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

test('one check-in per work period, on a main-loop tool result', () => {
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

	const off = { ...SETTINGS, checkIn: false }
	expect(ticks(26, () => 0, off).state.due).toBeUndefined()
})

test('the summary is the first paragraph that starts with Pomodoro:, and nothing else is', () => {
	expect(
		summary(
			'Ran the tests.\n\n**Pomodoro:** on the goal, the parser is next.\nTake a break.\n\n Pomodoro: again.',
		),
	).toBe('Pomodoro: on the goal, the parser is next.\nTake a break.')
	expect(summary('## Pomodoro check-in: done so far.')).toBe(
		'Pomodoro check-in: done so far.',
	)
	expect(summary('Done.\n\nThe pomodoro timer: unchanged.')).toBeUndefined()
	expect(summary('Fixed the Pomodoro: label.')).toBeUndefined()
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
