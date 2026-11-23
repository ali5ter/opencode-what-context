/** @jsxImportSource @opentui/solid */
/**
 * opencode-what-context — the context box model (pure, no JSX).
 *
 * The presentation model of the panel's context box: the context window grid
 * (one filled glyph for every used category, the four-corner glyph for free
 * space, the squared-saltire glyph for the auto-compact reserve), its figure
 * line, the composition legend with the system breakdown, the response line,
 * and the unit footer. Pure over the record and the resolved theme, so the
 * layout is unit-testable without a terminal.
 *
 * The grid always depicts the context window in the happy and title states;
 * in the shape states (a request with no usage yet) it depicts the request's
 * rendered-byte shape scaled to its estimated window share, so the free and
 * reserve glyphs keep one stable meaning in every state.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import type { ConfigEntry } from "@opencode/client"
import type { RGBA } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { estimate, type SliceName } from "./estimate"
import type { CallView } from "./types"

/** The context window grid's row count; its column count follows the box width. */
export const GRID_ROWS = 8

/** OpenCode's default auto-compaction reserve: 15% of the window... */
export const BUFFER_DEFAULT_SHARE = 0.15
/** ...floored at 16k tokens (the documented minimum). */
export const BUFFER_MIN = 16_000

/** A breakdown sub-block shows at most this many rows, then a `… +N more` row. */
export const SUB_MAX_ROWS = 5

/** The breakdown sub-row's name column width. */
export const SUB_NAME_WIDTH = 19

/**
 * The leader's minimum run in cells. A dot-leader row flexes through the
 * leader first, and only yields the name (with a single-cell ellipsis) once
 * the leader is down to this — so the row is always exactly the box's inner
 * width, and the engine's own truncation never has to step in.
 */
export const LEADER_MIN = 1

/**
 * One window-grid glyph per window category. The three are Miscellaneous
 * Symbols, each single-width, and none is in any monospace font: the terminal
 * renders them through the system fallback, and their *shapes* (a filled
 * mark, an open square, a saltire square) are the channel that separates the
 * categories on any theme. Every used category shares the one filled glyph;
 * the house hues carry the category.
 */
export const GL_FILLED = "⛁" // U+26C1, the filled cells of every used category
export const GL_FREE = "⛶" // U+26F6, free space
export const GL_BUFFER = "⛝" // U+26DD, the auto-compact reserve

/** The legend's name column width, shared by every legend row. */
export const LEGEND_NAME_WIDTH = 12

/**
 * The foreground of an RGBA as its integer channels, for colour comparison.
 *
 * @param color - The resolved colour.
 * @returns Its red, green, and blue channels.
 */
function channels(color: RGBA): [number, number, number] {
  const [r, g, b] = color.toInts()
  return [r, g, b]
}

/**
 * The squared Euclidean distance between two colours in sRGB.
 *
 * @param a - The first colour.
 * @param b - The second colour.
 * @returns The squared distance (any monotonic measure would do; this needs no sqrt).
 */
function colourDistanceSq(a: RGBA, b: RGBA): number {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2
}

/**
 * The decoration color of one used slice. The three content categories keep the
 * house hues (accent for system, interactive for messages, neutral for tools).
 * Scaffolding is the one the house palette gives no hue of its own: it is wire
 * overhead, not content, so it takes a categorical colour — but not just any.
 * The neutral scale is tightly compressed around its base step, so a "dimmer
 * grey" would not separate from the tools on the default theme; instead the
 * scaffolding picks the categorical hue *furthest* from the three house hues,
 * which keeps it distinct from system, messages, and tools on any theme. Free
 * and buffer keep their own colours and glyph shapes.
 *
 * @param name - The slice identity.
 * @param theme - The resolved theme.
 * @returns The slice's color.
 */
