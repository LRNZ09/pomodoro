import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import {
	type CheckIn,
	type Event,
	GIT_UNDER_WAY,
	initial,
	logged,
	MINUTE,
	step,
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
// Whether this turn got the check-in, and its answer is still to log.
// ponytail: a reload before the turn ends loses both, so that answer isn't logged and no menu opens; move them to $.state if that matters
let isCheckInTurn = false
let awaitingAnswer = false

// Moves the rhythm on by one event, and returns what to carry out, in order.
function feed(event: Event, options: PluginOptions) {
	const next = step(state, event, options)
	state = next.state
	return next.effects
}

// Leaving the loop, or the module unloading, ends the child.
// ponytail: one watcher per open session; share one through $.store if many sessions matter
async function watch($: EngineInterface, options: PluginOptions) {
	try {
		const watcher = $.process.spawn({
			argv: ['osascript', '-l', 'JavaScript', '-e', WATCHER],
			cwd: '/',
		})
		for await (const { stream, text } of watcher)
			if (stream === 'stdout')
				for (const line of text.split('\n'))
					feed({ type: 'input', line }, options)
	} catch {}
	feed({ type: 'watcherEnded' }, options)
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

async function tick($: EngineInterface, options: PluginOptions) {
	const now = await $.clock.now()
	const timer = ((await $.store.get('timer')) ?? {}) as Timer
	// ioreg only when the watcher isn't there to go by.
	const idleMs =
		state.lastInputThatCounts === undefined ? await systemIdleMs($) : undefined
	for (const effect of feed(
		{ type: 'tick', now, timer, systemIdleMs: idleMs },
		options,
	))
		if (effect.type === 'wake')
			$.clock.after(effect.afterMs, () => void tick($, options).catch(() => {}))
		// ponytail: read-then-write, so two sessions ticking in the same instant can both alert
		else if (effect.type === 'persist') await $.store.set('timer', effect.timer)
		else if (effect.type === 'show') show($, effect.label, effect.warning)
		else if (effect.type === 'alert')
			await alert($, effect.text, effect.sound, effect.mark)
}

// ponytail: read-then-write, so two sessions logging in the same instant can drop one
async function logAnswer($: EngineInterface, text: string) {
	const at = await $.clock.now()
	const repo = (await $.session.repo())?.root ?? null
	const log = ((await $.store.get('checkIns')) ?? []) as CheckIn[]
	await $.store.set('checkIns', logged(log, { at, repo, text }))
}

// Whether git is partway through a rebase or the like in the session's repository: Claude mustn't be stopped there.
// shortcut: git only, in the session's own repository; a migration or a deploy is Claude's to judge from the note
async function isGitUnderWay($: EngineInterface) {
	const root = (await $.session.repo())?.root
	if (root === undefined) return false
	// A failure prints nothing, so the names land at / and aren't found.
	const { stdout } = await $.process.run(
		['git', 'rev-parse', '--absolute-git-dir'],
		{ cwd: root, timeoutMs: 5_000 },
	)
	const found = await Promise.all(
		GIT_UNDER_WAY.map((name) => $.fs.exists(`${stdout.trim()}/${name}`)),
	)
	return found.includes(true)
}

// The menu after a check-in: Continue goes on, text typed under Other is the new course, Stop leaves it there.
// It rejects when dismissed or left unanswered, so nothing goes on without the person.
async function askToGoOn($: EngineInterface) {
	const choice = await $.ui.ask('Continue, change course or stop?', {
		header: 'Pomodoro',
		options: ['Continue', 'Stop'],
	})
	if (choice !== 'Stop') await $.prompt.submit({ text: choice, asUser: true })
}

// The clock runs where the count shows: an interactive terminal session. Never in -p, VS Code or the desktop app.
async function begin($: EngineInterface, options: PluginOptions) {
	if (isStarted) return
	isStarted = true
	// Read before the first tick, which is what makes a check due.
	const sentKey = await $.state.get(SENT).then(
		(read) => read.value,
		() => undefined,
	)
	state = { ...state, sentKey }
	// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
	if (!(await $.env.get('SSH_CONNECTION'))) void watch($, options)
	// A failed tick is retried by the next one.
	void tick($, options).catch(() => {})
	$.clock.every(MINUTE, () => void tick($, options).catch(() => {}))
}

export const register: Register = (on, options) => {
	on('session.start', async ($, e, next) => {
		await $.command
			.register({
				name: 'pomodoro',
				description: "Lists today's check-ins by repository.",
				argumentHint: 'today',
			})
			.catch(() => {})
		if (e.isInteractive) await begin($, options)
		// The eval (evals/) runs headless, where the clock never starts: EVAL_POMODORO_CHECK_IN_DUE=N makes one check-in
		// due with the main loop's Nth tool result.
		else
			feed(
				{
					type: 'forceDue',
					afterToolResults: Number(
						await $.env.get('EVAL_POMODORO_CHECK_IN_DUE'),
					),
				},
				options,
			)
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
		feed({ type: 'activity', now: await $.clock.now() }, options)
		return next(e)
	})

	// The check rides a tool result of the main loop: Claude reads it mid-turn, and it never waits in an idle session.
	on('tool.call', async ($, e, next) => {
		feed({ type: 'activity', now: await $.clock.now() }, options)
		const ran = await next(e)
		if (ran.deny !== undefined) return ran
		const [checkIn] = feed(
			{ type: 'toolResult', isMain: e.agentId === undefined },
			options,
		)
		if (checkIn?.type !== 'checkIn') return ran
		// It rides the first tool result after git is done.
		if (await isGitUnderWay($).catch(() => false)) {
			feed({ type: 'checkInHeld', key: checkIn.key }, options)
			return ran
		}
		isCheckInTurn = true
		awaitingAnswer = true
		void $.state.set(SENT, checkIn.key).catch(() => {})
		void $.session
			.append({
				message: {
					type: 'system',
					content: [
						{
							type: 'text',
							text: `${tomato(options)}Pomodoro: asked Claude to pause and check in.`,
						},
					],
				},
			})
			.catch(() => {})
		return { ...ran, context: [...(ran.context ?? []), checkIn.text] }
	})

	// Claude's answer to a check-in is the text of the main loop's first response after it that ends the turn or asks
	// with a menu: picking from the menu goes on in the same turn, so the turn's last text can come after the summary.
	on('turn.step', async function* ($, e, next) {
		const response = yield* next(e)
		if (
			awaitingAnswer &&
			e.agentId === undefined &&
			response.answer.trim() !== '' &&
			response.toolUses.every((use) => use.name === 'AskUserQuestion')
		) {
			awaitingAnswer = false
			await logAnswer($, response.answer.trim()).catch(() => {})
		}
		return response
	})

	// The check-in turn's end opens the menu, unless it was interrupted. An answer still unlogged (an error, an
	// interrupt) isn't left for the next turn.
	on('turn.complete', async ($, e, next) => {
		const ended = await next(e)
		if (e.agentId === undefined) {
			if (isCheckInTurn && e.reason === 'answer')
				void askToGoOn($).catch(() => {})
			isCheckInTurn = false
			awaitingAnswer = false
		}
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
