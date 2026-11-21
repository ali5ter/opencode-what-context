# Demo reel: the what-context panel inside a live OpenCode session.
#
# A real session against a local model makes two short prompts (each is a
# captured request), then the panel opens: the composition box (labelled by
# the model, its first row the window-fill gauge), the trend strip, the
# request list. The walk ends on the prompt-footer indicator, which stays on
# after the panel closes.
#
# Timing is fixed Sleep, not content waits (vhs 0.12 has no Wait command):
# the model is local, so the generous margins cover a loaded machine without
# the screen sitting still long enough to feel dead at playback speed.
#
# The session runs from the examples/ subdirectory: the session list (and the
# tab row) is scoped per directory, so the machine's real sessions never
# appear, while the project's plugin, configuration, and model registry all
# apply unchanged. Each render leaves one demo session in that directory;
# delete it from OpenCode's session list (or the row in opencode's database)
# before the next render to keep the tab row single.

Output what-context-demo.gif

Require opencode

Set Shell bash
Set FontSize 13
Set Width 1600
Set Height 900
Set Padding 10
Set PlaybackSpeed 1.25

Hide
Type "cd ~/Documents/Projects/opencode-what-context/examples" Enter
Sleep 500ms
Type "clear" Enter
Sleep 200ms
Show

# Boot: the session view with the prompt bar.
Type "opencode"
Sleep 400ms
Enter
Sleep 6s

# Two short prompts; each one is a captured request.
Type "Reply with exactly: one"
Sleep 300ms
Enter
Sleep 8s
Type "Reply with exactly: two"
Sleep 300ms
Enter
Sleep 5s

# Open the panel.
Type "/what-context"
Sleep 500ms
Enter
Sleep 10s

# Walk the request list; the context box follows the selection.
Type "k"
Sleep 2s
Type "k"
Sleep 3s
Type "j"
Sleep 2
Type "j"
Sleep 5s

Type "q"
Sleep 2s
