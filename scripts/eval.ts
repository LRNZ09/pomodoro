// Runs the check-in evals on each model and prints the README's pass-rate table. Costs tokens on your login.
// Usage: bun run eval [runs per model and case, default 10]
import { rm } from 'node:fs/promises'
import { $ } from 'bun'

type Run = {
	passed: boolean
	error: string | null
	graders: { name: string; passed: boolean }[]
}

const MODELS = ['haiku', 'sonnet', 'opus']
// Each case's graders for where Claude stopped, shown apart from all its graders: a model can stop in the right
// place and still miss a line of the summary.
const CASES = [
	{ name: 'check-in', stopped: ['paused'] },
	{ name: 'check-in-atomic', stopped: ['finished', 'stopped'] },
]
const runs = Number(process.argv[2] ?? 10)
const results = 'evals/results'
const { version } = await Bun.file('.claude-plugin/plugin.json').json()

const rows: string[] = []
let claudeVersion = ''
let isComplete = true
for (const model of MODELS) {
	const json = `${results}/${model}.json`
	await rm(json, { force: true })
	// It exits 1 when any run ends on an API error, whatever the scores: the JSON still holds the others.
	// --scaffold runs the cases' own scaffold scripts, which seed the transfer's two balances.
	await $`claude plugin eval . --model ${model} --runs ${runs} --ablation none --trust-plugin --scaffold --allow-tools Read Write --no-publish --threshold 0 --json ${json} --output-dir ${results}/${model}`.nothrow()
	if (!(await Bun.file(json).exists())) {
		isComplete = false
		rows.push(`| ${model} | no result |`)
		continue
	}
	const result = await Bun.file(json).json()
	claudeVersion = result.claudeVersion
	const cells = CASES.flatMap(({ name, stopped }) => {
		const all: Run[] =
			result.cases.find((c: { name: string }) => c.name === name)?.arms.with ??
			[]
		// A run that ended on an API error scores 0 without grading, so it says nothing about the check-in.
		const graded = all.filter((run) => !run.error)
		const errored = all.length - graded.length
		if (graded.length === 0 || errored > 0) isComplete = false
		const stoppedRight = graded.filter((run) =>
			stopped.every((name) =>
				run.graders.some((g) => g.name === name && g.passed),
			),
		).length
		return [
			`${stoppedRight}/${graded.length}`,
			`${graded.filter((run) => run.passed).length}/${graded.length}${errored > 0 ? ` (${errored} errored)` : ''}`,
		]
	})
	rows.push(
		`| ${model[0]?.toUpperCase() + model.slice(1)} | ${cells.join(' | ')} |`,
	)
}

const date = new Date().toISOString().slice(0, 10)
console.log(`| Model | Paused between steps | Paused and checked in | Finished a transfer, then stopped | Finished and checked in |
| ----- | -------------------- | --------------------- | --------------------------------- | ----------------------- |
${rows.join('\n')}

Plugin ${version}, Claude Code ${claudeVersion}, ${date}.`)
if (!isComplete) process.exitCode = 1
