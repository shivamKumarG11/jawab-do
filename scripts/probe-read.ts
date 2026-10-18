// Read-only probe: anonymous query + anonymous WebSocket subscription on Tiramisu. No wallet needed.
import { createPublicClient } from "@arkiv-network/sdk"
import { str } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { http, webSocket } from "viem"

const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

const httpClient = createPublicClient({ chain: tiramisu, transport: http() })
log("rpc urls", tiramisu.rpcUrls.default)
log("head", await httpClient.getBlockNumber())
try {
  const page = await httpClient.select({ key: true }).where(eq("project", str("jawab-do"))).limit(5).fetch()
  log("anon select ok, entities:", page.entities.length, "block", page.blockNumber)
} catch (e) {
  log("anon select FAILED:", (e as Error).message.slice(0, 300))
}

const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket() })
let events = 0
const unwatch = wsClient.watchEntityEvents({
  onEvent: (ev) => {
    events++
    if (events <= 3) log("ws event", ev.type, ev.entityKey.slice(0, 10), "block", ev.blockNumber)
  },
  onError: (e) => log("ws error", e.message.slice(0, 200)),
})
await new Promise((r) => setTimeout(r, 30_000))
unwatch()
log("ws events in 30s:", events)
process.exit(0)
