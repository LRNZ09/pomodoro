// The work-and-break rhythm the pomodoro plugins share. Each agent creates an instance for each session
// (createInstance), with a host that does its I/O, and passes it the session's events; whatever only one agent does
// stays in that agent's code (docs/adr/0001). Inside, step() is pure: it says what to do, and the instance does it.

// Shared by every open session through the agent's store: one pomodoro per person, not per session.
export type Timer = {
	blockStart?: number
	seenAt?: number
	alertedAt?: number
	lastInput?: number
}
// The agent's summary at a check-in, kept for /pomodoro today.
export type CheckIn = { at: number; repo: string | null; text: string }
// The Claude plugin's plugin.json declares the same defaults and minimums.
export const DEFAULTS = {
	workMinutes: 25,
	breakMinutes: 5,
	moveSeconds: 1,
	sound: true,
	checkIn: true,
	emoji: true,
}
export type Settings = Readonly<typeof DEFAULTS>
export const MINIMUM: Partial<Record<keyof Settings, number>> = {
	workMinutes: 1,
	breakMinutes: 1,
	moveSeconds: 0,
}

// The settings in a file's JSON or Claude Code's options, with the defaults for the keys left out or empty; or what's
// wrong with them, as Claude Code checks a plugin's options: then neither agent runs the timer.
export function settingsFrom(json: unknown): Settings | { problems: string[] } {
	if (typeof json !== 'object' || json === null || Array.isArray(json))
		return { problems: ['the file must hold a JSON object'] }
	const file = json as Record<string, unknown>
	const settings: Record<string, unknown> = { ...DEFAULTS }
	const problems: string[] = []
	for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
		const value = file[key]
		const min = MINIMUM[key]
		// Claude Code's check skips an empty value, then hands it on.
		if (value === undefined || value === '') continue
		// JSON's 1e999 is Infinity, which Claude Code refuses.
		if (
			typeof value !== typeof DEFAULTS[key] ||
			(typeof value === 'number' && !Number.isFinite(value))
		)
			problems.push(`${key} must be a ${typeof DEFAULTS[key]}`)
		else if (min !== undefined && (value as number) < min)
			problems.push(`${key} must be at least ${min}`)
		else settings[key] = value
	}
	return problems.length > 0 ? { problems } : (settings as Settings)
}

// One session's own: its last prompt or tool call, the stretch of mouse movement under way, the last input that counts
// (undefined: no watcher), the check-in now due, the last one sent, and whether the summary it asked for is still to
// log.
type State = {
	lastActivity: number
	stretch: { start: number; last: number }
	lastInputThatCounts?: number
	due?: { key: number; text: string }
	sentKey?: number
	awaitingSummary: boolean
}

type Event =
	// A prompt or a tool call.
	| { type: 'activity'; now: number }
	// A line the watcher printed.
	| { type: 'input'; line: string }
	| { type: 'watcherEnded' }
	// The minute's tick, with the stored timer and the system's input idle time where ioreg reads one.
	| { type: 'tick'; now: number; timer: Timer; systemIdleMs?: number }
	| { type: 'toolResult'; isMain: boolean }
	// A finished response of the main loop, and the end of its turn (in Pi, the run).
	| { type: 'reply'; text: string }
	| { type: 'turnEnded' }

// In the order to carry them out.
type Effect =
	// Tick again this much later.
	| { type: 'wake'; afterMs: number }
	// Store the shared timer.
	| { type: 'persist'; timer: Timer }
	// The count, and the warning while a break is due.
	| { type: 'show'; label: string; warning?: string }
	| { type: 'alert'; text: string; mark: string; sound: boolean }
	// Add `text` to this tool result.
	| { type: 'checkIn'; key: number; text: string }
	// Add the summary to the log.
	| { type: 'log'; text: string }

export const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// Movement less than this apart is one stretch; the watcher looks 4 times a second.
const STRETCH_GAP = 1_000

const initial: State = {
	lastActivity: 0,
	stretch: { start: 0, last: 0 },
	awaitingSummary: false,
}

// The command that runs a macOS JXA script, which prints the time of the latest input each time it changes (macOS HID
// idle time, 4 times a second), and with a `k` before it the time of the latest key, click or scroll: a mouse jiggler
// only moves the pointer.
const WATCHER = [
	'osascript',
	'-l',
	'JavaScript',
	'-e',
	`ObjC.import('CoreGraphics')
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
}`,
]

// The command that prints macOS's input idle time, and that time in its output (undefined: none, as off macOS).
export const IOREG = ['ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1']
function ioregIdleMs(stdout: string) {
	const ns = stdout.match(/"HIDIdleTime" = (\d+)/)?.[1]
	return ns === undefined ? undefined : Number(ns) / 1e6
}

