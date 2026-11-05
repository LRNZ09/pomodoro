import { expect, test } from 'bun:test'
import plugin from '../../packages/claude/.claude-plugin/plugin.json'
import {
	banner,
	CHIME,
	type CheckIn,
	createInstance,
	DEFAULTS,
	type Host,
	IOREG,
	MINIMUM,
	MINUTE,
	type Settings,
	settingsFrom,
} from './index'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * MINUTE

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

test("the banner's AppleScript keeps quotes and backslashes as text", () => {
	expect(banner('Say "hi" \\o/')).toEqual([
		'osascript',
		'-e',
		'display notification "Say \\"hi\\" \\\\o/" with title "Pomodoro"',
	])
})

type Pending = { at: number; every?: number; fn: () => void }

// An agent in memory: a clock at T0, the store (open to the test, which ages it to stand for a stretch with no tick),
// ioreg reporting `idle(now)` (null: no ioreg), a watcher the test prints through, a repository at /code/app, the
// agent's own alert answering `notify()`, and what the host was asked to do.
function world({
	idle = () => 0,
	notify = async () => true,
	seed = {},
}: {
	idle?: (now: number) => number | null
	notify?: () => Promise<boolean>
	seed?: Record<string, unknown>
} = {}) {
	let now = T0
	// A Set iterates in the order of adding, so of two timers due at once the one set first fires first.
	const timers = new Set<Pending>()
	const schedule = (pending: Pending) => {
		timers.add(pending)
		return () => void timers.delete(pending)
	}
	const store: Record<string, unknown> = { ...seed }
	const runs: (readonly string[])[] = []
	const shows: { label: string; warning?: string }[] = []
	const notified: string[] = []
	const keeps: number[] = []
	const spawned: (readonly string[])[] = []
	let kills = 0
	let watcher: { onOutput: (text: string) => void; onEnd: () => void }
	const host: Host = {
		now: async () => now,
		after: (ms, fn) => schedule({ at: now + ms, fn }),
		every: (ms, fn) => schedule({ at: now + ms, every: ms, fn }),
		load: async (key) => store[key],
		save: async (key, value) => {
			store[key] = value
		},
		run: async (argv) => {
			runs.push(argv)
			if (argv[0] !== 'ioreg') return ''
			const ms = idle(now)
			if (ms === null) throw new Error('no ioreg')
			// Indented, as ioreg prints it.
			return `    |   "HIDIdleTime" = ${ms * 1e6}\n`
		},
		spawn: (argv, onOutput, onEnd) => {
			spawned.push(argv)
			watcher = { onOutput, onEnd }
			return () => {
				kills++
			}
		},
		repo: async () => '/code/app',
		show: (label, warning) => {
			shows.push({ label, warning })
		},
		notify: (text, mark) => {
			notified.push(`${mark}${text}`)
			return notify()
		},
		keep: (kept) => {
			keeps.push(kept)
		},
	}

	// Moves the clock to `to`, firing each timer due on the way at its own time. Every call to the host resolves at
	// once, so what a timer started (a tick) is done by the next turn of the event loop.
	async function set(to: number) {
		for (;;) {
			await new Promise((resolve) => setImmediate(resolve))
			let next: Pending | undefined
			for (const pending of timers)
				if (pending.at <= to && (next === undefined || pending.at < next.at))
					next = pending
			if (next === undefined) break
			now = next.at
			timers.delete(next)
			if (next.every !== undefined) {
				next.at += next.every
				timers.add(next)
			}
			next.fn()
		}
		now = to
	}

	return {
		host,
		store,
		runs,
		shows,
		notified,
		keeps,
		spawned,
		kills: () => kills,
		now: () => now,
		set,
		advance: (ms: number) => set(now + ms),
		settle: () => set(now),
		pending: () => timers.size,
		label: () => shows.at(-1)?.label,
		// The watcher prints each [time, text] at its time, then ends at `endsAt`.
		watch(pieces: [number, string][], endsAt?: number) {
			for (const [at, text] of pieces)
				schedule({ at, fn: () => watcher.onOutput(text) })
			if (endsAt !== undefined)
				schedule({ at: endsAt, fn: () => watcher.onEnd() })
		},
	}
}

type World = ReturnType<typeof world>

// An instance on the world's host, started as in a terminal session.
function start(
	w: World,
	settings: Partial<Settings> = {},
	options: { remote?: boolean; kept?: unknown } = {},
) {
	const pomodoro = createInstance(w.host, {
		settings: { ...DEFAULTS, ...settings },
		remote: false,
		...options,
	})
	pomodoro.start()
	return pomodoro
}