export function sliceHue(name: SliceName, theme: ResolvedTheme): RGBA {
  if (name === "system") return theme.hue.accent[400]
  if (name === "messages") return theme.hue.interactive[400]
  if (name === "tools") return theme.hue.neutral[400]
  const house = [theme.hue.accent[400], theme.hue.interactive[400], theme.hue.neutral[400]]
  let best = theme.text.muted
  let bestDistance = -1
  for (const scale of theme.categorical) {
    const candidate = scale[400]
    const distance = Math.min(...house.map((h) => colourDistanceSq(candidate, h)))
    if (distance > bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Format a token count for display: `992`, `12.3k`, `1.2m`.
 *
 * @param n - The token count.
 * @returns The compact form.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

// --- context box model -----------------------------------------------------

/** One cell of the context window grid: a glyph and its color. */
export interface GridCell {
  /** The cell's glyph. */
  readonly glyph: string
  /** The cell's foreground color. */
  readonly fg: RGBA
}

/**
 * One colored run of a grid row: consecutive same-color cells of one category
 * collapsed into a single span, space-separated.
 */
export interface GridRun {
  /** The run's text: the glyph repeated for the run's cell count, space-separated. */
  readonly text: string
  /** The run's foreground color. */
  readonly fg: RGBA
}

/** One legend row of the composition section. */
export interface LegendRow {
  /** The row's glyph (the window category's). */
  readonly glyph: string
  /** The row's glyph color. */
  readonly fg: RGBA
  /** The category name, left-padded to the shared column width. */
  readonly name: string
  /** The dot leader between the name and the value. */
  readonly leader: string
  /** The figure, or dots when no figure exists yet. */
  readonly value: string
  /** The share in percent, parenthesized, or null when it is unknown. */
  readonly pct: string | null
}

/**
 * The breakdown sub-rows of the two slices that have them: the system's
 * instruction sources, and the messages' part types. Tools and scaffolding
 * are leaves; the title state has neither.
 */
export interface DetailSubs {
  /** The sub-rows hanging beneath the system legend row. */
  readonly system: DetailSubRow[]
  /** The sub-rows hanging beneath the messages legend row. */
  readonly messages: DetailSubRow[]
}

/** One breakdown sub-row hanging beneath its slice's legend row. */
export interface DetailSubRow {
  /** The tree connector: `├ ` for all but the last row, `└ ` for the last. */
  readonly tree: string
  /** The row's name, left-padded to the shared column width. */
  readonly name: string
  /** The dot leader between the name and the value. */
  readonly leader: string
  /** The figure, or dots when no figure exists yet. */
  readonly value: string
  /** The share of the parent slice in percent, or null when it cannot be shown. */
  readonly pct: string | null
}

/** One span of the figure or response line. */
export interface DetailSpan {
  /** The span's text. */
  readonly text: string
  /** The span's luminance step, or the status channel for severity-colored text. */
  readonly level: "base" | "muted" | "faint" | "status"
  /** The status channel's severity, when `level` is `"status"`. */
  readonly severity?: "dim" | "warning" | "error"
  /** Whether the span is bold. */
  readonly bold?: boolean
}

/** The context box's display state for the selected record. */
export type ContextState = "happy" | "shape" | "title"

/** The context box's full content for one record, ready to render. */
export interface ContextDetail {
  /** The record's state. */
  readonly state: ContextState
  /** The window grid, one run list per row. */
  readonly rows: GridRun[][]
  /** The figure line beneath the grid. */
  readonly figure: DetailSpan[]
  /** The composition legend rows (empty in the title state). */
  readonly legend: LegendRow[]
  /** The per-slice breakdown sub-rows (both empty in the title state). */
  readonly subs: DetailSubs
  /** The response line, or null when there is nothing to report. */
  readonly response: DetailSpan[] | null
  /** The unit footer, or null in the shape states (whose figures are bytes). */
  readonly footer: string | null
}

/**
 * Split `total` into integer shares proportional to `values` (largest-remainder):
 * the floor of each exact share, then the leftover cells to the largest
 * remainders in turn, so the counts sum to exactly `total`.
 *
 * @param values - Non-negative magnitudes (token counts or share points).
 * @param total - The number of cells to distribute.
 * @returns Integer counts summing to exactly `total`.
 */
export function apportion(values: number[], total: number): number[] {
  const denom = values.reduce((sum, v) => sum + v, 0)
  if (denom <= 0 || total <= 0) return values.map(() => 0)
  const exact = values.map((v) => (v / denom) * total)
  const counts = exact.map(Math.floor)
  const order = values
    .map((_, i) => i)
    .sort((a, b) => exact[b] - counts[b] - (exact[a] - counts[a]))
  let leftover = total - counts.reduce((sum, c) => sum + c, 0)
  let k = 0
  while (leftover > 0) {
    counts[order[k % order.length]] += 1
    leftover -= 1
    k += 1
  }
  return counts
}

/** A percentage of `part` over `whole`, rounded; zero when `whole` is zero. */
export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part * 100) / whole)
}

