/**
 * One-off probe: do `recorded` RPC events reach the global event stream?
 *
 * Usage: node scripts/probe-events.mjs [baseUrl] [seconds]
 *
 * The probe process itself triggers nothing — a separate model call in the
 * service (e.g. the live session's next turn) is what fires the event.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { OpenCode } from "@opencode/client"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:49374"
const seconds = Number(process.argv[3] ?? 25)

const service = JSON.parse(readFileSync(`${homedir()}/.config/opencode/service.json`, "utf8"))
const auth = `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`

const client = OpenCode.make({ baseUrl, headers: { authorization: auth } })

const deadline = Date.now() + seconds * 1000
let seen = 0
console.log(`listening for rpc.what-context.recorded for ${seconds}s …`)
try {
  for await (const event of client.event.subscribe({ types: ["rpc.what-context.recorded"] })) {
    if (Date.now() > deadline) break
    seen += 1
    console.log(`  ${seen}: ${JSON.stringify(event.data ?? event)}`)
  }
} catch (err) {
  console.log("subscribe ended:", err instanceof Error ? err.message : err)
}
console.log(seen === 0 ? "no events seen" : `done, ${seen} event(s)`)
