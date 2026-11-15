/** @jsxImportSource @opentui/solid */
/**
 * opencode-what-context — build step 3: the TUI panel.
 *
 * Renders the server part's per-call records in the session panel: a
 * context-window gauge, a request list with a per-call mini gauge, a
 * four-slice composition detail (the E2w' estimator, `estimate.ts`), and
 * a trend strip across the session's requests.
 *
 * The records come over the `what-context` RPC (`rpc.ts`) — the TUI process
 * cannot read the server's plugin storage — and each `recorded` event triggers
 * a refetch so the panel stays live.
 *
 * The design must survive any theme: OpenCode generates its system theme from
 * the terminal's palette, and a monochrome terminal collapses every hue token
 * to the same gray. Information therefore rides on channels that survive any
 * theme — the luminance steps (text.base/muted/faint), glyph shape (block
 * densities, markers), and bold — while the house hues (accent for system,
 * interactive for messages, neutral for tools) remain decoration that reads
 * better on colored terminals. Layout: a list + detail split that collapses to
 * a column in a narrow panel, a stacked composition bar with a legend, and a
 * trend strip with a marker row.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { LocationRef } from "@opencode/client"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { MouseButton, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { realpathSync } from "node:fs"
import { estimate, type SliceName } from "./estimate"
import { WhatContext } from "./rpc"
import type { CallView } from "./types"

/** The content name the panel slot publishes for this plugin. */
const NAME = "what-context"

/** The request list's fixed width in the split layout. */
const LIST_WIDTH = 36

/** The split layout needs this width before the detail can breathe. */
const SPLIT_MIN_WIDTH = 76

/** Detail bars are at most this many cells. */
const BAR_WIDTH = 20

/** Header gauge width in cells. */
const GAUGE_CELLS = 10

/** Trend strip: at most this many recent requests. */
const TREND_MAX = 40

/**
 * Retry ladder for the `calls` fetch. Right after boot the server may not have
 * registered the plugin's RPC yet, so the first call can 400; the panel retries
 * on a doubling backoff and self-heals without needing a reopen.
 */
const LOAD_MAX_RETRIES = 5
const LOAD_RETRY_BASE_MS = 250

/** One-cell-per-request trend blocks, low to full. */
const BLOCKS = "▁▂▃▄▅▆▇█"

/**
 * One block glyph per slice, in wire-body order. The four block densities are
 * the channel that separates the slices of the stacked composition bar on any
 * theme; the house hues only decorate them.
 */
const SLICE_GLYPH: Record<SliceName, string> = {
  system: "█",
  messages: "▓",
  tools: "▒",
  scaffolding: "░",
}

/**
 * The decoration color of one slice: the house hues where the terminal has
 * them, and the faint step for scaffolding, which is deliberately the
 * quietest. On a monochrome terminal the hues may collapse to gray; the block
 * glyphs keep the slices apart.
 *
 * @param name - The slice identity.
 * @param theme - The resolved theme.
 * @returns The slice's color.
 */
function sliceHue(name: SliceName, theme: Context["theme"]): RGBA {
  if (name === "system") return theme.hue.accent[400]
  if (name === "messages") return theme.hue.interactive[400]
  if (name === "tools") return theme.hue.neutral[400]
  return theme.text.faint
}

/**
 * Format a token count for display: `992`, `12.3k`, `1.2m`.
 *
 * @param n - The token count.
 * @returns The compact form.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

/**
 * Resolve a directory to its real path, tolerating paths that no longer exist
 * (for instance a project directory removed while the TUI is open).
 *
 * @param directory - The directory as supplied by the TUI or the session.
 * @returns The real path, or the input when it cannot be resolved.
 */
