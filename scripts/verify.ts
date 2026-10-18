// Verify Jawab Do's numbers WITHOUT our server: queries Arkiv (Tiramisu) directly.
// Run: npx tsx scripts/verify.ts            (public RPC)
//      ARKIV_ACCESS_KEY=... npx tsx scripts/verify.ts   (optional Hub access key, higher limits)
import { createPublicClient } from "@arkiv-network/sdk"
import { str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, lt } from "@arkiv-network/sdk/query"
import { http } from "viem"

const DESK = "0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2" // trusted filing desk ($creator)
const key = process.env.ARKIV_ACCESS_KEY?.trim()
const arkiv = createPublicClient({ chain: tiramisu, transport: http(key ? `${tiramisu.rpcUrls.default.http[0]}/${key}` : undefined) })

const all = arkiv
  .select({ key: true, creator: true, attributes: true })
  .where(eq("project", str("jawab-do")), eq("type", str("request")))
const overdue = arkiv
  .select({ key: true, attributes: true })
  .where(eq("project", str("jawab-do")), eq("type", str("request")), eq("stage", str("awaiting_reply")), lt("due_at", u64(Date.now())))
  .createdBy(DESK)

console.log("Query 1 (every creator):", all.toString())
const byCreator = new Map<string, number>()
for await (const e of all) byCreator.set(e.creator, (byCreator.get(e.creator) ?? 0) + 1)
console.log("Requests by $creator:", Object.fromEntries(byCreator), `(trusted desk = ${DESK})`)

console.log("\nQuery 2 (overdue, trusted desk only):", overdue.toString())
const byAuthority = new Map<string, string[]>()
for await (const e of overdue) {
  const a = String(e.attributes.authority?.value)
  byAuthority.set(a, [...(byAuthority.get(a) ?? []), String(e.attributes.ref?.value)])
}
for (const [a, refs] of [...byAuthority].sort((x, y) => y[1].length - x[1].length)) console.log(`  ${a}: ${refs.length} overdue (${refs.join(", ")})`)
console.log(`Total overdue: ${[...byAuthority.values()].flat().length}. Compare with the Overdue column on the live scorecard.`)
