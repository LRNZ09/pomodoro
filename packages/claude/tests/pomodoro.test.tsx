import type { On, UiNotifyResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const T0 = 1_700_000_000_000
const MIN = 60_000

const SENT: UiNotifyResult = { isSent: true, channel: 'ghostty' }

// The engine beneath the mod: a clock, a store, ioreg reporting `idle(now)` (null: no ioreg), the terminal's
// answer to a notification, a repository at /code/app, and recorders. `notified` holds every banner, `viaOsascript` those osascript posted,
// `labels` each count written for the prompt footer.
const world = (
	on: On,
	idle: (now: number) => number | null,
	seed?: Record<string, unknown>,
	notify: UiNotifyResult = SENT,
) => {
	const clock = mock.clock(on, { now: T0 })
	// The mod's store, open to the test.
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
	on('prompt.submit', (_, e) => ({ text: e.text }))
	on('tool.call', () => ({ result: {} }))
	on('command.register', (_, e) => ({ value: { command: e.name } }))
	on('session.repo', () => ({
		value: { root: '/code/app', remote: null, internal: false, name: null },
	}))
	on('turn.complete', (_, e) => ({ text: e.answer }))
	// The model: its next response, which `respond` sets.
	let reply = { answer: '', tools: [] as string[] }
	on('turn.step', async function* (_, e) {
		yield* []
		return {
			turnId: e.turnId,
			index: e.index,
			answer: reply.answer,
			toolUses: reply.tools.map((name) => ({ name, input: {} })),
			stopReason: reply.tools.length > 0 ? 'tool_use' : 'end_turn',
			usage: null,
		}
	})
	// A response of the main loop, or of a subagent's run with `agentId`: its text and the tools it calls.
	const respond = async (
		$: Engine,
		answer: string,
		tools: string[] = [],
		agentId?: string,
	) => {
		reply = { answer, tools }
		const step = $.turn.step({
			turnId: 't',
			index: 0,
			model: 'claude',
			messageCount: 1,
			agentId,
		})
		for await (const _ of step) {
		}
		return step.result
	}
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
		respond,
	}
}

const start = ($: Engine) =>
	$.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

// A tool call of the main loop, or of a subagent's with `agentId`; true when the check-in came back with its result.
const checked = async ($: Engine, agentId?: string) =>
	JSON.stringify(
		await $.tool.call({ tool: 'Bash', command: 'ls', agentId }),
	).includes('[Pomodoro]')

// The end of the main loop's turn, answered or interrupted, or of a subagent's run with `agentId`.
const endTurn = (
	$: Engine,
	reason: 'answer' | 'aborted' = 'answer',
	agentId?: string,
) =>
	$.turn.complete({
		answer: '',
		durationMs: 1,
		isAborted: reason === 'aborted',
		turnId: 't',
		reason,
		agentId,
	})

// What /pomodoro today prints.
const listed = async ($: Engine) =>
	(
		await $.command.run({
			command: 'pomodoro',
			args: 'today',
			origin: { kind: 'composer' },
			presentation: { isFullscreen: false, columns: 80 },
		})
	).text

const texts = (checkIns: unknown) =>
	(checkIns as { text: string }[]).map((c) => c.text)

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
	expect(await checked($)).toBe(false)
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

test('the check-in rides the next tool result, once per pomodoro, and never waits in an idle session', async ($, on) => {
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
	expect(JSON.stringify(session.appended())).toContain(
		'told the agent your pomodoro is up',
	)
	expect(await checked($)).toBe(false)

	// Still no break 25 minutes later: a second check-in.
	await clock.advance(25 * MIN)
	expect(await checked($)).toBe(true)

	// A break clears what is due.
	leftAt = clock.now()
	await clock.advance(6 * MIN)
	leftAt = Infinity
	await clock.advance(MIN)
	expect(await checked($)).toBe(false)
})

// The check-in is for Claude's own loop, and a denied call returns no result to carry it.
test("a subagent's tool call, or one that was denied, doesn't take the check-in", async ($, on) => {
	// Beneath the mod, before world()'s answer to every tool call.
	on('tool.call', { tool: 'Write' }, () => ({ deny: 'not now' }))
	const { clock } = world(on, () => 0)
	await start($)
	await clock.advance(26 * MIN)
	expect(await checked($, 'a1')).toBe(false)
	expect(
		JSON.stringify(
			await $.tool.call({ tool: 'Write', file_path: '/a', content: '' }),
		),
	).not.toContain('[Pomodoro]')
	expect(await checked($)).toBe(true)
})

test('a reload does not repeat the check-in the session was given', async ($, on) => {
	// Overdue for a minute, and the check-in for this pomodoro was given before the mod reloaded (a /config change). The
	// number under sentKey is also what 0.6.1 left there, so an update doesn't repeat a check-in.
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

	// The next pomodoro still gets its check-in, and it's kept for the next reload.
	await clock.advance(25 * MIN)
	expect(await checked($)).toBe(true)
	expect(sent).toEqual([T0 + 24 * MIN])
})