/** A dot leader filling `n` cells. */
export function leader(n: number): string {
  return "·".repeat(Math.max(0, n))
}

/**
 * The color of a figure or response span: the luminance step it names, or the
 * theme's feedback color for the status channel.
 *
 * @param span - The span to color.
 * @param theme - The resolved theme.
 * @returns The span's foreground color.
 */
export function spanColor(span: DetailSpan, theme: ResolvedTheme): RGBA {
  if (span.level === "base") return theme.text.base
  if (span.level === "muted") return theme.text.muted
  if (span.level === "faint") return theme.text.faint
  if (span.severity === "error") return theme.text.feedback.error.base
  if (span.severity === "warning") return theme.text.feedback.warning.base
  return theme.text.muted // "dim"
}

/**
 * Assemble an ordered cell list from per-category counts and their
 * `[glyph, color]` pairs, in the given (wire-body) order.
 *
 * @param counts - The cell count per category.
 * @param pairs - One glyph and color per category, aligned with `counts`.
 * @returns The ordered cell list.
 */
export function gridCells(counts: number[], pairs: Array<[string, RGBA]>): GridCell[] {
  const cells: GridCell[] = []
  for (let i = 0; i < pairs.length; i++) {
    for (let n = 0; n < (counts[i] ?? 0); n++) cells.push({ glyph: pairs[i][0], fg: pairs[i][1] })
  }
  return cells
}

/**
 * Group a grid row's consecutive same-color cells into runs of
 * space-separated glyphs: a run is one span of the row, and the runs are
 * joined by single spaces when the row renders.
 *
 * @param row - The row's ordered cells.
 * @returns The row's runs (empty for an empty row).
 */
export function gridRowRuns(row: GridCell[]): GridRun[] {
  const runs: GridRun[] = []
  let lastCell: GridCell | null = null
  for (const cell of row) {
    // A run continues while the colour stays the same. The colour is compared
    // by value, not by reference: in a theme where two categories resolve to
    // one colour (the default dark theme's gray), their cells still form a
    // single span, exactly as the design mock groups it.
    if (lastCell !== null && sameRGBA(lastCell.fg, cell.fg)) {
      const last = runs[runs.length - 1]
      runs[runs.length - 1] = { ...last, text: `${last.text} ${cell.glyph}` }
    } else {
      runs.push({ text: cell.glyph, fg: cell.fg })
    }
    lastCell = cell
  }
  return runs
}

/** Whether two RGBA colours are identical (channel by channel). */
function sameRGBA(a: RGBA, b: RGBA): boolean {
  const ia = a.toInts()
  const ib = b.toInts()
  return ia[0] === ib[0] && ia[1] === ib[1] && ia[2] === ib[2] && ia[3] === ib[3]
}

/**
 * The one-line status of a call that is not a fully answered primary: its
 * text and severity. The figure line and the response line carry the same
 * words; the render maps the severity to a theme color.
 *
 * @param rec - The stored per-call record.
 * @returns The status, or null when the call is complete.
 */
export function callStatus(rec: CallView): { text: string; severity: "dim" | "warning" | "error" } | null {
  if (rec.orphan === true) return { text: "no response received", severity: "warning" }
  if (rec.response === null) return { text: "no usage yet", severity: "dim" }
  if (rec.response.status >= 400) {
    return { text: `provider error ${rec.response.status}`, severity: "error" }
  }
  if (rec.tokens === null) return { text: "no usage reported", severity: "warning" }
  return null
}

/**
 * The resolved compaction settings: the auto-compact switch and the buffer as
 * a window share (configured as a percent string) or a token count (configured
 * as a number).
 */
export interface CompactionConfig {
  readonly auto: boolean
  readonly pct: number | null
  readonly tokens: number | null
}

/**
 * Parse the compaction settings out of the config documents: the last document
 * that defines `compaction` wins (the documents arrive in merge-precedence
 * order).
 *
 * @param entries - The config documents as served by the client.
 * @returns The resolved settings, or null when no document defines them.
 */
export function parseCompaction(entries: ConfigEntry[]): CompactionConfig | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type !== "document") continue
    const c = entry.info.compaction
    if (c === undefined) continue
    let pct: number | null = null
    let tokens: number | null = null
    if (typeof c.buffer === "string") {
      const n = parseFloat(c.buffer)
      if (Number.isFinite(n) && n > 0) pct = Math.min(1, n / 100)
    } else if (typeof c.buffer === "number" && c.buffer > 0) {
      tokens = c.buffer
    }
    return { auto: c.auto ?? true, pct, tokens }
  }
  return null
}

