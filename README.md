# Pomodoro for Claude Code and Pi

One rhythm for you and your agent on long sessions: every 25 minutes of work, you get told to take a break, and the agent pauses to tell you what it did, whether it has drifted from the goal, and what it would do next, then a menu asks whether to go on. It's a plugin for [Claude Code](https://code.claude.com) and an extension for [Pi](https://pi.dev).

How Claude takes the check-in, from the evals in [`packages/claude/evals/`](packages/claude/evals/), 10 runs per model and case. In one, the check-in comes between steps that each stand on their own, and Claude should stop at once. In the other, it comes halfway through a transfer between two balances, and Claude should finish the transfer, then stop before the next task:

| Model  | Paused between steps | Paused and checked in | Finished a transfer, then stopped | Finished and checked in |
| ------ | -------------------- | --------------------- | --------------------------------- | ----------------------- |
| Haiku  | 10/10                | 9/10                  | 4/10                              | 4/10                    |
| Sonnet | 10/10                | 10/10                 | 10/10                             | 9/10                    |
| Opus   | 10/10                | 9/10                  | 10/10                             | 10/10                   |

Plugin 0.5.0, Claude Code 2.1.308, 2026-10-31. Checked in means the answer said in three lines at most what was done, whether it's still on the goal and what comes next, as the eval's judge graded it. Haiku sometimes takes the check-in for a note that didn't come from you and carries on, as it did in 6 of the 10 transfer runs.

## Install

### Claude Code

At the prompt of a Claude Code terminal session:

```
/plugin install pomodoro --marketplace LRNZ09/pomodoro
```

Answer `y` to add the marketplace, then press Enter to install it for your user (or pick another scope).

From a shell:

```
claude plugin install pomodoro --marketplace LRNZ09/pomodoro
```

