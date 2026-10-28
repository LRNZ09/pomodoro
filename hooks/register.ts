import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Shared by every open session through $.store: one pomodoro per person, not per session.
type Timer = {
	blockStart?: number
	seenAt?: number
	alertedAt?: number
	lastInput?: number
}
// Claude's answer to a check-in, kept in $.store for /pomodoro today.
type CheckIn = { at: number; repo: string | null; text: string }

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// The last check delivered, kept in $.state: a reload (a /config change) starts the module over, not the session.
const SENT = { plugin: 'pomodoro', key: 'sentKey' } as const
const LABEL = { plugin: 'pomodoro', key: 'label' } as const

// This session's own: whether its clock runs, its last prompt or tool call, the check-in now due, and the last one delivered.
let isStarted = false
let lastActivity = 0
let due: { key: number; text: string } | undefined
let sentKey: number | undefined
// Whether this turn got the check-in, and its answer is still to log.
// ponytail: a reload before the turn ends loses both, so that answer isn't logged and no menu opens; move them to $.state if that matters
let isCheckInTurn = false
let awaitingAnswer = false
// The watcher's input: the stretch of mouse movement under way, and the last input that counts (undefined: no watcher).
const stretch = { start: 0, last: 0 }
let lastInputThatCounts: number | undefined

// Movement less than this apart is one stretch; the watcher looks 4 times a second.
const STRETCH_GAP = 1_000
// Prints the time of the latest input each time it changes (macOS HID idle time, 4 times a second), and with a `k`
// before it the time of the latest key, click or scroll: a mouse jiggler only moves the pointer.
const WATCHER = `ObjC.import('CoreGraphics')
const out = $.NSFileHandle.fileHandleWithStandardOutput
const latest = (...types) => Math.round(Date.now() - 1e3 * Math.min(...types.map((t) => $.CGEventSourceSecondsSinceLastEventType(1, t))))
const print = (line) => out.writeData($(line + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
let lastAny = 0
let lastKey = 0
for (;;) {
	const any = latest(0xffffffff)
	const key = latest(10, 12, 1, 3, 25, 22)
	if (any - lastAny > 50) print(lastAny = any)
	if (key - lastKey > 50) print('k' + (lastKey = key))
	delay(0.25)
}`

const check = (minutes: number) =>
	`[Pomodoro] The user has been working for ${minutes} minutes without a break. ` +
	'Pause now: finish only what would otherwise be left half-done, start nothing new, and tell them in at most three short lines: ' +
	'what was done since the break, whether it still serves the original goal or has drifted into a side problem, and what you would do next. ' +
	'Remind them to take a short break, then end your turn without asking anything: a menu will ask them whether to go on.'

// Keys, clicks and scrolls count at once, mouse movement once its stretch lasts `minMs`: a mouse jiggler's nudge
// (keep-awake apps) is a blip.
function sawInput(line: string, minMs: number) {
	const isKey = line.startsWith('k')
	const at = Number(isKey ? line.slice(1) : line)
	if (!(at > 0)) return
	if (!isKey) {
		if (at - stretch.last > STRETCH_GAP) stretch.start = at
		stretch.last = at
	}
	// The first line is the input before the watcher started, as ioreg tells it: a reload doesn't end a break.
	if (lastInputThatCounts === undefined || isKey || at - stretch.start >= minMs)
		lastInputThatCounts = Math.max(lastInputThatCounts ?? 0, at)
}

// Leaving the loop, or the module unloading, ends the child.
// ponytail: one watcher per open session; share one through $.store if many sessions matter
async function watch($: EngineInterface, minMs: number) {
	try {
		const watcher = $.process.spawn({
			argv: ['osascript', '-l', 'JavaScript', '-e', WATCHER],
			cwd: '/',
		})
		for await (const { stream, text } of watcher)
			if (stream === 'stdout')
				for (const line of text.split('\n')) sawInput(line, minMs)
	} catch {}
	// It ended or never started: ioreg stands in, where every input counts.
	lastInputThatCounts = undefined
}

// Time since input that counts, from the watcher; else macOS input idle time, unless over SSH (ioreg sees the
// console's input); else time since this session's last activity.
async function idleMs($: EngineInterface, now: number) {
	if (lastInputThatCounts !== undefined) return now - lastInputThatCounts
	if (!(await $.env.get('SSH_CONNECTION'))) {
		try {
			const { stdout } = await $.process.run(
				['ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1'],
				{ cwd: '/', timeoutMs: 5_000 },
			)
			const ns = stdout.match(/"HIDIdleTime" = (\d+)/)?.[1]
			if (ns !== undefined) return Number(ns) / 1e6
		} catch {}
	}
	return now - lastActivity
}

