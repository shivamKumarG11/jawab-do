// Server-side reads for Supply Setu. Access key stays here; browser reads go through these or straight to public RPC.
import { createPublicClient, createWalletClient, type Entity } from "@arkiv-network/sdk"
import { key, str, i32 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gt, lte } from "@arkiv-network/sdk/query"
import { http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { attr, isSetu, num } from "../src/shared/setuOps"
import {
  OVERPRICED_BP, PROJECT, ROLES, type LotView, type MoveView, type OfferView, type ParticipantView, type PriceView,
  type ProductView, type RecallView, type RoleId,
} from "../src/shared/setu"

const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()
const rpcUrl = accessKey ? `${tiramisu.rpcUrls.default.http[0]}/${accessKey}` : undefined
export const usingAccessKey = Boolean(accessKey)
export const pub = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) })

export const wallets = Object.fromEntries(
  Object.entries(ROLES).flatMap(([id, r]) => {
    const pk = process.env[r.env]?.trim()
    return pk ? [[id, createWalletClient({ chain: tiramisu, transport: http(rpcUrl), account: privateKeyToAccount(pk as Hex) })]] : []
  }),
) as Partial<Record<RoleId, import("@arkiv-network/sdk").WalletArkivClient & { account: { address: Hex } }>>

const ORACLE = ROLES.oracle.address
const REGULATOR = ROLES.regulator.address
const where = (type: string, ...more: ReturnType<typeof eq>[]) => [eq("project", str(PROJECT)), eq("type", str(type)), ...more]
const FULL = { key: true, owner: true, creator: true, expiresAt: true, creationFlags: true, attributes: true } as const

// Short-lived memo so verification doesn't refetch the same entities for every card.
const memo = new Map<string, { at: number; p: Promise<unknown> }>()
function remember<T>(k: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(k)
  if (hit && Date.now() - hit.at < ms) return hit.p as Promise<T>
  const p = fn().catch((e) => { memo.delete(k); throw e })
  memo.set(k, { at: Date.now(), p })
  return p
}
export const forget = () => memo.clear()
const getE = (k: Hex): Promise<E> => remember(`e:${k.toLowerCase()}`, 20_000, () => pub.getEntity(k)) as Promise<E>
async function all<T>(q: AsyncIterable<T>) { const out: T[] = []; for await (const x of q) out.push(x); return out }
async function expiryMs<T extends { expiresAt: string; expiresAtMs?: number }>(items: T[]) {
  const t = await pub.getBlockTiming()
  for (const i of items) i.expiresAtMs = (t.currentBlockTime + Number(BigInt(i.expiresAt) - t.currentBlock) * t.blockDuration) * 1000
  return items
}
type E = Entity & { key: Hex; owner: Hex; creator: Hex; expiresAt: bigint }
const s = (e: Entity, n: string) => String(attr(e, n) ?? "")

// ---- prices ----
export function pricesQuery(source = "doca") {
  return pub.select(FULL).where(where("price", eq("source", str(source)))).createdBy(ORACLE).limit(200)
}
export function latestPrices(source = "doca") { return remember(`prices:${source}`, 30_000, () => latestPricesRaw(source)) }
async function latestPricesRaw(source: string) {
  const q = pricesQuery(source)
  const rows = (await all(q)) as E[]
  const best = new Map<string, E>()
  for (const e of rows) {
    const k = source === "doca" ? s(e, "commodity") : `${s(e, "commodity")}|${s(e, "market")}`
    const cur = best.get(k)
    if (!cur || (num(e, "as_of") ?? 0) > (num(cur, "as_of") ?? 0)) best.set(k, e)
  }
  const items: PriceView[] = [...best.values()].map((e) => ({
    key: e.key, source: s(e, "source"), commodity: s(e, "commodity"), label: s(e, "label"), category: s(e, "category"), unit: s(e, "unit"),
    pricePaise: num(e, "price_paise") ?? 0, date: s(e, "date"), asOf: num(e, "as_of") ?? 0, trend1mBp: num(e, "trend_1m_bp"), trend1yBp: num(e, "trend_1y_bp"),
    state: s(e, "state") || undefined, market: s(e, "market") || undefined, expiresAt: String(e.expiresAt), creator: e.creator, trusted: e.creator.toLowerCase() === ORACLE.toLowerCase(),
  }))
  items.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
  return { items, query: q.toString() }
}
export async function officialPrice(commodity: string) {
  const { items } = await latestPrices("doca")
  return items.find((p) => p.commodity === commodity)
}

// ---- registry ----
export function participantsQuery() { return pub.select(FULL).where(where("participant")).createdBy(REGULATOR).limit(200) }
export function participants() { return remember("participants", 20_000, participantsRaw) }
async function participantsRaw() {
  const q = participantsQuery()
  const items: ParticipantView[] = ((await all(q)) as E[]).map((e) => ({
    key: e.key, wallet: s(e, "wallet"), role: s(e, "role"), name: s(e, "name"), licence: s(e, "licence"), state: s(e, "state"), expiresAt: String(e.expiresAt),
  }))
  return { items: await expiryMs(items), query: q.toString() }
}
async function licensed() {
  const { items } = await participants()
  return new Map(items.map((p) => [p.wallet.toLowerCase(), p]))
}

