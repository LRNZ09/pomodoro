---
"@beautifoo/pi-pomodoro": patch
---

A `/reload`, `/resume` or `pi --continue` no longer brings the same block's check-in again: the extension keeps the check-in it gave in an entry of the session, and reads it back when the session starts.
