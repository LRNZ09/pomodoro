import type { On, UiNotifyResult } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const T0 = 1_700_000_000_000
const MIN = 60_000

const SENT: UiNotifyResult = { isSent: true, channel: 'ghostty' }

// The engine beneath the mod: a clock, a store, ioreg reporting `idle(now)` (null: no ioreg), the terminal's
// answer to a notification, and recorders. `notified` holds every banner, `viaOsascript` those osascript posted,
// `labels` each count written for the prompt footer.
const world = (
	on: On,
	idle: (now: number) => number | null,
	seed?: Record<string, unknown>,
	notify: UiNotifyResult = SENT,
) => {
	const clock = mock.clock(on, { now: T0 })
	// The mod's store, open to the test, which ages it to stand for a stretch with no tick.
	const store: Record<string, unknown> = { ...seed }
	on('store.get', (_, e) => ({ value: store[e.key] }))
	on('store.set', (_, e) => {
		store[e.key] = e.value
		return { value: undefined }
	})
	mock.env(on, {})
	const session = mock.session(on)
	const notified: string[] = []
	const viaOsascript: string[] = []
	const status: (string | undefined)[] = []
	const labels: string[] = []
	const chimes: number[] = []
	on('session.start', (_, e) => ({ cwd: e.cwd }))
	on('tool.call', () => ({ result: {} }))
	on('process.run', (_, e) => {
		if (e.argv[0] === 'afplay') chimes.push(clock.now())
		if (e.argv[0] === 'osascript') {
			const text =
				e.argv[2]?.match(/display notification "(.*)" with title/)?.[1] ?? ''
			notified.push(text)
			viaOsascript.push(text)
		}
		const ms = idle(clock.now())
		return {
			value: {
				exitCode: ms === null ? 1 : 0,
				stdout: ms === null ? '' : `"HIDIdleTime" = ${ms * 1e6}`,
				stderr: '',
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		}
	})
	on('ui.notify', (_, e) => {
		if (notify.isSent) notified.push(e.text)
		return { value: notify }
	})
	const toasts: string[] = []
	on('ui.toast', (_, e) => {
		toasts.push(e.text)
		return { value: undefined }
	})
	on('ui.status', (_, e) => {
		status.push(e.text)
		return { value: undefined }
	})
	on('state.set', { plugin: 'pomodoro', key: 'label' }, (_, e, next) => {
		labels.push(e.value)
		return next(e)
	})
	return {
		clock,
		store,
		session,
		notified,
		viaOsascript,
		status,
		labels,
		toasts,
		chimes,
	}
}

const start = ($: Engine) =>
	$.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

// A tool call of the main loop; true when the check-in came back with its result.
const checked = async ($: Engine) =>
	JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ls' })).includes(
		'[Pomodoro]',
	)

test('alerts at the block end, then every break length while there is no break', async ($, on) => {
	const { clock, notified, chimes } = world(on, () => 0)
	await start($)
	await clock.advance(24 * MIN)
	expect(notified.length).toBe(0)
	await clock.advance(MIN)
	expect(notified).toEqual([
		'25 minutes without a break. Stand up and look away from the screen for 5.',
	])
	await clock.advance(5 * MIN)
	expect(notified.length).toBe(2)
	// Ghostty shows the banner of the tab in front for a few seconds only, and a Focus silences it: each alert also chimes.
	expect(chimes.length).toBe(2)
})

test('the count is a mode label in the prompt footer', async ($, on) => {
	const { clock } = world(on, () => 0)
	// Stands for the engine drawing the footer's labels.
	on('ui.render', { component: 'SessionMode' }, ($, e) => {
		const { Text } = $.ui.resolve(e)
		return <Text>{e.props.modes.join(' & ')}</Text>
	})
	await start($)
	await clock.settle()

	const ui = await $.ui.mount({
		plugin: 'pomodoro',
		surface: 'terminal',
		component: 'SessionMode',
		props: { modes: ['focus'] },
	})
	expect((await ui.find({ type: 'Text', text: /🍅/ }))?.text).toBe(
		'focus & 🍅 0/25m',
	)
	await clock.advance(MIN)
	expect((await ui.find({ type: 'Text', text: /🍅/ }))?.text).toBe(
		'focus & 🍅 1/25m',
	)
	await ui.unmount()
})