// The chimes and banners the alerts ran.
const sounds = (w: World) => w.runs.filter((argv) => argv[0] !== 'ioreg')

const texts = (checkIns: unknown) => (checkIns as CheckIn[]).map((c) => c.text)

// An instance 26 minutes into a block, which has given its check-in.
async function checkedIn(w: World) {
	const pomodoro = start(w)
	await w.advance(26 * MINUTE)
	expect(pomodoro.toolResult(true)).toBeDefined()
	return pomodoro
}

test('alerts at the block end, then every break length while there is no break', async () => {
	const w = world()
	start(w)
	await w.advance(24 * MINUTE)
	expect(w.notified).toEqual([])
	await w.advance(MINUTE)
	expect(w.shows.at(-1)).toEqual({
		label: '🍅 25/25m',
		warning: '🍅 25m, time for a break',
	})
	await w.advance(5 * MINUTE)
	expect(w.notified).toEqual([
		'🍅 25 minutes without a break. Stand up and look away from the screen for 5.',
		'🍅 30 minutes without a break. Stand up and look away from the screen for 5.',
	])
	// Ghostty shows the banner of the tab in front for a few seconds only, and a Focus silences it: each alert also chimes.
	expect(sounds(w)).toEqual([CHIME, CHIME])
})

test("the osascript banner comes after the chime only when the agent's own alert raised none or failed", async () => {
	const text =
		'25 minutes without a break. Stand up and look away from the screen for 5.'
	const ran = async (
		notify: () => Promise<boolean>,
		settings: Partial<Settings> = {},
	) => {
		const w = world({ notify })
		start(w, settings)
		await w.advance(25 * MINUTE)
		expect(w.notified).toEqual([`🍅 ${text}`])
		return sounds(w)
	}
	expect(await ran(async () => true)).toEqual([CHIME])
	expect(await ran(async () => false)).toEqual([CHIME, banner(text)])
	expect(await ran(() => Promise.reject(new Error('no terminal')))).toEqual([
		CHIME,
		banner(text),
	])
	expect(await ran(async () => false, { sound: false })).toEqual([banner(text)])
})

test('no chime when turned off', async () => {
	const w = world()
	start(w, { sound: false })
	await w.advance(25 * MINUTE)
	expect(w.notified.length).toBe(1)
	expect(sounds(w)).toEqual([])
})

test('a closed lid clears the status line: the block that starts on waking is not due', async () => {
	const w = world()
	start(w)
	await w.advance(25 * MINUTE)
	expect(w.shows.at(-1)?.warning).toBe('🍅 25m, time for a break')

	// Asleep for 10 minutes, so no tick ran, and the keyboard was touched on waking.
	w.store.timer = {
		...(w.store.timer as object),
		seenAt: w.now() - 10 * MINUTE,
	}
	await w.advance(MINUTE)
	expect(w.shows.at(-1)).toEqual({ label: '🍅 0/25m', warning: undefined })
})

test('a break of just the break length counts, and no alert comes during it', async () => {
	const leftAt = T0 + 25 * MINUTE + 10_000
	const backAt = leftAt + 5 * MINUTE + 5_000
	const w = world({
		idle: (now) => (now >= leftAt && now < backAt ? now - leftAt : 0),
	})
	start(w)
	await w.advance(25 * MINUTE)
	expect(w.notified.length).toBe(1)

	await w.set(leftAt + 5 * MINUTE + 2_000)
	expect(w.label()).toBe('🍅 on a break')
	expect(w.notified.length).toBe(1)

	// Back at work: a fresh block, alerting 25 minutes after its first tick.
	await w.set(T0 + 31 * MINUTE)
	expect(w.label()).toBe('🍅 0/25m')
	await w.advance(24 * MINUTE)
	expect(w.notified.length).toBe(1)
	await w.advance(MINUTE)
	expect(w.notified.length).toBe(2)
})

test('a gap with no tick (sleep, no session open) counts as a break', async () => {
	// The last tick a minute before keeps the block; one a break's length before is a gap.
	for (const [seenAgo, label] of [
		[MINUTE, '🍅 20/25m'],
		[5 * MINUTE, '🍅 0/25m'],
	] as const) {
		const w = world({
			seed: { timer: { blockStart: T0 - 20 * MINUTE, seenAt: T0 - seenAgo } },
		})
		start(w)
		await w.settle()
		expect(w.label()).toBe(label)
	}

	const w = world({
		seed: {
			timer: { blockStart: T0 - 180 * MINUTE, seenAt: T0 - 60 * MINUTE },
		},
	})
	start(w)
	await w.advance(MINUTE)
	expect(w.notified.length).toBe(0)
	await w.advance(24 * MINUTE)
	expect(w.notified.length).toBe(1)
})

