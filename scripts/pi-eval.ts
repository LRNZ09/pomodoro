// Runs the check-in evals' cases through Pi with the extension and prints Pi's row of the README's pass-rate table:
// where the agent stopped. It runs the Pi that packages/pi builds against, with your Pi login and default model.
// Usage: bun run eval:pi [runs per case, default 10] [more pi flags, like --model sonnet]
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

type Case = {
	context?: { scaffold_script?: string }
	execution: { prompt: string; env: { EVAL_POMODORO_CHECK_IN_DUE: string } }
}

const extension = resolve('packages/pi')
const pi = resolve('packages/pi/node_modules/@earendil-works/pi-coding-agent')
const { version } = await Bun.file(`${pi}/package.json`).json()
const runs = Number(process.argv[2] ?? 10)
const piFlags = process.argv.slice(3)

// The Claude evals' cases, and where the agent should have stopped: their graders for it.
// shortcut: no judge for the checked-in columns; run one if Pi's row matters as much as Claude's
const CASES = [
	{
		name: 'check-in',
		stopped: async (dir: string) => !existsSync(join(dir, 'step2.txt')),
	},
	{
		name: 'check-in-atomic',
		stopped: async (dir: string) =>
			/^\s*500\s*$/.test(
				await readFile(join(dir, 'b.txt'), 'utf8').catch(() => ''),
			) && !existsSync(join(dir, 'hello.txt')),
	},
]

const models = new Set<string>()
let isComplete = true
const cells: string[] = []
for (const { name, stopped } of CASES) {
	const caseDir = resolve('packages/claude/evals', name)
	const { context, execution } = Bun.YAML.parse(
		await Bun.file(join(caseDir, 'case.yaml')).text(),
	) as Case
	let stoppedRight = 0
	let errored = 0
	for (let run = 0; run < runs; run++) {
		const dir = await mkdtemp(join(tmpdir(), 'pi-eval-'))
		if (context?.scaffold_script)
			await $`bash ${join(caseDir, context.scaffold_script)}`.cwd(dir).quiet()
		const { stdout } =
			await $`node ${pi}/dist/bundle/cli.js --mode json -p --no-session -ne -nc -e ${extension} --tools read,write ${piFlags} ${execution.prompt}`
				.cwd(dir)
				.env({
					...process.env,
					EVAL_POMODORO_CHECK_IN_DUE: execution.env.EVAL_POMODORO_CHECK_IN_DUE,
				})
				.nothrow()
				.quiet()
		const last = stdout
			.toString()
			.split('\n')
			.filter((line) => line.startsWith('{'))
			.map((line) => JSON.parse(line))
			.filter(
				(e) => e.type === 'message_end' && e.message?.role === 'assistant',
			)
			.at(-1)?.message
		// A run that ended on an error says nothing about the check-in.
		if (last === undefined || ['error', 'aborted'].includes(last.stopReason))
			errored++
		else {
			models.add(last.model)
			if (await stopped(dir)) stoppedRight++
		}
		await rm(dir, { recursive: true, force: true })
	}
	const graded = runs - errored
	if (graded === 0 || errored > 0) isComplete = false
	cells.push(
		`${stoppedRight}/${graded}${errored > 0 ? ` (${errored} errored)` : ''}`,
		'—',
	)
}

const date = new Date().toISOString().slice(0, 10)
console.log(`| Pi (${[...models].join(', ')}) | ${cells.join(' | ')} |

Pi ${version}, ${date}. Its checked-in columns need a judge, which this run doesn't have.`)
if (!isComplete) process.exitCode = 1
