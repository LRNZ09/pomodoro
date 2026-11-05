---
"@beautifoo/claude-pomodoro": patch
---

With `breakMinutes` under 2, a wake-up tick never replaced the one before, so while you worked without a break the plugin ticked one more time a minute for each minute worked, until your next break. Each tick reads and writes the shared timer, and without the input watcher runs `ioreg`. Now, as in Pi, a new wake-up replaces the one before, so it ticks at most about twice a minute.
