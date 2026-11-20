# opencode-what-context

A plugin for [OpenCode](https://opencode.ai) that shows what was sent to the model, request by
request.

## What it does

Every time OpenCode calls a model, the plugin records what went out. Agent-loop calls carry the
assembled context — system instructions by source, tool schemas, and conversation; every call
also carries the wire body size and the provider's reported usage. In the TUI the records render
as a [dsh-context](https://github.com/bowenliang123/dsh-context)-style panel: a context-window
gauge, a request history, a per-request composition bar with per-source, per-part, and per-tool
breakdowns, a token trend, and the free space in the window. The prompt bar always carries a
context-window indicator, so the session's fill is visible without opening the panel.

## Install

```sh
opencode plugin add opencode-what-context
```

The package is installed from the npm registry on first start, so restart OpenCode afterwards.

## Usage

Open the panel in the TUI with the `/what-context` command or the `<leader>v` keybinding. Use
`j`/`k` to move through the request history, `f` to toggle fullscreen, and `q` to close.

## Why

OpenCode persists per-message token and cost totals in its SQLite session database, but not the
served request body. A community `/context` plugin —
[`opencode-context-usage`](https://github.com/angeloper86/opencode-context-usage) by angeloper86 —
answers *how many*: token totals by category, cache hit rate, cost, including delegated subagents.
Nothing answers *what*: the served request body is not persisted, so the composition of the
context (system instructions, tool schemas, conversation) stays invisible. This plugin closes
that gap through the [plugin API](https://opencode.ai/docs/plugins/) session hooks — and its
`/what-context` command is named to sit beside, not collide with, the community plugin's
`/context`.

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