// ---- catalog ----
export async function products() {
  const q = pub.select(FULL).where(where("product")).limit(200)
  const reg = await licensed()
  const items: ProductView[] = ((await all(q)) as E[])
    .filter((e) => reg.get(e.creator.toLowerCase())?.role === "maker")
    .map((e) => ({ key: e.key, brand: s(e, "brand"), name: s(e, "name"), category: s(e, "category"), commodity: s(e, "commodity"), unit: s(e, "unit"), mrpPaise: num(e, "mrp_paise") ?? 0, sku: s(e, "sku"), creator: e.creator }))
  return { items, query: q.toString() }
}

// ---- lots + verification ----
function toLot(e: E): LotView {
  return {
    key: e.key, product: s(e, "product"), sku: s(e, "sku"), brand: s(e, "brand"), category: s(e, "category"), commodity: s(e, "commodity"), batch: s(e, "batch"),
    qty: num(e, "qty") ?? 0, unit: s(e, "unit"), mfgAt: num(e, "mfg_at") ?? 0, bestBefore: num(e, "best_before") ?? 0, originState: s(e, "origin_state"),
    root: s(e, "root"), parent: s(e, "parent") || undefined, owner: e.owner, creator: e.creator, expiresAt: String(e.expiresAt),
  }
}
export function recallsQuery() { return pub.select(FULL).where(where("recall")).limit(200) }
export function recalls() { return remember("recalls", 10_000, recallsRaw) }
async function recallsRaw() {
  const q = recallsQuery()
  const rows = (await all(q)) as E[]
  const makers = new Map<string, string>()
  const items: RecallView[] = []
  for (const e of rows) {
    let trusted = e.creator.toLowerCase() === REGULATOR.toLowerCase()
    if (!trusted) {
      const root = s(e, "root") as Hex
      const maker = makers.get(root) ?? (await getE(root).then((r) => r.creator).catch(() => ""))
      makers.set(root, maker)
      trusted = maker!.toLowerCase() === e.creator.toLowerCase()
    }
    items.push({ key: e.key, root: s(e, "root"), sku: s(e, "sku"), brand: s(e, "brand"), batch: s(e, "batch"), reason: s(e, "reason"), severity: s(e, "severity"), at: num(e, "at") ?? 0, creator: e.creator, trusted })
  }
  items.sort((a, b) => b.at - a.at)
  return { items, query: q.toString() }
}

export async function verify(lot: LotView, reg?: Map<string, ParticipantView>) {
  reg ??= await licensed()
  const reasons: string[] = []
  let genuine = true
  const creatorLic = reg.get(lot.creator.toLowerCase())
  if (!creatorLic) { genuine = false; reasons.push(`Created by ${lot.creator.slice(0, 6)}…${lot.creator.slice(-4)}, which holds no live licence`) }
  try {
    const product = (await getE(lot.product as Hex)) as E
    const maker = reg.get(product.creator.toLowerCase())
    if (!isSetu(product, "product") || maker?.role !== "maker") { genuine = false; reasons.push("Product listing is not from a licensed maker") }
    let cur: E | undefined
    let k: string | undefined = lot.parent ? lot.key : undefined
    let hops = 0
    while (k && hops++ < 12) {
      cur = (await getE(k as Hex)) as E
      if (!reg.get(cur.creator.toLowerCase())) { genuine = false; reasons.push(`A link in the chain was created by an unlicensed wallet`) ; break }
      const p = s(cur, "parent")
      if (!p) break
      k = p
    }
    const rootE = await getE(lot.root as Hex).catch(() => undefined)
    if (!rootE) { genuine = false; reasons.push("Original batch record not found (expired or never existed)") }
    else if (rootE.creator.toLowerCase() !== product.creator.toLowerCase()) {
      genuine = false; reasons.push(`Brand ${lot.brand} is made by ${maker?.name ?? product.creator}, but this batch was started by another wallet`)
    }
  } catch { genuine = false; reasons.push("Product record not found") }
  if (genuine) reasons.push(`Made by licensed ${reg.get((await getE(lot.root as Hex)).creator.toLowerCase())?.name}; every holder is licensed`)
  return { genuine, reasons }
}

export async function lotsQuery(f: { owner?: string; category?: string }) {
  const preds = where("lot")
  if (f.category) preds.push(eq("category", str(f.category)))
  let q = pub.select(FULL).where(and(preds)).limit(200)
  if (f.owner) q = q.ownedBy(f.owner as Hex)
  return q
}
export async function lots(f: { owner?: string; category?: string }) {
  const q = await lotsQuery(f)
  const reg = await licensed()
  const rc = (await recalls()).items.filter((r) => r.trusted)
  const items = await expiryMs(((await all(q)) as E[]).map(toLot))
  await Promise.all(items.map(async (l) => { l.verdict = await verify(l, reg); l.recalled = rc.filter((r) => r.root === l.root) }))
  items.sort((a, b) => a.bestBefore - b.bestBefore)
  return { items, query: q.toString() }
}