// 🍅 before a line, unless the setting turns it off; `word` stands in where the line needs a name to make sense.
const tomato = (options: PluginOptions, word = '') =>
	options.emoji === true ? '🍅 ' : word

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
	const workMs = Number(options.workMinutes) * MINUTE
	const breakMs = Math.max(1, Number(options.breakMinutes)) * MINUTE
	const now = await $.clock.now()
	const timer = ((await $.store.get('timer')) ?? {}) as Timer
	// The latest input any session has seen, so an idle session can't end the block another one is working in.
	const lastInput = Math.max(timer.lastInput ?? 0, now - (await idleMs($, now)))
	const idle = now - lastInput

	if (idle >= breakMs) {
		due = undefined
		await $.store.set('timer', { seenAt: now, lastInput })
		show($, `${tomato(options, 'pomodoro ')}on a break`)
		return
	}
	// Ticks are a minute apart: look again the moment this stretch without input would become a break.
	if (idle > breakMs - MINUTE)
		$.clock.after(
			breakMs - idle + 1_000,
			() => void tick($, options).catch(() => {}),
		)

	// No tick for a break's length (two ticks at least): the machine slept or no session was open.
	const isGap =
		timer.seenAt === undefined ||
		now - timer.seenAt >= Math.max(breakMs, 2 * MINUTE)
	const blockStart =
		isGap || timer.blockStart === undefined ? now : timer.blockStart
	const worked = now - blockStart
	const minutes = Math.floor(worked / MINUTE)
	const isDue = worked >= workMs
	const alertedAt = timer.alertedAt ?? 0
	// Not once the person has been away a while: that may be the break already under way.
	const shouldAlert =
		isDue &&
		idle < 2 * MINUTE &&
		(alertedAt < blockStart || now - alertedAt >= breakMs)

	// ponytail: read-then-write, so two sessions ticking in the same instant can both alert
	await $.store.set('timer', {
		blockStart,
		seenAt: now,
		alertedAt: shouldAlert ? now : alertedAt,
		lastInput,
	})
	show(
		$,
		`${tomato(options, 'pomodoro ')}${minutes}/${options.workMinutes}m`,
		isDue ? `${tomato(options)}${minutes}m, time for a break` : undefined,
	)
	// One check per work period without a break, keyed by when that period ended.
	due =
		isDue && options.checkIn
			? {
					key: blockStart + Math.floor(worked / workMs) * workMs,
					text: check(minutes),
				}
			: undefined
	if (shouldAlert) {
		const text = `${minutes} minutes without a break. Stand up and look away from the screen for ${breakMs / MINUTE}.`
		await alert($, text, options.sound === true, tomato(options))
	}
}

// ponytail: read-then-write, so two sessions logging in the same instant can drop one
async function logAnswer($: EngineInterface, text: string) {
	const at = await $.clock.now()
	const repo = (await $.session.repo())?.root ?? null
	const kept = (((await $.store.get('checkIns')) ?? []) as CheckIn[]).filter(
		(c) => at - c.at < 14 * DAY,
	)
	await $.store.set('checkIns', [
		...kept,
		{ at, repo, text: text.slice(0, 4_000) },
	])
}

// Today's check-ins at local time, under the name of their repository's folder.
async function today($: EngineInterface) {
	const day = new Date(await $.clock.now()).toDateString()
	const byRepo = new Map<string | null, string[]>()
	for (const { at, repo, text } of ((await $.store.get('checkIns')) ??
		[]) as CheckIn[])
		if (new Date(at).toDateString() === day)
			byRepo.set(repo, [
				...(byRepo.get(repo) ?? []),
				`  ${new Date(at).toTimeString().slice(0, 5)}  ${text.replaceAll('\n', '\n         ')}`,
			])
	if (byRepo.size === 0) return 'No check-ins today.'
	return [...byRepo]
		.map(([repo, lines]) =>
			[repo?.split(/[/\\]/).at(-1) ?? 'no repository', ...lines].join('\n'),
		)
		.join('\n\n')
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
	sentKey = await $.state.get(SENT).then(
		(read) => read.value,
		() => undefined,
	)
	// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
	if (!(await $.env.get('SSH_CONNECTION')))
		void watch($, Number(options.moveSeconds) * 1_000)
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
		// The eval (evals/check-in) runs headless, where the clock never starts: it makes one check-in due at once.
		else if (options.checkIn && (await $.env.get('EVAL_POMODORO_CHECK_IN_DUE')))
			due = { key: 0, text: check(Number(options.workMinutes)) }
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
		lastActivity = await $.clock.now()
		return next(e)
	})

	// The check rides a tool result of the main loop: Claude reads it mid-turn, and it never waits in an idle session.
	on('tool.call', async ($, e, next) => {
		lastActivity = await $.clock.now()
		const ran = await next(e)
		if (
			due === undefined ||
			due.key === sentKey ||
			e.agentId !== undefined ||
			ran.deny !== undefined
		)
			return ran
		sentKey = due.key
		isCheckInTurn = true
		awaitingAnswer = true
		void $.state.set(SENT, due.key).catch(() => {})
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
		return { ...ran, context: [...(ran.context ?? []), due.text] }
	})

	// Claude's answer to a check-in is the text of the main loop's first response after it that ends the turn or asks
	// with a menu: picking from the menu goes on in the same turn, so the turn's last text can come after the summary.
	on('turn.step', async function* ($, e, next) {
		const step = yield* next(e)
		if (
			awaitingAnswer &&
			e.agentId === undefined &&
			step.answer.trim() !== '' &&
			step.toolUses.every((use) => use.name === 'AskUserQuestion')
		) {
			awaitingAnswer = false
			await logAnswer($, step.answer.trim()).catch(() => {})
		}
		return step
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
			? await today($)
			: 'Usage: /pomodoro [today]',
	}))
}
