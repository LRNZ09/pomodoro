# Pomodoro

A break reminder inside coding agents: once a pomodoro is up, it alerts the person and gives the agent a check-in, so it can sum up the session if that helps.

## Language

### Time

**Pomodoro**:
`workMinutes` at the computer, the Pomodoro Technique's unit; pomodoros follow one another until a break.
_Avoid_: block, work block, work period

**Break**:
`breakMinutes` with no input that counts, or a gap; the next pomodoro starts once the person is back.

**Gap**:
A break's length with no tick in any session of the agent, as with a closed lid or no session open.

**Tick**:
One look at the clock, every minute and at the moment a break would begin.

**Input that counts**:
A key, click or scroll at once, or mouse movement once it lasts `moveSeconds`, so a mouse jiggler's nudge doesn't count.

**Activity**:
A prompt or a tool call, which stands in for input where there's no system idle time to read (Linux, Windows, SSH).

**Shared timer**:
When the pomodoros since the last break began, the last tick, the last alert and the last input, shared by every session of one agent.

### Agents

**Agent**:
Claude Code or Pi, the coding agent the person works with.
_Avoid_: host, app

**Session**:
One open session of an agent; only one in a terminal counts.

**Main loop**:
The agent's own turn, as opposed to a subagent's run.

### What the person and the agent get

**Count**:
The minutes since the last break, against a pomodoro's length: `🍅 27/25m`.

**Alert**:
A chime, a toast and a desktop banner when a pomodoro is up.

**Check-in**:
A note on a tool result of the main loop that a pomodoro is up, asking the agent to carry on and to sum up if that helps.
_Avoid_: reminder, rabbit-hole check

**Summary**:
The paragraph starting "Pomodoro:" that the agent may write after a check-in, until its turn ends.

**Log**:
The summaries of the last 14 days, with their time and repository; `/pomodoro today` lists today's.

## Relationships

- An **Agent** keeps one **Shared timer**, which all its **Sessions** read and write; Claude Code and Pi keep one each.
- A **Break** ends the **Pomodoro** under way; without one, **Pomodoros** follow back to back.
- The first **Alert** comes when a **Pomodoro** is up, then one every break length until a **Break**, once per **Agent**.
- Each **Session** gets at most one **Check-in** per **Pomodoro** that ends without a **Break**, on its **Main loop**'s next tool result; one not sent by the time the next **Pomodoro** ends gives way to that **Pomodoro**'s.
- A **Check-in** gets at most one **Summary**, which goes into the **Log**.

## Example dialogue

> **Dev:** "The person has worked 52 minutes without a break, with one session open and the agent busy all along: how many **Check-ins** did it get?"
> **Domain expert:** "Two, one per **Pomodoro**: just after 25 and just after 50 minutes, each on the next tool result of the **Main loop**. Had the agent sat idle from 20 to 52 minutes, only one, for the second **Pomodoro**. The **Count** reads `52/25m`, since it runs from the last **Break**, not from the **Pomodoro**'s start."
> **Dev:** "And if the lid was closed for ten minutes in between?"
> **Domain expert:** "That **Gap** is a **Break**: the next **Pomodoro** starts when the person is back, and the **Count** with it."

## Flagged ambiguities

- "Pomodoro" names both the product and its unit, as in the technique ("the Pomodoro Technique", "a Pomodoro"): resolved, "Pomodoro" with no article is the product (the Claude Code plugin and the Pi extension), and "a pomodoro" is the unit. The count's word without the emoji ("pomodoro 12/25m", "pomodoro on a break") is the product's name.
- "block", "work block" and "work period" meant a **Pomodoro**: resolved, it's a **Pomodoro**, the technique's word. The code keeps `blockStart` (stored in the shared timer) for when the pomodoros since the last break began, and the setting keeps its name, `workMinutes`.
- A **Pomodoro** here isn't quite the technique's: it starts by itself with the first input after a break, it isn't started for a task, and without a break the next one starts at once, which is what the alert is about; there are no sets of four and no long break.
