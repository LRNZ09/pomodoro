import { spawn } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
} from '@earendil-works/pi-coding-agent'
import {
	COMMAND,
	createInstance,
	DEFAULTS,
	type Host,
	type Instance,
	type Settings,
	settingsFrom,
	tomato,
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

// What core keeps across a /reload, /resume or --continue: an entry in the session, the latest on any of its branches,
// since a block is time, not part of the conversation (a /tree back past the check-in doesn't undo it).
const KEPT = 'pomodoro'

// Pi caches this factory per path, so everything lives in its closure, set again at each session start.
export default function (pi: ExtensionAPI) {
	const dir = getAgentDir()
	// One timer per person, shared by every open Pi session, and the log of summaries after check-ins: a file each.
	const paths = {
		timer: join(dir, 'pomodoro.json'),
		checkIns: join(dir, 'pomodoro-log.json'),
	}
	const settingsPath = join(dir, 'pomodoro-settings.json')

	let settings: Settings = DEFAULTS
	// This session's instance of core (lib/core), or why there's none.
	let instance: Instance | undefined
	let off: string | undefined

	// Pi's side of core, for a session in `cwd`; `ui` only in the terminal UI.
	const host = (cwd: string, ui: ExtensionUIContext | undefined): Host => ({
		now: async () => Date.now(),
		after: (ms, fn) => {
			const timeout = setTimeout(fn, ms)
			return () => clearTimeout(timeout)
		},
		every: (ms, fn) => {
			const interval = setInterval(fn, ms)
			return () => clearInterval(interval)
		},
		load: (key) => load(paths[key]),
		save: (key, value) => save(paths[key], value),
		run: async ([file, ...args], timeoutMs) =>
			(await pi.exec(file, args, { timeout: timeoutMs })).stdout,
		// Leaving Pi ends the child.
		spawn: ([file, ...args], onOutput, onEnd) => {
			const child = spawn(file, args, {
				cwd: '/',
				stdio: ['ignore', 'pipe', 'ignore'],
			})
			child.stdout.setEncoding('utf8').on('data', onOutput)
			// Once its output is all read; an error (it couldn't start) may come with a close or alone.
			let hasEnded = false
			const ended = () => {
				if (hasEnded) return
				hasEnded = true
				onEnd()
			}
			child.on('error', ended).on('close', ended)
			return () => child.kill()
		},
		repo: async () => {
			const { code, stdout } = await pi
				.exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5_000 })
				.catch(() => ({ code: 1, stdout: '' }))
			return code === 0 ? stdout.trim() : null
		},
		// One status entry: the count, or that a break is due.
		show: (label, warning) => ui?.setStatus('pomodoro', warning ?? label),
		// Pi has no desktop notification of its own: core's osascript posts the banner (macOS).
		notify: async (text, mark) => {
			ui?.notify(`${mark}${text}`, 'warning')
			return false
		},
		keep: (kept) => pi.appendEntry(KEPT, kept),
	})

	pi.on('session_start', async (_, ctx) => {
		instance = undefined
		off = undefined
		const read = await readSettings(settingsPath)
		// No timer, as in Claude Code with a setting that doesn't fit; Claude Code says why only in its debug log.
		if ('problems' in read) {
			off = `Pomodoro is off: ${read.problems.join('; ')} (${settingsPath}).`
			ctx.ui.notify(off, 'error')
			return
		}
		settings = read
		// The clock runs where the count shows: the terminal UI. Never with -p, --mode json or RPC.
		const isTui = ctx.mode === 'tui'
		const kept = ctx.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === 'custom' && entry.customType === KEPT)
		instance = createInstance(host(ctx.cwd, isTui ? ctx.ui : undefined), {
			settings,
			remote: Boolean(process.env.SSH_CONNECTION),
			kept: kept?.type === 'custom' ? kept.data : undefined,
		})
		if (isTui) instance.start()
		// The smoke test (scripts/pi-smoke.ts) runs where the clock never starts: EVAL_POMODORO_TICK makes one tick, on the
		// timer it stored, before the first prompt.
		else if (process.env.EVAL_POMODORO_TICK) await instance.tick()
	})

	pi.on('session_shutdown', () => {
		instance?.stop()
	})

	pi.on('input', async () => {
		await instance?.activity()
	})

	// The check rides a tool result of the agent's own: it reads it mid-run, and it never waits in an idle session.
	pi.on('tool_result', async (e, ctx) => {
		await instance?.activity()
		const checkIn = instance?.toolResult(e.parentToolCallId === undefined)
		if (checkIn === undefined) return
		ctx.ui.notify(
			`${tomato(settings)}Pomodoro: told the agent your block is up.`,
			'info',
		)
		// Replacing the content drops the structured content unless it comes back too.
		return {
			content: [...e.content, { type: 'text', text: checkIn }],
			structuredContent: e.structuredContent,
		}
	})

	// A finished response of the agent's. One cut short (an error, Escape, the length limit) ends here too, with its
	// partial text: it's not a reply, as a retry may finish it.
	pi.on('message_end', async (e) => {
		const { message } = e
		if (
			!('role' in message) ||
			message.role !== 'assistant' ||
			!['stop', 'toolUse'].includes(message.stopReason)
		)
			return
		await instance?.reply(
			message.content
				.map((part) => (part.type === 'text' ? part.text : ''))
				.join('\n\n'),
		)
	})

	// Pi is done with the run, retries and compaction included (agent_end can come before them).
	pi.on('agent_settled', () => {
		instance?.turnEnded()
	})

	pi.registerCommand(COMMAND.name, {
		description: COMMAND.description,
		handler: async (args, ctx) => {
			ctx.ui.notify(
				(await instance?.command(args)) ?? off ?? '',
				off === undefined ? 'info' : 'error',
			)
		},
	})
}
