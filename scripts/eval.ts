// Runs the check-in eval on each model and prints the README's pass-rate table. Costs tokens on your login.
// Usage: bun run eval [runs per model, default 10]
import { $ } from 'bun'

const MODELS = ['haiku', 'sonnet', 'opus']
const runs = Number(process.argv[2] ?? 10)
const results = 'evals/results'
const { version } = await Bun.file('.claude-plugin/plugin.json').json()

const rows: string[] = []
let claudeVersion = ''
for (const model of MODELS) {
	const json = `${results}/${model}.json`
	await $`claude plugin eval . --model ${model} --runs ${runs} --ablation none --trust-plugin --allow-tools Write --no-publish --threshold 0 --json ${json} --output-dir ${results}/${model}`.quiet()
	const result = await Bun.file(json).json()
	claudeVersion = result.claudeVersion
	const all: { passed: boolean }[] = result.cases.flatMap(
		(c: { arms: { with: { passed: boolean }[] } }) => c.arms.with,
	)
	rows.push(
		`| ${model} | ${all.filter((run) => run.passed).length}/${all.length} |`,
	)
}

const date = new Date().toISOString().slice(0, 10)
console.log(`| Model | Paused and checked in |
| ----- | --------------------- |
${rows.join('\n')}

Plugin ${version}, Claude Code ${claudeVersion}, ${date}.`)
