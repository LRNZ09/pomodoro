---
"@beautifoo/claude-pomodoro": patch
---

`/config` no longer takes a work block or a break under 1 minute, or mouse movement under 0 seconds. A work block of 0 put the check-in on every tool result. A value below its minimum already in `settings.json` now stops the plugin from loading, and Claude Code names the setting only in its debug log (`claude --debug`). If the timer is gone after this update, look for a break of 0, a work block or a break under 1 minute, or `moveSeconds` under 0, and raise it.