test('short settings still alert: 3-minute blocks, 1-minute breaks', async () => {
	const w = world()
	start(w, { workMinutes: 3, breakMinutes: 1 })
	await w.advance(3 * MINUTE)
	expect(w.notified).toEqual([
		'🍅 3 minutes without a break. Stand up and look away from the screen for 1.',
	])
})

// With 1-minute breaks every tick asks for a wake. With input half a second before each tick, the next minute's tick
// comes before that wake and replaces it, so only the minute's ticks run.
test("one wake is pending at most: with 1-minute breaks the ticks don't pile up while the person works", async () => {
	const w = world({ idle: () => 500 })
	start(w, { breakMinutes: 1 })
	await w.settle()
	const before = w.shows.length
	await w.advance(10 * MINUTE)
	expect(w.shows.length - before).toBe(10)
	// The minute's clock and one wake.
	expect(w.pending()).toBe(2)
})

test('stop cancels the clock and the wake and ends the watcher, and no tick runs after it', async () => {
	const w = world({ idle: () => 500 })
	const pomodoro = start(w, { breakMinutes: 1 })
	await w.settle()
	expect(w.pending()).toBe(2)
	pomodoro.stop()
	expect(w.kills()).toBe(1)
	expect(w.pending()).toBe(0)
	const [shown, ran] = [w.shows.length, w.runs.length]
	await w.advance(10 * MINUTE)
	expect([w.shows.length, w.runs.length]).toEqual([shown, ran])

	// Stopped while its first tick is under way: that tick carries out nothing, so a session that took its place doesn't
	// see its count.
	const early = world({ idle: () => 500 })
	start(early, { breakMinutes: 1 }).stop()
	await early.advance(10 * MINUTE)
	expect(early.shows.length).toBe(0)
	expect(early.store.timer).toBeUndefined()
	expect(early.pending()).toBe(0)
})

test('over SSH no watcher starts and ioreg never runs: activity stands in', async () => {
	const w = world()
	const pomodoro = start(w, {}, { remote: true })
	await w.settle()
	await pomodoro.activity()
	await w.advance(MINUTE)
	expect(w.spawned).toEqual([])
	expect(w.runs).toEqual([])
	// No activity before the first tick: nothing to say the person was there.
	expect(w.shows.map((show) => show.label)).toEqual([
		'🍅 on a break',
		'🍅 0/25m',
	])
})

test('no check-in when turned off', async () => {
	const w = world()
	const pomodoro = start(w, { checkIn: false })
	await w.advance(26 * MINUTE)
	expect(w.notified.length).toBe(1)
	expect(pomodoro.toolResult(true)).toBeUndefined()
})

test("one check-in per block, on a main-loop tool result, kept so that a reloaded instance gives only the next block's", async () => {
	const w = world()
	const pomodoro = start(w)
	await w.advance(26 * MINUTE)
	expect(pomodoro.toolResult(false)).toBeUndefined()
	expect(pomodoro.toolResult(true)).toStartWith(
		'[Pomodoro] The user has been working for 26 minutes without a break.',
	)
	expect(pomodoro.toolResult(true)).toBeUndefined()
	expect(w.keeps).toEqual([T0 + 25 * MINUTE])

	// A reload (a /config change): the session's next instance gets what this one kept.
	pomodoro.stop()
	const reloaded = start(w, {}, { kept: w.keeps[0] })
	await w.settle()
	expect(reloaded.toolResult(true)).toBeUndefined()
	await w.advance(25 * MINUTE)
	expect(reloaded.toolResult(true)).toStartWith(
		'[Pomodoro] The user has been working for 51 minutes without a break.',
	)
	expect(w.keeps).toEqual([T0 + 25 * MINUTE, T0 + 50 * MINUTE])
})

test('a break clears the check-in due', async () => {
	let leftAt = Infinity
	const w = world({ idle: (now) => (now >= leftAt ? now - leftAt : 0) })
	const pomodoro = start(w)
	await w.advance(26 * MINUTE)
	leftAt = w.now()
	await w.advance(6 * MINUTE)
	expect(w.label()).toBe('🍅 on a break')
	expect(pomodoro.toolResult(true)).toBeUndefined()
})