test('the status line, which Claude Code marks ⚠, shows only while a break is due', async ($, on) => {
	let leftAt = Infinity
	const { clock, status } = world(on, (now) =>
		now >= leftAt ? now - leftAt : 0,
	)
	await start($)
	await clock.advance(24 * MIN)
	expect(status.filter((text) => text !== undefined)).toEqual([])
	await clock.advance(MIN)
	expect(status.at(-1)).toBe('🍅 25m, time for a break')

	leftAt = clock.now()
	await clock.advance(6 * MIN)
	expect(status.at(-1)).toBe(undefined)
})

test('a session with nobody at its prompt never counts: -p, VS Code, the desktop app', async ($, on) => {
	const { clock, labels } = world(on, () => 0)
	on('session.attach', (_, e) => ({ clientId: e.clientId }))
	await $.session.start({ cwd: '/', surface: null, isInteractive: false })
	await clock.advance(2 * MIN)
	expect(labels).toEqual([])

	// VS Code and the desktop app attach to a session that started headless; neither starts the clock.
	await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
	await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
	await clock.advance(MIN)
	expect(labels).toEqual([])
})

test('a closed lid clears the status line: the block that starts on waking is not due', async ($, on) => {
	const { clock, store, status, labels } = world(on, () => 0)
	await start($)
	await clock.advance(25 * MIN)
	expect(status.at(-1)).toBe('🍅 25m, time for a break')

	// Asleep for 10 minutes, so no tick ran, and the keyboard was touched on waking.
	store.timer = { ...(store.timer as object), seenAt: clock.now() - 10 * MIN }
	await clock.advance(MIN)
	expect(status.at(-1)).toBe(undefined)
	expect(labels.at(-1)).toBe('🍅 0/25m')
})

test('the banner goes through the terminal, osascript only where the terminal cannot raise one', async ($, on) => {
	const { clock, notified, viaOsascript } = world(on, () => 0, undefined, {
		isSent: false,
		reason: 'no-channel',
	})
	await start($)
	await clock.advance(25 * MIN)
	expect(notified).toEqual([
		'25 minutes without a break. Stand up and look away from the screen for 5.',
	])
	expect(viaOsascript.length).toBe(1)
})

test('no osascript banner when Claude Code notifications are turned off', async ($, on) => {
	const { clock, notified, chimes } = world(on, () => 0, undefined, {
		isSent: false,
		reason: 'disabled',
	})
	await start($)
	await clock.advance(25 * MIN)
	expect(notified.length).toBe(0)
	expect(chimes.length).toBe(1)
})

test(
	'no chime when turned off',
	{ options: { sound: false } },
	async ($, on) => {
		const { clock, notified, chimes } = world(on, () => 0)
		await start($)
		await clock.advance(25 * MIN)
		expect(notified.length).toBe(1)
		expect(chimes.length).toBe(0)
	},
)

test('the check-in rides the next tool result, once per work period, and never waits in an idle session', async ($, on) => {
	let leftAt = Infinity
	const { clock, session } = world(on, (now) =>
		now >= leftAt ? now - leftAt : 0,
	)
	await start($)
	expect(await checked($)).toBe(false)

	// At the prompt, typing elsewhere: nothing lands in the conversation.
	await clock.advance(26 * MIN)
	expect(session.appended().length).toBe(0)

	expect(await checked($)).toBe(true)
	expect(JSON.stringify(session.appended())).toContain('asked Claude to pause')
	expect(await checked($)).toBe(false)

	// Still no break 25 minutes later: a second check.
	await clock.advance(25 * MIN)
	expect(await checked($)).toBe(true)

	// A break clears what is due.
	leftAt = clock.now()
	await clock.advance(6 * MIN)
	leftAt = Infinity
	await clock.advance(MIN)
	expect(await checked($)).toBe(false)
})

