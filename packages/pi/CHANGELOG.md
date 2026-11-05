# @beautifoo/pi-pomodoro

## 0.2.1

### Patch Changes

- 5c40ae6: A value of the wrong kind or below its minimum in `pomodoro-settings.json`, or a file that isn't valid JSON, now keeps the timer off, with an error at session start that names it. Pi used to take the default for it without a word, and kept a work block of a fraction of a minute as it was (a break under a minute became 1 minute). `workMinutes` and `breakMinutes` take 1 or more, `moveSeconds` 0 or more, and an empty value counts as left out.

## 0.2.0

### Minor Changes

- 1173db2: The check-in no longer stops the agent or asks whether to go on: once the block is up, the agent gets a note, carries on, and sums up the session in its next reply, in a paragraph that starts with "Pomodoro:", if that would help. The hold during a git rebase or merge goes with the stop. The log keeps only that paragraph, or nothing when the agent doesn't sum up.

## 0.1.0

### Minor Changes

- 9279e49: Add the Pi extension: the break alert, the check-in with its menu, and /pomodoro today.