// With 1-minute breaks every tick asks for a wake. With input half a second before each tick, the next minute's tick
// comes before that wake and replaces it, so only the minute's ticks run.
test(
	"a wake replaces the one before: with 1-minute breaks the ticks don't pile up while the person works",
	{ options: { breakMinutes: 1 } },
	async ($, on) => {
		const { clock, labels } = world(on, () => 500)
		await start($)
		await clock.settle()
		const before = labels.length
		await clock.advance(10 * MIN)
		expect(labels.length - before).toBe(10)
	},
)

// Claude Code refuses it in /config too. A pomodoro of 0 minutes would put the check-in on every tool result.
test(
	'a setting below its minimum fails the load, naming the setting',
	{ options: { workMinutes: 0 } },
	async ($, on) => {
		world(on, () => 0)
		await expect(start($)).rejects.toThrow(
			'Pomodoro (minutes) must be at least 1',
		)
	},
)

// Claude Code's check takes it as unset, then hands it to the plugin.
test(
	'an empty setting takes its default',
	{ options: { breakMinutes: '' } },
	async ($, on) => {
		const { clock, notified } = world(on, () => 0)
		await start($)
		await clock.advance(25 * MIN)
		expect(notified).toEqual([
			'25 minutes without a break. Stand up and look away from the screen for 5.',
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
			'Pomodoro: told the agent your pomodoro is up',
		)
		expect(
			JSON.stringify([labels, status, toasts, session.appended()]),
		).not.toContain('🍅')
	},
)

// Listed at the moment it's logged, so the day matches in any time zone: CI's and this Mac's differ.
test("the check-in's summary is logged from any reply in its turn, and /pomodoro today lists it by repository", async ($, on) => {
	const { clock, store, respond } = world(on, () => 0)
	await start($)
	expect(await listed($)).toBe('No check-ins today.')

	// A summary with no check-in before it logs nothing.
	await respond($, 'Pomodoro: early.')
	expect(store.checkIns).toBe(undefined)

	await clock.advance(26 * MIN)
	expect(await checked($)).toBe(true)
	// Neither a subagent's summary nor a reply without one is logged, and the end of the subagent's run doesn't end the
	// wait; one given mid-task, beside a tool call, is.
	await respond($, 'Pomodoro: the subagent.', [], 'a1')
	await endTurn($, 'answer', 'a1')
	await respond($, 'Writing step2.', ['Write'])
	await respond(
		$,
		'Wrote step2.\n\n**Pomodoro:** on the goal.\nTake a break.',
		['Write'],
	)
	await respond($, 'Pomodoro: again.')
	expect(texts(store.checkIns)).toEqual([
		'Pomodoro: on the goal.\nTake a break.',
	])
	expect(await listed($)).toMatch(
		/^app\n {2}\d\d:\d\d {2}Pomodoro: on the goal\.\n {9}Take a break\.$/,
	)
})

test("a turn that ends without the summary, answered or cut short, logs nothing, and the next turn's isn't taken for it", async ($, on) => {
	const { clock, store, respond } = world(on, () => 0)
	await start($)
	for (const reason of ['answer', 'aborted'] as const) {
		await clock.advance(26 * MIN)
		expect(await checked($)).toBe(true)
		await respond($, 'Done.')
		await endTurn($, reason)
		await respond($, 'Pomodoro: the next turn.')
	}
	expect(store.checkIns).toBe(undefined)
})

test('when the watcher ends, ioreg stands in', async ($, on) => {
	// ioreg sees the person away since 10 minutes before the start; the watcher sees them back a second in, then ends.
	let leftAt = T0 - 10 * MIN
	const { clock, labels } = world(on, (now) =>
		now >= leftAt ? now - leftAt : 0,
	)
	on('process.spawn', async function* () {
		await clock.sleep(1_000)
		yield { stream: 'stdout' as const, text: `${T0 + 1_000}\n` }
		await clock.sleep(90_000)
		return { value: { code: 1, signal: null } }
	})
	await start($)
	await clock.set(T0 + MIN)
	expect(labels.at(-1)).toBe('🍅 0/25m')

	// Still at the keyboard, which only ioreg sees now.
	leftAt = Infinity
	await clock.set(T0 + 10 * MIN)
	expect(labels.at(-1)).toBe('🍅 9/25m')
})

test('without ioreg, a break is a break from every session', async ($, on) => {
	// Another session was in use 10 seconds ago, 20 minutes into a pomodoro: a fresh session keeps that pomodoro.
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

	// Prompts, then tool calls, stand in for input: one a minute until the alert, then until the next.
	for (let i = 0; i < 5; i++) {
		await $.prompt.submit({
			text: 'Go on.',
			wait: false,
			origin: { kind: 'composer' },
		})
		await clock.advance(MIN)
	}
	expect(notified.length).toBe(1)
	for (let i = 0; i < 5; i++) {
		await $.tool.call({ tool: 'Bash', command: 'ls' })
		await clock.advance(MIN)
	}
	expect(notified.length).toBe(2)

	await clock.advance(6 * MIN)
	expect(labels.at(-1)).toBe('🍅 on a break')
})
