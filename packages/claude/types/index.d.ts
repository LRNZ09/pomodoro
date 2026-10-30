declare module 'claude-code' {
	interface PluginState {
		// The work period whose check-in this session was given, kept across reloads,
		// and the count the prompt footer shows.
		pomodoro: { sentKey: number; label: string }
	}
}
