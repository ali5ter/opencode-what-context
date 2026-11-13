/**
 * One-off probe: does the running OpenCode service know the what-context RPC?
 *
 * Usage: node scripts/probe-rpc.mjs [baseUrl] [sessionID]
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { OpenCode } from "@opencode/client"
import { WhatContext } from "../src/rpc.ts"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:49374"
const sessionID = process.argv[3] ?? "ses_e2e48de3fffeZY1tul1Xii7FDX"

// The service authenticates with HTTP basic: user "opencode", password from service.json.
const service = JSON.parse(readFileSync(`${homedir()}/.config/opencode/service.json`, "utf8"))
const auth = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`

const client = OpenCode.make({ baseUrl, headers: { authorization: auth } })

const info = await client.server.info()
console.log("service:", JSON.stringify({ version: info.version, name: info.name }))

const rpc = client.rpc(WhatContext)
try {
  const calls = await rpc.calls({ sessionID }, { location: { directory: process.cwd() } })
  const rows = Array.isArray(calls) ? calls : []
  console.log(`calls(${sessionID}): ${rows.length} records`)
  for (const rec of rows.slice(-5)) {
    const comp = rec.composition
    const usage = rec.response?.usage ?? null
    console.log(
      `  #${rec.seq} kind=${rec.kind ?? "?"} model=${rec.model?.id ?? "?"} ` +
        `status=${rec.response?.status ?? "?"} prompt_tokens=${usage?.prompt_tokens ?? "?"} ` +
        `systemParts=${comp?.system?.length ?? 0} tools=${comp?.tools?.length ?? 0} messages=${comp?.messages?.length ?? 0}` +
        (rec.orphan ? " ORPHAN" : ""),
    )
  }
} catch (err) {
  console.error("calls() failed:", err instanceof Error ? err.message : err)
  process.exit(1)
}
