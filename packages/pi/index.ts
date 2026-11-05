import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
	type ExecOptions,
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
} from '@earendil-works/pi-coding-agent'
import {
	banner,
	CHIME,
	type CheckIn,
	COMMAND,
	command,
	DEFAULTS,
	type Event,
	IOREG,
	initial,
	ioregIdleMs,
	logged,
	MINUTE,
	type Settings,
	settingsFrom,
	step,
	type Timer,
	tomato,
	WATCHER,
} from './core'

// A file's JSON, or undefined when it's missing or unreadable.
const load = (path: string): Promise<unknown> =>
	readFile(path, 'utf8')
		.then(JSON.parse)
		.catch(() => undefined)

// Through a temp file, so a reader never sees half a file.
async function save(path: string, value: unknown) {
	await writeFile(`${path}.${process.pid}`, JSON.stringify(value))
	await rename(`${path}.${process.pid}`, path)
}

// The file's settings, the defaults without one, or what's wrong with it.
async function readSettings(path: string) {
	const text = await readFile(path, 'utf8').catch(
		(error: NodeJS.ErrnoException) => error,
	)
	if (text instanceof Error)
		return text.code === 'ENOENT'
			? DEFAULTS
			: { problems: [`the file can't be read (${text.code})`] }
	try {
		return settingsFrom(JSON.parse(text))
	} catch {
		return { problems: ["the file isn't valid JSON"] }
	}
}

