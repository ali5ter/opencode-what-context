# opencode-what-context

A plugin for [OpenCode](https://opencode.ai) that shows what was sent to the model, request by request.

![The what-context panel in a live OpenCode session](examples/what-context-demo.gif)

## What it does

This plugin records the OpenCode calls to the model, and gathers the assembled context:
the system instructions by source, tool schemas, and conversation.

This plugin renders:

* A summary of context usage in the footer of the OpenCode session view.
* A side-panel displaying the breakdown of what is contained in the context sent in the
  selected request, a navigable trend of the context size request by request, and a list of
  request history.

## Install

```sh
opencode plugin add opencode-what-context
```

The package is installed from the npm registry on first start, so quit OpenCode and start
it again for the plugin to load.

## Usage

When in OpenCode, use the `/what-context` command (or the `<leader>v` keybinding) to open the panel.

Click into the panel and use `j`/`k` to move through the request history, `f` to toggle fullscreen, and `q` to close.

## Why

OpenCode persists per-message token and cost totals in its SQLite session database, but not the
served request body.

The community `/context` plugin —
[`opencode-context-usage`](https://github.com/angeloper86/opencode-context-usage) by angeloper86 —
answers *how many*: token totals by category, cache hit rate, cost, including delegated subagents.
Nothing answers *what*: the served request body is not persisted, so the composition of the
context (system instructions, tool schemas, conversation) stays invisible.

This plugin closes
that gap. The `/what-context` command is named to sit beside, not collide with, the community plugin's `/context`.

## Development

To work on the plugin from a clone, install the dependencies and generate the local loader:

```sh
npm install
scripts/dev-link.sh
```

The loader in `.opencode/plugins/` is generated, not tracked: OpenCode discovers it
automatically, so a session started in the repo runs the checkout's `src/` live (a running
service reloads it on save).

## License

MIT — see [LICENSE](LICENSE).
