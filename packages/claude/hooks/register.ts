import type { EngineInterface, Register } from 'claude-code'
import {
	type CheckIn,
	type Event,
	initial,
	logged,
	MINUTE,
	type Settings,
	settingsFrom,
	step,
	summary,
	type Timer,
	today,
	tomato,
	WATCHER,
} from './core'

// The last check delivered, kept in $.state: a reload (a /config change) starts the module over, not the session.
const SENT = { plugin: 'pomodoro', key: 'sentKey' } as const
const LABEL = { plugin: 'pomodoro', key: 'label' } as const

// This session's own: the rhythm's state (lib/core), and whether its clock runs.
let state = initial
let isStarted = false
// Whether the summary the check-in asked for is still to log.
// ponytail: a reload before the turn ends loses this, so that summary isn't logged; move it to $.state if that matters
let awaitingSummary = false

// Moves the rhythm on by one event, and returns what to carry out, in order.
function feed(event: Event, settings: Settings) {
	const next = step(state, event, settings)
	state = next.state
	return next.effects
}

// Leaving the loop, or the module unloading, ends the child.
// ponytail: one watcher per open session; share one through $.store if many sessions matter
async function watch($: EngineInterface, settings: Settings) {
	try {
		const watcher = $.process.spawn({
			argv: ['osascript', '-l', 'JavaScript', '-e', WATCHER],
			cwd: '/',
		})
		for await (const { stream, text } of watcher)
			if (stream === 'stdout')
				for (const line of text.split('\n'))
					feed({ type: 'input', line }, settings)
	} catch {}
	feed({ type: 'watcherEnded' }, settings)
}

// macOS input idle time, unless over SSH, where ioreg sees the console's input (undefined: none to read).
async function systemIdleMs($: EngineInterface) {
	if (await $.env.get('SSH_CONNECTION')) return undefined
	try {
		const { stdout } = await $.process.run(
			['ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1'],
			{ cwd: '/', timeoutMs: 5_000 },
		)
		const ns = stdout.match(/"HIDIdleTime" = (\d+)/)?.[1]
		return ns === undefined ? undefined : Number(ns) / 1e6
	} catch {
		return undefined
	}
}

async function alert(
	$: EngineInterface,
	text: string,
	hasSound: boolean,
	mark: string,
) {
	$.ui.toast(`${mark}${text}`, { timeoutMs: 15_000 })
	// Ghostty shows the banner of the tab in front for a few seconds only, and a Focus silences it; not a chime (macOS).
	if (hasSound)
		await $.process
			.run(['afplay', '/System/Library/Sounds/Glass.aiff'], { cwd: '/' })
			.catch(() => {})
	// osascript only where the terminal can't raise one; notifications turned off stay off (macOS).
	const sent = await $.ui
		.notify(text, { title: 'Pomodoro' })
		.catch(() => undefined)
	if (
		!sent ||
		(!sent.isSent &&
			(sent.reason === 'no-channel' || sent.reason === 'no-surface'))
	) {
		await $.process
			.run(
				[
					'osascript',
					'-e',
					`display notification "${text}" with title "Pomodoro"`,
				],
				{ cwd: '/' },
			)
			.catch(() => {})
	}
}

// The count is a mode label in the prompt footer. The status line, which Claude Code marks ⚠, only says a break is due.
function show($: EngineInterface, label: string, warning?: string) {
	void $.state.set(LABEL, label).catch(() => {})
	$.ui.status(warning)
}

async function tick($: EngineInterface, settings: Settings) {
	const now = await $.clock.now()
	const timer = ((await $.store.get('timer')) ?? {}) as Timer
	// ioreg only when the watcher isn't there to go by.
	const idleMs =
		state.lastInputThatCounts === undefined ? await systemIdleMs($) : undefined
	for (const effect of feed(
		{ type: 'tick', now, timer, systemIdleMs: idleMs },
		settings,
	))
		if (effect.type === 'wake')
			$.clock.after(
				effect.afterMs,
				() => void tick($, settings).catch(() => {}),
			)
		// ponytail: read-then-write, so two sessions ticking in the same instant can both alert
		else if (effect.type === 'persist') await $.store.set('timer', effect.timer)
		else if (effect.type === 'show') show($, effect.label, effect.warning)
		else if (effect.type === 'alert')
			await alert($, effect.text, effect.sound, effect.mark)
}

