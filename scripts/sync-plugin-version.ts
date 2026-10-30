// Copies packages/claude's version, which `changeset version` bumps, into the plugin.json Claude Code reads.
const manifest = 'packages/claude/.claude-plugin/plugin.json'
const { version } = await Bun.file('packages/claude/package.json').json()
const text = await Bun.file(manifest).text()
const line = /^(\t"version": )"[^"]*"/m
if (!line.test(text)) throw new Error(`No "version" line in ${manifest}`)
await Bun.write(manifest, text.replace(line, `$1"${version}"`))
