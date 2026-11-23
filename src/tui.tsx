/** @jsxImportSource @opentui/solid */
/**
 * opencode-what-context — build step 3 (TUI panel) and step 4 (display).
 *
 * Renders the server part's per-call records in the session panel: a context
 * window grid with its composition legend (the E2w' estimator,
 * `estimate.ts`), a trend strip across the session's requests, and a request
 * list with a per-call mini gauge. Step 4 adds the prompt-footer
 * context-window indicator, which reads the client's synced session state
 * directly and never touches the captured records.
 *
 * The records come over the `what-context` RPC (`rpc.ts`) — the TUI process
 * cannot read the server's plugin storage — and each `recorded` event triggers
 * a refetch so the panel stays live.
 *
 * The design must survive any theme: OpenCode generates its system theme from
 * the terminal's palette, and a monochrome terminal collapses every hue token
 * to the same gray. Information therefore rides on channels that survive any
 * theme — the luminance steps (text.base/muted/faint), glyph shape (the
 * filled/free/reserve window glyphs, markers), and bold — while the house
 * hues (accent for system, interactive for messages, neutral for tools)
 * remain decoration that reads better on colored terminals.
 *
 * Layout: three stacked btop-style boxes — each a rounded frame whose border
 * carries its label and, where the section has a headline figure, that figure
 * padded to the border's right end. The context box is labelled by the
 * selected record's model and depicts the context window as a grid of single-
 * width glyphs — one filled glyph for every used category (the house hue
 * carries the category), the four-corner glyph for free space, and the
 * squared-saltire glyph for the auto-compact reserve — filled in reading
 * order, with a dot-leader legend beneath it; it is content-sized (its height
 * is the detail's row count) so the whole detail is visible whenever the
 * terminal can hold it, and it scrolls only when it cannot. The system
 * breakdown rows hang as `tree`-style `├`/`└` branches beneath the system
 * legend row; tool names and the subagent list stay out of the panel. The
 * trend strip sits between the context and the request list, which grows to
 * fill the remaining space and scrolls.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput, SlotMap } from "@opencode/plugin/tui/context"
import type { LocationRef } from "@opencode/client"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { MouseButton, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { realpathSync } from "node:fs"
import { estimate } from "./estimate"
import { WhatContext } from "./rpc"
import type { CallView } from "./types"
import {
  BUFFER_DEFAULT_SHARE,
  BUFFER_MIN,
  GRID_ROWS,
  contextDetail,
  formatTokens,
  parseCompaction,
  spanColor,
  type CompactionConfig,
  type ContextDetail,
  type DetailSpan,
} from "./context"

/** The content name the panel slot publishes for this plugin. */
const NAME = "what-context"

/** The plugin's version, shown in the panel header. Keep in sync with package.json. */
const VERSION = "0.3.1"

/** The prompt-footer indicator's gauge width in cells. */
const FOOTER_GAUGE_CELLS = 10

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
 * Request-list column widths, shared by the rows and the header row so the
 * two cannot drift apart. The token column is right-aligned (a figure), the
 * others left-aligned.
 */
const LIST_KIND_WIDTH = 7
const LIST_TOKEN_WIDTH = 6
const LIST_FILL_WIDTH = 8

/**
 * A request row's fixed cells, the gauge excluded: marker, seq, gaps, kind,
 * and tokens. The mini gauge takes whatever the box's inner width leaves,
 * capped at {@link LIST_FILL_WIDTH}, so no row ever overflows the box.
 */
const LIST_FIXED_WIDTH = 8 + LIST_KIND_WIDTH + 2 + LIST_TOKEN_WIDTH + 2

/**
 * The list's header row: a label under each column, btop-style. The window
 * label matches the gauge's *current* width so the two stay aligned when the
 * gauge shrinks in a narrow box.
 */
function listHeader(fill: number): string {
  const label = fill >= 6 ? "window".padEnd(fill) : "window".slice(0, Math.max(0, fill))
  return (
    " " +
    "#seq".padEnd(5) +
    "  " +
    "kind".padEnd(LIST_KIND_WIDTH) +
    "  " +
    "tokens".padStart(LIST_TOKEN_WIDTH) +
    "  " +
    label
  )
}

