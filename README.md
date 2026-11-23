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
The three sections stack at their natural sizes; when the view is too short to show them all, the whole panel scrolls.

## Reading the panel

The context box depicts the context window: a grid of its cells, a figure line, and a
legend with one row per window category (system, messages, tools, scaffolding, free space,
and the auto-compact reserve). All numbers are tokens; the percentages are dimmed.

Two legend rows expand into breakdowns: the system row into the system prompt's sections,
and the messages row into the conversation's part types (text, tool results, reasoning).
OpenCode assembles the system sections itself, so each row names a source rather than a
file:

| Row                   | What it is                                                                    | To reduce it                                                             |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `core/skill-guidance` | The registered skills: id, name, and description of each                      | Disable or remove skills that are not used                               |
| `core/instructions`   | The base system prompt plus every discovered instruction file, concatenated   | Trim the instruction files (global and project `AGENTS.md`, `CLAUDE.md`) |
| `core/mcp-guidance`   | The instruction blocks served by the configured MCP servers                   | Disable the MCP servers that are not used                                |
| `core/codemode` etc.  | OpenCode's fixed boilerplate (date, environment, tool guidance)               | Not configurable                                                         |

The `core/instructions` row is one merged block, so it cannot by itself attribute tokens to a
single file. OpenCode prefixes each file it folds in with an `Instructions from: {path}` line;
to measure one file, move it aside, send one request, and read the row's difference.

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