export async function trace(lotKey: Hex) {
  const e = (await getE(lotKey)) as E
  if (!isSetu(e, "lot")) throw new Error("Lot not found")
  const [lot] = await expiryMs([toLot(e)])
  lot.verdict = await verify(lot)
  const chain: LotView[] = []
  let p = lot.parent
  while (p && chain.length < 12) {
    const pe = await getE(p as Hex).catch(() => undefined)
    if (!pe) break
    chain.push(toLot(pe as E)); p = s(pe, "parent") || undefined
  }
  const mq = pub.select(FULL).where(where("move", eq("root", key(lot.root as Hex)))).limit(200)
  const moves: MoveView[] = ((await all(mq)) as E[]).map((m) => ({
    key: m.key, lot: s(m, "lot"), root: s(m, "root"), kind: s(m, "kind"), from: s(m, "from"), to: s(m, "to"), qty: num(m, "qty") ?? 0,
    pricePaise: num(m, "price_paise") ?? 0, at: num(m, "at") ?? 0, creator: m.creator, owner: m.owner, readonly: Boolean(m.creationFlags?.readonly),
  })).sort((a, b) => a.at - b.at)
  const rc = (await recalls()).items.filter((r) => r.root === lot.root)
  lot.recalled = rc.filter((r) => r.trusted)
  let product: ProductView | undefined
  try {
    const pe = (await getE(lot.product as Hex)) as E
    product = { key: pe.key, brand: s(pe, "brand"), name: s(pe, "name"), category: s(pe, "category"), commodity: s(pe, "commodity"), unit: s(pe, "unit"), mrpPaise: num(pe, "mrp_paise") ?? 0, sku: s(pe, "sku"), creator: pe.creator }
  } catch { /* product gone */ }
  const official = lot.commodity && lot.commodity !== "medicine" ? await officialPrice(lot.commodity) : undefined
  return { lot, chain, moves, recalls: rc, product, official, query: mq.toString() }
}

export async function findBatch(text: string) {
  const t = text.trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { items: [(await trace(t as Hex)).lot], query: `getEntity(${t})` }
  const q = pub.select(FULL).where(where("lot", eq("batch", str(t.toUpperCase())))).limit(50)
  const reg = await licensed()
  const items = await expiryMs(((await all(q)) as E[]).map(toLot))
  await Promise.all(items.map(async (l) => { l.verdict = await verify(l, reg) }))
  return { items, query: q.toString() }
}

// ---- marketplace ----
export type OfferFilter = { category?: string; commodity?: string; state?: string; price?: "overpriced" | "fair"; cursor?: string }
export function offersQuery(f: OfferFilter) {
  const preds = where("offer")
  if (f.category) preds.push(eq("category", str(f.category)))
  if (f.commodity) preds.push(eq("commodity", str(f.commodity)))
  if (f.state) preds.push(eq("state", str(f.state)))
  if (f.price === "overpriced") preds.push(gt("markup_bp", i32(OVERPRICED_BP)))
  if (f.price === "fair") preds.push(lte("markup_bp", i32(OVERPRICED_BP)))
  let q = pub.select(FULL).where(and(preds)).limit(30)
  if (f.cursor) q = q.cursor(f.cursor)
  return q
}
export async function offers(f: OfferFilter) {
  const q = offersQuery(f)
  const page = await q.fetch()
  const reg = await licensed()
  const rc = (await recalls()).items.filter((r) => r.trusted)
  const items: OfferView[] = await expiryMs((page.entities as E[]).map((e) => ({
    key: e.key, lot: s(e, "lot"), root: s(e, "root"), sku: s(e, "sku"), brand: s(e, "brand"), category: s(e, "category"), commodity: s(e, "commodity"),
    qty: num(e, "qty") ?? 0, unitPricePaise: num(e, "unit_price_paise") ?? 0, refPricePaise: num(e, "ref_price_paise") ?? 0, markupBp: num(e, "markup_bp") ?? 0,
    seller: s(e, "seller"), sellerRole: s(e, "seller_role"), state: s(e, "state"), creator: e.creator, expiresAt: String(e.expiresAt),
  })))
  await Promise.all(items.map(async (o) => {
    o.recalled = rc.some((r) => r.root === o.root)
    const lot = await getE(o.lot as Hex).then((x) => toLot(x as E)).catch(() => undefined)
    o.verdict = lot ? await verify(lot, reg) : { genuine: false, reasons: ["Lot no longer exists (sold or expired)"] }
  }))
  return { items, cursor: page.cursor ?? null, query: q.toString() }
}

// ---- stats for the hero ----
export async function stats() {
  const [l, o, r, p] = await Promise.all([lots({}), offers({}), recalls(), latestPrices("doca")])
  const genuine = l.items.filter((x) => x.verdict?.genuine).length
  return {
    lots: l.items.length, genuine, counterfeit: l.items.length - genuine,
    offers: o.items.length, overpriced: o.items.filter((x) => x.markupBp > OVERPRICED_BP).length,
    recalls: r.items.filter((x) => x.trusted).length, prices: p.items.length, priceDate: p.items[0]?.date ?? null,
  }
}