// An alert's chime, and the banner osascript posts (macOS); the text's quotes and backslashes stay text in AppleScript.
export const CHIME = ['afplay', '/System/Library/Sounds/Glass.aiff']
export const banner = (text: string) => [
	'osascript',
	'-e',
	`display notification "${text.replace(/["\\]/g, '\\$&')}" with title "Pomodoro"`,
]

// /pomodoro, which an instance answers.
export const COMMAND = {
	name: 'pomodoro',
	description: "Lists today's check-ins by repository.",
}

// What an agent gives an instance to do its I/O with. Each of these is general: what only one agent does stays in
// that agent's code.
export type Host = {
	now: () => Promise<number>
	// `fn` once after `ms`, or every `ms`; each returns what cancels it.
	after: (ms: number, fn: () => void) => () => void
	every: (ms: number, fn: () => void) => () => void
	// What every session of the agent shares: the timer, and the log of summaries.
	load: (key: 'timer' | 'checkIns') => Promise<unknown>
	save: (key: 'timer' | 'checkIns', value: unknown) => Promise<void>
	// A command's output; a rejection or '' when it can't run, which core takes the same.
	run: (argv: readonly string[], timeoutMs?: number) => Promise<string>
	// A command that runs on: its output as it comes, in pieces that needn't be lines, then `onEnd` once it ended or
	// couldn't start. Returns what ends it.
	spawn: (
		argv: readonly string[],
		onOutput: (text: string) => void,
		onEnd: () => void,
	) => () => void
	// The root of the session's repository (null: none).
	repo: () => Promise<string | null>
	// The count, and the warning while a break is due.
	show: (label: string, warning?: string) => void
	// The agent's own alert. True: it raised a desktop banner, or mustn't, so no osascript banner follows.
	notify: (text: string, mark: string) => Promise<boolean>
	// What the session keeps across a reload, to hand back to createInstance.
	keep: (kept: Kept) => void
}

// The block whose check-in the session got. Only that: the wait for the summary ends with the turn, and a reload
// comes between turns.
export type Kept = number

// One session's: each agent passes it the session's events.
export type Instance = {
	// The clock, and the watcher unless over SSH: only where the count shows.
	start: () => void
	stop: () => void
	// One tick now, as the clock would.
	tick: () => Promise<void>
	// A prompt or a tool call.
	activity: () => Promise<void>
	// The check-in to add to this tool result, if it's of the main loop and one is due: once per block.
	toolResult: (isMain: boolean) => string | undefined
	// A finished response of the main loop, which may hold the summary.
	reply: (text: string) => Promise<void>
	// The end of the main loop's turn (in Pi, the run).
	turnEnded: () => void
	// What /pomodoro prints for `args`.
	command: (args: string) => Promise<string>
}

