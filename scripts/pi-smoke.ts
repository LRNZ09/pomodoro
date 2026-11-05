// Runs Pi with the extension against a scripted model on localhost, on a stored timer whose block is up. Fails unless
// Pi's tick makes the check-in due without an alert, and the check-in rides the first tool result and reaches the
// model, once; and unless nothing ticks with a settings file that doesn't fit. No login, so CI runs it against each Pi
// it checks.
// Usage: bun scripts/pi-smoke.ts (after bun run build)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULTS, MINUTE, type Timer } from '../lib/core'

const pi = resolve('packages/pi/node_modules/@earendil-works/pi-coding-agent')
const { version, bin } = await Bun.file(`${pi}/package.json`).json()

// The model writes a.txt, then b.txt, then answers, by how many tool results it has been sent.
const replies = [
	{ tool: { name: 'write', arguments: { path: 'a.txt', content: '1' } } },
	{ tool: { name: 'write', arguments: { path: 'b.txt', content: '2' } } },
	{ text: 'Done.' },
]
const chunk = (body: object) =>
	`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'smoke', ...body })}\n\n`
// What the latest tool result in each request of the current run held: the check-in, or not.
let seen: boolean[] = []
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { messages } = (await request.json()) as {
			messages: { role: string; content: unknown }[]
		}
		const results = messages.filter((m) => m.role === 'tool')
		if (results.length > 0)
			seen.push(JSON.stringify(results.at(-1)?.content).includes('[Pomodoro]'))
		const reply = replies[Math.min(results.length, replies.length - 1)]
		const delta = reply?.tool
			? {
					role: 'assistant',
					tool_calls: [
						{
							index: 0,
							id: `call_${results.length}`,
							type: 'function',
							function: {
								name: reply.tool.name,
								arguments: JSON.stringify(reply.tool.arguments),
							},
						},
					],
				}
			: { role: 'assistant', content: reply?.text }
		return new Response(
			chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
				chunk({
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: reply?.tool ? 'tool_calls' : 'stop',
						},
					],
				}) +
				chunk({
					choices: [],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}) +
				'data: [DONE]\n\n',
			{ headers: { 'content-type': 'text/event-stream' } },
		)
	},
})

// One run of Pi in a new agent dir, with `settings` as its settings file; what `seen` held, whether Pi's tick stored the
// timer and whether it alerted, and Pi's stderr.
async function run(settings?: string) {
	seen = []
	const agentDir = await mkdtemp(join(tmpdir(), 'pi-smoke-agent-'))
	const workDir = await mkdtemp(join(tmpdir(), 'pi-smoke-work-'))
	// A block just up, its alert given, and input just now (whatever ioreg says): a tick makes the check-in due, and
	// alerts or wakes for nothing.
	const now = Date.now()
	const seeded: Timer = {
		blockStart: now - DEFAULTS.workMinutes * MINUTE,
		seenAt: now,
		alertedAt: now,
		lastInput: now,
	}
	await writeFile(join(agentDir, 'pomodoro.json'), JSON.stringify(seeded))
	if (settings)
		await writeFile(join(agentDir, 'pomodoro-settings.json'), settings)
	await writeFile(
		join(agentDir, 'models.json'),
		JSON.stringify({
			providers: {
				smoke: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					api: 'openai-completions',
					apiKey: 'smoke',
					models: [
						{
							id: 'smoke',
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	)
	// Spawned, not run synchronously: this process answers the model's requests meanwhile.
	const child = Bun.spawn(
		[
			'node',
			join(pi, typeof bin === 'string' ? bin : bin.pi),
			'--mode',
			'json',
			'-p',
			'--no-session',
			'-ne',
			'-nc',
			'-e',
			resolve('packages/pi'),
			'--tools',
			'read,write',
			'--model',
			'smoke/smoke',
			'Write a.txt, then b.txt.',
		],
		{
			cwd: workDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				EVAL_POMODORO_TICK: '1',
			},
			stdout: 'ignore',
			stderr: 'pipe',
		},
	)
	const timeout = setTimeout(() => child.kill(), 60_000)
	const stderr = await new Response(child.stderr).text()
	await child.exited
	clearTimeout(timeout)
	const timer: Timer = JSON.parse(
		await readFile(join(agentDir, 'pomodoro.json'), 'utf8'),
	)
	await rm(agentDir, { recursive: true, force: true })
	await rm(workDir, { recursive: true, force: true })
	return {
		seen,
		ticked: timer.seenAt !== seeded.seenAt,
		alerted: timer.alertedAt !== seeded.alertedAt,
		stderr,
	}
}

for (const [settings, seen, ticked, what] of [
	[
		undefined,
		[true, false],
		true,
		'came due with a tick, rode the first tool result and reached the model once',
	],
	[
		'{ "workMinutes": 0 }',
		[false, false],
		false,
		'stayed off with workMinutes 0',
	],
	[
		'{ "workMinutes": 50',
		[false, false],
		false,
		'stayed off with a broken file',
	],
] as const) {
	const { stderr, ...got } = await run(settings)
	const expected = { seen, ticked, alerted: false }
	if (JSON.stringify(got) !== JSON.stringify(expected)) {
		console.error(
			`Pi ${version}${settings ? ` with ${settings}` : ''}: ${JSON.stringify(got)}, not ${JSON.stringify(expected)}.\n${stderr}`,
		)
		process.exit(1)
	}
	console.log(`Pi ${version}: the check-in ${what}.`)
}
server.stop(true)
