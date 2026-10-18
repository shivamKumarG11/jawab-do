// Seeds Supply Setu: REAL official prices (DoCA) + a SYNTHETIC supply chain through the same code paths the app uses.
// Run: npx tsx --env-file=.env scripts/seed-setu.ts
import { writeFileSync } from "node:fs"
import type { Hex } from "viem"
import { ingestPrices } from "../server/handler"
import { officialPrice, pub, wallets } from "../server/setu"
import { ROLES, type RoleId } from "../src/shared/setu"
import { attr, createProduct, fillOffer, listOffer, makeLot, recallBatch, registerParticipant, splitLot } from "../src/shared/setuOps"

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const w = (id: RoleId) => { const x = wallets[id]; if (!x) throw new Error(`Missing ${ROLES[id].env}`); return x }
const out: Record<string, unknown> = {}
const D = 86_400_000

// 1. Real official prices
out.prices = await ingestPrices()
log("prices", JSON.stringify(out.prices).slice(0, 200))

// 2. Licence registry (regulator). The counterfeiter gets none.
const reg = w("regulator")
out.participants = []
for (const id of ["maker_food", "maker_pharma", "distributor", "retailer"] as RoleId[]) {
  const r = ROLES[id]
  const p = await registerParticipant(pub, reg, { wallet: r.address, role: r.role, name: r.name, licence: r.licence!, state: r.state, validDays: 365 })
  ;(out.participants as unknown[]).push({ id, ...p }); log("licence", id, p.txHash)
}

// 3. Catalog
type P = { brand: string; name: string; category: string; commodity: string; unit: string; mrpPaise: number; sku: string; maker: RoleId }
const catalog: P[] = [
  { maker: "maker_food", brand: "Annapurna", name: "Tur Dal 1 kg", category: "pulses", commodity: "tur-dal", unit: "1 Kg", mrpPaise: 16000, sku: "ANN-TUR1" },
  { maker: "maker_food", brand: "Annapurna", name: "Chakki Atta 1 kg", category: "grains", commodity: "atta", unit: "1 Kg", mrpPaise: 4500, sku: "ANN-ATA1" },
  { maker: "maker_food", brand: "Annapurna", name: "Mustard Oil 1 kg", category: "edible-oils", commodity: "mustard-oil", unit: "1 Kg", mrpPaise: 23000, sku: "ANN-MUS1" },
  { maker: "maker_food", brand: "Annapurna", name: "Sugar 1 kg", category: "sugar-salt", commodity: "sugar", unit: "1 Kg", mrpPaise: 6500, sku: "ANN-SUG1" },
  { maker: "maker_food", brand: "Annapurna", name: "Iodised Salt 1 kg", category: "sugar-salt", commodity: "salt", unit: "1 Kg", mrpPaise: 2800, sku: "ANN-SAL1" },
  { maker: "maker_food", brand: "Annapurna", name: "Basmati Rice 1 kg", category: "grains", commodity: "rice", unit: "1 Kg", mrpPaise: 6000, sku: "ANN-RIC1" },
  { maker: "maker_pharma", brand: "Jeevan", name: "Paracetamol 500 mg (strip of 10)", category: "medicines", commodity: "medicine", unit: "1 strip", mrpPaise: 3000, sku: "JVN-PCM500" },
  { maker: "maker_pharma", brand: "Jeevan", name: "ORS sachet 21 g", category: "medicines", commodity: "medicine", unit: "1 sachet", mrpPaise: 2100, sku: "JVN-ORS21" },
  { maker: "maker_pharma", brand: "Jeevan", name: "Metformin 500 mg (strip of 10)", category: "medicines", commodity: "medicine", unit: "1 strip", mrpPaise: 4500, sku: "JVN-MET500" },
]
const prod: Record<string, Hex> = {}
for (const p of catalog) { const r = await createProduct(pub, w(p.maker), p); prod[p.sku] = r.key as Hex; log("product", p.sku, r.txHash) }
out.products = prod

// 4. Lots + trades
const lots: Record<string, unknown>[] = []
const ref = async (commodity: string) => (await officialPrice(commodity))?.pricePaise ?? 0
async function make(sku: string, maker: RoleId, qty: number, shelfDays: number, batch: string) {
  const product = await pub.getEntity(prod[sku])
  const r = await makeLot(pub, w(maker), { product, batch, qty, mfgAt: Date.now() - 5 * D, bestBefore: Date.now() + shelfDays * D, originState: ROLES[maker].state })
  lots.push({ sku, batch, ...r }); log("made", sku, batch, r.txHash); return r.lotKey as Hex
}
async function sell(seller: RoleId, buyer: RoleId, lot: Hex, qty: number, factor: number) {
  const l = await pub.getEntity(lot)
  const official = await ref(String(attr(l, "commodity")))
  const unit = Math.round((official || 3000) * factor)
  const o = await listOffer(pub, w(seller), { lotKey: lot, qty, unitPricePaise: unit, refPricePaise: official, sellerRole: ROLES[seller].role, state: ROLES[seller].state })
  const f = await fillOffer(pub, w(seller), o.offerKey as Hex, ROLES[buyer].address)
  log("sold", seller, "→", buyer, qty, f.txHash); return f.lotKey as Hex
}
async function offer(seller: RoleId, lot: Hex, qty: number, factor: number) {
  const l = await pub.getEntity(lot)
  const official = await ref(String(attr(l, "commodity")))
  const o = await listOffer(pub, w(seller), { lotKey: lot, qty, unitPricePaise: Math.round((official || 3000) * factor), refPricePaise: official, sellerRole: ROLES[seller].role, state: ROLES[seller].state })
  log("offer", seller, qty, factor, o.txHash); return o.offerKey
}

