#!/usr/bin/env node
/**
 * measure.ts — Build step 2: what was sent, how much it cost, and how far off
 * the byte-based estimates are.
 *
 * Part A (always) joins the plugin's `wc/call` records (kv table) with the
 * `session_message` rows and reports, per lane:
 *   - the body/prompt ratio across calls (does the scaffolding stay constant?),
 *   - the wire scaffolding delta (bodyBytes − compositionRendered),
 *   - per-category byte-share stability across body sizes,
 *   - provider usage vs DB token agreement (the join criterion).
 *
 * Part B (`--reference`) downloads the Qwen3-32B tokenizer into
 * `.tokenizer-cache/` and, for every FULL record with provider usage:
 *   - tokenizes each composition part standalone (system sources, message text
 *     parts, tools) as the reference,
 *   - renders the wire conversation through the Qwen3 chat template and
 *     tokenizes the render (whole-prompt calibration),
 *   - tokenizes the string-zeroed skeleton of the wire body (scaffolding),
 *   - tokenizes each wire message's rendered block (prefix-diff) so the
 *     tool-call/tool-result content gets a reference too,
 *   - fits the provider's excess over the render per lane
 *     (excess = S + k·messageTokens) to locate the provider-tokenizer
 *     difference, and reports the per-slice error of the viewer's estimator
 *     E2w' = slice rendered-byte share × the provider's prompt_tokens.
 *
 * Note: the Qwen3-32B tokenizer is a reference, not the providers' — the qwen3.6
 * lane's chat template is byte-identical to Qwen3-32B's (checked against the
 * ollama debug log), but the providers' tokenizers differ by a few percent.
 *
 * Usage:
 *   node scripts/measure.ts [--reference] [--session <id>]... [--db <path>]
 */

import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import type { Message } from "@huggingface/transformers"

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  reference: boolean
  sessions: string[]
  dbPath: string
}

/**
 * Parse the command line.
 *
 * @param argv - The `process.argv` slice after the script path.
 * @returns The parsed arguments.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { reference: false, sessions: [], dbPath: join(homedir(), ".local/share/opencode/opencode.db") }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--reference") args.reference = true
    else if (arg === "--session") args.sessions.push(argv[++i] ?? "")
    else if (arg === "--db") args.dbPath = argv[++i] ?? args.dbPath
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

// ── Record shapes (mirror src/index.ts; only the fields the script reads) ──

interface UsageShape {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  [key: string]: unknown
}

interface SourceShape {
  key: string
  bytes: number
  rendered: number
  text?: string
}

interface SystemShape {
  bytes: number
  rendered: number
  sources?: SourceShape[]
  text?: string
}

interface PartShape {
  type: string
  bytes: number
  rendered: number
  tool?: string
  text?: string
}

interface MessageShape {
  role: string
  parts: PartShape[]
}

interface ToolShape {
  name: string
  descBytes: number
  descRendered: number
  schemaBytes: number
  schemaRendered: number
  description?: string
  schema?: unknown
}

interface CompositionShape {
  system: SystemShape[]
  messages: MessageShape[]
  tools: ToolShape[]
  totals: { systemRendered: number; contentRendered: number; toolsRendered: number }
}

interface CallRecord {
  v: number
  full: boolean
  kind: string
  sessionID: string
  /** The 4-digit sequence number, from the storage key. */
  seq: string
  model: { id: string; providerID: string }
  request: { time: string; url: string; bodyBytes: number | null; body?: string }
  composition: CompositionShape | null
  response: { time: string; status: number; usage: UsageShape | null } | null
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | null
}

/** The token shape persisted on a `session_message` row. */
interface DbTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** One wire message of a captured request body. */
interface WireMessage {
  role: string
  content: string | null
  name?: string
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
  reasoning_content?: string
}

