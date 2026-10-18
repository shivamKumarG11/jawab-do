// Verify Supply Setu's numbers WITHOUT our server: queries Arkiv (Tiramisu) directly. No keys needed.
// Run: npm run verify
import { createPublicClient } from "@arkiv-network/sdk"
import { i32, str } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, gt } from "@arkiv-network/sdk/query"
import { http } from "viem"

const ORACLE = "0xBdCFa186015be08C849399e754d998100cd09fCC" // official-price oracle ($creator)
const REGULATOR = "0x3E4769d8f0dB51286b468ff015d7540D2F93043c" // licence registry + recalls ($creator)
const key = process.env.ARKIV_ACCESS_KEY?.trim()
const arkiv = createPublicClient({ chain: tiramisu, transport: http(key ? `${tiramisu.rpcUrls.default.http[0]}/${key}` : undefined) })
const P = eq("project", str("supply-setu"))

const prices = arkiv.select({ key: true, attributes: true }).where(P, eq("type", str("price")), eq("source", str("doca"))).createdBy(ORACLE)
const licences = arkiv.select({ key: true, attributes: true }).where(P, eq("type", str("participant"))).createdBy(REGULATOR)
const lots = arkiv.select({ key: true, creator: true, owner: true, attributes: true }).where(P, eq("type", str("lot")))
const over = arkiv.select({ key: true, attributes: true }).where(P, eq("type", str("offer")), gt("markup_bp", i32(2000)))

const all = async <T>(q: AsyncIterable<T>) => { const out: T[] = []; for await (const x of q) out.push(x); return out }
const v = (e: { attributes?: Record<string, { value: unknown } | undefined> }, n: string) => e.attributes?.[n]?.value

console.log("1. Official prices (DoCA), oracle-created:", prices.toString())
const p = await all(prices)
const tur = p.filter((e) => v(e, "commodity") === "tur-dal").sort((a, b) => Number(v(b, "as_of")) - Number(v(a, "as_of")))[0]
console.log(`   ${new Set(p.map((e) => v(e, "commodity"))).size} commodities; Tur dal today: ₹${Number(v(tur ?? {}, "price_paise") ?? 0) / 100}/kg (${v(tur ?? {}, "date")})`)

console.log("\n2. Licence registry, regulator-created:", licences.toString())
const lic = new Set((await all(licences)).map((e) => String(v(e, "wallet")).toLowerCase()))
console.log(`   ${lic.size} licensed wallets`)

console.log("\n3. Batches whose $creator holds no licence (counterfeit):", lots.toString())
const l = await all(lots)
const fake = l.filter((e) => !lic.has(e.creator.toLowerCase()))
console.log(`   ${l.length} live batches, ${fake.length} created by unlicensed wallets: ${fake.map((e) => `${v(e, "batch")} by ${e.creator.slice(0, 8)}…`).join(", ")}`)

console.log("\n4. Offers priced > 20% above govt (numeric range on markup_bp):", over.toString())
const o = await all(over)
console.log(`   ${o.length}: ${o.map((e) => `${v(e, "sku")} +${Number(v(e, "markup_bp")) / 100}%`).join(", ")}`)
console.log("\nCompare with the live app's hero stats and marketplace filter.")