/** The mini gauge's width at a box inner width: the box's slack, capped. */
function listFillWidth(inner: number): number {
  return Math.max(0, Math.min(LIST_FILL_WIDTH, inner - LIST_FIXED_WIDTH))
}

/**
 * A section box's native title: the label, and the summary figure padded to
 * sit inside the border's right corner. The native box title is one string of
 * one color drawn on the top border, inset one cell from each corner — and
 * the native renderer drops the title entirely (it never clips) when the
 * string is longer than that inset area, so the string must be at most the
 * box's width minus four cells: the two corners and the two inset cells. The
 * leading and trailing spaces lift the text off the border dashes. The
 * native title is one string of one color, so label and figure share the
 * heading's step; the box shape, not the hue, carries the structure.
 *
 * @param label - The section's label.
 * @param width - The box's outer width in cells.
 * @param summary - The headline figure, or empty for a label-only title.
 * @returns The title string.
 */
function boxTitle(label: string, width: number, summary: string): string {
  if (summary.length === 0) return ` ${label} `
  const spaces = Math.max(1, width - 4 - label.length - summary.length - 2)
  return ` ${label}${" ".repeat(spaces)}${summary} `
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
 * The gauge color at a context-window fill: teal, then purple, then warning,
 * then error past the window. Shared by the panel's gauges and the footer
 * indicator.
 *
 * @param f - The fill ratio, unbounded above 1.
 * @param theme - The resolved theme.
 * @returns The gauge color.
 */
function gaugeColor(f: number, theme: Context["theme"]): RGBA {
  if (f > 1) return theme.text.feedback.error.base
  if (f >= 0.85) return theme.text.feedback.warning.base
  if (f >= 0.7) return theme.hue.interactive[500]
  return theme.hue.accent[400]
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

  // The context window for the selected record's model: the model's registered
  // limit (a true window), falling back to the largest prompt observed in the
  // session (a scale, not a window — `known` is false, and the context box
  // renders the request at full scale rather than a bogus free space).
  const windowFor = createMemo((): { size: number; known: boolean } | undefined => {
    const rec = current()
    if (rec !== undefined) {
      const models = context.data.location.model.list(location()) ?? []
      const info = models.find(
        (model) => model.providerID === rec.model.providerID && model.modelID === rec.model.id,
      )
      if (info !== undefined && info.limit.context > 0) {
        return { size: info.limit.context, known: true }
      }
    }
    let max = 0
    for (const rec of records()) {
      const prompt = estimate(rec).prompt
      if (prompt !== null && prompt > max) max = prompt
    }
    return max > 0 ? { size: max, known: false } : undefined
  })

  const windowSize = createMemo(() => windowFor()?.size)

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

  const modelLabel = createMemo(() => {
    const rec = current()
    return rec === undefined ? "" : `${rec.model.providerID}/${rec.model.id}`
  })

  // --- layout

  const width = () => props.panel.width
  const docked = () => props.panel.presentation === "panel"
  /** The content width inside the panel's left/right padding. */
  const contentWidth = () => Math.max(0, width() - 2)
  /** The context box's content width inside its frame and padding. */
  const innerWidth = () => Math.max(0, contentWidth() - 4)

  // The auto-compact reserve: the compaction setting's buffer, resolved
  // against the window. OpenCode's documented default (15%, floored at 16k)
  // applies when the setting is absent; `auto: false` releases the reserve,
  // and it renders as free, because no compaction is scheduled to consume it.
  // The fetch is one-way — a config change mid-session needs a panel reopen.
  const [compactionConfig, setCompactionConfig] = createSignal<CompactionConfig | null>(null)
  let configGeneration = 0
  createEffect(() => {
    const loc = location()
    const generation = ++configGeneration
    void client
      .config.get(loc !== undefined ? { location: loc } : undefined)
      .then(
        (entries) => {
          if (generation === configGeneration) setCompactionConfig(parseCompaction(entries))
        },
        () => {
          // The config is unreadable (the service restarted mid-session): the
          // documented default applies rather than hiding the reserve.
          if (generation === configGeneration) setCompactionConfig(null)
        },
      )
  })
  onCleanup(() => {
    configGeneration += 1
  })

  const bufferTokens = createMemo(() => {
    const window = windowSize()
    if (window === undefined || window <= 0) return 0
    const fallback = Math.max(BUFFER_MIN, Math.round(BUFFER_DEFAULT_SHARE * window))
    const config = compactionConfig()
    if (config === null) return fallback
    if (config.auto === false) return 0
    if (config.pct !== null) return Math.round(config.pct * window)
    if (config.tokens !== null) return Math.max(0, Math.min(window, config.tokens))
    return fallback
  })

  // The context box's content for the selected record: the window grid, its
  // figure line, the composition legend, the system breakdown, the response
  // line, and the unit footer. Pure over the panel's signals, so it recomputes
  // on selection, records, window, buffer, width, and theme changes.
  const detail = createMemo<ContextDetail | null>(() => {
    const rec = current()
    if (rec === undefined) return null
    const window = windowFor()
    return contextDetail(
      rec,
      records(),
      window?.size,
      window !== undefined && window.known,
      bufferTokens(),
      innerWidth(),
      theme,
    )
  })

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

  // Keep the selected row in view when the selection changes. Deferred: the
  // first run would drag the whole-panel scroll to the (latest) selected row
  // on open, hiding the context box — a fresh panel starts at the top.
  on(
    () => selection(),
    (i) => {
      if (i < 0 || list === null) return
      list.scrollChildIntoView(`wc-row-${records()[i].seq}`, { align: "nearest" })
    },
    { defer: true },
  )

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
   * The trend strip's cell count: fills the box's inner width (the frame and
   * its padding on each side), capped at `TREND_MAX`, and never below eight
   * so the curve stays legible on a narrow docked panel.
   */
  const trendCount = createMemo(() => Math.min(TREND_MAX, Math.max(8, contentWidth() - 4)))

  /**
   * The trend box's title figure: the window size the block heights are a
   * share of — the curve's scale label, carried on the box's border (btop
   * keeps a graph's scale at the frame's edge, not beside the curve).
   */
  const trendSummary = createMemo(() => {
    const window = windowSize()
    if (window === undefined) return ""
    const total = records().length
    // The scale label, plus a truncation figure when the strip can only show
    // part of the session's history (by record cap or by box width).
    const shown = Math.min(trend().length, trendCount())
    return shown < total
      ? `${formatTokens(window)} window · ${shown}/${total}`
      : `${formatTokens(window)} window`
  })

  /** The requests box's title figure: how many calls were captured. */
  const requestsSummary = createMemo(() => `${records().length} calls`)

  return (
    // The host places this in the session.panel slot (a box that grows to
    // fill its pane). Fill and shrink the same way, so the panel takes exactly
    // the space the view gives it — no more, no less.
    <box
      width="100%"
      flexGrow={1}
      flexShrink={1}
      flexDirection="column"
      minWidth={0}
      minHeight={0}
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      {/* Panel header: the plugin's name left, the version right. The name
          takes the slack (and truncates in a narrow pane), so the version
          stays pinned to the edge. */}
      <box flexDirection="row" width="100%" minWidth={0} minHeight={0} flexShrink={0}>
        <text
          fg={theme.text.faint}
          wrapMode="none"
          truncate
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          minHeight={0}
          selectable={false}
        >
          {"opencode-what-context"}
        </text>
        <text
          fg={theme.text.faint}
          wrapMode="none"
          truncate
          flexShrink={0}
          minWidth={0}
          minHeight={0}
          selectable={false}
        >
          {`v${VERSION}`}
        </text>
      </box>

      {/* Body: three stacked boxes — the selected request's composition
          (the box's border carries the model; its first row is the
          window-fill gauge), the trend, and the request list. The whole
          body scrolls as one: the boxes stack at their natural heights and
          the scrollbox (which fills and shrinks with the slot) carries the
          overflow, so a short view never crushes a box and a long one —
          the 200-record request list above all — stays reachable. */}
      <Show
        when={error() === null && records().length > 0}
        fallback={
          <box flexGrow={1} flexShrink={1} minHeight={0} minWidth={0} alignItems="center" justifyContent="center">
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
        <scrollbox
          ref={(value) => {
            list = value
          }}
          scrollY
          flexGrow={1}
          flexShrink={1}
          // Zero basis: a scrollbox left to auto reports its content height
          // to the column, and a 200-record list would push the header off
          // the pane. With a zero basis it takes exactly the space the slot
          // leaves below the header, and scrolls when the boxes are taller.
          flexBasis={0}
          width="100%"
          minHeight={0}
          minWidth={0}
        >
          <box flexDirection="column" width="100%" minWidth={0} gap={0}>
            {/* Context: the selected request's window, in a btop-style box.
                The border carries the model (the box's only label — a bare
                "context" would say nothing the panel does not), and the
                detail is keyed — the callback re-runs whenever the selected
                record's identity changes. The box is content-sized: it stacks
                inside the panel scroll at exactly the height its rows need. */}
            <box
              border
              borderStyle="rounded"
              borderColor={theme.text.faint}
              title={boxTitle(modelLabel() !== "" ? `Context · ${modelLabel()}` : "Context", contentWidth(), "")}
              titleColor={theme.text.muted}
              paddingLeft={1}
              paddingRight={1}
              minWidth={0}
            >
              <Show when={current()} keyed>
                  {(rec) => {
                    // The detail is a memo over the selected record (and the
                    // window, buffer, width, and theme); the keyed callback only
                    // re-runs on record identity changes, and the memo's own
                    // dependencies keep every row live. It can only be null when
                    // the record itself vanished, which `when` rules out.
                    const d = detail()
                    if (d === null) return <box flexDirection="column" width="100%" minWidth={0} />
                    const spanFg = (span: DetailSpan): RGBA => spanColor(span, theme)
                    return (
                      <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
                      {/* Usage: the window grid, filled in reading order — the
                          used slices, then free space, then the reserve. */}
                      <text fg={theme.text.base} wrapMode="none" truncate selectable={false}>
                        {`Usage:`}
                      </text>
                      <For each={d.rows}>
                        {(runs) => (
                          <text wrapMode="none" truncate selectable={false}>
                            {runs.map((run, i) => (
                              <>
                                {i > 0 ? " " : null}
                                <span style={{ fg: run.fg }}>{run.text}</span>
                              </>
                            ))}
                          </text>
                        )}
                      </For>
                      {/* The figure line: the headline numbers the grid shows. */}
                      <text wrapMode="none" truncate selectable={false}>
                        {d.figure.map((span) => (
                          <span style={{ fg: spanFg(span), bold: span.bold === true }}>{span.text}</span>
                        ))}
                      </text>
                      {/* A breathing line between the usage and the legend. */}
                      <box height={1} flexShrink={0} />
                      {/* Composition: the dot-leader legend, one row per window
                          category; the system row grows the source breakdown
                          beneath it, the messages row the part-type breakdown
                          (tree connectors, a `more` row for a hidden tail).
                          Non-primary calls carry no composition at all. */}
                      <text fg={theme.text.base} wrapMode="none" truncate selectable={false}>
                        {`Composition:`}
                      </text>
                      {d.legend.length === 0 ? (
                        <text fg={theme.text.muted} wrapMode="none" truncate selectable={false}>
                          {`no composition captured`}
                        </text>
                      ) : (
                        <For each={d.legend}>
                          {(row, i) => (
                            <>
                              <text wrapMode="none" truncate selectable={false}>
                                <span style={{ fg: row.fg }}>{row.glyph}</span>
                                <span style={{ fg: theme.text.muted }}>{` ${row.name}`}</span>
                                <span style={{ fg: theme.text.faint }}>{row.leader}</span>
                                <span style={{ fg: theme.text.base }}>{` ${row.value.padStart(6)}`}</span>
                                {row.pct !== null && (
                                  <span style={{ fg: theme.text.muted }}>{` ${row.pct}`}</span>
                                )}
                              </text>
                              {/* The legend's first two rows (system, messages)
                                  are the only slices with breakdowns; the rest
                                  are leaves. */}
                              <For
                                each={i() === 0 ? d.subs.system : i() === 1 ? d.subs.messages : []}
                              >
                                {(sub) => (
                                  <text wrapMode="none" truncate selectable={false}>
                                    <span style={{ fg: theme.text.faint }}>{sub.tree}</span>
                                    <span style={{ fg: theme.text.muted }}>{sub.name}</span>
                                    <span style={{ fg: theme.text.faint }}>{sub.leader}</span>
                                    <span style={{ fg: theme.text.base }}>{` ${sub.value.padStart(6)}`}</span>
                                    {sub.pct !== null && (
                                      <span style={{ fg: theme.text.muted }}>{` ${sub.pct}`}</span>
                                    )}
                                  </text>
                                )}
                              </For>
                            </>
                          )}
                        </For>
                      )}
                      {/* A breathing line before the response figures. */}
                      <box height={1} flexShrink={0} />
                      <text fg={theme.text.base} wrapMode="none" truncate selectable={false}>
                        {`Response:`}
                      </text>
                      {d.response !== null && (
                        <text wrapMode="none" truncate selectable={false}>
                          {d.response.map((span) => (
                            <span style={{ fg: spanFg(span), bold: span.bold === true }}>{span.text}</span>
                          ))}
                        </text>
                      )}
                      {d.footer !== null && (
                        <>
                          <box height={1} flexShrink={0} />
                          <text fg={theme.text.faint} wrapMode="none" truncate selectable={false}>
                            {d.footer}
                          </text>
                        </>
                      )}
                    </box>
                  )
                }}
              </Show>
            </box>

          {/* Trend: one cell per request, latest at the right — the box's
              border carries the window figure (the curve's scale label), so
              the strip and its marker row fill the box's width. Block height
              is the window share; the selected cell is bold, and the marker
              row below points at it (^) and at compaction events (~) — shape
              and markers, not hue, carry the meaning on any theme. */}
          <box
            border
            borderStyle="rounded"
            borderColor={theme.text.faint}
            title={boxTitle("trend", contentWidth(), trendSummary())}
            titleColor={theme.text.muted}
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            minWidth={0}
          >
            <box flexDirection="column" minWidth={0}>
              {(() => {
                // Fill the box's width with the most recent requests, latest
                // at the right, the oldest hidden ones dropped first.
                const cells =
                  trendCount() < trend().length ? trend().slice(-trendCount()) : trend()
                return (
                  <>
                    <text wrapMode="none" truncate flexShrink={0} minWidth={0} selectable={false}>
                      {cells.map((cell, i) => {
                        const isLatest = i === cells.length - 1
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
                    <text wrapMode="none" truncate flexShrink={0} minWidth={0} selectable={false}>
                      {cells.map((cell) => {
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
                  </>
                )
              })()}
            </box>
          </box>

          {/* Requests: the session's calls, oldest at the top, in a box that
              stacks at its natural height in the panel scroll. The frame is
              the native border; a header row names the columns, and every
              column is fixed width — seq, kind, right-aligned tokens, mini
              gauge — so the columns stay aligned whether a figure is present
              or a placeholder. */}
          <box
            border
            borderStyle="rounded"
            borderColor={theme.text.faint}
            title={boxTitle("requests", contentWidth(), requestsSummary())}
            titleColor={theme.text.muted}
            paddingLeft={1}
            paddingRight={1}
            minWidth={0}
          >
            <box flexDirection="column" width="100%" minWidth={0}>
              <text fg={theme.text.faint} wrapMode="none" truncate flexShrink={0} minWidth={0} selectable={false}>
                {listHeader(listFillWidth(innerWidth()))}
              </text>
              <box
                flexDirection="column"
                width="100%"
                minWidth={0}
              >
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
                      // The gauge takes whatever the box's inner width leaves
                      // past the fixed columns, so a narrow panel shrinks the
                      // gauge instead of truncating the row.
                      const fillW = listFillWidth(innerWidth())
                      const filled = f === null ? 0 : Math.min(fillW, Math.round(f * fillW))
                      const mini =
                        f === null
                          ? "·".repeat(fillW)
                          : "▇".repeat(filled) + "░".repeat(fillW - filled)
                      // The selected row takes base + bold (and the raised
                      // surface); non-primary kinds recede to faint so the
                      // primary calls read as the list's spine. The mini gauge
                      // carries the window fill, so no separate percentage
                      // column.
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
                              {kind.padEnd(LIST_KIND_WIDTH)}
                            </span>
                            {`  ${(prompt === null ? "·····" : formatTokens(prompt)).padStart(LIST_TOKEN_WIDTH)}  ${mini}`}
                          </text>
                        </box>
                      )
                    }}
                  </For>
              </box>
            </box>
          </box>
        </box>
        </scrollbox>
      </Show>

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
 * The `prompt.footer.status` slot: a context-window indicator on the prompt
 * bar, where the Claude Code prompt bar shows its context fill. It reads the
 * client's synced session state directly, like the host's own footer:
 * `lastAssistantWithUsage` picks the latest completed step after the last
 * compaction and before the revert boundary, and the model's registered
 * `limit.context` supplies the window — reactive, with no captured records
 * and no RPC.
 *
 * The host's own footer already shows the *consumed* tokens and cost as
 * numbers in the same row, so this shows the complement instead: a
 * glyph-density gauge of the window plus the *free* space (or the overrun),
 * in the panel's gauge colors — the visual channel, not a third number.
 * Appended inside the status slot, it stays one line and yields in shell
 * mode and when the host hides details.
 *
 * @param props - The plugin context, plus the slot's input.
 * @returns The indicator, or nothing when the prompt has no session, is in
 *   shell mode, the host hides details, or no usage has landed yet.
 */
function StatusIndicator(props: { context: Context; input: SlotMap["prompt.footer.status"] }) {
  const { data } = props.context
  const theme = props.context.theme
  const usage = createMemo(() => {
    if (!props.input.sessionID || props.input.mode === "shell" || !props.input.showDetails) return null
    const session = data.session.get(props.input.sessionID)
    if (!session) return null
    const step = lastAssistantWithUsage(
      data.session.message.list(props.input.sessionID),
      session.revert?.messageID,
    )
    if (!step) return null
    const tokens = step.tokens
    // On every lane the served prompt is input + the cache split (ollama
    // reports Anthropic-style: input is the uncached remainder; the openai
    // lanes report input as the full prompt and cache zero) — the same number
    // the panel's gauges use.
    const prompt = tokens.input + tokens.cache.read + tokens.cache.write
    if (prompt <= 0) return null
    const models = data.location.model.list(session.location) ?? []
    const model = models.find(
      (m) => m.providerID === step.model.providerID && m.id === step.model.id,
    )
    const window = model?.limit.context
    if (window === undefined || window <= 0) return null
    const f = prompt / window
    const filled = Math.min(FOOTER_GAUGE_CELLS, Math.max(1, Math.round(f * FOOTER_GAUGE_CELLS)))
    const cells = "▇".repeat(filled) + "░".repeat(Math.max(0, FOOTER_GAUGE_CELLS - filled))
    const free = window - prompt
    return { f, cells, free }
  })
  return (
    <Show when={usage()} keyed>
      {(u) => (
        <box flexDirection="row" gap={1} flexShrink={0} minWidth={0}>
          <text fg={theme.text.faint} wrapMode="none" truncate selectable={false}>
            ctx
          </text>
          <text wrapMode="none" truncate selectable={false}>
            <span style={{ fg: gaugeColor(u.f, theme), bold: true }}>{u.cells}</span>
            <span
              style={
                u.free < 0
                  ? { fg: theme.text.feedback.error.base, bold: true }
                  : { fg: gaugeColor(u.f, theme), bold: true }
              }
            >
              {` ${u.free < 0 ? `over by ${formatTokens(-u.free)}` : `${formatTokens(u.free)} free`}`}
            </span>
          </text>
        </box>
      )}
    </Show>
  )
}

/**
 * The app-scope contribution: the `/what-context` slash command, the palette
 * entry, the `<leader>v` keybind that open or close the panel, and the
 * prompt-footer context indicator.
 *
 * @param props - The plugin context.
 * @returns Nothing; the component only registers the keymap and slot layers.
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
        slash: { name: "what-context" },
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
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <StatusIndicator context={context} input={input} />,
    })
  },
})
