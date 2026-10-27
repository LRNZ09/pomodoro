// Runs the check-in eval on each model and prints the README's pass-rate table. Costs tokens on your login.
// Usage: bun run eval [runs per model, default 10]
import { rm } from 'node:fs/promises'
import { $ } from 'bun'

type Run = {
	passed: boolean
	error: string | null
	graders: { name: string; passed: boolean }[]
}

const MODELS = ['haiku', 'sonnet', 'opus']
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
	await $`claude plugin eval . --model ${model} --runs ${runs} --ablation none --trust-plugin --allow-tools Read Write --no-publish --threshold 0 --json ${json} --output-dir ${results}/${model}`.nothrow()
	if (!(await Bun.file(json).exists())) {
		isComplete = false
		rows.push(`| ${model} | no result |`)
		continue
	}
	const result = await Bun.file(json).json()
	claudeVersion = result.claudeVersion
	const all: Run[] = result.cases.flatMap(
		(c: { arms: { with: Run[] } }) => c.arms.with,
	)
	// A run that ended on an API error scores 0 without grading, so it says nothing about the check-in.
	const graded = all.filter((run) => !run.error)
	const errored = all.length - graded.length
	if (errored > 0) isComplete = false
	// Stopping and checking in fully apart: a model can pause and still miss a line of the summary.
	const paused = graded.filter((run) =>
		run.graders.some((g) => g.name === 'paused' && g.passed),
	).length
	const name = model[0]?.toUpperCase() + model.slice(1)
	rows.push(
		`| ${name} | ${paused}/${graded.length} | ${graded.filter((run) => run.passed).length}/${graded.length}${errored > 0 ? ` (${errored} errored)` : ''} |`,
	)
}

const date = new Date().toISOString().slice(0, 10)
console.log(`| Model | Paused | Paused and checked in |
| ----- | ------ | --------------------- |
${rows.join('\n')}

Plugin ${version}, Claude Code ${claudeVersion}, ${date}.`)
if (!isComplete) process.exitCode = 1