It needs Claude Code 2.1.304 or later, and `npm` on your PATH, which comes with [Node.js](https://nodejs.org): Claude Code fetches the plugin from npm with it. Without it, the install fails with "Could not resolve @beautifoo/claude-pomodoro@latest from the npm registry: npm exited with an error". It runs in terminal sessions only: not in the desktop app, VS Code or `claude -p`. It's built on Claude Code's plugin API for TypeScript hooks, which is in early access, so a Claude Code update can break it.

Claude Code doesn't update plugins from a marketplace like this one by itself, unless you turn on auto-update for it under `/plugin` → Marketplaces. To update by hand, run these, then `/reload-plugins` in open sessions:

```
claude plugin marketplace update pomodoro
claude plugin update pomodoro@pomodoro
```

To keep the timer without the check-in, set `checkIn` to `false` under `/config`. To remove the plugin:

```
claude plugin uninstall pomodoro@pomodoro
```

### Pi

```
pi install npm:@beautifoo/pi-pomodoro
```

Tested with Pi 1.5. It runs in Pi's terminal UI only: not with `-p`, `--mode json` or RPC. `pi update --extensions` updates it, and `pi remove npm:@beautifoo/pi-pomodoro` removes it.

## Features

The same in both agents, as Claude Code shows them; how Pi differs follows the list.
- **Check-in.** Once the block is up, Claude gets a note with its next tool result. The note tells it to stop at the first point where nothing it started is left half-applied. An operation that leaves things inconsistent until its last step, like a migration, a rebase or a rename across files, gets finished first, and nothing more, so the check-in comes at its end; between fixes or steps that each stand on their own, it stops at once, and failures that were there before don't count as half-applied. Which is which is Claude's call, so the plugin can't guarantee it, except with git: while a rebase, merge, cherry-pick or revert is under way in the session's repository, the note waits until git is done. Then it gives you, in three lines at most: what it did since the break, whether it's still on the original goal or has drifted into a side problem, and what it would do next. Once Claude ends that turn, a menu asks whether to go on: **Continue** sends "Continue" as your next prompt, **Stop** leaves it there, and what you type under Other goes to Claude as the new course. A line in the transcript tells you why Claude stopped. The check-in is sent once for every 25 minutes without a break, and only while Claude is working: it never waits in an idle session for your next prompt. It reaches the main conversation only, so during a long-running subagent it comes once the subagent returns.
- **Log.** Claude's summary at each check-in is kept for 14 days, with the time and the repository, in Claude Code's plugin store on this machine (`~/.claude/plugins/store/`). `/pomodoro today` lists today's, by repository.
- **Count.** Shows how long you've worked since your last break, at the right of the prompt footer beside its other labels: `🍅 12/25m`. Once a break is due, a status line under the prompt says so too; Claude Code draws a plugin's status line in yellow with a ⚠, as `⚠ pomodoro: 🍅 27m, time for a break`. A phone following the session shows that line only.
- **Alert.** After a 25-minute block it plays a chime and shows a toast and a desktop notification. The alert repeats every 5 minutes until you take a break, but not once you've been away from the keyboard for 2 minutes (the break may already be under way).

It runs on a clock, a tick every minute, so the alert comes on time even while you're reading code and not typing to Claude.

In Pi, the count and the break warning share one entry at the foot of the screen, and the alert is a warning line in Pi with the chime and a desktop notification. The menu after a check-in offers **Continue**, **Change course**, which asks you for the new course, and **Stop**. The log is in `~/.pi/agent/pomodoro-log.json`.

## Breaks

You never start or stop the timer:
- 5 minutes with no keyboard or mouse input (macOS idle time) counts as a break, and the next block starts when you're back.
- Mouse movement counts only once it goes on for a second, so the nudge a keep-awake app's mouse jiggler gives every minute doesn't keep a break from ever starting. Keys, clicks and scrolls count at once.
- Idle time is this Mac's own: 5 minutes spent on another computer counts as a break, unless you use this Mac's keyboard or trackpad in between (Universal Control included).
- A closed lid, or a stretch with no session of the agent open, also counts as a break.
- The timer is one per person, shared by all your open sessions, so three sessions don't mean three notifications.
- Claude Code and Pi keep a timer each: with both open, each counts and alerts on its own.

On Linux, on Windows, or over SSH, there's no system idle time to read, so it falls back to the agent's activity: 5 minutes with no prompt or tool call in any session of that agent counts as a break.

## Settings

Under `/config`, or `pluginConfigs` in `settings.json`:

| Setting        | Default | What it does                                                                       |
| -------------- | ------- | ---------------------------------------------------------------------------------- |
| `workMinutes`  | `25`    | Minutes of work before the alert                                                   |
| `breakMinutes` | `5`     | Idle minutes that count as a break, and how often the alert repeats                |
| `moveSeconds`  | `1`     | Seconds the mouse has to keep moving to count (macOS); `0` counts every movement   |
| `sound`        | `true`  | Whether each alert plays a chime (macOS)                                           |
| `checkIn`      | `true`  | Whether Claude stops to sum up at the alert; off leaves only the alert             |
| `emoji`        | `true`  | Whether 🍅 marks the count and the alerts; off, the footer reads `pomodoro 12/25m` |

In Pi, the same keys go in `~/.pi/agent/pomodoro-settings.json`, read when a session starts or on `/reload`. A key the file leaves out, or gives a value of the wrong kind, keeps its default:

```json
{ "workMinutes": 50, "breakMinutes": 10 }
```

## Alerts

- **Banner.** It goes through your Claude Code notification channel (`preferredNotifChannel`), so your terminal shows it. While the Claude tab is in front, Ghostty shows it for a few seconds only, then removes it, so it's easy to miss. Where the terminal can't raise one, it falls back to `osascript` on macOS: Apple Terminal has no notification channel. macOS credits that banner to Script Editor. If you turned Claude Code notifications off, there's no banner.
- **Chime.** Plain audio, not a notification, so you hear it even when the banner is easy to miss, and through a Focus (Work, Do Not Disturb).

A Focus silences the banner unless it allows your terminal: System Settings → Focus → (your Focus) → Allowed Notifications → Apps.

Pi has no notification channel of its own, so there the banner always comes through `osascript` (macOS), credited to Script Editor, and a Focus silences it unless it allows Script Editor.

## Development

The Claude Code plugin is in `packages/claude`, and the Pi extension in `packages/pi`. The rhythm itself, with neither agent's API in it, is in `lib/core`, which each of them copies in. From a clone of this repository:

```
bun install
bun run build
claude plugin validate packages/claude
bun run test
claude --plugin-dir packages/claude
```

`bun run build` copies `lib/core/index.ts` to `packages/claude/hooks/core.ts` and `packages/pi/core.ts` (both ignored by git), since a Claude Code plugin can only import its own files: run it again after editing core. `bun run test` runs core's tests, the plugin's, and a smoke test that runs Pi with the extension against a scripted model on localhost. The last command starts a session with the mod loaded from the folder; saving a file reloads it. Each load also writes the `claude-code` module's types for your Claude Code version into `packages/claude/.claude-plugin/types/` (ignored by git), which `packages/claude/tsconfig.json` points your editor and `tsc -p packages/claude` at, so run it once after cloning.

For Pi, `pi -e ./packages/pi` starts a session with the extension loaded from the folder; remove the installed package first, or both run.

Formatting and linting use [Biome](https://biomejs.dev) with the [`@lrnz09/biome-config`](https://www.npmjs.com/package/@lrnz09/biome-config) preset:

```
bun run check
bun run fix
bun run typecheck
```

`bun run eval` runs the check-in evals (`packages/claude/evals/`) on Haiku, Sonnet and Opus with your login, which costs tokens, and prints the pass-rate table. In `check-in`, the check-in comes between steps that each stand on their own, and Claude should stop at once; in `check-in-atomic`, it comes halfway through a transfer between two balances, and Claude should finish the transfer, then stop before the next, separate task.

To release, describe the change with `bunx changeset`, then run `bun run bump`: it bumps the version of each package the changesets name, writes their changelogs, and copies the plugin's version into `plugin.json`. Core isn't published on its own: it ships inside the plugin, so a change to it needs a changeset for the plugin. Before a release of the plugin, run `bun run eval` and update the table above with its numbers. Once that's pushed to `main` and the checks pass, CI publishes each new version to npm.

## License

[MIT](LICENSE)

Pomodoro Technique® is a registered trademark of Francesco Cirillo; this project isn't affiliated with it.
