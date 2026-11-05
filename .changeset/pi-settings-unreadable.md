---
"@beautifoo/pi-pomodoro": patch
---

A `pomodoro-settings.json` that can't be read (its permissions, or a folder at that path) now keeps the timer off, with an error at session start, as a broken one does. Pi used to run on the defaults without a word. Only a missing file means the defaults.
