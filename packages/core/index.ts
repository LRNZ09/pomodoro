// The work-and-break rhythm the pomodoro plugins share. It's pure: step() says what to do, and each agent's plugin
// carries that out with its own APIs.

// Shared by every open session through the agent's store: one pomodoro per person, not per session.
export type Timer = {
	blockStart?: number
	seenAt?: number
	alertedAt?: number
	lastInput?: number
}
// The agent's answer to a check-in, kept for /pomodoro today.
export type CheckIn = { at: number; repo: string | null; text: string }
// The plugin's settings as the agent stores them, read the way each one needs: Number(), `=== true`, or truthy.
export type Settings = Readonly<
	Partial<
		Record<
			| 'workMinutes'
			| 'breakMinutes'
			| 'moveSeconds'
			| 'sound'
			| 'checkIn'
			| 'emoji',
			unknown
		>
	>
>

// One session's own: its last prompt or tool call, the stretch of mouse movement under way, the last input that counts
// (undefined: no watcher), the check-in now due, the last one sent, and the eval's main-loop tool results still to come
// before its check-in is due (0: none to come).
export type State = {
	lastActivity: number
	stretch: { start: number; last: number }
	lastInputThatCounts?: number
	due?: { key: number; text: string }
	sentKey?: number
	evalCheckInIn: number
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
	// The check-in a tool result was given goes back to waiting: git is partway through a rebase or the like.
	| { type: 'checkInHeld'; key: number }
	// The eval runs where the clock never starts: the check-in is due with the main loop's Nth tool result.
	| { type: 'forceDue'; afterToolResults: number }

// In the order to carry them out.
export type Effect =
	// Tick again this much later.
	| { type: 'wake'; afterMs: number }
	// Store the shared timer.
	| { type: 'persist'; timer: Timer }
	// The count, and the warning while a break is due.
	| { type: 'show'; label: string; warning?: string }
	| { type: 'alert'; text: string; mark: string; sound: boolean }
	// Add `text` to this tool result, or answer checkInHeld to keep it for a later one.
	| { type: 'checkIn'; key: number; text: string }

export const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// Movement less than this apart is one stretch; the watcher looks 4 times a second.
const STRETCH_GAP = 1_000

export const initial: State = {
	lastActivity: 0,
	stretch: { start: 0, last: 0 },
	evalCheckInIn: 0,
}

// A macOS JXA script, run with `osascript -l JavaScript -e`. Prints the time of the latest input each time it changes
// (macOS HID idle time, 4 times a second), and with a `k` before it the time of the latest key, click or scroll: a
// mouse jiggler only moves the pointer.
export const WATCHER = `ObjC.import('CoreGraphics')
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

// What git keeps in its directory while a rebase, merge, cherry-pick or revert is under way, stopped on a conflict say.
// The agent mustn't be stopped there: its plugin answers checkInHeld while any of them exists.
export const GIT_UNDER_WAY = [
	'rebase-merge',
	'rebase-apply',
	'MERGE_HEAD',
	'CHERRY_PICK_HEAD',
	'REVERT_HEAD',
]

const check = (minutes: number) =>
	`[Pomodoro] The user has been working for ${minutes} minutes without a break. ` +
	'Pause at the first point where nothing you started is left half-applied. If you are partway through one operation that leaves code, data or the repository ' +
	"inconsistent until its last step (a migration, a rebase, a rename whose other call sites don't build yet), finish that operation and nothing more. " +
	'Otherwise stop now: failures that were there before it, and further fixes, files or steps that each stand on their own, are not half-applied. ' +
	'Start nothing new, then tell them in at most three short lines: ' +
	'what was done since the break, whether it still serves the original goal or has drifted into a side problem, and what you would do next. ' +
	'Remind them to take a short break, then end your turn without asking anything: a menu will ask them whether to go on.'

// 🍅 before a line, unless the setting turns it off; `word` stands in where the line needs a name to make sense.
export const tomato = (settings: Settings, word = '') =>
	settings.emoji === true ? '🍅 ' : word

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
				state: sawInput(
					state,
					event.line,
					Number(settings.moveSeconds) * 1_000,
				),
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
			return toolResult(state, event.isMain, settings)
		// Unless a later tool result has since been given a later check-in.
		case 'checkInHeld':
			return {
				state:
					state.sentKey === event.key
						? { ...state, sentKey: undefined }
						: state,
				effects: [],
			}
		case 'forceDue':
			return {
				state: settings.checkIn
					? { ...state, evalCheckInIn: event.afterToolResults || 0 }
					: state,
				effects: [],
			}
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
	const workMs = Number(settings.workMinutes) * MINUTE
	const breakMs = Math.max(1, Number(settings.breakMinutes)) * MINUTE
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
			sound: settings.sound === true,
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
	settings: Settings,
): { state: State; effects: Effect[] } {
	if (!isMain) return { state, effects: [] }
	const due =
		state.evalCheckInIn === 1
			? { key: 0, text: check(Number(settings.workMinutes)) }
			: state.due
	const counted = {
		...state,
		due,
		evalCheckInIn: Math.max(0, state.evalCheckInIn - 1),
	}
	if (due === undefined || due.key === state.sentKey)
		return { state: counted, effects: [] }
	return {
		state: { ...counted, sentKey: due.key },
		effects: [{ type: 'checkIn', ...due }],
	}
}

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