const tur = await make("ANN-TUR1", "maker_food", 2000, 300, "ANN-TUR1-B2611")
const atta = await make("ANN-ATA1", "maker_food", 3000, 120, "ANN-ATA1-B2610")
const mus = await make("ANN-MUS1", "maker_food", 1200, 270, "ANN-MUS1-B2609")
const sug = await make("ANN-SUG1", "maker_food", 2500, 365, "ANN-SUG1-B2610")
const sal = await make("ANN-SAL1", "maker_food", 1500, 700, "ANN-SAL1-B2608")
const ric = await make("ANN-RIC1", "maker_food", 1800, 365, "ANN-RIC1-B2610")
const pcm = await make("JVN-PCM500", "maker_pharma", 5000, 730, "JVN-PCM-24A17")
const ors = await make("JVN-ORS21", "maker_pharma", 4000, 540, "JVN-ORS-24B03")
const met = await make("JVN-MET500", "maker_pharma", 3000, 3, "JVN-MET-24C09")

// maker → distributor (wholesale, below retail)
const dTur = await sell("maker_food", "distributor", tur, 800, 0.82)
const dAtta = await sell("maker_food", "distributor", atta, 1200, 0.85)
const dMus = await sell("maker_food", "distributor", mus, 500, 0.86)
const dSug = await sell("maker_food", "distributor", sug, 900, 0.84)
const dPcm = await sell("maker_pharma", "distributor", pcm, 2000, 0.7)
const dOrs = await sell("maker_pharma", "distributor", ors, 1500, 0.7)
// distributor splits and sells to retailer
const parts = await splitLot(pub, w("distributor"), dTur, [200, 100]); log("split", parts.txHash)
const rTur = await sell("distributor", "retailer", parts.children[0] as Hex, 200, 0.93)
const rAtta = await sell("distributor", "retailer", dAtta, 300, 0.93)
const rPcm = await sell("distributor", "retailer", dPcm, 500, 0.85)
// open market: fair retail offers, wholesale offers, and an overpriced (hoarding) tur dal offer
out.offers = [
  await offer("retailer", rTur, 50, 1.0), await offer("retailer", rAtta, 80, 0.98), await offer("retailer", rPcm, 120, 0.9),
  await offer("distributor", parts.children[1] as Hex, 100, 1.36), await offer("distributor", dMus, 200, 0.97),
  await offer("distributor", dSug, 300, 1.02), await offer("distributor", dOrs, 400, 0.8),
  await offer("maker_food", sal, 500, 0.9), await offer("maker_food", ric, 400, 0.95), await offer("maker_pharma", met, 200, 0.75),
]

// 5. Counterfeit: unlicensed wallet copies the Annapurna Tur Dal product into its own "batch", offers it cheap
const fakeProduct = await pub.getEntity(prod["ANN-TUR1"])
const fake = await makeLot(pub, w("counterfeiter"), { product: fakeProduct, batch: "ANN-TUR1-B2611", qty: 600, mfgAt: Date.now() - 2 * D, bestBefore: Date.now() + 200 * D, originState: "BR" })
log("COUNTERFEIT lot", fake.txHash)
const fo = await listOffer(pub, w("counterfeiter"), { lotKey: fake.lotKey as Hex, qty: 300, unitPricePaise: Math.round((await ref("tur-dal")) * 0.7), refPricePaise: await ref("tur-dal"), sellerRole: "unlicensed", state: "BR" })
out.counterfeit = { lot: fake, offer: fo }

// 6. Recall: regulator recalls the paracetamol batch (modelled on a CDSCO "Not of Standard Quality" alert)
out.recall = await recallBatch(pub, reg, pcm, { reason: "Failed dissolution test: Not of Standard Quality (demo, modelled on CDSCO NSQ alerts)", severity: "class1" })
log("RECALL", JSON.stringify(out.recall))
out.lots = lots
out.refs = { tur, atta, mus, sug, sal, ric, pcm, ors, met, dTur, dAtta, dMus, dSug, dPcm, dOrs, rTur, rAtta, rPcm, splitChildren: parts.children }
writeFileSync("../toolchain/evidence/setu-seed-manifest.json", JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
log("done")
process.exit(0)