function canonicalize(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/**
 * A readable message for any thrown value. RPC errors cross the wire as plain
 * objects rather than `Error` instances, so `String(err)` would yield
 * `[object Object]`.
 *
 * @param err - The thrown value.
 * @returns Its message, or its string form.
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null) {
    const message = (err as { readonly message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(err)
}

/**
 * A slice of the selected record's prompt, ready for a bar row.
 */
interface SliceView {
  /** The slice identity. */
  readonly name: SliceName
  /** The slice's share of the prompt (0..1). */
  readonly share: number
  /** Estimated tokens, or null when no usage has landed. */
  readonly tokens: number | null
}

/**
 * The slice views for a record: token share when usage is present, otherwise
 * rendered-byte share (the bars still show the composition's proportions).
 *
 * @param rec - The stored per-call record.
 * @returns The four slices in wire-body order, or empty when nothing can be shown.
 */
function sliceViews(rec: CallView): SliceView[] {
  const est = estimate(rec)
  if (est.slices.length > 0) {
    const total = est.slices.reduce((sum, s) => sum + s.rendered, 0)
    return est.slices.map((s) => ({
      name: s.name,
      share: total > 0 ? s.rendered / total : 0,
      tokens: s.tokens,
    }))
  }
  const composition = rec.composition
  const body = rec.overhead.bodyBytes
  if (composition === null || body === null || body <= 0) return []
  const parts: Array<[SliceName, number]> = [
    ["system", Math.max(0, composition.totals.systemRendered)],
    ["messages", Math.max(0, composition.totals.contentRendered)],
    ["tools", Math.max(0, composition.totals.toolsRendered)],
    ["scaffolding", Math.max(0, rec.overhead.delta ?? 0)],
  ]
  const total = parts.reduce((sum, [, bytes]) => sum + bytes, 0)
  return parts.map(([name, bytes]) => ({ name, share: total > 0 ? bytes / total : 0, tokens: null }))
}

/**
 * One system instruction source as a sub-row of the system slice.
 */
interface SourceView {
  /** The source key, e.g. `core/skill-guidance`. */
  readonly key: string
  /** The source's share of the system slice (0..1). */
  readonly share: number
  /** Estimated tokens, or null when no usage has landed. */
  readonly tokens: number | null
}

/**
 * The system sources of a record, largest first.
 *
 * @param rec - The stored per-call record.
 * @returns The per-source views, or empty when the composition has none.
 */
function sourceViews(rec: CallView): SourceView[] {
  const composition = rec.composition
  if (composition === null || composition.totals.systemRendered <= 0) return []
  const system = estimate(rec).slices.find((s) => s.name === "system")
  const sources = composition.system.flatMap((part) => part.sources ?? [])
  const views = sources.map((source) => ({
    key: source.key,
    share: source.rendered / composition.totals.systemRendered,
    tokens: system !== undefined && system.tokens !== null ? Math.round(system.tokens * (source.rendered / composition.totals.systemRendered)) : null,
  }))
  return views.sort((a, b) => b.share - a.share)
}

/**
 * One message part-type aggregate for the detail's messages sub-row.
 */
interface PartTypeView {
  /** The part type, e.g. `tool-call`. */
  readonly type: string
  /** How many parts of this type. */
  readonly count: number
  /** The type's share of the messages slice (0..1), by rendered bytes. */
  readonly share: number
  /** Estimated tokens, or null when no usage has landed. */
  readonly tokens: number | null
}

/**
 * The message part-type aggregates of a record, largest first.
 *
 * @param rec - The stored per-call record.
 * @returns The per-type views, or empty when the composition has no messages.
 */
function partTypeViews(rec: CallView): PartTypeView[] {
  const composition = rec.composition
  if (composition === null || composition.totals.contentRendered <= 0) return []
  const messages = estimate(rec).slices.find((s) => s.name === "messages")
  const grouped = new Map<string, { count: number; rendered: number }>()
  for (const message of composition.messages) {
    for (const part of message.parts) {
      const entry = grouped.get(part.type) ?? { count: 0, rendered: 0 }
      entry.count += 1
      entry.rendered += part.rendered
      grouped.set(part.type, entry)
    }
  }
  const content = composition.totals.contentRendered
  const views = Array.from(grouped.entries()).map(([type, entry]) => ({
    type,
    count: entry.count,
    share: content > 0 ? entry.rendered / content : 0,
    tokens: messages !== undefined && messages.tokens !== null ? Math.round(messages.tokens * (entry.rendered / content)) : null,
  }))
  return views.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1))
}

