# @beautifoo/claude-pomodoro

## 0.6.2

### Patch Changes

- c1c8d63: A line of the input watcher's output that reached the plugin in two pieces was read as two broken times, which could restart the measure of how long the mouse had been moving. The pieces are now joined into whole lines first. The desktop notification your terminal raises for an alert now comes before the chime, not after it.
- 1618545: With `breakMinutes` under 2, a wake-up tick never replaced the one before, so while you worked without a break the plugin ticked one more time a minute for each minute worked, until your next break. Each tick reads and writes the shared timer, and without the input watcher runs `ioreg`. Now, as in Pi, a new wake-up replaces the one before, so it ticks at most about twice a minute.
- 3deed36: It says "pomodoro", the Pomodoro Technique's word, where it said "work block", and no longer calls that time work: `workMinutes` is "Pomodoro (minutes)" under `/config` and in the error for a value below 1, described as "Minutes without a break before the alert.", the transcript line reads "told the agent your pomodoro is up", and the plugin's description says "a notification after a pomodoro without a break".

## 0.6.1

### Patch Changes

- 02346f0: `/config` no longer takes a work block or a break under 1 minute, or mouse movement under 0 seconds. A work block of 0 put the check-in on every tool result. A value below its minimum already in `settings.json` now stops the plugin from loading, and Claude Code names the setting only in its debug log (`claude --debug`). If the timer is gone after this update, look for a break of 0, a work block or a break under 1 minute, or `moveSeconds` under 0, and raise it.
- 5c40ae6: A setting left empty in `settings.json` now takes its default. An empty work block put the check-in on every tool result, and an empty break made it 1 minute.

## 0.6.0

### Minor Changes

- 1173db2: The check-in no longer stops the agent or asks whether to go on: once the block is up, the agent gets a note, carries on, and sums up the session in its next reply, in a paragraph that starts with "Pomodoro:", if that would help. The hold during a git rebase or merge goes with the stop. The log keeps only that paragraph, or nothing when the agent doesn't sum up.

## 0.5.0

### Minor Changes

- 7028a72: Install the plugin from npm.