test('a reload does not repeat the check-in the session was given', async ($, on) => {
	// Overdue for a minute, and the check for this period was given before the mod reloaded (a /config change).
	const { clock } = world(on, () => 0, {
		timer: {
			blockStart: T0 - 26 * MIN,
			seenAt: T0 - 30_000,
			alertedAt: T0 - MIN,
			lastInput: T0,
		},
	})
	const sent: number[] = []
	on('state.get', { plugin: 'pomodoro', key: 'sentKey' }, () => ({
		value: { value: T0 - MIN, version: 1 },
	}))
	on('state.set', { plugin: 'pomodoro', key: 'sentKey' }, (_, e) => {
		sent.push(e.value)
		return { value: { isSet: true, version: 2 } }
	})
	await start($)
	await clock.settle()
	expect(await checked($)).toBe(false)

	// The next period still gets its check, and it's kept for the next reload.
	await clock.advance(25 * MIN)
	expect(await checked($)).toBe(true)
	expect(sent).toEqual([T0 + 24 * MIN])
})

test('a break of just the break length counts, and no alert comes during it', async ($, on) => {
	const leftAt = T0 + 25 * MIN + 10_000
	const backAt = leftAt + 5 * MIN + 5_000
	const { clock, notified, labels } = world(on, (now) =>
		now >= leftAt && now < backAt ? now - leftAt : 0,
	)
	await start($)
	await clock.advance(25 * MIN)
	expect(notified.length).toBe(1)

	await clock.set(leftAt + 5 * MIN + 2_000)
	expect(labels.at(-1)).toBe('🍅 on a break')
	expect(notified.length).toBe(1)

	// Back at work: a fresh block, alerting 25 minutes after its first tick.
	await clock.set(T0 + 31 * MIN)
	expect(labels.at(-1)).toBe('🍅 0/25m')
	await clock.advance(24 * MIN)
	expect(notified.length).toBe(1)
	await clock.advance(MIN)
	expect(notified.length).toBe(2)
})

test('a gap with no tick (sleep, no session open) counts as a break', async ($, on) => {
	const { clock, notified } = world(on, () => 0, {
		timer: { blockStart: T0 - 180 * MIN, seenAt: T0 - 60 * MIN },
	})
	await start($)
	await clock.advance(MIN)
	expect(notified.length).toBe(0)
	await clock.advance(24 * MIN)
	expect(notified.length).toBe(1)
})

test(
	'short settings still alert: 3-minute blocks, 1-minute breaks',
	{ options: { workMinutes: 3, breakMinutes: 1 } },
	async ($, on) => {
		const { clock, notified } = world(on, () => 0)
		await start($)
		await clock.advance(3 * MIN)
		expect(notified).toEqual([
			'3 minutes without a break. Stand up and look away from the screen for 1.',
		])
	},
)

test(
	'without the emoji, the footer says pomodoro and nothing else shows a tomato',
	{ options: { emoji: false } },
	async ($, on) => {
		const { clock, session, status, labels, toasts } = world(on, () => 0)
		await start($)
		await clock.settle()
		expect(labels.at(-1)).toBe('pomodoro 0/25m')

		await clock.advance(25 * MIN)
		expect(status.at(-1)).toBe('25m, time for a break')
		expect(toasts).toEqual([
			'25 minutes without a break. Stand up and look away from the screen for 5.',
		])
		expect(await checked($)).toBe(true)
		expect(JSON.stringify(session.appended())).toContain(
			'Pomodoro: asked Claude to pause',
		)
		expect(
			JSON.stringify([labels, status, toasts, session.appended()]),
		).not.toContain('🍅')
	},
)

test(
	'no check-in when turned off',
	{ options: { checkIn: false } },
	async ($, on) => {
		const { clock, notified } = world(on, () => 0)
		await start($)
		await clock.advance(25 * MIN)
		expect(notified.length).toBe(1)
		expect(await checked($)).toBe(false)
	},
)

// The watcher, printing each [time, text] as it comes, sorted and after T0. It then stays running, or ends with `exits`.
const watcher = (
	on: On,
	clock: MockClock,
	lines: [number, string][],
	exits = false,
) =>
	on('process.spawn', async function* () {
		for (const [at, text] of lines) {
			await clock.sleep(at - clock.now())
			yield { stream: 'stdout' as const, text: `${text}\n` }
		}
		if (!exits) await clock.sleep(24 * 60 * MIN)
		return { value: { code: exits ? 1 : 0, signal: null } }
	})