export function createInstance(
	host: Host,
	options: { settings: Settings; remote: boolean; kept?: unknown },
): Instance {
	const { settings, remote } = options
	let state: State = {
		...initial,
		sentKey: typeof options.kept === 'number' ? options.kept : undefined,
	}
	// The watcher's output after its last full line, and what ends it, the minute's clock and the wake.
	let partial = ''
	let kill: (() => void) | undefined
	let cancelClock: (() => void) | undefined
	let cancelWake: (() => void) | undefined
	let isStopped = false

	// Moves the rhythm on by one event, and returns what to carry out, in order.
	function feed(event: Event) {
		const next = step(state, event, settings)
		state = next.state
		return next.effects
	}

	// Where osascript can't run (not macOS) it ends at once, and ioreg's idle time stands in, or where there's none, the
	// session's activity.
	function watch() {
		kill = host.spawn(
			WATCHER,
			(text) => {
				const lines = (partial + text).split('\n')
				partial = lines.pop() ?? ''
				for (const line of lines) feed({ type: 'input', line })
			},
			() => {
				feed({ type: 'watcherEnded' })
			},
		)
	}

	// The agent's alert, the chime, and osascript's banner where the agent raised none (macOS).
	async function alert(text: string, hasSound: boolean, mark: string) {
		const isRaised = await host.notify(text, mark).catch(() => false)
		// Ghostty shows the banner of the tab in front for a few seconds only, and a Focus silences it; not a chime.
		if (hasSound) await host.run(CHIME).catch(() => {})
		if (!isRaised) await host.run(banner(text)).catch(() => {})
	}

	async function runTick() {
		const now = await host.now()
		const timer = ((await host.load('timer')) ?? {}) as Timer
		// ioreg only when the watcher isn't there to go by; over SSH it would see the console's input.
		const systemIdleMs =
			state.lastInputThatCounts === undefined && !remote
				? ioregIdleMs(await host.run(IOREG, 5_000).catch(() => ''))
				: undefined
		for (const effect of feed({ type: 'tick', now, timer, systemIdleMs })) {
			// A tick still under way when the instance stopped carries out nothing more: its session is gone.
			if (isStopped) return
			// Each wake aims at the moment the stretch without input becomes a break, so the newest replaces the last.
			if (effect.type === 'wake') {
				cancelWake?.()
				cancelWake = host.after(
					effect.afterMs,
					() => void runTick().catch(() => {}),
				)
			}
			// ponytail: read-then-write, so two sessions ticking in the same instant can both alert
			else if (effect.type === 'persist') await host.save('timer', effect.timer)
			else if (effect.type === 'show') host.show(effect.label, effect.warning)
			else if (effect.type === 'alert')
				await alert(effect.text, effect.sound, effect.mark)
		}
	}

	// ponytail: read-then-write, so two sessions logging in the same instant can drop one
	async function log(text: string) {
		const at = await host.now()
		const repo = await host.repo()
		const checkIns = ((await host.load('checkIns')) ?? []) as CheckIn[]
		await host.save('checkIns', logged(checkIns, { at, repo, text }))
	}

	return {
		start() {
			if (cancelClock !== undefined || isStopped) return
			// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
			// ponytail: one watcher per open session; share one across sessions if many sessions matter
			if (!remote) watch()
			// A failed tick is retried by the next one.
			void runTick().catch(() => {})
			cancelClock = host.every(MINUTE, () => void runTick().catch(() => {}))
		},
		stop() {
			isStopped = true
			cancelClock?.()
			cancelWake?.()
			kill?.()
		},
		tick: runTick,
		async activity() {
			feed({ type: 'activity', now: await host.now() })
		},
		toolResult(isMain) {
			const [checkIn] = feed({ type: 'toolResult', isMain })
			if (checkIn?.type !== 'checkIn') return undefined
			host.keep(checkIn.key)
			return checkIn.text
		},
		async reply(text) {
			for (const effect of feed({ type: 'reply', text }))
				if (effect.type === 'log') await log(effect.text).catch(() => {})
		},
		turnEnded() {
			feed({ type: 'turnEnded' })
		},
		async command(args) {
			if (!['', 'today'].includes(args.trim()))
				return 'Usage: /pomodoro [today]'
			return today(
				((await host.load('checkIns')) ?? []) as CheckIn[],
				await host.now(),
			)
		},
	}
}

// Whether to sum up, and when, is the agent's call: nothing stops it or asks the person anything.
const check = (minutes: number) =>
	`[Pomodoro] The user has been working for ${minutes} minutes without a break. Carry on with the task. ` +
	'If it would help them, include in your next reply a short summary of the session so far, and whether it still ' +
	'serves the original goal, in a paragraph that starts with "Pomodoro:". Remind them to take a break.'

// 🍅 before a line, unless the setting turns it off; `word` stands in where the line needs a name to make sense.
const tomato = (settings: Settings, word = '') =>
	settings.emoji ? '🍅 ' : word

// What the person reads once the check-in went out, the same in every agent.
export const notice = (settings: Settings) =>
	`${tomato(settings)}Pomodoro: told the agent your block is up.`

function step(
	state: State,
	event: Event,
	settings: Settings,
): { state: State; effects: Effect[] } {
	switch (event.type) {
		case 'activity':
			return { state: { ...state, lastActivity: event.now }, effects: [] }
		case 'input':
			return {
				state: sawInput(state, event.line, settings.moveSeconds * 1_000),
				effects: [],
			}
		// It ended or never started: the system's idle time stands in, where every input counts.
		case 'watcherEnded':
			return {
				state: { ...state, lastInputThatCounts: undefined },
				effects: [],
			}
		case 'tick':
			return tick(state, event, settings)
		case 'toolResult':
			return toolResult(state, event.isMain)
		case 'reply':
			return reply(state, event.text)
		// No summary by the turn's end: the agent chose not to give one, or the turn was cut short.
		case 'turnEnded':
			return { state: { ...state, awaitingSummary: false }, effects: [] }
	}
}

// Keys, clicks and scrolls count at once, mouse movement once its stretch lasts `minMs`: a mouse jiggler's nudge
// (keep-awake apps) is a blip.
function sawInput(state: State, line: string, minMs: number): State {
	const isKey = line.startsWith('k')
	const at = Number(isKey ? line.slice(1) : line)
	if (!(at > 0)) return state
	const stretch = isKey
		? state.stretch
		: {
				start: at - state.stretch.last > STRETCH_GAP ? at : state.stretch.start,
				last: at,
			}
	// The first line is the input before the watcher started, as the system's idle time tells it: a reload doesn't end a
	// break.
	const counts =
		state.lastInputThatCounts === undefined ||
		isKey ||
		at - stretch.start >= minMs
	return {
		...state,
		stretch,
		lastInputThatCounts: counts
			? Math.max(state.lastInputThatCounts ?? 0, at)
			: state.lastInputThatCounts,
	}
}

