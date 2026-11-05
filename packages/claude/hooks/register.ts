import type { EngineInterface, Register } from 'claude-code'
import {
	COMMAND,
	createInstance,
	type Host,
	type Instance,
	type Settings,
	settingsFrom,
	tomato,
} from './core'

// What core keeps across a reload, in $.state: a reload (a /config change) starts the module over, not the session.
// The key is named for what it holds, the number 0.6.1 kept there too, so an update doesn't repeat a check-in.
const KEPT = { plugin: 'pomodoro', key: 'sentKey' } as const
const LABEL = { plugin: 'pomodoro', key: 'label' } as const

// This session's instance of core (lib/core), from its start.
let instance: Instance | undefined

// Claude Code's side of core: the engine's clock, store, processes and UI, through the session's start's `$`.
function host($: EngineInterface): Host {
	return {
		now: () => $.clock.now(),
		after: (ms, fn) => {
			const timer = $.clock.after(ms, fn)
			return () => timer.cancel()
		},
		every: (ms, fn) => {
			const timer = $.clock.every(ms, fn)
			return () => timer.cancel()
		},
		load: (key) => $.store.get(key),
		save: (key, value) => $.store.set(key, value),
		run: async (argv, timeoutMs) =>
			(await $.process.run(argv, { cwd: '/', timeoutMs })).stdout,
		// Leaving the loop, or the module unloading, ends the child.
		spawn: (argv, onOutput, onEnd) => {
			const child = $.process.spawn({ argv, cwd: '/' })
			void (async () => {
				try {
					for await (const { stream, text } of child)
						if (stream === 'stdout') onOutput(text)
				} catch {}
				onEnd()
			})()
			return () =>
				void child.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
		},
		repo: async () => (await $.session.repo())?.root ?? null,
		// The count is a mode label in the prompt footer. The status line, which Claude Code marks ⚠, only says a break
		// is due.
		show: (label, warning) => {
			void $.state.set(LABEL, label).catch(() => {})
			$.ui.status(warning)
		},
		// osascript only where the terminal can't raise one; notifications turned off stay off (macOS).
		notify: async (text, mark) => {
			$.ui.toast(`${mark}${text}`, { timeoutMs: 15_000 })
			const sent = await $.ui
				.notify(text, { title: 'Pomodoro' })
				.catch(() => undefined)
			return (
				sent !== undefined &&
				(sent.isSent ||
					(sent.reason !== 'no-channel' && sent.reason !== 'no-surface'))
			)
		},
		keep: (kept) => void $.state.set(KEPT, kept).catch(() => {}),
	}
}

// The clock runs where the count shows: an interactive terminal session. Never in -p, VS Code or the desktop app.
async function begin(
	$: EngineInterface,
	settings: Settings,
	isInteractive: boolean,
) {
	const kept = await $.state.get(KEPT).then(
		(read) => read.value,
		() => undefined,
	)
	// Like ioreg, the watcher sees the console's input, not the input of an SSH session.
	const remote = Boolean(await $.env.get('SSH_CONNECTION'))
	if (instance !== undefined) return
	instance = createInstance(host($), { settings, remote, kept })
	if (isInteractive) instance.start()
}

export const register: Register = (on, options) => {
	// Claude Code has checked them against plugin.json, but hands an empty one on. A problem left fails the load, as its
	// own check does.
	const read = settingsFrom(options)
	if ('problems' in read) throw new Error(read.problems.join('; '))
	const settings = read
	on('session.start', async ($, e, next) => {
		await $.command
			.register({ ...COMMAND, argumentHint: 'today' })
			.catch(() => {})
		await begin($, settings, e.isInteractive)
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

	on('prompt.submit', async (_, e, next) => {
		await instance?.activity()
		return next(e)
	})

	// The check rides a tool result of the main loop: Claude reads it mid-turn, and it never waits in an idle session.
	on('tool.call', async ($, e, next) => {
		await instance?.activity()
		const ran = await next(e)
		if (ran.deny !== undefined) return ran
		const checkIn = instance?.toolResult(e.agentId === undefined)
		if (checkIn === undefined) return ran
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
		return { ...ran, context: [...(ran.context ?? []), checkIn] }
	})

	// A response of the main loop.
	on('turn.step', async function* (_, e, next) {
		const response = yield* next(e)
		if (e.agentId === undefined) await instance?.reply(response.answer)
		return response
	})

	// The main loop's turn ended, answered or cut short.
	on('turn.complete', async (_, e, next) => {
		const ended = await next(e)
		if (e.agentId === undefined) instance?.turnEnded()
		return ended
	})

	on('command.run', { command: COMMAND.name }, async (_, e) => ({
		text: (await instance?.command(e.args)) ?? '',
	}))
}