/**
 * The context box's state for a record:
 * - `happy` — a primary call whose usage landed: the grid depicts the window.
 * - `shape` — a primary call whose usage has not landed (in flight, orphaned,
 *   or a provider error): the grid depicts the request's rendered-byte shape.
 * - `title` — a non-primary call, or one with no usable composition: the
 *   grid shows a single unclassified band.
 *
 * @param rec - The stored per-call record.
 * @returns The state.
 */
export function contextState(rec: CallView): ContextState {
  const est = estimate(rec)
  const body = rec.overhead.bodyBytes
  const usable = rec.composition !== null && body !== null && body > 0
  if (rec.kind !== "primary" || !usable) return "title"
  return est.prompt !== null ? "happy" : "shape"
}

/**
 * The shape states' window share: the in-flight request's estimated share of
 * the window, scaling the previous completed call's measured prompt by the
 * request-body growth ratio. One hundred — the request rendered at full
 * scale — when there is no measured baseline or no known window.
 *
 * @param rec - The in-flight record.
 * @param records - Every record of the session, oldest first.
 * @param window - The context window in tokens, or undefined.
 * @returns The share in percent, 0..100.
 */
export function shapeSharePct(rec: CallView, records: CallView[], window: number | undefined): number {
  if (window === undefined || window <= 0) return 100
  const cur = rec.request.bodyBytes
  if (cur === null || cur <= 0) return 100
  for (let i = records.length - 1; i >= 0; i--) {
    const prev = records[i]
    if (prev.seq >= rec.seq) continue
    const prevBody = prev.request.bodyBytes
    const prevPrompt = estimate(prev).prompt
    if (prevBody === null || prevBody <= 0 || prevPrompt === null || prevPrompt <= 0) continue
    const tokens = (cur * prevPrompt) / prevBody
    return Math.min(100, Math.max(0, Math.round((tokens * 100) / window)))
  }
  return 100
}

/**
 * Build the context box's content for one record: the window grid, its figure
 * line, the composition legend, the system breakdown, the response line, and
 * the unit footer.
 *
 * The grid always depicts the context window in the happy and title states.
 * In the shape states it depicts the request's rendered-byte shape scaled to
 * its estimated window share (variant B of the design: one stable meaning for
 * the grid in every state); when no share can be estimated it renders the
 * request at full scale and the note says so.
 *
 * @param rec - The selected record.
 * @param records - Every record of the session, oldest first (the shape-share baseline).
 * @param window - The context window in tokens, or undefined when unknown.
 * @param windowKnown - Whether the window is the model's registered limit.
 * @param buffer - The auto-compact reserve in tokens; zero renders it as free.
 * @param inner - The box's content width in cells.
 * @param theme - The resolved theme.
 * @returns The box's content, ready to render.
 */
/**
 * Fit a row's name into the box: padded to its nominal width when the box
 * hosts it, elided to a single-cell ellipsis when the box cannot host name,
 * leader, and figure together. The leader absorbs the difference down to
 * {@link LEADER_MIN}; only the name's excess beyond that is cut, so the
 * composed row is never wider than the box and the renderer's own
 * truncation (a hard `...` mid-name) never has to step in.
 *
 * @param name - The full name.
 * @param nominal - The name's nominal width in cells.
 * @param lead - The cells left of the name (glyph plus gap, or tree connector).
 * @param after - The cells right of the leader (figure plus share).
 * @param inner - The box's content width in cells.
 * @returns The name, padded or elided, at the width that keeps the row exact.
 */
function fitName(name: string, nominal: number, lead: number, after: number, inner: number): string {
  const w = Math.min(nominal, Math.max(0, inner - lead - after - LEADER_MIN))
  if (name.length <= w) return name.padEnd(w)
  return w > 1 ? `${name.slice(0, w - 1)}…` : name.slice(0, w)
}

