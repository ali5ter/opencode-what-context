# opencode-context

A plugin for [OpenCode](https://opencode.ai) that shows what was sent to the model, request by
request.

## What it does

Every time OpenCode calls a model — the agent loop, tool continuations, compaction, title
generation — the plugin captures the assembled context: system instructions by source, tool
schemas, and conversation, and renders a [dsh-context](https://github.com/bowenliang123/dsh-context)-style
panel in the TUI: a per-request composition chart, a request history, and a context trend.

## Why

OpenCode persists per-message token and cost totals in its SQLite session database, but not the
served request body. That leaves you able to see *how many* tokens went out, not *what*. The
plugin closes that gap through the V2 plugin API's session hooks. The motivation, the
information map, and the full research are in the
[ai-local-first research notes](https://github.com/ali5ter/ai-local-first/blob/main/docs/research/2026-11-11-llm-monitoring-tools.md).

## Status

Scaffold — no released functionality yet.

## License

MIT — see [LICENSE](LICENSE).