/** A parsed wire request body. */
interface WireBody {
  model?: string
  messages: WireMessage[]
  tools?: unknown[]
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load all what-context call records from the kv table.
 *
 * @param db - The open database.
 * @param sessions - When non-empty, only records of these sessions.
 * @returns The parsed records, in storage order.
 */
function loadCalls(db: DatabaseSync, sessions: string[]): CallRecord[] {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE '%:wc/call/%'").all() as Array<{
    key: string
    value: string
  }>
  const out: CallRecord[] = []
  for (const row of rows) {
    let record: CallRecord
    try {
      record = JSON.parse(row.value) as CallRecord
    } catch {
      continue
    }
    record.seq = row.key.split("/").pop() ?? "?"
    if (!sessions.length || sessions.includes(record.sessionID)) out.push(record)
  }
  return out
}

interface DbRow {
  session_id: string
  time_created: number
  modelId: string | null
  tokens: DbTokens | null
}

/**
 * Load the `session_message` rows (the assistant rows carry the provider tokens).
 *
 * @param db - The open database.
 * @returns All rows with their model id and tokens parsed.
 */
function loadMessageRows(db: DatabaseSync): DbRow[] {
  const rows = db.prepare("SELECT session_id, time_created, data FROM session_message").all() as Array<{
    session_id: string
    time_created: number
    data: string
  }>
  return rows.map((row) => {
    let modelId: string | null = null
    let tokens: DbTokens | null = null
    try {
      const data = JSON.parse(row.data) as { model?: { id?: string }; tokens?: DbTokens }
      modelId = data.model?.id ?? null
      tokens = data.tokens ?? null
    } catch {
      // keep nulls
    }
    return { session_id: row.session_id, time_created: row.time_created, modelId, tokens }
  })
}

// ── Join ─────────────────────────────────────────────────────────────────────

/** The join of one captured call to its persisted DB row, when found. */
interface Join {
  db: DbRow | null
  /** Seconds between the captured request time and the DB row's time_created. */
  dtSeconds: number | null
}

/**
 * The call's completion tokens on a version-independent basis.
 *
 * The corpus spans plugin builds: current records split `output` =
 * completion − reasoning, while pre-fix records keep `output` = the full
 * completion with `reasoning` double-counted. The raw usage in the record
 * disambiguates.
 *
 * @param call - The captured call record.
 * @returns The completion tokens, or null when the record is inconsistent.
 */
function callCompletion(call: CallRecord): number | null {
  const t = call.tokens
  const completion = call.response?.usage?.completion_tokens
  if (!t || completion == null) return null
  if (t.output + t.reasoning === completion) return completion
  if (t.output === completion) return completion
  return null
}

/**
 * Join a captured call to the nearest same-session, same-model DB row.
 *
 * @param call - The captured call record.
 * @param rows - All message rows.
 * @returns The join result (null DB when no row is within the window).
 */
function joinCall(call: CallRecord, rows: DbRow[]): Join {
  // DB message rows are created at dispatch time, so anchor on the request.
  const anchor = Date.parse(call.request.time)
  if (Number.isNaN(anchor)) return { db: null, dtSeconds: null }
  let best: Join["db"] = null
  let bestDt = Infinity
  for (const row of rows) {
    if (row.session_id !== call.sessionID || row.modelId !== call.model.id) continue
    if (!row.tokens) continue
    const dt = Math.abs(row.time_created - anchor)
    if (dt < bestDt) {
      best = row
      bestDt = dt
    }
  }
  if (bestDt > 300_000) return { db: null, dtSeconds: null }
  return { db: best, dtSeconds: Math.round((best!.time_created - anchor) / 1000) }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format bytes as a compact human string.
 *
 * @param n - The byte count (or null).
 * @returns e.g. `61.9KB`, `923B`, `-`.
 */
function kb(n: number | null | undefined): string {
  if (n == null || n < 0) return "-"
  return n < 1000 ? `${n}B` : n < 100_000 ? `${(n / 1000).toFixed(1)}KB` : `${(n / 1_000_000).toFixed(2)}MB`
}

/**
 * Print a fixed-width table.
 *
 * @param headers - The column headers.
 * @param rows - The cell strings, one row at a time.
 */
function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").replace(/\s+$/, "")
  console.log(line(headers))
  console.log(widths.map((w) => "-".repeat(w)).join("  "))
  for (const row of rows) console.log(line(row))
}

