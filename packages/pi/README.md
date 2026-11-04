# Pomodoro for Pi

After every 25 minutes of work, you get a reminder to take a break, and your agent gets a note so it can sum up the session if that helps.

```
pi install npm:@beautifoo/pi-pomodoro
```

It runs in Pi's terminal UI only, not with `-p`, `--mode json` or RPC. The footer counts your minutes, and a break is 5 minutes with no keyboard or mouse input (macOS idle time; elsewhere, no prompt or tool call in any Pi session). `/pomodoro today` lists today's check-ins by repository.

Settings go in `~/.pi/agent/pomodoro-settings.json`, read when a session starts or on `/reload`, with these defaults:

```json
{
	"workMinutes": 25,
	"breakMinutes": 5,
	"moveSeconds": 1,
	"sound": true,
	"checkIn": true,
	"emoji": true
}
```

The [repository](https://github.com/LRNZ09/pomodoro) has the details, and the same plugin for Claude Code. MIT licensed. Pomodoro Technique® is a registered trademark of Francesco Cirillo; this package isn't affiliated with it.
