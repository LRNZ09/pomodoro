# Core carries out its own effects through a host

Core was a pure `step()` that returned effects as data, and each agent carried them out with its own APIs: core never saw an agent's API, with no host and no adapters. Both agents then repeated the same handling of the tick, the shared timer, idle time, the watcher and the log, and the copies drifted apart: only Pi cancelled the pending wake, so with 1-minute breaks Claude Code's ticks grew by one every minute, and only Pi joined a line of the watcher's output that came in two pieces. So core now exports `createInstance(host, options)`, one instance per session. Each agent hands it a host of general capabilities (the clock, the store, running a command, its repository, how it shows the count, its own alert, a value kept across a reload) and passes its events to the instance. `step()` stays pure inside core, core still never sees an agent's API, and whatever only one agent does stays in that agent's code.

## Considered Options

- **Effects as data only**, as before: every rule about carrying out an effect lived in both agents, and the copies had already drifted.
- **A host of specific actions** (read the idle time, play the chime): the macOS commands are the same for both agents, so they belong in core, not in each host.