// ponytail: read-then-write, so two sessions logging in the same instant can drop one
async function logSummary($: EngineInterface, text: string) {
	const at = await $.clock.now()
	const repo = (await $.session.repo())?.root ?? null
	const log = ((await $.store.get('checkIns')) ?? []) as CheckIn[]
	await $.store.set('checkIns', logged(log, { at, repo, text }))
}

// The clock runs where the count shows: an interactive terminal session. Never in -p, VS Code or the desktop app.
async function begin($: EngineInterface, settings: Settings) {
	if (isStarted) return
	isStarted = true
	// Read before the first tick, which is what makes a check due.
	const sentKey = await $.state.get(SENT).then(
		(read) => read.value,
		() => undefined,
	)
	state = { ...state, sentKey }
	// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
	if (!(await $.env.get('SSH_CONNECTION'))) void watch($, settings)
	// A failed tick is retried by the next one.
	void tick($, settings).catch(() => {})
	$.clock.every(MINUTE, () => void tick($, settings).catch(() => {}))
}

export const register: Register = (on, options) => {
	// Claude Code has checked them against plugin.json, but hands an empty one on. A problem left fails the load, as its
	// own check does.
	const read = settingsFrom(options)
	if ('problems' in read) throw new Error(read.problems.join('; '))
	const settings = read
	on('session.start', async ($, e, next) => {
		await $.command
			.register({
				name: 'pomodoro',
				description: "Lists today's check-ins by repository.",
				argumentHint: 'today',
			})
			.catch(() => {})
		if (e.isInteractive) await begin($, settings)
		return next(e)
	})

	// Reading the label while drawing redraws the footer on each new count.
	on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
		const { value } = await $.state.get(LABEL)
		return next(
			value === undefined
				? e
				: { ...e, props: { ...e.props, modes: [...e.props.modes, value] } },
		)
	})

	on('prompt.submit', async ($, e, next) => {
		feed({ type: 'activity', now: await $.clock.now() }, settings)
		return next(e)
	})

	// The check rides a tool result of the main loop: Claude reads it mid-turn, and it never waits in an idle session.
	on('tool.call', async ($, e, next) => {
		feed({ type: 'activity', now: await $.clock.now() }, settings)
		const ran = await next(e)
		if (ran.deny !== undefined) return ran
		const [checkIn] = feed(
			{ type: 'toolResult', isMain: e.agentId === undefined },
			settings,
		)
		if (checkIn?.type !== 'checkIn') return ran
		awaitingSummary = true
		void $.state.set(SENT, checkIn.key).catch(() => {})
		void $.session
			.append({
				message: {
					type: 'system',
					content: [
						{
							type: 'text',
							text: `${tomato(settings)}Pomodoro: told Claude your work block is up.`,
						},
					],
				},
			})
			.catch(() => {})
		return { ...ran, context: [...(ran.context ?? []), checkIn.text] }
	})

	// The summary can come in any response of the main loop after the check-in, mid-task too, until the turn ends.
	on('turn.step', async function* ($, e, next) {
		const response = yield* next(e)
		const text =
			awaitingSummary && e.agentId === undefined
				? summary(response.answer)
				: undefined
		if (text !== undefined) {
			awaitingSummary = false
			await logSummary($, text).catch(() => {})
		}
		return response
	})

	// No summary by the turn's end: Claude chose not to give one, or the turn was cut short.
	on('turn.complete', async (_, e, next) => {
		const ended = await next(e)
		if (e.agentId === undefined) awaitingSummary = false
		return ended
	})

	on('command.run', { command: 'pomodoro' }, async ($, e) => ({
		text: ['', 'today'].includes(e.args.trim())
			? today(
					((await $.store.get('checkIns')) ?? []) as CheckIn[],
					await $.clock.now(),
				)
			: 'Usage: /pomodoro [today]',
	}))
}