export function contextDetail(
  rec: CallView,
  records: CallView[],
  window: number | undefined,
  windowKnown: boolean,
  buffer: number,
  inner: number,
  theme: ResolvedTheme,
): ContextDetail {
  const state = contextState(rec)
  const est = estimate(rec)
  const prompt = est.prompt
  // A grid row is 2*cols-1 cells (glyphs space-separated); this keeps it at
  // or under the inner width at every box width.
  const cols = Math.max(1, Math.floor((inner + 1) / 2))
  const total = cols * GRID_ROWS
  const hue = {
    system: sliceHue("system", theme),
    messages: sliceHue("messages", theme),
    tools: sliceHue("tools", theme),
    scaffolding: sliceHue("scaffolding", theme),
    free: theme.text.faint,
    buffer: theme.text.feedback.warning.base,
    unclassified: theme.text.muted,
  }

  /** A legend row: colored glyph, padded name, dot leader, figure, dim share. */
  const legendRow = (glyph: string, fg: RGBA, name: string, tokens: number | null, whole: number | null): LegendRow => {
    const value = tokens === null ? "·····" : formatTokens(tokens)
    const pctText = tokens === null || whole === null ? null : `${percent(tokens, whole)}%`.padStart(5)
    const after = ` ${value.padStart(6)}${pctText !== null ? ` ${pctText}` : ""}`
    const fitted = fitName(name, LEGEND_NAME_WIDTH, 2, after.length, inner) // glyph + gap
    return {
      glyph,
      fg,
      name: fitted,
      leader: leader(inner - 2 - fitted.length - after.length),
      value,
      pct: pctText,
    }
  }

  /** A breakdown sub-row: tree connector, padded name, dot leader, figure, dim share. */
  const subRow = (tree: string, name: string, tokens: number | null, share: number | null): DetailSubRow => {
    const value = tokens === null ? "·····" : formatTokens(tokens)
    const pctText = share === null ? null : `${Math.round(share * 100)}%`.padStart(5)
    const after = ` ${value.padStart(6)}${pctText !== null ? ` ${pctText}` : ""}`
    const fitted = fitName(name, SUB_NAME_WIDTH, 2, after.length, inner) // tree connector
    return {
      tree,
      name: fitted,
      leader: leader(inner - 2 - fitted.length - after.length),
      value,
      pct: pctText,
    }
  }

  /**
   * The breakdown sub-rows of one slice: up to the cap, then a summed `more`
   * row. Only the system (instruction sources) and messages (part types)
   * slices have breakdowns; tools and scaffolding are leaves.
   */
  const breakdownSubs = (name: SliceName): DetailSubRow[] => {
    const entries = breakdownRows(name, rec)
    if (entries === null || entries.length === 0) return []
    const shown = entries.slice(0, SUB_MAX_ROWS)
    const hidden = entries.slice(SUB_MAX_ROWS)
    const rows = [
      ...shown,
      ...(hidden.length > 0
        ? [
            {
              name: `… +${hidden.length} more`,
              tokens: hidden.every((h) => h.tokens === null) ? null : hidden.reduce((sum, h) => sum + (h.tokens ?? 0), 0),
              share: hidden.reduce((sum, h) => sum + h.share, 0),
            },
          ]
        : []),
    ]
    return rows.map((row, i) =>
      subRow(i === rows.length - 1 ? "└ " : "├ ", row.name, row.tokens, row.share),
    )
  }

  const status = callStatus(rec)

  // The shape states: the request's rendered-byte shape, scaled.
  if (state === "shape") {
    const slices = sliceViews(rec)
    const share = shapeSharePct(rec, records, window)
    const [usedN, freeN] = apportion([share, 100 - share], total)
    const counts = apportion(slices.map((s) => s.share), usedN)
    const cells = gridCells(counts, [
      [GL_FILLED, hue.system],
      [GL_FILLED, hue.messages],
      [GL_FILLED, hue.tools],
      [GL_FILLED, hue.scaffolding],
    ])
    cells.push(...Array.from({ length: freeN }, () => ({ glyph: GL_FREE, fg: hue.free })))
    const note =
      share >= 100 ? "shares by rendered bytes" : `est. ${share}% of window (bytes)`
    const figure: DetailSpan[] = []
    if (status !== null) {
      figure.push({ text: status.text, level: "status", severity: status.severity })
      figure.push({ text: ` · ${note}`, level: "faint" })
    } else {
      figure.push({ text: note, level: "faint" })
    }
    return {
      state,
      rows: chunkRows(cells, cols),
      figure,
      // The shape states' legend shares are the request's rendered-byte
      // shares: the one number the bytes can still measure. The figures are
      // placeholders, so the row is fitted in one pass against the final
      // (share-bearing) width.
      legend: (
        [
          [hue.system, "System"],
          [hue.messages, "Messages"],
          [hue.tools, "Tools"],
          [hue.scaffolding, "Scaffolding"],
        ] as const
      ).map(([fg, name], i) => {
        const pct = slices[i] !== undefined ? `${Math.round(slices[i].share * 100)}%`.padStart(5) : null
        const value = "·····"
        const after = ` ${value.padStart(6)}${pct !== null ? ` ${pct}` : ""}`
        const fitted = fitName(name, LEGEND_NAME_WIDTH, 2, after.length, inner)
        return {
          glyph: GL_FILLED,
          fg,
          name: fitted,
          leader: leader(inner - 2 - fitted.length - after.length),
          value,
          pct,
        }
      }),
      subs: { system: breakdownSubs("system"), messages: breakdownSubs("messages") },
      response:
        status !== null
          ? [
              { text: "→ ", level: "faint" },
              { text: status.text, level: "status", severity: status.severity },
            ]
          : null,
      footer: null,
    }
  }

  // The title states: a non-primary call, or no usable composition.
  if (state === "title") {
    let cells: GridCell[]
    let figure: DetailSpan[]
    if (window !== undefined && window > 0 && (prompt ?? 0) > 0) {
      const free = Math.max(0, window - (prompt ?? 0) - buffer)
      const counts = apportion([prompt ?? 0, free, buffer], total)
      cells = gridCells(counts, [
        [GL_FILLED, hue.unclassified],
        [GL_FREE, hue.free],
        [GL_BUFFER, hue.buffer],
      ])
      figure = [
        { text: `${percent(prompt ?? 0, window)}% used`, level: "base" },
        { text: ` · ${formatTokens(prompt ?? 0)}/${formatTokens(window)}`, level: "muted" },
      ]
    } else if (prompt !== null && prompt > 0) {
      // No known window: the request at full scale, like the shape states.
      cells = gridCells([total], [[GL_FILLED, hue.unclassified]])
      figure = [
        { text: `${formatTokens(prompt)} prompt`, level: "base" },
        { text: " · window size unknown", level: "faint" },
      ]
    } else {
      cells = Array.from({ length: total }, () => ({ glyph: GL_FREE, fg: hue.free }))
      figure =
        status !== null
          ? [{ text: status.text, level: "status", severity: status.severity }]
          : [{ text: "no usage yet", level: "muted" }]
    }
    const completion = est.completion
    const response: DetailSpan[] | null =
      completion !== null && completion > 0
        ? [
            { text: "→ ", level: "faint" },
            { text: formatTokens(completion), level: "base" },
            { text: " response", level: "muted" },
          ]
        : status !== null
          ? [
              { text: "→ ", level: "faint" },
              { text: status.text, level: "status", severity: status.severity },
            ]
          : null
    return {
      state,
      rows: chunkRows(cells, cols),
      figure,
      legend: [],
      subs: { system: [], messages: [] },
      response,
      footer: "all numbers in tokens",
    }
  }

  // The happy states: a fully answered primary call.
  const sliceTokens = (name: SliceName): number =>
    est.slices.find((s) => s.name === name)?.tokens ?? 0
  const sys = sliceTokens("system")
  const msg = sliceTokens("messages")
  const tool = sliceTokens("tools")
  const scaff = sliceTokens("scaffolding")
  const cacheRead = est.cacheRead ?? 0

  let cells: GridCell[]
  let figure: DetailSpan[]
  const free =
    window !== undefined && window > 0 ? window - (prompt ?? 0) - buffer : 0
  if (windowKnown && window !== undefined && window > 0) {
    const counts = apportion([sys, msg, tool, scaff, Math.max(0, free), buffer], total)
    cells = gridCells(counts, [
      [GL_FILLED, hue.system],
      [GL_FILLED, hue.messages],
      [GL_FILLED, hue.tools],
      [GL_FILLED, hue.scaffolding],
      [GL_FREE, hue.free],
      [GL_BUFFER, hue.buffer],
    ])
    figure = [
      { text: `${percent(prompt ?? 0, window)}% used`, level: "base" },
      { text: ` · ${formatTokens(prompt ?? 0)}/${formatTokens(window)}`, level: "muted" },
    ]
    if (free > 0) figure.push({ text: ` · ${formatTokens(free)} free`, level: "faint" })
    if (free < 0) {
      figure.push({ text: ` · over by ${formatTokens(-free)}`, level: "status", severity: "error", bold: true })
    }
    if ((prompt ?? 0) > 0 && cacheRead > 0) {
      figure.push({ text: ` · ${percent(cacheRead, prompt ?? 0)}% cached`, level: "muted" })
    }
  } else {
    // No known window: the request at full scale, like the shape states.
    cells = gridCells(apportion([sys, msg, tool, scaff], total), [
      [GL_FILLED, hue.system],
      [GL_FILLED, hue.messages],
      [GL_FILLED, hue.tools],
      [GL_FILLED, hue.scaffolding],
    ])
    figure = [
      { text: `${formatTokens(prompt ?? 0)} prompt`, level: "base" },
      { text: " · window size unknown", level: "faint" },
    ]
  }

  const whole = windowKnown && window !== undefined && window > 0 ? window : null
  const legend = [
    legendRow(GL_FILLED, hue.system, "System", sys, whole),
    legendRow(GL_FILLED, hue.messages, "Messages", msg, whole),
    legendRow(GL_FILLED, hue.tools, "Tools", tool, whole),
    legendRow(GL_FILLED, hue.scaffolding, "Scaffolding", scaff, whole),
  ]
  if (free > 0) legend.push(legendRow(GL_FREE, hue.free, "Free", free, whole))
  if (buffer > 0) legend.push(legendRow(GL_BUFFER, hue.buffer, "Buffer", buffer, whole))

  const completion = est.completion
  const reasoning = rec.tokens?.reasoning ?? 0
  const reasoningSpan: DetailSpan | null =
    reasoning > 0 ? { text: ` (${formatTokens(reasoning)} reasoning)`, level: "muted" } : null
  const response: DetailSpan[] | null =
    completion !== null && completion > 0
      ? [
          { text: "→ ", level: "faint" },
          { text: formatTokens(completion), level: "base" },
          { text: " response", level: "muted" },
          ...(reasoningSpan !== null ? [reasoningSpan] : []),
        ]
      : null

  return {
    state: "happy",
    rows: chunkRows(cells, cols),
    figure,
    legend,
    subs: { system: breakdownSubs("system"), messages: breakdownSubs("messages") },
    response,
    footer: "all numbers in tokens",
  }
}

