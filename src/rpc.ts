/**
 * opencode-what-context — the RPC bridge between the capture side and the TUI.
 *
 * The server part and the TUI part run in different processes with separate
 * storage backends (the server's `ctx.storage` is the SQLite `kv` table; the
 * TUI's is its own state directory), so the TUI cannot read the captured
 * records directly. This definition is the bridge: the server part registers
 * the handlers, the TUI part calls them and subscribes to `recorded`.
 *
 * Wire schemas are plain JSON schema objects, the documented `Rpc.define`
 * pattern for portable definitions; the TypeScript shapes travel alongside
 * as local types, cast at the boundary.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Rpc } from "@opencode/plugin"
import type { CallView, RecordedEvent } from "./types"

/** Schema for a session selector. */
const SessionIdInput = {
  type: "object" as const,
  properties: { sessionID: { type: "string" as const } },
  required: ["sessionID"],
} satisfies Rpc.PortableValueSchema

/** Schema for a single-record selector. */
const CallInput = {
  type: "object" as const,
  properties: {
    sessionID: { type: "string" as const },
    seq: { type: "number" as const },
  },
  required: ["sessionID", "seq"],
} satisfies Rpc.PortableValueSchema

/** Schema for the `recorded` event payload. */
const Recorded = {
  schema: {
    type: "object" as const,
    properties: {
      sessionID: { type: "string" as const },
      seq: { type: "number" as const },
    },
    required: ["sessionID", "seq"],
  },
} satisfies Rpc.PortableEventDefinition

/**
 * The what-context RPC definition, shared by both plugin parts.
 *
 * `calls` serves every per-call record for a session, oldest first; `call`
 * serves one by sequence number; `recorded` fires after each write (the
 * request, and the response update) so an open TUI refetches.
 */
export const WhatContext = Rpc.define({
  id: "what-context",
  methods: {
    calls: {
      input: SessionIdInput,
      output: { type: "array" as const, items: { type: "object" as const } },
    },
    call: {
      input: CallInput,
      output: { type: "object" as const },
    },
  },
  events: {
    recorded: Recorded,
  },
})

/** The `calls` output, typed locally (the wire schema is a plain object). */
export type CallsOutput = CallView[]
/** The `call` output, typed locally. */
export type CallOutput = CallView | null
/** The `recorded` payload, typed locally. */
export type { RecordedEvent }