/**
 * The median of a list.
 *
 * @param values - The values.
 * @returns The median, or null for an empty list.
 */
function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ── Part A: join + stability ─────────────────────────────────────────────────

/** One joined call, for reporting. */
interface JoinedCall {
  seq: string
  call: CallRecord
  join: Join
}

/**
 * Run Part A: the per-lane join table and stability aggregates.
 *
 * @param calls - All captured call records.
 * @param rows - All assistant message rows.
 */
/** The rendered-byte total of a composition. */
function compositionRendered(c: CompositionShape): number {
  return c.totals.systemRendered + c.totals.contentRendered + c.totals.toolsRendered
}

function partA(calls: CallRecord[], rows: DbRow[]): void {
  console.log(`\n# Part A — join & stability (${calls.length} call records)\n`)
  const lanes = new Map<string, JoinedCall[]>()
  for (const call of calls) {
    const lane = `${call.model.providerID}/${call.model.id}`
    const joined: JoinedCall = { seq: call.seq, call, join: joinCall(call, rows) }
    const list = lanes.get(lane) ?? []
    list.push(joined)
    lanes.set(lane, list)
  }
  for (const [lane, list] of [...lanes.entries()].sort()) {
    console.log(`## ${lane}  (${list.length} calls)`)
    const rowsOut: string[][] = []
    for (const { seq, call, join } of list) {
      const u = call.response?.usage
      const prompt = u?.prompt_tokens ?? null
      const cached = u?.prompt_tokens_details?.cached_tokens ?? null
      const t = call.tokens
      const d = join.db?.tokens
      const body = call.request.bodyBytes
      const comp = call.composition ? compositionRendered(call.composition) : null
      const ratio = body != null && prompt ? (body / prompt).toFixed(2) : "-"
      rowsOut.push([
        seq,
        call.kind,
        call.full ? "F" : "-",
        kb(body),
        kb(comp),
        kb(body != null && comp != null ? body - comp : null),
        prompt != null ? String(prompt) : "-",
        cached != null ? String(cached) : "-",
        t ? `${t.input}/${t.output}` : "-",
        d ? `${d.input ?? "?"}/${d.output ?? "?"}/cr${d.cache?.read ?? 0}` : "unjoined",
        ratio,
        join.dtSeconds != null ? `${join.dtSeconds}s` : "-",
      ])
    }
    table(["seq", "kind", "full", "body", "compR", "delta", "prompt", "cached", "tok in/out", "db in/out/cr", "B/tok", "dt"], rowsOut)

    // Aggregates over joined primary calls with usage.
    const primaries = list.filter((j) => j.call.kind === "primary" && j.call.response?.usage?.prompt_tokens)
    if (primaries.length >= 2) {
      const ratios = primaries.map((j) => (j.call.request.bodyBytes ?? 0) / (j.call.response?.usage?.prompt_tokens ?? 1))
      const deltas = primaries
        .map((j) => {
          const c = j.call.composition
          const body = j.call.request.bodyBytes
          return c && body != null ? body - compositionRendered(c) : null
        })
        .filter((n): n is number => n != null && n >= 0)
      const joinedCount = primaries.filter((j) => j.join.db).length
      const exactMatch = primaries.filter((j) => {
        const completion = callCompletion(j.call)
        const d = j.join.db?.tokens
        const t = j.call.tokens
        return (
          t != null &&
          completion != null &&
          d != null &&
          d.input === t.input &&
          (d.output ?? 0) + (d.reasoning ?? 0) === completion &&
          (d.cache?.read ?? 0) === t.cache.read
        )
      }).length
      console.log(
        `  body/prompt: first ${ratios[0].toFixed(2)}  last ${ratios[ratios.length - 1].toFixed(2)}  median ${median(ratios)?.toFixed(2)}  over ${primaries.length} calls`,
      )
      if (deltas.length) {
        console.log(`  scaffolding delta: min ${Math.min(...deltas)}B  median ${Math.round(median(deltas) ?? 0)}B  max ${Math.max(...deltas)}B`)
      }
      console.log(`  usage↔DB exact: ${exactMatch}/${joinedCount} joined`)
    }
    console.log("")
  }
  partAShares(calls)
}

