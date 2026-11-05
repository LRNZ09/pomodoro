declare module 'claude-code' {
	interface PluginState {
		// What core keeps across a reload (the block whose check-in this session got),
		// and the count the prompt footer shows.
		pomodoro: { sentKey: number; label: string }
	}
}