/**
 * A one-line status for a record that is not a fully answered primary call.
 *
 * @param rec - The stored per-call record.
 * @param warning - The theme's warning color.
 * @param info - The theme's info color.
 * @param error - The theme's error color.
 * @returns The status line, or null when the record is complete.
 */
function statusLine(
  rec: CallView,
  warning: RGBA,
  info: RGBA,
  error: RGBA,
): { text: string; color: RGBA } | null {
  if (rec.orphan === true) {
    return { text: "no response received (orphaned request)", color: warning }
  }
  if (rec.response === null) {
    return { text: "awaiting response…", color: info }
  }
  if (rec.response.status >= 400) {
    return { text: `provider error ${rec.response.status}`, color: error }
  }
  if (rec.tokens === null) {
    return { text: "no usage reported", color: warning }
  }
  return null
}

/**
 * The what-context panel, rendered inside the host's session.panel slot.
 *
 * @param props - The plugin context and the slot's panel input.
 * @returns The panel view.
 */
function Panel(props: { context: Context; panel: PanelInput }) {
  const context = props.context
  const theme = context.theme
  const client = context.client
  /**
   * The location for every RPC call.
   *
   * The service routes each RPC call to a location and matches its directory
   * literally, but a macOS shell yields a symlinked directory in its logical
   * form (`/var/folders/...` while the service registered `/private/var/...`),
   * so the TUI's own `context.location` can fail to route and the call 400s
   * with `rpc.unavailable`. The session's stored location is canonical — the
   * service realpaths on storage — so prefer it, and canonicalize whatever is
   * sent either way.
   */
  const location = createMemo<LocationRef | undefined>(() => {
    const directory =
      context.data.session.get(props.panel.sessionID)?.location?.directory ??
      context.location?.directory
    if (directory === undefined) return undefined
    return { directory: canonicalize(directory) }
  })

  const [records, setRecords] = createSignal<CallView[]>([])
  const [error, setError] = createSignal<string | null>(null)
  /** The selected record's index, or -1 to follow the newest record. */
  const [selected, setSelected] = createSignal(-1)

  /**
   * The latest `recorded` event, in a TUI-lifetime in-memory store; the panel
   * refetches when the counter changes. (The server's records live in the
   * server's storage; this is only the TUI-side change signal.)
   */
  const [last, bumpLast] = context.storage.memory("what-context.tui", {
    initial: { n: 0, sessionID: "", seq: 0 },
  })

  let generation = 0
  /** The pending `calls` retry, so unmount can cancel it. */
  let loadTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Fetch every captured record for the panel's session, oldest first.
   *
   * @param retries - How many times this fetch has already retried after an error.
   */
  async function load(retries = 0): Promise<void> {
    const sessionID = props.panel.sessionID
    const gen = ++generation
    const loc = location()
    try {
      const out = await client.rpc(WhatContext).calls({ sessionID }, { location: loc })
      if (gen !== generation) return
      const views = ((out as unknown) ?? []) as unknown as CallView[]
      views.sort((a, b) => a.seq - b.seq)
      setRecords(views)
      setError(null)
    } catch (err) {
      // Superseded by a newer load (a session change or a `recorded` event):
      // drop it and do not schedule a retry.
      if (gen !== generation) return
      // The boot race: the first call can land before the server registers the
      // plugin's RPC and 400. Retry on a doubling backoff; the panel heals
      // itself instead of sitting on the error until a reopen.
      if (retries < LOAD_MAX_RETRIES) {
        loadTimer = setTimeout(() => {
          loadTimer = null
          void load(retries + 1)
        }, LOAD_RETRY_BASE_MS * 2 ** retries)
        return
      }
      setRecords([])
      setError(errorText(err))
    }
  }

  // Refetch on session change and on every recorded event.
  createEffect(() => {
    void props.panel.sessionID
    void last.n
    void load()
  })

  // Keep up with new records; unsubscribe when the panel unmounts.
  const unsubscribe = client.rpc(WhatContext).events.on("recorded", (event) => {
    const data = event.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : null
    // If the event names a different session it is not ours — ignore. When the
    // payload is empty (the server stripped the data) we cannot tell whose it
    // is, so refetch: the refetch is for *this* panel's session and is
    // self-correcting, at the cost of an extra round trip for other sessions'
    // writes.
    if (sessionID !== null && sessionID !== props.panel.sessionID) return
    const seq = typeof data.seq === "number" ? data.seq : 0
    bumpLast((draft) => {
      draft.n += 1
      if (sessionID !== null) draft.sessionID = sessionID
      if (seq !== 0) draft.seq = seq
    })
  })
  onCleanup(() => {
    generation += 1
    if (loadTimer !== null) clearTimeout(loadTimer)
    unsubscribe()
  })

  // On session change, start following the tail.
  createEffect(() => {
    void props.panel.sessionID
    setSelected(-1)
  })

  const selection = createMemo(() => {
    const m = records().length
    if (m === 0) return -1
    const s = selected()
    return s === -1 ? m - 1 : Math.min(Math.max(0, s), m - 1)
  })

  const current = createMemo(() => {
    const i = selection()
    return i < 0 ? undefined : records()[i]
  })

  // The context window for gauges: the selected model's registered limit,
  // falling back to the largest prompt observed in the session.
  const windowSize = createMemo(() => {
    const rec = current()
    if (rec !== undefined) {
      const models = context.data.location.model.list(location()) ?? []
      const info = models.find(
        (model) => model.providerID === rec.model.providerID && model.modelID === rec.model.id,
      )
      if (info !== undefined) return info.limit.context
    }
    let max = 0
    for (const rec of records()) {
      const prompt = estimate(rec).prompt
      if (prompt !== null && prompt > max) max = prompt
    }
    return max > 0 ? max : undefined
  })

  /**
   * The selected record's fill of the context window, or null when unknown.
   *
   * @param rec - The record to measure.
   * @returns The fill ratio, unbounded above 1.
   */
  function fill(rec: CallView): number | null {
    const prompt = estimate(rec).prompt
    const window = windowSize()
    if (prompt === null || window === undefined || window <= 0) return null
    return prompt / window
  }

  /**
   * The color of a gauge at a given fill: teal, then purple, then warning,
   * then error past the window.
   *
   * @param f - The fill ratio.
   * @returns The gauge color.
   */
  function gaugeColor(f: number): RGBA {
    if (f > 1) return theme.text.feedback.error.base
    if (f >= 0.85) return theme.text.feedback.warning.base
    if (f >= 0.7) return theme.hue.interactive[500]
    return theme.hue.accent[400]
  }

  const modelLabel = createMemo(() => {
    const rec = current()
    return rec === undefined ? "" : `${rec.model.providerID}/${rec.model.id}`
  })

  // --- layout

  const width = () => props.panel.width
  const docked = () => props.panel.presentation === "panel"
  const split = () => width() >= SPLIT_MIN_WIDTH
  const barWidth = createMemo(() => Math.max(8, Math.min(BAR_WIDTH, Math.max(0, width()) - 60)))

  // In fullscreen the session is hidden, so the panel is the only surface;
  // docked, it only owns keys while the host focuses it.
  const active = () => !docked() || props.panel.focused === true

  function select(index: number): void {
    setSelected(index)
  }

  function selectDelta(delta: number): void {
    const m = records().length
    if (m === 0) return
    const i = selection()
    setSelected(Math.min(m - 1, Math.max(0, i + delta)))
  }

  // Resume following the tail when a record lands while we sit on the tail.
  let previousCount = 0
  createEffect(() => {
    const m = records().length
    const s = selected()
    if (m > previousCount && (s === -1 || s === previousCount - 1)) setSelected(-1)
    if (m < previousCount) setSelected(-1)
    previousCount = m
  })

  let list: ScrollBoxRenderable | null = null

  // Keep the selected row in view.
  createEffect(() => {
    const i = selection()
    if (i < 0 || list === null) return
    list.scrollChildIntoView(`wc-row-${records()[i].seq}`, { align: "nearest" })
  })

  // --- keymap

  context.keymap.layer(() => ({
    enabled: active,
    commands: [
      {
        id: "what-context.close",
        title: "Close context panel",
        group: "Context",
        bind: "q",
        enabled: active,
        run: () => props.panel.close(),
      },
      {
        id: "what-context.fullscreen",
        title: "Toggle context panel fullscreen",
        group: "Context",
        bind: "f",
        enabled: active,
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "what-context.select-down",
        title: "Select next request",
        group: "Context",
        bind: "j",
        enabled: active,
        run: () => selectDelta(1),
      },
      {
        id: "what-context.select-up",
        title: "Select previous request",
        group: "Context",
        bind: "k",
        enabled: active,
        run: () => selectDelta(-1),
      },
    ],
  }))

  // --- views

  const trend = createMemo(() => {
    const visible = records().slice(-TREND_MAX)
    return visible.map((rec) => {
      const f = fill(rec)
      const bucket = f === null ? -1 : Math.min(7, Math.floor(f * 8))
      return { seq: rec.seq, kind: rec.kind, char: bucket < 0 ? "·" : BLOCKS[bucket] }
    })
  })

  /**
   * The trend label: how many of the session's requests the strip shows, and
   * the window size the block heights are a share of.
   */
  const trendLabel = createMemo(() => {
    const total = records().length
    const shown = Math.min(TREND_MAX, total)
    const window = windowSize()
    return `trend ${shown < total ? `${shown} of ${total} · ` : ""}${
      window !== undefined ? `${formatTokens(window)} window` : ""
    }`
  })

  const headerGauge = createMemo(() => {
    const rec = current()
    if (rec === undefined) return { cells: "·".repeat(GAUGE_CELLS), color: theme.text.faint, label: "" }
    const f = fill(rec)
    if (f === null) return { cells: "·".repeat(GAUGE_CELLS), color: theme.text.faint, label: "no usage yet" }
    const filled = Math.min(GAUGE_CELLS, Math.round(f * GAUGE_CELLS))
    const over = f > 1
    const cells = "▇".repeat(filled) + (over ? "!" : "░".repeat(Math.max(0, GAUGE_CELLS - filled)))
    return {
      cells,
      color: gaugeColor(f),
      label: over ? ">100%" : `${Math.round(f * 100)}%`,
    }
  })

  function headerTokens(): string {
    const rec = current()
    if (rec === undefined) return ""
    const prompt = estimate(rec).prompt
    const window = windowSize()
    if (prompt === null || window === undefined) return ""
    return `${formatTokens(prompt)} / ${formatTokens(window)}`
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      minWidth={0}
      minHeight={0}
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      {/* Header: title, model, window gauge. Title and tokens take the
          emphasis channel (base + bold); the gauge fill is bolded so it reads
          against its track even where the hue has collapsed to gray. */}
      <box flexDirection="row" gap={1} height={1} flexShrink={0} minWidth={0}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0} selectable={false}>
          what-context
        </text>
        <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} minWidth={0} flexShrink={1} selectable={false}>
          {modelLabel()}
        </text>
        <Show when={current() !== undefined}>
          <text fg={headerGauge().color} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0} selectable={false}>
            {headerGauge().cells}
          </text>
          <Show when={headerGauge().label !== ""}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0} selectable={false}>
              {headerTokens()}
            </text>
            <text fg={theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
              {headerGauge().label}
            </text>
          </Show>
        </Show>
      </box>

      {/* Body: list + detail, split when wide, column when narrow. */}
      <Show
        when={error() === null && records().length > 0}
        fallback={
          <box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
            <Show
              when={error() === null}
              fallback={
                <text fg={theme.text.feedback.error.base} wrapMode="word" textAlign="center" maxWidth={width() - 4}>
                  {`failed to load records: ${error()}`}
                </text>
              }
            >
              <text fg={theme.text.muted} wrapMode="word" textAlign="center" maxWidth={width() - 4}>
                {`no captured requests yet — records appear as this session makes model calls`}
              </text>
            </Show>
          </box>
        }
      >
        <box flexGrow={1} minHeight={0} minWidth={0} flexDirection={split() ? "row" : "column"} gap={1}>
          {/* Request list. */}
          <scrollbox
            ref={(value) => {
              list = value
            }}
            scrollY
            flexGrow={split() ? 0 : 2}
            flexShrink={split() ? 0 : 1}
            width={split() ? LIST_WIDTH : "100%"}
            height={split() ? "100%" : 6}
            minWidth={0}
            minHeight={0}
          >
            <box flexDirection="column" minWidth={0}>
              <For each={records()}>
                {(rec, index) => {
                  const selectedHere = index() === selection()
                  const f = fill(rec)
                  const kind =
                    rec.kind === "primary"
                      ? "primary"
                      : rec.kind === "compaction"
                        ? "compact"
                        : rec.kind === "title"
                          ? "title"
                          : rec.kind.slice(0, 7)
                  const prompt = estimate(rec).prompt
                  const mini = f === null ? "·".repeat(8) : "▇".repeat(Math.min(8, Math.round(f * 8))) + "░".repeat(Math.max(0, 8 - Math.min(8, Math.round(f * 8))))
                  // The selected row takes base + bold (and the raised surface);
                  // non-primary kinds recede to faint so the primary calls read
                  // as the list's spine. The mini gauge carries the window
                  // fill, so no separate percentage column.
                  const rowFg = selectedHere ? theme.text.base : theme.text.muted
                  return (
                    <box
                      id={`wc-row-${rec.seq}`}
                      height={1}
                      minWidth={0}
                      backgroundColor={selectedHere ? theme.background.raised.high : undefined}
                      onMouseDown={(event) => {
                        if (event.button !== MouseButton.LEFT) return
                        select(index())
                      }}
                    >
                      <text
                        fg={rowFg}
                        attributes={selectedHere ? TextAttributes.BOLD : undefined}
                        wrapMode="none"
                        truncate
                        selectable={false}
                      >
                        {`${selectedHere ? "▸" : " "}#${String(rec.seq).padStart(4, "0")}  `}
                        <span style={{ fg: selectedHere ? rowFg : rec.kind === "primary" ? theme.text.muted : theme.text.faint }}>
                          {kind.padEnd(7)}
                        </span>
                        {`  ${prompt === null ? "·····" : formatTokens(prompt)}  ${mini}`}
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          </scrollbox>

          {/* Detail: the four-slice composition of the selected request.
              Keyed: the callback receives the record itself and re-runs
              whenever the selected record's identity changes. */}
          <Show when={current()} keyed>
            {(rec) => {
              const slices = sliceViews(rec)
              const sources = sourceViews(rec)
              const parts = partTypeViews(rec)
              const status = statusLine(rec, theme.text.feedback.warning.base, theme.text.feedback.info.base, theme.text.feedback.error.base)
              const est = estimate(rec)
              const messages = rec.composition?.messages ?? []
              const toolCount = rec.composition?.tools.length ?? 0
              const prompt = est.prompt
              const completion = est.completion
              const cacheRead = est.cacheRead
              const cacheHit = prompt !== null && prompt > 0 && cacheRead !== null ? cacheRead / prompt : 0
              return (
                <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0} gap={0}>
                  {/* The prompt as one stacked bar: segment width is share,
                      block density is identity. Non-primary kinds carry no
                      composition at all. */}
                  {slices.length > 0 ? (
                    <CompositionBar slices={slices} barWidth={barWidth()} theme={theme} />
                  ) : (
                    <text fg={theme.text.faint} wrapMode="none" truncate selectable={false}>
                      {`  ${rec.kind} call — no composition captured`}
                    </text>
                  )}
                  {/* Legend: one row per slice. The glyph ties each row to its
                      segment of the bar; tokens and share carry the numbers. */}
                  <For each={slices}>
                    {(slice) => (
                      <text wrapMode="none" truncate selectable={false}>
                        <span style={{ fg: sliceHue(slice.name, theme) }}>{SLICE_GLYPH[slice.name]}</span>
                        <span style={{ fg: theme.text.muted }}>{` ${slice.name}`.padEnd(13)}</span>
                        <span style={{ fg: theme.text.base }}>{slice.tokens === null ? "·····" : formatTokens(slice.tokens).padStart(6)}</span>
                        <span style={{ fg: theme.text.muted }}>{` ${Math.round(slice.share * 100)}%${slice.name === "tools" ? ` (${toolCount})` : ""}`}</span>
                      </text>
                    )}
                  </For>
                  {sources.length > 0 && (
                    <box flexDirection="column">
                      <text fg={theme.text.faint} wrapMode="none" truncate selectable={false}>
                        {"  system sources — % of system"}
                      </text>
                      <For each={sources.slice(0, 5)}>
                        {(source) => (
                          <text wrapMode="none" truncate selectable={false}>
                            <span style={{ fg: theme.text.muted }}>{`    ${source.key.slice(0, 20)}`.padEnd(25)}</span>
                            <span style={{ fg: theme.text.base }}>{source.tokens === null ? "·····" : formatTokens(source.tokens).padStart(6)}</span>
                            <span style={{ fg: theme.text.muted }}>{` ${Math.round(source.share * 100)}%`}</span>
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                  {parts.length > 0 && (
                    <box flexDirection="column">
                      <text fg={theme.text.faint} wrapMode="none" truncate selectable={false}>
                        {`  message parts — % of messages · ${messages.length} messages`}
                      </text>
                      <For each={parts.slice(0, 5)}>
                        {(part) => (
                          <text wrapMode="none" truncate selectable={false}>
                            <span style={{ fg: theme.text.muted }}>{`    ${part.type} (${part.count})`.padEnd(25)}</span>
                            <span style={{ fg: theme.text.base }}>{part.tokens === null ? "·····" : formatTokens(part.tokens).padStart(6)}</span>
                            <span style={{ fg: theme.text.muted }}>{` ${Math.round(part.share * 100)}%`}</span>
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                  {status !== null && (
                    <text fg={status.color} attributes={TextAttributes.BOLD} wrapMode="none" truncate selectable={false}>
                      {`  ${status.text}`}
                    </text>
                  )}
                  {prompt !== null && (
                    <text wrapMode="none" truncate selectable={false}>
                      <span style={{ fg: theme.text.base, bold: true }}>{`${formatTokens(prompt)} prompt`}</span>
                      <span style={{ fg: theme.text.muted }}>
                        {` · ${completion === null ? "···" : formatTokens(completion)} completion`}
                        {cacheRead !== null && cacheRead > 0
                          ? ` · ${formatTokens(cacheRead)} cache (${Math.round(cacheHit * 100)}%)`
                          : ""}
                      </span>
                    </text>
                  )}
                </box>
              )
            }}
          </Show>
        </box>
      </Show>

      {/* Trend: one cell per request, latest at the right. Block height is
          the window share; the selected cell is bold, and the marker row
          below points at it (^) and at compaction events (~) — shape and
          markers, not hue, carry the meaning on any theme. */}
      <box flexDirection="row" gap={1} height={1} flexShrink={0} minWidth={0}>
        <text fg={theme.text.faint} wrapMode="none" flexShrink={0} selectable={false}>
          {trendLabel()}
        </text>
        <text wrapMode="none" truncate flexGrow={1} minWidth={0} selectable={false}>
          {trend().map((cell, i) => {
            const isLatest = i === trend().length - 1
            const isSelected = cell.seq === (current()?.seq ?? -1)
            const color = isSelected
              ? theme.hue.interactive[500]
              : isLatest
                ? theme.hue.accent[500]
                : theme.text.faint
            return (
              <span style={{ fg: color, bold: isSelected }}>{cell.char}</span>
            )
          })}
        </text>
      </box>
      <box flexDirection="row" gap={1} height={1} flexShrink={0} minWidth={0}>
        <text wrapMode="none" flexShrink={0} selectable={false}>
          {" ".repeat(trendLabel().length)}
        </text>
        <text wrapMode="none" truncate flexGrow={1} minWidth={0} selectable={false}>
          {trend().map((cell) => {
            if (cell.seq === (current()?.seq ?? -1))
              return (
                <span style={{ fg: theme.text.base, bold: true }}>^</span>
              )
            if (cell.kind === "compaction")
              return (
                <span style={{ fg: theme.text.faint }}>~</span>
              )
            return " "
          })}
        </text>
      </box>

      {/* Footer: key help. */}
      <box flexDirection="row" gap={1} height={1} flexShrink={0} minWidth={0}>
        <text fg={theme.text.faint} wrapMode="none" truncate flexGrow={1} minWidth={0} selectable={false}>
          {`j/k select · q close · f ${docked() ? "fullscreen" : "dock"}`}
        </text>
      </box>
    </box>
  )
}

/**
 * The prompt of one request as a single stacked bar: each segment spans its
 * share of the prompt's rendered bytes, and each slice's block glyph marks its
 * identity. The four block densities separate the slices on any theme; the
 * house hues color them where the terminal has color.
 *
 * @param props - The row's data.
 * @returns The stacked bar row.
 */
function CompositionBar(props: {
  slices: SliceView[]
  barWidth: number
  theme: Context["theme"]
}) {
  const { theme } = props
  const width = props.barWidth
  const cells: { char: string; fg: RGBA }[] = []
  if (width <= 0 || props.slices.length === 0) {
    return (
      <text wrapMode="none" truncate selectable={false}>
        {""}
      </text>
    )
  }
  for (let i = 0; i < width; i++) {
    const pos = (i + 0.5) / width
    let slice = props.slices[props.slices.length - 1]
    let end = 0
    for (const s of props.slices) {
      end += s.share
      if (pos <= end) {
        slice = s
        break
      }
    }
    // Shares can sum to less than one when the wire body is partly unaccounted
    // for; the uncovered tail is track, not scaffolding.
    if (pos > end) cells.push({ char: "·", fg: theme.text.faint })
    else cells.push({ char: SLICE_GLYPH[slice.name], fg: sliceHue(slice.name, theme) })
  }
  return (
    <text wrapMode="none" truncate selectable={false}>
      {cells.map((cell) => (
        <span style={{ fg: cell.fg }}>{cell.char}</span>
      ))}
    </text>
  )
}

/**
 * The app-scope contribution: the `/context` slash command, the palette
 * entry, and the `<leader>v` keybind that open or close the panel.
 *
 * @param props - The plugin context.
 * @returns Nothing; the component only registers the keymap layer.
 */
function Commands(props: { context: Context }) {
  const { context } = props
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "what-context.open",
        title: "Open context panel",
        description: "Show what was sent to the model, request by request",
        slash: { name: "context" },
        group: "Context",
        palette: true,
        bind: "<leader>v",
        run() {
          const route = context.ui.router.current()
          context.ui.dialog.clear()
          const open = context.ui.panel.current()
          if (route.type === "session" && open?.sessionID === route.sessionID && open.name === NAME) {
            context.ui.panel.close()
            return
          }
          if (route.type !== "session") return
          context.ui.panel.open(NAME)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode-what-context.tui",
  setup(context) {
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === NAME}>
          <Panel context={context} panel={panel} />
        </Show>
      ),
    })
    context.ui.slot({
      append: "app",
      render: () => <Commands context={context} />,
    })
  },
})