// Pi caches this factory per path, so everything lives in its closure, set again at each session start.
export default function (pi: ExtensionAPI) {
	const dir = getAgentDir()
	// One timer per person, shared by every open Pi session; the log of summaries after check-ins; the settings.
	const timerPath = join(dir, 'pomodoro.json')
	const logPath = join(dir, 'pomodoro-log.json')
	const settingsPath = join(dir, 'pomodoro-settings.json')

	let settings: Settings = DEFAULTS
	// ponytail: a /reload or /resume starts the extension over and forgets the check-in it sent, so one can come again
	let state = initial
	// While a terminal session runs: its UI, the input watcher, the minute's tick, and the tick at a break's start.
	let ui: ExtensionUIContext | undefined
	let watcher: ChildProcess | undefined
	let interval: ReturnType<typeof setInterval> | undefined
	let wake: ReturnType<typeof setTimeout> | undefined

	// Runs a command line from lib/core.
	const run = ([file, ...args]: string[], options?: ExecOptions) =>
		pi.exec(file, args, options)

	// Moves the rhythm on by one event (lib/core), and returns what to carry out, in order.
	function feed(event: Event) {
		const next = step(state, event, settings)
		state = next.state
		return next.effects
	}

	// Leaving Pi or the session ends the child; where osascript can't run (not macOS) it ends at once.
	function watch() {
		const [file, ...args] = WATCHER
		const child = spawn(file, args, {
			cwd: '/',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		watcher = child
		createInterface({ input: child.stdout }).on('line', (line) =>
			feed({ type: 'input', line }),
		)
		// It ended or never started: ioreg stands in, where every input counts.
		const ended = () => {
			if (watcher !== child) return
			watcher = undefined
			feed({ type: 'watcherEnded' })
		}
		child.on('error', ended).on('exit', ended)
	}

	// macOS input idle time (undefined: none to read, as off macOS).
	async function readIdleMs() {
		const { stdout } = await run(IOREG, { timeout: 5_000 }).catch(() => ({
			stdout: '',
		}))
		return ioregIdleMs(stdout)
	}

	// Pi has no desktop notification of its own: osascript posts the banner (macOS).
	async function alert(text: string, hasSound: boolean, mark: string) {
		ui?.notify(`${mark}${text}`, 'warning')
		if (hasSound) await run(CHIME).catch(() => {})
		await run(banner(text)).catch(() => {})
	}

	async function tick() {
		const now = Date.now()
		const timer = ((await load(timerPath)) ?? {}) as Timer
		// ioreg only when the watcher isn't there to go by; over SSH it would see the console's input.
		const systemIdleMs =
			state.lastInputThatCounts === undefined && !process.env.SSH_CONNECTION
				? await readIdleMs()
				: undefined
		// Each wake aims at the moment the stretch without input becomes a break, so the newest replaces the last.
		for (const effect of feed({ type: 'tick', now, timer, systemIdleMs }))
			if (effect.type === 'wake') {
				clearTimeout(wake)
				wake = setTimeout(() => void tick().catch(() => {}), effect.afterMs)
			}
			// ponytail: read-then-write, so two sessions ticking in the same instant can both alert
			else if (effect.type === 'persist') await save(timerPath, effect.timer)
			// One status entry: the count, or that a break is due.
			else if (effect.type === 'show')
				ui?.setStatus('pomodoro', effect.warning ?? effect.label)
			else if (effect.type === 'alert')
				await alert(effect.text, effect.sound, effect.mark)
	}

	// ponytail: read-then-write, so two sessions logging in the same instant can drop one
	async function logSummary(text: string, cwd: string) {
		const at = Date.now()
		const { code, stdout } = await pi
			.exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5_000 })
			.catch(() => ({ code: 1, stdout: '' }))
		const log = ((await load(logPath)) ?? []) as CheckIn[]
		await save(
			logPath,
			logged(log, { at, repo: code === 0 ? stdout.trim() : null, text }),
		)
	}

	pi.on('session_start', async (_, ctx) => {
		const read = await readSettings(settingsPath)
		state = initial
		// No timer, as in Claude Code with a setting that doesn't fit; Claude Code says why only in its debug log.
		if ('problems' in read) {
			ctx.ui.notify(
				`Pomodoro is off: ${read.problems.join('; ')} (${settingsPath}).`,
				'error',
			)
			return
		}
		settings = read
		// The clock runs where the count shows: the terminal UI. Never with -p, --mode json or RPC.
		if (ctx.mode === 'tui') {
			ui = ctx.ui
			// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
			if (!process.env.SSH_CONNECTION) watch()
			// A failed tick is retried by the next one.
			void tick().catch(() => {})
			interval = setInterval(() => void tick().catch(() => {}), MINUTE)
		}
		// The smoke test (scripts/pi-smoke.ts) runs where the clock never starts: EVAL_POMODORO_TICK makes one tick, on the
		// timer it stored, before the first prompt.
		else if (process.env.EVAL_POMODORO_TICK) await tick()
	})

	pi.on('session_shutdown', () => {
		clearInterval(interval)
		clearTimeout(wake)
		watcher?.kill()
		watcher = undefined
		ui = undefined
	})

	pi.on('input', () => {
		feed({ type: 'activity', now: Date.now() })
	})

	// The check rides a tool result of the agent's own: it reads it mid-run, and it never waits in an idle session.
	pi.on('tool_result', async (e, ctx) => {
		feed({ type: 'activity', now: Date.now() })
		const [checkIn] = feed({
			type: 'toolResult',
			isMain: e.parentToolCallId === undefined,
		})
		if (checkIn?.type !== 'checkIn') return
		ctx.ui.notify(
			`${tomato(settings)}Pomodoro: told the agent your work block is up.`,
			'info',
		)
		// Replacing the content drops the structured content unless it comes back too.
		return {
			content: [...e.content, { type: 'text', text: checkIn.text }],
			structuredContent: e.structuredContent,
		}
	})

	// A finished response of the agent's. One cut short (an error, Escape, the length limit) ends here too, with its
	// partial text: it's not a reply, as a retry may finish it.
	pi.on('message_end', async (e, ctx) => {
		const { message } = e
		if (
			!('role' in message) ||
			message.role !== 'assistant' ||
			!['stop', 'toolUse'].includes(message.stopReason)
		)
			return
		const text = message.content
			.map((part) => (part.type === 'text' ? part.text : ''))
			.join('\n\n')
		for (const effect of feed({ type: 'reply', text }))
			if (effect.type === 'log')
				await logSummary(effect.text, ctx.cwd).catch(() => {})
	})

	// Pi is done with the run, retries and compaction included (agent_end can come before them).
	pi.on('agent_settled', () => {
		feed({ type: 'turnEnded' })
	})

	pi.registerCommand(COMMAND.name, {
		description: COMMAND.description,
		handler: async (args, ctx) => {
			ctx.ui.notify(
				command(args, ((await load(logPath)) ?? []) as CheckIn[], Date.now()),
				'info',
			)
		},
	})
}