// Mouse movement the watcher saw at each time; a key, click or scroll comes with its `k` line too.
const moves = (times: number[]) =>
	times.map((at): [number, string] => [at, `${at}`])
const keys = (times: number[]) =>
	times.map((at): [number, string] => [at, `${at}\nk${at}`])

// Work until 29 minutes in (2 seconds of movement every 20, seen 4 times a second), away for 11, back at 40.
// A mouse jiggler nudges every minute all along: two events 80 ms apart.
const jiggledDay = () => {
	const stretch = (from: number) =>
		Array.from({ length: 9 }, (_, i) => from + i * 250)
	const work = Array.from({ length: 87 }, (_, i) => T0 + 5_000 + i * 20_000)
	const nudges = Array.from({ length: 50 }, (_, i) => T0 + i * MIN + 12_000)
	return moves(
		[
			...work.flatMap(stretch),
			...nudges.flatMap((at) => [at, at + 80]),
			...stretch(T0 + 40 * MIN + 10_000),
		].sort((a, b) => a - b),
	)
}

test("a mouse jiggler's nudge doesn't keep a break from starting", async ($, on) => {
	const { clock, labels } = world(on, () => 0)
	watcher(on, clock, jiggledDay())
	await start($)
	await clock.set(T0 + 35 * MIN)
	expect(labels.at(-1)).toBe('🍅 on a break')

	await clock.set(T0 + 41 * MIN)
	expect(labels.at(-1)).toBe('🍅 0/25m')
})

test(
	'with moveSeconds 0, every movement counts, the nudge included',
	{ options: { moveSeconds: 0 } },
	async ($, on) => {
		const { clock, labels } = world(on, () => 0)
		watcher(on, clock, jiggledDay())
		await start($)
		await clock.set(T0 + 35 * MIN)
		expect(labels.at(-1)).toBe('🍅 35/25m')
	},
)

test('a lone key, click or scroll counts at once', async ($, on) => {
	const { clock, labels } = world(on, () => 0)
	// One press every 30 seconds, as when answering Claude's prompts or paging through a diff.
	watcher(
		on,
		clock,
		keys(Array.from({ length: 16 }, (_, i) => T0 + (i + 1) * 30_000)),
	)
	await start($)
	await clock.set(T0 + 8 * MIN)
	expect(labels.at(-1)).toBe('🍅 8/25m')
})

test("a reload while the person is away doesn't end their break", async ($, on) => {
	// 26 minutes into a block, last input 4 minutes ago: the watcher's first line says so, as ioreg does.
	const leftAt = T0 - 4 * MIN
	const { clock, labels } = world(on, (now) => now - leftAt, {
		timer: {
			blockStart: T0 - 26 * MIN,
			seenAt: T0 - 30_000,
			lastInput: leftAt,
		},
	})
	watcher(on, clock, [[T0 + 100, `${leftAt}`]])
	await start($)
	await clock.set(T0 + 2 * MIN)
	expect(labels.at(-1)).toBe('🍅 on a break')
})

test('when the watcher ends, ioreg stands in', async ($, on) => {
	const { clock, labels } = world(on, () => 0)
	watcher(on, clock, [[T0 + 1_000, `${T0 + 1_000}`]], true)
	await start($)
	await clock.set(T0 + 10 * MIN)
	expect(labels.at(-1)).toBe('🍅 10/25m')
})

test('without ioreg, a break is a break from every session', async ($, on) => {
	// Another session was in use 10 seconds ago, 20 minutes into a block: a fresh session keeps that block.
	const { clock, notified, labels } = world(on, () => null, {
		timer: {
			blockStart: T0 - 20 * MIN,
			seenAt: T0 - 30_000,
			lastInput: T0 - 10_000,
		},
	})
	await start($)
	await clock.settle()
	expect(labels.at(-1)).toBe('🍅 20/25m')

	for (let i = 0; i < 5; i++) {
		await $.tool.call({ tool: 'Bash', command: 'ls' })
		await clock.advance(MIN)
	}
	expect(notified.length).toBe(1)

	await clock.advance(6 * MIN)
	expect(labels.at(-1)).toBe('🍅 on a break')
})