/**
 * Per-category byte-share stability: the share of system / messages / tools
 * (rendered bytes) in the smallest, a middle, and the largest call per lane.
 *
 * @param calls - All captured call records.
 */
function partAShares(calls: CallRecord[]): void {
  console.log("## Per-category share stability (rendered bytes, primaries with composition)")
  const byLane = new Map<string, CallRecord[]>()
  for (const call of calls) {
    if (call.kind !== "primary" || !call.composition) continue
    const lane = `${call.model.providerID}/${call.model.id}`
    const list = byLane.get(lane) ?? []
    list.push(call)
    byLane.set(lane, list)
  }
  for (const [lane, list] of [...byLane.entries()].sort()) {
    if (list.length < 3) continue
    const sized = [...list].sort((a, b) => compositionRendered(a.composition!) - compositionRendered(b.composition!))
    const pick = [sized[0], sized[Math.floor(sized.length / 2)], sized[sized.length - 1]]
    const rows = pick.map((call) => {
      const c = call.composition!
      const total = compositionRendered(c)
      const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`
      return [`total ${kb(total)}`, pct(c.totals.systemRendered), pct(c.totals.contentRendered), pct(c.totals.toolsRendered)]
    })
    console.log(`  ${lane} (smallest / median / largest of ${list.length}):`)
    table(["size", "system", "messages", "tools"], rows)
  }
  console.log("")
}

// ── Part B: reference tokenizer ──────────────────────────────────────────────

/** The Qwen3 tokenizer, typed loosely around the parts the script uses. */
interface ReferenceTokenizer {
  /** Tokenize one string; returns the token count. */
  count(text: string): number
  /** Render a conversation with the (model's) chat template. */
  render(conversation: WireMessage[], tools: unknown[], addGenerationPrompt: boolean): string
}

/**
 * Load the Qwen3-32B tokenizer (byte-identical across the Qwen3 family) and
 * wrap it in the two operations the script needs.
 *
 * @param cacheDir - Where the ~12MB tokenizer.json download lands.
 * @returns The wrapped tokenizer.
 */
async function loadTokenizer(cacheDir: string): Promise<ReferenceTokenizer> {
  const { Qwen2Tokenizer } = await import("@huggingface/transformers")
  const tok = await Qwen2Tokenizer.from_pretrained("Qwen/Qwen3-32B", { cache_dir: cacheDir })
  return {
    count(text: string): number {
      return tok.encode(text).length
    },
    render(conversation: WireMessage[], tools: unknown[], addGenerationPrompt: boolean): string {
      // The wire messages carry provider fields (tool_calls, reasoning_content)
      // the library's Message type does not declare; the template reads them anyway.
      const result = tok.apply_chat_template(conversation as unknown as Message[], {
        tools,
        add_generation_prompt: addGenerationPrompt,
        tokenize: false,
      }) as unknown as string
      return result
    },
  }
}

/** A part measured against its reference token count. */
interface PartMeasure {
  label: string
  bytes: number
  rendered: number
  refTokens: number | null
}

/**
 * Zero every string in a JSON value, keeping structure (the scaffolding skeleton).
 *
 * @param value - Any JSON value.
 * @returns The skeleton of the same shape.
 */
function skeleton(value: unknown): unknown {
  if (typeof value === "string") return ""
  if (Array.isArray(value)) return value.map(skeleton)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = skeleton(v)
    return out
  }
  return value
}

/** The rendered block of one wire message, from the prefix-diff. */
interface WireBlock {
  role: string
  /** The rendered block text (message wrapper included). */
  text: string
  /** Token count of the block, tokenized standalone. */
  tokens: number
}

/**
 * Tokenize the wire conversation per rendered block.
 *
 * The Qwen3 template is append-only for a conversation with a single real
 * user query (the `last_query_index` scan is stable across prefixes), so
 * render(0..i) is a string prefix of render(0..i+1) and the diff is the
 * exact rendered block of message i. When the prefix property fails (e.g. a
 * second real user query re-opens the reasoning rendering), the block falls
 * back to a standalone single-message render.
 *
 * @param ref - The reference tokenizer.
 * @param wire - The parsed wire body.
 * @param hasTools - Whether the body carries a tools field.
 * @returns The per-message blocks, the generation-prompt trailer, the
 *   system-content and tools-block token counts, and the full render count.
 */
function wireBlocks(ref: ReferenceTokenizer, wire: WireBody, hasTools: boolean): {
  blocks: WireBlock[]
  trailerTokens: number
  sysTokens: number
  toolsTokens: number
  fullTokens: number
  prefixOk: boolean
} {
  const tools = wire.tools ?? []
  const fullRender = ref.render(wire.messages, tools, true)
  const fullTokens = ref.count(fullRender)
  const blocks: WireBlock[] = []
  let prev = ""
  let prefixOk = true
  for (let i = 0; i < wire.messages.length; i++) {
    let text = ""
    if (prefixOk) {
      const cur = ref.render(wire.messages.slice(0, i + 1), tools, false)
      if (cur.startsWith(prev)) {
        text = cur.slice(prev.length)
        prev = cur
      } else {
        prefixOk = false
      }
    }
    if (!text && !prefixOk) {
      // Standalone render of the single message (approximate: a fresh
      // conversation; no tools block for non-system messages).
      const t = i === 0 ? tools : []
      text = ref.render([wire.messages[i]], t, false)
    }
    blocks.push({ role: wire.messages[i].role, text, tokens: ref.count(text) })
  }
  const trailer = prefixOk ? fullRender.slice(prev.length) : ""
  // The system block includes the tools section; separate them.
  const sysOnly = ref.render([wire.messages[0]], [], false)
  let cp = 0
  while (cp < sysOnly.length && cp < (blocks[0]?.text.length ?? 0) && sysOnly[cp] === blocks[0].text[cp]) cp++
  let toolsBlock = (blocks[0]?.text ?? "").slice(cp)
  if (toolsBlock.endsWith("\n\n")) toolsBlock = toolsBlock.slice(0, -2)
  return {
    blocks,
    trailerTokens: ref.count(trailer),
    sysTokens: ref.count(sysOnly),
    toolsTokens: hasTools ? ref.count(toolsBlock) : 0,
    fullTokens,
    prefixOk,
  }
}

/** One lane's provider-excess fit: excess = S_class + k·messageTokens. */
interface LaneFit {
  sNoTools: number
  sWithTools: number
  /** Provider inflation rate on message tokens, relative to the reference. */
  k: number
  /** The mean absolute residual of the fit, in tokens. */
  residual: number
  /** The message-token counts the fit was run on. */
  points: number
}

/**
 * Fit the provider's excess over the reference render for one lane.
 *
 * Records within a lane share the same system + tools block, so the
 * provider-tokenizer excess on that block is a per-record-class constant
 * (S, with/without tools); k is the inflation rate on message tokens.
 *
 * @param fit - One point per FULL record: message tokens and provider excess.
 * @returns The fitted parameters.
 */
function fitLane(points: Array<{ withTools: boolean; msgTokens: number; excess: number }>): LaneFit {
  // Design matrix rows: [sNoTools?, sWithTools?, msgTokens] · [S0, St, k] = excess.
  const m = points.length
  const a: number[][] = points.map((p) => [p.withTools ? 0 : 1, p.withTools ? 1 : 0, p.msgTokens])
  const b = points.map((p) => p.excess)
  // Normal equations AᵀA x = Aᵀb (3×3), Gauss-Jordan elimination.
  const ata: number[][] = Array.from({ length: 3 }, () => [0, 0, 0])
  const atb: number[] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (const row of a) s += row[i] * row[j]
      ata[i][j] = s
    }
    let s = 0
    for (let r = 0; r < m; r++) s += a[r][i] * b[r]
    atb[i] = s
  }
  const singular: boolean[] = [false, false, false]
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(ata[r][col]) > Math.abs(ata[pivot][col])) pivot = r
    if (Math.abs(ata[pivot][col]) < 1e-6) {
      singular[col] = true
      continue
    }
    ;[ata[col], ata[pivot]] = [ata[pivot], ata[col]]
    ;[atb[col], atb[pivot]] = [atb[pivot], atb[col]]
    const d = ata[col][col]
    for (let c2 = col; c2 < 3; c2++) ata[col][c2] /= d
    atb[col] /= d
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = ata[r][col]
      if (f === 0) continue
      for (let c2 = col; c2 < 3; c2++) ata[r][c2] -= f * ata[col][c2]
      atb[r] -= f * atb[col]
    }
  }
  const x = atb.map((v, i) => (singular[i] ? 0 : v))
  const resid = points.map((p) => Math.abs(p.excess - (p.withTools ? 0 : 1) * x[0] - (p.withTools ? 1 : 0) * x[1] - p.msgTokens * x[2]))
  return { sNoTools: x[0], sWithTools: x[1], k: x[2], residual: resid.reduce((s, r) => s + r, 0) / m, points: m }
}

/** A per-slice measurement of the viewer's estimator against the reference. */
interface SliceMeasure {
  slice: string
  renderedBytes: number
  /** The viewer's estimate: rendered-byte share × the provider prompt. */
  e2w: number
  /** The reference tokens (Qwen3-32B) of the slice. */
  ref: number
  /** The provider-estimate of the reference (inflated by the lane fit). */
  refProvider: number
}

/**
 * Run Part B: reference tokenization and estimator error margins.
 *
 * @param calls - All captured call records.
 * @param cacheDir - The tokenizer download directory.
 */
async function partB(calls: CallRecord[], cacheDir: string): Promise<void> {
  const full = calls.filter((c) => c.full && c.response?.usage?.prompt_tokens && c.request.body)
  if (!full.length) {
    console.log("\n# Part B — no FULL records with usage; run with WC_FULL=1 to capture some.\n")
    return
  }
  console.log(`\n# Part B — reference tokenizer (${full.length} FULL calls with usage)`)
  console.log("loading Qwen/Qwen3-32B tokenizer …")
  const ref = await loadTokenizer(cacheDir)

  interface RecordData {
    call: CallRecord
    lane: string
    prompt: number
    wire: WireBody
    blocks: ReturnType<typeof wireBlocks>
    skelTokens: number
  }
  const data: RecordData[] = []
  for (const call of full) {
    let wire: WireBody
    try {
      wire = JSON.parse(call.request.body!) as WireBody
    } catch {
      console.log(`\n## ${call.model.providerID}/${call.model.id} ${call.seq}: wire body unparsable; skipped`)
      continue
    }
    const prompt = call.response!.usage!.prompt_tokens!
    const blocks = wireBlocks(ref, wire, wire.tools?.length ? true : false)
    data.push({ call, lane: `${call.model.providerID}/${call.model.id}`, prompt, wire, blocks, skelTokens: ref.count(JSON.stringify(skeleton(wire))) })
  }

  // Per-lane provider-excess fits.
  const fits = new Map<string, LaneFit>()
  const byLane = new Map<string, RecordData[]>()
  for (const d of data) {
    const list = byLane.get(d.lane) ?? []
    list.push(d)
    byLane.set(d.lane, list)
  }
  for (const [lane, list] of [...byLane.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const points = list.map((d) => ({
      withTools: d.wire.tools?.length ? true : false,
      msgTokens: d.blocks.blocks.slice(1).reduce((s, b) => s + b.tokens, 0),
      excess: d.prompt - d.blocks.fullTokens,
    }))
    fits.set(lane, fitLane(points))
  }
  for (const [lane, f] of [...fits.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    console.log(`\n## lane ${lane}: provider excess = ${f.sNoTools.toFixed(0)} (no tools) / ${f.sWithTools.toFixed(0)} (with tools) + ${(100 * f.k).toFixed(1)}%·msgTok   [${f.points} points, |resid| ${f.residual.toFixed(0)} tok]`)
  }
  const display: RecordData[] = []
  for (const [, list] of byLane) for (const d of [...list].sort((a, b) => a.call.seq.localeCompare(b.call.seq))) display.push(d)

  for (const d of display) {
    const { call, prompt, wire, blocks } = d
    console.log(`\n## ${d.lane} ${call.seq}  body ${kb(call.request.bodyBytes)}  provider prompt_tokens ${prompt}`)
    console.log(
      `  template render: ${blocks.fullTokens} tokens  (provider ${prompt}, diff ${blocks.fullTokens - prompt} = ${(100 * (blocks.fullTokens - prompt) / prompt).toFixed(1)}%)${blocks.prefixOk ? "" : "  [prefix property failed; standalone blocks]"}`,
    )
    console.log(`  scaffolding skeleton: ${d.skelTokens} tokens  (JSON envelope, strings zeroed)`)
    const msgTok = blocks.blocks.slice(1).reduce((s, b) => s + b.tokens, 0)
    const roleTok = new Map<string, number>()
    for (const b of blocks.blocks.slice(1)) roleTok.set(b.role, (roleTok.get(b.role) ?? 0) + b.tokens)
    const blockSum = blocks.blocks.reduce((s, b) => s + b.tokens, 0)
    console.log(`  message blocks (ref): ${msgTok} tokens  ` + [...roleTok.entries()].map(([r, t]) => `${r} ${t}`).join(" ") + `  trailer ${blocks.trailerTokens}  [block sum ${blockSum} + trailer vs full ${blocks.fullTokens}, seam Δ ${blocks.fullTokens - blockSum - blocks.trailerTokens}]`)

    // Per-part reference: every part with captured text + tools.
    const c = call.composition
    const measures: PartMeasure[] = []
    if (c) {
      for (const sys of c.system) {
        if (sys.sources?.length) {
          for (const source of sys.sources) {
            measures.push({ label: `system/${source.key}`, bytes: source.bytes, rendered: source.rendered, refTokens: source.text != null ? ref.count(source.text) : null })
          }
        } else if (sys.text != null) {
          measures.push({ label: "system/part", bytes: sys.bytes, rendered: sys.rendered, refTokens: ref.count(sys.text) })
        }
      }
      let messageIndex = 0
      for (const message of c.messages) {
        for (const part of message.parts) {
          if (part.text != null) {
            const label = part.type === "text" ? `msg${messageIndex}/${message.role}-text` : `msg${messageIndex}/${part.type}${part.tool ? `:${part.tool}` : ""}`
            measures.push({ label, bytes: part.bytes, rendered: part.rendered, refTokens: ref.count(part.text) })
          }
        }
        messageIndex++
      }
      for (const tool of c.tools) {
        const wireTool = { type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.schema ?? null } }
        const text = JSON.stringify(wireTool)
        measures.push({ label: `tool/${tool.name}`, bytes: tool.descBytes + tool.schemaBytes, rendered: tool.descRendered + tool.schemaRendered, refTokens: tool.schema != null ? ref.count(text) : null })
      }
    }
    const covered = measures.filter((m) => m.refTokens != null && (m.bytes > 0 || m.rendered > 0))
    if (covered.length) {
      const sumRef = covered.reduce((a, m) => a + (m.refTokens ?? 0), 0)
      const sumE1 = covered.reduce((a, m) => a + m.bytes, 0)
      const sumE2 = covered.reduce((a, m) => a + m.rendered, 0)
      if (sumRef && sumE1 && sumE2) {
        const rows = covered.map((m) => {
          const refShare = (m.refTokens ?? 0) / sumRef
          const e1 = (m.bytes / sumE1) * sumRef
          const e2 = (m.rendered / sumE2) * sumRef
          return [
            m.label.slice(0, 34),
            String(m.refTokens ?? "-"),
            kb(m.bytes),
            kb(m.rendered),
            `${(100 * refShare).toFixed(1)}%`,
            `${e1 - (m.refTokens ?? 0) >= 0 ? "+" : ""}${(e1 - (m.refTokens ?? 0)).toFixed(0)} tok`,
            `${e2 - (m.refTokens ?? 0) >= 0 ? "+" : ""}${(e2 - (m.refTokens ?? 0)).toFixed(0)} tok`,
          ]
        })
        table(["part (covered set only)", "ref tok", "raw B", "JSON B", "ref share", "E1 err", "E2 err"], rows)
        const errs = (estimate: (m: PartMeasure) => number) => {
          const list = covered.map((m) => Math.abs(estimate(m) - (m.refTokens ?? 0)))
          return { mae: list.reduce((a, b) => a + b, 0) / list.length, max: Math.max(...list) }
        }
        const e1 = errs((m) => (m.bytes / sumE1) * sumRef)
        const e2 = errs((m) => (m.rendered / sumE2) * sumRef)
        console.log(
          `  part-level vs ref: coverage ${(100 * sumRef / prompt).toFixed(0)}% of prompt  |  E1 MAE ${e1.mae.toFixed(0)} (max ${e1.max.toFixed(0)})  E2 MAE ${e2.mae.toFixed(0)} (max ${e2.max.toFixed(0)}) tokens`,
        )
      } else {
        console.log("  no measurable parts in this record")
      }
    } else {
      console.log("  no composition captured (non-primary kind)")
    }

    // Slice-level: the viewer's estimator (E2w' = rendered-byte share × the
    // provider prompt) against the provider-estimate reference.
    const fit = fits.get(d.lane)!
    const c2 = call.composition
    if (!c2) {
      console.log("  no composition captured (title/compaction kind) — slice measurement skipped")
      continue
    }
    const sysRendered = c2.totals.systemRendered
    const toolsRendered = c2.totals.toolsRendered
    const msgRendered = c2.totals.contentRendered
    const bodyBytes = call.request.bodyBytes ?? 0
    const compRendered = sysRendered + toolsRendered + msgRendered
    const skelBytes = Math.max(0, bodyBytes - compRendered)
    // The system block reference includes the tools section and the trailer.
    const blockRef = blocks.sysTokens + blocks.toolsTokens + blocks.trailerTokens
    const blockProvider = blockRef + (wire.tools?.length ? fit.sWithTools : fit.sNoTools)
    const msgProvider = msgTok * (1 + fit.k)
    // The provider's leftover after system/tools/messages: the JSON envelope
    // plus any wire-vs-part rendering delta the viewer cannot see.
    const skelProvider = prompt - blockProvider - msgProvider
    const slices: Array<[string, number, number, number]> = [
      ["system", sysRendered, blocks.sysTokens, blocks.sysTokens * (blockProvider / (blockRef || 1))],
      ["tools", toolsRendered, blocks.toolsTokens, blocks.toolsTokens * (blockProvider / (blockRef || 1))],
      ["messages", msgRendered, msgTok, msgProvider],
      ["scaffolding", skelBytes, d.skelTokens, skelProvider],
    ]
    const totalRendered = slices.reduce((s, x) => s + x[1], 0) || 1
    const measures2: SliceMeasure[] = slices.map(([slice, bytes, r, rp]) => ({ slice, renderedBytes: bytes, ref: r, refProvider: rp, e2w: (bytes / totalRendered) * prompt }))
    const rows = measures2.map((m) => [
      m.slice,
      kb(m.renderedBytes),
      String(Math.round(m.e2w)),
      `${((100 * m.e2w) / prompt).toFixed(1)}%`,
      String(Math.round(m.ref)),
      String(Math.round(m.refProvider)),
      `${m.e2w - m.refProvider >= 0 ? "+" : ""}${(m.e2w - m.refProvider).toFixed(0)} tok`,
    ])
    table(["slice", "rendered B", "E2w' est", "% of prompt", "ref", "ref·provider-est", "E2w' err"], rows)
    const errs = measures2.map((m) => Math.abs(m.e2w - m.refProvider))
    console.log(`  slice E2w' MAE ${Math.round(errs.reduce((a, b) => a + b, 0) / errs.length)} tok (max ${Math.round(Math.max(...errs))} tok, vs provider-est reference)`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = new DatabaseSync(args.dbPath, { readOnly: true })
  const calls = loadCalls(db, args.sessions)
  if (!calls.length) {
    console.error(`no wc/call records found in ${args.dbPath}`)
    process.exit(1)
  }
  const rows = loadMessageRows(db)
  partA(calls, rows)
  if (args.reference) await partB(calls, join(process.cwd(), ".tokenizer-cache"))
  db.close()
}

await main()