test("the check-in's summary is logged from the first reply that has one, until the turn ends", async () => {
	const w = world()
	const pomodoro = start(w)
	// No summary is awaited before the check-in.
	await pomodoro.reply('Pomodoro: early.')
	await w.advance(26 * MINUTE)
	expect(pomodoro.toolResult(true)).toBeDefined()
	await pomodoro.reply('Wrote a.txt.')
	await pomodoro.reply('Done.\n\nPomodoro: on the goal.')
	await pomodoro.reply('Pomodoro: again.')
	// Only the tool result that carries the check-in starts a wait.
	expect(pomodoro.toolResult(true)).toBeUndefined()
	await pomodoro.reply('Pomodoro: after another tool result.')
	expect(w.store.checkIns).toEqual([
		{ at: T0 + 26 * MINUTE, repo: '/code/app', text: 'Pomodoro: on the goal.' },
	])

	// The next block's check-in, in a turn that ends without its summary.
	await w.advance(25 * MINUTE)
	expect(pomodoro.toolResult(true)).toBeDefined()
	pomodoro.turnEnded()
	await pomodoro.reply('Pomodoro: the next turn.')
	expect(texts(w.store.checkIns)).toEqual(['Pomodoro: on the goal.'])
})

test('the summary is the first paragraph that starts with Pomodoro:, and nothing else is', async () => {
	const w = world()
	const pomodoro = await checkedIn(w)
	await pomodoro.reply('Done.\n\nThe pomodoro timer: unchanged.')
	await pomodoro.reply('Fixed the Pomodoro: label.')
	await pomodoro.reply(
		'Ran the tests.\n\n**Pomodoro:** on the goal, the parser is next.\nTake a break.\n\n Pomodoro: again.',
	)
	await w.advance(25 * MINUTE)
	expect(pomodoro.toolResult(true)).toBeDefined()
	await pomodoro.reply('## Pomodoro check-in: done so far.')
	expect(texts(w.store.checkIns)).toEqual([
		'Pomodoro: on the goal, the parser is next.\nTake a break.',
		'Pomodoro check-in: done so far.',
	])
})

test('a long summary is cut to 4,000 characters', async () => {
	const w = world()
	const pomodoro = await checkedIn(w)
	await pomodoro.reply(`Pomodoro: ${'x'.repeat(5_000)}`)
	expect(texts(w.store.checkIns)).toEqual([`Pomodoro: ${'x'.repeat(3_990)}`])
})

test("check-ins older than 14 days are dropped, and /pomodoro today lists only today's", async () => {
	const w = world({
		seed: {
			checkIns: [
				{ at: T0 - 14 * DAY, repo: '/code/app', text: 'Old.' },
				{ at: T0 - 2 * DAY, repo: null, text: 'Two days ago.' },
			],
		},
	})
	const pomodoro = await checkedIn(w)
	await pomodoro.reply('Pomodoro: today.')
	expect(texts(w.store.checkIns)).toEqual(['Two days ago.', 'Pomodoro: today.'])
	expect(await pomodoro.command('today')).toMatch(
		/^app\n {2}\d\d:\d\d {2}Pomodoro: today\.$/,
	)
})

test("/pomodoro lists today's check-ins by repository, and gives its usage for anything but today", async () => {
	const w = world()
	const pomodoro = start(w)
	for (const args of ['', ' today '])
		expect(await pomodoro.command(args)).toBe('No check-ins today.')
	w.store.checkIns = [
		{ at: T0 - 2 * DAY, repo: null, text: 'Two days ago.' },
		{ at: T0, repo: '/code/app', text: 'Pomodoro: on the goal.' },
		{ at: T0 + 1, repo: null, text: 'Line one.\nLine two.' },
	]
	for (const args of ['', ' today '])
		expect(await pomodoro.command(args)).toMatch(
			/^app\n {2}\d\d:\d\d {2}Pomodoro: on the goal\.\n\nno repository\n {2}\d\d:\d\d {2}Line one\.\n {9}Line two\.$/,
		)
	expect(await pomodoro.command('yesterday')).toBe('Usage: /pomodoro [today]')
})

// Mouse movement the watcher saw at each time; a key, click or scroll comes with its `k` line too.
const moves = (times: number[]) =>
	times.map((at): [number, string] => [at, `${at}\n`])
const keys = (times: number[]) =>
	times.map((at): [number, string] => [at, `${at}\nk${at}\n`])

