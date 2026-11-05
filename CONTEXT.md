# Pomodoro

A break reminder inside coding agents: once a block is up, it alerts the person and gives the agent a check-in, so it can sum up the session if that helps.

## Language

### Time

**Block**:
`workMinutes` at the computer; blocks follow one another until a break.
_Avoid_: work period, work block, pomodoro

**Break**:
`breakMinutes` with no input that counts, or a gap; the next block starts once the person is back.

**Gap**:
A break's length with no tick in any session of the agent, as with a closed lid or no session open.

**Tick**:
One look at the clock, every minute and at the moment a break would begin.

**Input that counts**:
A key, click or scroll at once, or mouse movement once it lasts `moveSeconds`, so a mouse jiggler's nudge doesn't count.

**Activity**:
A prompt or a tool call, which stands in for input where there's no system idle time to read (Linux, Windows, SSH).

**Shared timer**:
When the blocks since the last break began, the last tick, the last alert and the last input, shared by every session of one agent.

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
The minutes since the last break, against a block's length: `🍅 27/25m`.

**Alert**:
A chime, a toast and a desktop banner when a block is up.

**Check-in**:
A note on a tool result of the main loop that a block is up, asking the agent to carry on and to sum up if that helps.
_Avoid_: reminder, rabbit-hole check

**Summary**:
The paragraph starting "Pomodoro:" that the agent may write after a check-in, until its turn ends.

**Log**:
The summaries of the last 14 days, with their time and repository; `/pomodoro today` lists today's.

**Pomodoro**:
The product: the Claude Code plugin and the Pi extension.

## Relationships

- An **Agent** keeps one **Shared timer**, which all its **Sessions** read and write; Claude Code and Pi keep one each.
- A **Break** ends the **Block** under way; without one, **Blocks** follow back to back.
- The first **Alert** comes when a **Block** is up, then one every break length until a **Break**, once per **Agent**.
- Each **Session** gets at most one **Check-in** per **Block** that ends without a **Break**, on its **Main loop**'s next tool result; one not sent by the time the next **Block** ends gives way to that **Block**'s.
- A **Check-in** gets at most one **Summary**, which goes into the **Log**.

## Example dialogue

> **Dev:** "The person has worked 52 minutes without a break, with one session open and the agent busy all along: how many **Check-ins** did it get?"
> **Domain expert:** "Two, one per **Block**: just after 25 and just after 50 minutes, each on the next tool result of the **Main loop**. Had the agent sat idle from 20 to 52 minutes, only one, for the second **Block**. The **Count** reads `52/25m`, since it runs from the last **Break**, not from the **Block**'s start."
> **Dev:** "And if the lid was closed for ten minutes in between?"
> **Domain expert:** "That **Gap** is a **Break**: the next **Block** starts when the person is back, and the **Count** with it."

## Flagged ambiguities

- "pomodoro" meant the product, a block, and the count's word without the emoji ("pomodoro on a break"): resolved, **Pomodoro** is the product and the time is a **Block**.
- "work period" and "work block" meant a **Block**: resolved, it's a **Block**, since nothing in it has to be work. The code keeps `blockStart` (stored in the shared timer) for when the blocks since the last break began, and the setting keeps its name, `workMinutes`.
