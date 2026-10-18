// One-off repair (18 Oct): "Turmeric" was mis-mapped to tur-dal, so the seeded tur dal chain was priced against ₹16.36.
// Re-posts today's prices, deletes our own synthetic tur dal offers/lots, and remakes that chain with the correct official price.
import { writeFileSync } from "node:fs"
import type { Hex } from "viem"
import { str } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { ingestPrices } from "../server/handler"
import { officialPrice, pub, wallets } from "../server/setu"
import { PROJECT, ROLES, type RoleId } from "../src/shared/setu"
import { attr, fillOffer, listOffer, makeLot, splitLot } from "../src/shared/setuOps"

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const w = (id: RoleId) => wallets[id]!
const idOf = (a: string) => Object.entries(ROLES).find(([, r]) => r.address.toLowerCase() === a.toLowerCase())?.[0] as RoleId
const out: Record<string, unknown> = { prices: await ingestPrices(true) }
const tur = await officialPrice("tur-dal")
log("tur-dal official now", tur?.pricePaise, tur?.label)
if (!tur || tur.pricePaise < 5000) throw new Error("tur-dal price still wrong")

for (const type of ["offer", "lot"]) {
  const rows = await pub.select({ key: true, owner: true, attributes: true }).where(eq("project", str(PROJECT)), eq("type", str(type)), eq("sku", str("ANN-TUR1"))).limit(200).fetch()
  for (const e of rows.entities) {
    const r = await w(idOf(e.owner!)).deleteEntity({ entityKey: e.key! })
    log("deleted", type, e.key, r.txHash)
  }
}

const D = 86_400_000
const product = (await pub.select({ key: true, creator: true, attributes: true }).where(eq("project", str(PROJECT)), eq("type", str("product")), eq("sku", str("ANN-TUR1"))).createdBy(ROLES.maker_food.address).limit(1).fetch()).entities[0]
const root = await makeLot(pub, w("maker_food"), { product, batch: "ANN-TUR1-B2611", qty: 2000, mfgAt: Date.now() - 5 * D, bestBefore: Date.now() + 300 * D, originState: "MP" })
log("made", root.txHash)
async function sell(seller: RoleId, buyer: RoleId, lot: Hex, qty: number, f: number) {
  const o = await listOffer(pub, w(seller), { lotKey: lot, qty, unitPricePaise: Math.round(tur!.pricePaise * f), refPricePaise: tur!.pricePaise, sellerRole: ROLES[seller].role, state: ROLES[seller].state })
  const r = await fillOffer(pub, w(seller), o.offerKey as Hex, ROLES[buyer].address); log("sold", seller, buyer, qty, r.txHash); return r.lotKey as Hex
}
const offer = async (seller: RoleId, lot: Hex, qty: number, f: number) => {
  const o = await listOffer(pub, w(seller), { lotKey: lot, qty, unitPricePaise: Math.round(tur!.pricePaise * f), refPricePaise: tur!.pricePaise, sellerRole: ROLES[seller].role, state: ROLES[seller].state })
  log("offer", seller, qty, f, o.txHash); return o
}
const d = await sell("maker_food", "distributor", root.lotKey as Hex, 800, 0.82)
const parts = await splitLot(pub, w("distributor"), d, [200, 100]); log("split", parts.txHash)
const r = await sell("distributor", "retailer", parts.children[0] as Hex, 200, 0.93)
out.offers = [await offer("retailer", r, 50, 1.0), await offer("distributor", parts.children[1] as Hex, 100, 1.36)]
const fake = await makeLot(pub, w("counterfeiter"), { product, batch: "ANN-TUR1-B2611", qty: 600, mfgAt: Date.now() - 2 * D, bestBefore: Date.now() + 200 * D, originState: "BR" })
const fo = await listOffer(pub, w("counterfeiter"), { lotKey: fake.lotKey as Hex, qty: 300, unitPricePaise: Math.round(tur.pricePaise * 0.7), refPricePaise: tur.pricePaise, sellerRole: "unlicensed", state: "BR" })
out.tur = { root, d, parts, r, fake, fakeOffer: fo }
log("counterfeit", fake.txHash, fo.txHash, "seller qty check", String(attr(await pub.getEntity(d), "qty")))
writeFileSync("../toolchain/evidence/setu-fix-tur.json", JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
process.exit(0)
