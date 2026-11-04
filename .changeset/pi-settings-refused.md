---
"@beautifoo/pi-pomodoro": patch
---

A value of the wrong kind or below its minimum in `pomodoro-settings.json`, or a file that isn't valid JSON, now keeps the timer off, with an error at session start that names it. Pi used to take the default for it without a word, and kept a work block of a fraction of a minute as it was (a break under a minute became 1 minute). `workMinutes` and `breakMinutes` take 1 or more, `moveSeconds` 0 or more, and an empty value counts as left out.