function tick(
	state: State,
	{ now, timer, systemIdleMs }: Extract<Event, { type: 'tick' }>,
	settings: Settings,
): { state: State; effects: Effect[] } {
	const workMs = settings.workMinutes * MINUTE
	const breakMs = settings.breakMinutes * MINUTE
	// Time since input that counts, from the watcher; else the system's input idle time; else time since this session's
	// last activity.
	const idleMs =
		state.lastInputThatCounts !== undefined
			? now - state.lastInputThatCounts
			: (systemIdleMs ?? now - state.lastActivity)
	// The latest input any session has seen, so an idle session can't end the block another one is working in.
	const lastInput = Math.max(timer.lastInput ?? 0, now - idleMs)
	const idle = now - lastInput

	if (idle >= breakMs)
		return {
			state: { ...state, due: undefined },
			effects: [
				{ type: 'persist', timer: { seenAt: now, lastInput } },
				{ type: 'show', label: `${tomato(settings, 'pomodoro ')}on a break` },
			],
		}
	const effects: Effect[] = []
	// Ticks are a minute apart: look again the moment this stretch without input would become a break.
	if (idle > breakMs - MINUTE)
		effects.push({ type: 'wake', afterMs: breakMs - idle + 1_000 })

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

	effects.push(
		{
			type: 'persist',
			timer: {
				blockStart,
				seenAt: now,
				alertedAt: shouldAlert ? now : alertedAt,
				lastInput,
			},
		},
		{
			type: 'show',
			label: `${tomato(settings, 'pomodoro ')}${minutes}/${settings.workMinutes}m`,
			warning: isDue
				? `${tomato(settings)}${minutes}m, time for a break`
				: undefined,
		},
	)
	if (shouldAlert)
		effects.push({
			type: 'alert',
			text: `${minutes} minutes without a break. Stand up and look away from the screen for ${breakMs / MINUTE}.`,
			mark: tomato(settings),
			sound: settings.sound,
		})
	// One check-in per block that ends without a break, keyed by when that block ended.
	const due =
		isDue && settings.checkIn
			? {
					key: blockStart + Math.floor(worked / workMs) * workMs,
					text: check(minutes),
				}
			: undefined
	return { state: { ...state, due }, effects }
}

// The check-in rides a tool result of the main loop, once per block. It counts as sent from here, so two tool results
// at once can't both carry it.
function toolResult(
	state: State,
	isMain: boolean,
): { state: State; effects: Effect[] } {
	const { due } = state
	if (!isMain || due === undefined || due.key === state.sentKey)
		return { state, effects: [] }
	return {
		state: { ...state, sentKey: due.key, awaitingSummary: true },
		effects: [{ type: 'checkIn', ...due }],
	}
}

// The summary can come in any response after the check-in, mid-task too, until the turn ends.
function reply(
	state: State,
	text: string,
): { state: State; effects: Effect[] } {
	const found = state.awaitingSummary ? summary(text) : undefined
	if (found === undefined) return { state, effects: [] }
	return {
		state: { ...state, awaitingSummary: false },
		effects: [{ type: 'log', text: found }],
	}
}

// The summary the note asks for: the first paragraph of a reply that starts with "Pomodoro:", with markdown around the
// label (**Pomodoro:**) or a word before its colon (Pomodoro check-in:) allowed. Undefined: the agent didn't sum up.
const summary = (reply: string) =>
	reply
		.split(/\n\s*\n/)
		.find((paragraph) => /^[\s#>*_]*pomodoro\b[^:\n]{0,20}:/i.test(paragraph))
		?.replace(/^[\s#>*_]+/, '')
		.replaceAll('**', '')
		.trim()

// The log with `entry` added, its text cut to 4,000 characters, less the entries 14 days old.
const logged = (log: CheckIn[], entry: CheckIn): CheckIn[] => [
	...log.filter((c) => entry.at - c.at < 14 * DAY),
	{ ...entry, text: entry.text.slice(0, 4_000) },
]

// Today's check-ins at local time, under the name of their repository's folder.
function today(log: CheckIn[], now: number) {
	const day = new Date(now).toDateString()
	const byRepo = new Map<string | null, string[]>()
	for (const { at, repo, text } of log)
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
