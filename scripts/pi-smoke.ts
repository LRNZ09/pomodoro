// Runs Pi with the extension against a scripted model on localhost, and fails unless the check-in rides the first tool
// result and reaches the model, once. No login, so CI runs it against each Pi it checks.
// Usage: bun scripts/pi-smoke.ts (after bun run build)
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
// What the latest tool result in each request held: the check-in, or not.
const seen: boolean[] = []
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

const agentDir = await mkdtemp(join(tmpdir(), 'pi-smoke-agent-'))
const workDir = await mkdtemp(join(tmpdir(), 'pi-smoke-work-'))
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
const run = Bun.spawn(
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
			EVAL_POMODORO_CHECK_IN_DUE: '1',
		},
		stdout: 'ignore',
		stderr: 'pipe',
	},
)
const timeout = setTimeout(() => run.kill(), 60_000)
const stderr = await new Response(run.stderr).text()
await run.exited
clearTimeout(timeout)
server.stop(true)
await rm(agentDir, { recursive: true, force: true })
await rm(workDir, { recursive: true, force: true })

const expected = [true, false]
if (JSON.stringify(seen) !== JSON.stringify(expected)) {
	console.error(
		`Pi ${version}: the check-in in the model's requests was ${JSON.stringify(seen)}, not ${JSON.stringify(expected)}.\n${stderr}`,
	)
	process.exit(1)
}
console.log(
	`Pi ${version}: the check-in rode the first tool result and reached the model once.`,
)