/**
 * Chunk the ordered cell list into the grid's rows.
 *
 * @param cells - The ordered cell list.
 * @param cols - The cells per row.
 * @returns One row per `cols` cells, each run-grouped.
 */
export function chunkRows(cells: GridCell[], cols: number): GridRun[][] {
  const rows: GridRun[][] = []
  for (let i = 0; i < cells.length; i += cols) rows.push(gridRowRuns(cells.slice(i, i + cols)))
  return rows
}


/**
 * A slice of the selected record's prompt, ready for a bar row.
 */
export interface SliceView {
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
export function sliceViews(rec: CallView): SliceView[] {
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
export interface SourceView {
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
export function sourceViews(rec: CallView): SourceView[] {
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
export interface PartTypeView {
  /** The part type, e.g. `text`, `tool`, or `reasoning`. */
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
export function partTypeViews(rec: CallView): PartTypeView[] {
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

/** One row of a breakdown sub-block, formatted for the block's shared columns. */
export interface SubRow {
  /** The row's label: a source key, part type, tool name, or agent name. */
  readonly name: string
  /** Estimated tokens, or null when no usage has landed. */
  readonly tokens: number | null
  /** The row's share of its slice (0..1). */
  readonly share: number
}

/**
 * The breakdown tree that hangs beneath a slice's legend row: the record's
 * system sources under `system`, its message part types under `messages`.
 * Every other slice — tools among them, per the panel's no-tool-names rule —
 * is a leaf.
 *
 * @param name - The slice the row would break down.
 * @param rec - The stored per-call record.
 * @returns The entries, largest first, or null when the slice has none.
 */
export function breakdownRows(name: SliceName, rec: CallView): SubRow[] | null {
  if (name === "system") {
    const sources = sourceViews(rec)
    if (sources.length === 0) return null
    return sources.map((s) => ({ name: s.key, tokens: s.tokens, share: s.share }))
  }
  if (name === "messages") {
    const parts = partTypeViews(rec)
    if (parts.length === 0) return null
    return parts.map((p) => ({ name: p.type, tokens: p.tokens, share: p.share }))
  }
  return null
}