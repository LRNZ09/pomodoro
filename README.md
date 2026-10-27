# Pomodoro plugin for Claude Code

One rhythm for you and Claude on long sessions: every 25 minutes of work, you get told to take a break, and Claude pauses to tell you what it did, whether it has drifted from the goal, and what it would do next, then asks whether to go on.

How often Claude pauses, from the eval in [`evals/check-in`](evals/check-in/case.yaml), 10 runs per model:

| Model  | Paused | Paused and checked in |
| ------ | ------ | --------------------- |
| Haiku  | 5/10   | 5/10                  |
| Sonnet | 10/10  | 10/10                 |
| Opus   | 10/10  | 8/10                  |

Plugin 0.3.0, Claude Code 2.1.308, 2026-10-27. Checked in means the answer said what was done, whether it's still on the goal and what comes next, then asked whether to go on. Haiku sometimes takes the check-in for a hook's note rather than yours, and carries on.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pomodoro --marketplace LRNZ09/pomodoro
```

Answer `y` to add the marketplace, then press Enter to install it for your user (or pick another scope).

From a shell:

```
claude plugin install pomodoro --marketplace LRNZ09/pomodoro
```

It needs Claude Code 2.1.304 or later, and runs in terminal sessions only: not in the desktop app, VS Code or `claude -p`. It's built on Claude Code's plugin API for TypeScript hooks, which is in early access, so a Claude Code update can break it.

To keep the timer without the check-in, set `checkIn` to `false` under `/config`. To remove the plugin:

```
claude plugin uninstall pomodoro@pomodoro
```

## Features

- **Check-in.** Once the block is up, Claude gets a note with its next tool result. The note tells it to finish only what would otherwise be left half-done, then give you, in three lines at most: what it did since the break, whether it's still on the original goal or has drifted into a side problem, and what it would do next. Then Claude asks whether to go on. A line in the transcript tells you why Claude stopped. The check-in is sent once for every 25 minutes without a break, and only while Claude is working: it never waits in an idle session for your next prompt. It reaches the main conversation only, so during a long-running subagent it comes once the subagent returns.
- **Count.** Shows how long you've worked since your last break, at the right of the prompt footer beside its other labels: `🍅 12/25m`. Once a break is due, a status line under the prompt says so too; Claude Code draws a plugin's status line in yellow with a ⚠, as `⚠ pomodoro: 🍅 27m, time for a break`. A phone following the session shows that line only.
- **Alert.** After a 25-minute block it plays a chime and shows a toast and a desktop notification. The alert repeats every 5 minutes until you take a break, but not once you've been away from the keyboard for 2 minutes (the break may already be under way).

It runs on a clock, a tick every minute, so the alert comes on time even while you're reading code and not typing to Claude.

## Breaks

You never start or stop the timer:
- 5 minutes with no keyboard or mouse input (macOS idle time) counts as a break, and the next block starts when you're back.
- Mouse movement counts only once it goes on for a second, so the nudge a keep-awake app's mouse jiggler gives every minute doesn't keep a break from ever starting. Keys, clicks and scrolls count at once.
- Idle time is this Mac's own: 5 minutes spent on another computer counts as a break, unless you use this Mac's keyboard or trackpad in between (Universal Control included).
- A closed lid, or a stretch with no Claude Code session open, also counts as a break.
- The timer is one per person, shared by all your open sessions, so three sessions don't mean three notifications.

On Linux, on Windows, or over SSH, there's no system idle time to read, so it falls back to Claude Code activity: 5 minutes with no prompt or tool call in any session counts as a break.

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

## Alerts

- **Banner.** It goes through your Claude Code notification channel (`preferredNotifChannel`), so your terminal shows it. While the Claude tab is in front, Ghostty shows it for a few seconds only, then removes it, so it's easy to miss. Where the terminal can't raise one, it falls back to `osascript` on macOS: Apple Terminal has no notification channel. macOS credits that banner to Script Editor. If you turned Claude Code notifications off, there's no banner.
- **Chime.** Plain audio, not a notification, so you hear it even when the banner is easy to miss, and through a Focus (Work, Do Not Disturb).

A Focus silences the banner unless it allows your terminal: System Settings → Focus → (your Focus) → Allowed Notifications → Apps.

## Development

From a clone of this repository:

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The last one starts a session with the mod loaded from the folder; saving a file reloads it. Each load also writes the `claude-code` module's types for your Claude Code version into `.claude-plugin/types/` (ignored by git), which `tsconfig.json` points your editor and `tsc -p .` at, so run it once after cloning.

Formatting and linting use [Biome](https://biomejs.dev) with the [`@lrnz09/biome-config`](https://www.npmjs.com/package/@lrnz09/biome-config) preset:

```
bun install
bun run check
bun run fix
bun run typecheck
```

`bun run eval` runs the check-in eval (`evals/check-in`) on Haiku, Sonnet and Opus with your login, which costs tokens, and prints the pass-rate table.

## License

[MIT](LICENSE)

Pomodoro Technique® is a registered trademark of Francesco Cirillo; this plugin isn't affiliated with it.