// Work until 29 minutes in (2 seconds of movement every 20, seen 4 times a second), away for 11, back at 40.
// A mouse jiggler nudges every minute all along: two events 80 ms apart.
const jiggledDay = () => {
	const stretch = (from: number) =>
		Array.from({ length: 9 }, (_, i) => from + i * 250)
	const work = Array.from({ length: 87 }, (_, i) => T0 + 5_000 + i * 20_000)
	const nudges = Array.from({ length: 50 }, (_, i) => T0 + i * MINUTE + 12_000)
	return moves(
		[
			...work.flatMap(stretch),
			...nudges.flatMap((at) => [at, at + 80]),
			...stretch(T0 + 40 * MINUTE + 10_000),
		].sort((a, b) => a - b),
	)
}

test("a mouse jiggler's nudge doesn't keep a break from starting", async () => {
	const w = world()
	w.watch(jiggledDay())
	start(w)
	await w.set(T0 + 35 * MINUTE)
	expect(w.label()).toBe('🍅 on a break')

	await w.set(T0 + 41 * MINUTE)
	expect(w.label()).toBe('🍅 0/25m')
})

test('with moveSeconds 0, every movement counts, the nudge included', async () => {
	const w = world()
	w.watch(jiggledDay())
	start(w, { moveSeconds: 0 })
	await w.set(T0 + 35 * MINUTE)
	expect(w.label()).toBe('🍅 35/25m')
})

test('mouse movement counts once it lasts moveSeconds, not before', async () => {
	// The input before the watcher started, a second in, then a stretch of movement a minute in: 1 s, or just under.
	const after = async (stretch: number[]) => {
		const w = world()
		w.watch(moves([T0 + 1_000, ...stretch]))
		start(w)
		await w.set(T0 + 6 * MINUTE)
		return w.label()
	}
	expect(await after([T0 + 61_000, T0 + 61_500, T0 + 62_000])).toBe('🍅 6/25m')
	expect(await after([T0 + 61_000, T0 + 61_500, T0 + 61_999])).toBe(
		'🍅 on a break',
	)
})

test('a lone key, click or scroll counts at once', async () => {
	const w = world()
	// One press every 30 seconds, as when answering the agent's prompts or paging through a diff.
	w.watch(keys(Array.from({ length: 16 }, (_, i) => T0 + (i + 1) * 30_000)))
	start(w)
	await w.set(T0 + 8 * MINUTE)
	expect(w.label()).toBe('🍅 8/25m')
})

test('a watcher line split across two output pieces counts once, as one whole line', async () => {
	const w = world()
	// Movement a second in, then a key 3 minutes in, whose line comes in two pieces.
	const key = `k${T0 + 3 * MINUTE}\n`
	w.watch([
		[T0 + 1_000, `${T0 + 1_000}\n`],
		[T0 + 3 * MINUTE, key.slice(0, 6)],
		[T0 + 3 * MINUTE + 1, key.slice(6)],
	])
	start(w)
	await w.set(T0 + 7 * MINUTE)
	expect(w.label()).toBe('🍅 7/25m')
})

test("a reload while the person is away doesn't end their break", async () => {
	// 26 minutes into a block, last input 4 minutes ago: the watcher's first line says so, as ioreg does.
	const leftAt = T0 - 4 * MINUTE
	const w = world({
		idle: (now) => now - leftAt,
		seed: {
			timer: {
				blockStart: T0 - 26 * MINUTE,
				seenAt: T0 - 30_000,
				lastInput: leftAt,
			},
		},
	})
	w.watch([[T0 + 100, `${leftAt}\n`]])
	start(w)
	await w.set(T0 + 2 * MINUTE)
	expect(w.label()).toBe('🍅 on a break')
	// From the watcher's first line on, it's gone by, not ioreg.
	expect(w.runs).toEqual([IOREG])
})

test('when the watcher ends, ioreg stands in', async () => {
	const w = world()
	w.watch([[T0 + 1_000, `${T0 + 1_000}\n`]], T0 + 1_000)
	start(w)
	await w.set(T0 + 10 * MINUTE)
	expect(w.label()).toBe('🍅 10/25m')
})

test('without ioreg, a break is a break from every session', async () => {
	// Another session was in use 10 seconds ago, 20 minutes into a block: a fresh session keeps that block.
	const w = world({
		idle: () => null,
		seed: {
			timer: {
				blockStart: T0 - 20 * MINUTE,
				seenAt: T0 - 30_000,
				lastInput: T0 - 10_000,
			},
		},
	})
	const pomodoro = start(w)
	await w.settle()
	expect(w.label()).toBe('🍅 20/25m')

	for (let i = 0; i < 5; i++) {
		await pomodoro.activity()
		await w.advance(MINUTE)
	}
	expect(w.notified.length).toBe(1)

	await w.advance(6 * MINUTE)
	expect(w.label()).toBe('🍅 on a break')
})
