// The work-and-break rhythm the pomodoro plugins share. It's pure: step() says what to do, and each agent's plugin
// carries that out with its own APIs.

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
export type State = {
	lastActivity: number
	stretch: { start: number; last: number }
	lastInputThatCounts?: number
	due?: { key: number; text: string }
	sentKey?: number
	awaitingSummary: boolean
}

export type Event =
	// A prompt or a tool call.
	| { type: 'activity'; now: number }
	// A line the watcher printed.
	| { type: 'input'; line: string }
	| { type: 'watcherEnded' }
	// The minute's tick, with the stored timer and the system's input idle time where the agent reads one.
	| { type: 'tick'; now: number; timer: Timer; systemIdleMs?: number }
	| { type: 'toolResult'; isMain: boolean }
	// A finished response of the main loop, and the end of its turn (in Pi, the run).
	| { type: 'reply'; text: string }
	| { type: 'turnEnded' }

// In the order to carry them out.
export type Effect =
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

export const initial: State = {
	lastActivity: 0,
	stretch: { start: 0, last: 0 },
	awaitingSummary: false,
}

// The command that runs a macOS JXA script, which prints the time of the latest input each time it changes (macOS HID
// idle time, 4 times a second), and with a `k` before it the time of the latest key, click or scroll: a mouse jiggler
// only moves the pointer.
export const WATCHER = [
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
export function ioregIdleMs(stdout: string) {
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

// /pomodoro, and what it prints for `args`.
export const COMMAND = {
	name: 'pomodoro',
	description: "Lists today's check-ins by repository.",
}
export const command = (args: string, log: CheckIn[], now: number) =>
	['', 'today'].includes(args.trim())
		? today(log, now)
		: 'Usage: /pomodoro [today]'

// Whether to sum up, and when, is the agent's call: nothing stops it or asks the person anything.
const check = (minutes: number) =>
	`[Pomodoro] The user has been working for ${minutes} minutes without a break. Carry on with the task. ` +
	'If it would help them, include in your next reply a short summary of the session so far, and whether it still ' +
	'serves the original goal, in a paragraph that starts with "Pomodoro:". Remind them to take a break.'

// 🍅 before a line, unless the setting turns it off; `word` stands in where the line needs a name to make sense.
export const tomato = (settings: Settings, word = '') =>
	settings.emoji ? '🍅 ' : word

export function step(
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
	// One check per work period without a break, keyed by when that period ended.
	const due =
		isDue && settings.checkIn
			? {
					key: blockStart + Math.floor(worked / workMs) * workMs,
					text: check(minutes),
				}
			: undefined
	return { state: { ...state, due }, effects }
}

// The check-in rides a tool result of the main loop, once per work period. It counts as sent from here, so two tool
// results at once can't both carry it.
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
export const summary = (reply: string) =>
	reply
		.split(/\n\s*\n/)
		.find((paragraph) => /^[\s#>*_]*pomodoro\b[^:\n]{0,20}:/i.test(paragraph))
		?.replace(/^[\s#>*_]+/, '')
		.replaceAll('**', '')
		.trim()

// The log with `entry` added, its text cut to 4,000 characters, less the entries 14 days old.
export const logged = (log: CheckIn[], entry: CheckIn): CheckIn[] => [
	...log.filter((c) => entry.at - c.at < 14 * DAY),
	{ ...entry, text: entry.text.slice(0, 4_000) },
]

// Today's check-ins at local time, under the name of their repository's folder.
export function today(log: CheckIn[], now: number) {
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
