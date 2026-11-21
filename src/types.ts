/**
 * opencode-what-context — shared record and view types.
 *
 * The per-call record (`CallRecord`) is the single source of truth shared by
 * the capture side (`index.ts`), the presentation side (`tui.tsx`), and the
 * RPC bridge (`rpc.ts`).
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

/** A JSON-safe value, structurally compatible with `Schema.Json`. */
export type Shape = null | boolean | number | string | Shape[] | { [key: string]: Shape }

/** Per-source breakdown of the instructions system part. */
export interface SourceShape {
  key: string
  bytes: number
  rendered: number
  sample: string | null
  text?: string
}

/** One system part of the request. */
export interface SystemShape {
  bytes: number
  rendered: number
  sample: string | null
  sources?: SourceShape[]
  text?: string
}

/** One content part of one message. */
export interface PartShape {
  type: string
  bytes: number
  rendered: number
  sample: string | null
  tool?: string
  text?: string
}

/** One message of the conversation. */
export interface MessageShape {
  role: string
  parts: PartShape[]
}

/** One agent entry of the subagent tool's description list. */
export interface SubagentShape {
  /** The agent name, e.g. `explorer` or `over-50s-health/advisor`. */
  name: string
  /** The entry's raw UTF-8 bytes as carried in the description. */
  bytes: number
  /** The entry's JSON-rendered bytes (its share of the description's rendering). */
  rendered: number
}

/** One tool entry of the request. */
export interface ToolShape {
  name: string
  descBytes: number
  descRendered: number
  schemaBytes: number
  schemaRendered: number
  /** The agent entries parsed from the description of a `subagent`-style tool. */
  subagents?: SubagentShape[]
  description?: string
  schema?: unknown
}

/** The per-call composition, from the `context` event (primary calls only). */
export interface CompositionShape {
  system: SystemShape[]
  messages: MessageShape[]
  tools: ToolShape[]
  totals: {
    systemBytes: number
    systemRendered: number
    contentBytes: number
    contentRendered: number
    toolsBytes: number
    toolsRendered: number
  }
}

/** Provider-reported usage, raw as delivered in the final response frame. */
export interface UsageShape {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: Shape | undefined
}

/** Normalized to the DB `session_message.data.tokens` shape. */
export interface TokensShape {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** The stored per-call record. */
export interface CallRecord {
  v: 2
  full: boolean
  kind: string
  sessionID: string
  agent: string
  model: { id: string; providerID: string; variant?: string }
  request: {
    time: string
    url: string
    method: string
    bodyBytes: number | null
    body?: string
  }
  composition: CompositionShape | null
  overhead: {
    bodyBytes: number | null
    compositionRendered: number | null
    delta: number | null
  }
  response: {
    time: string
    status: number
    usage: UsageShape | null
    body?: string
  } | null
  tokens: TokensShape | null
  orphan?: boolean
}

/** A stored record with its sequence number, as served by the RPC `calls` method. */
export interface CallView extends CallRecord {
  seq: number
}

/** The payload of the `recorded` event: a record was written or updated. */
export interface RecordedEvent {
  readonly sessionID: string
  readonly seq: number
}
