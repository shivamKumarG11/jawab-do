// Every Supply Setu write, each ONE atomic executeBatch. Same code path for server relay, scripts and browser wallets.
import { ExpirationTime, jsonToPayload, type Entity, type PublicArkivClient, type WalletArkivClient } from "@arkiv-network/sdk"
import { addr, bool, i32, key, str, u64 } from "@arkiv-network/sdk/attr"
import type { Hex } from "viem"
import {
  BURN, MOVE_LIFETIME, OFFER_LIFETIME, PRICE_LIFETIME, PRODUCT_LIFETIME, PROJECT, RECALL_LIFETIME, SCHEMA, markupBp,
} from "./setu"

type Pub = PublicArkivClient
type Wallet = WalletArkivClient

export const base = (type: string) => ({ project: str(PROJECT), schema: str(SCHEMA), type: str(type), demo: bool(true) })
export const attr = (e: Pick<Entity, "attributes">, n: string) => e.attributes?.[n]?.value as unknown
export const num = (e: Pick<Entity, "attributes">, n: string) => { const v = attr(e, n); return v === undefined ? undefined : Number(v) }
export const isSetu = (e: Pick<Entity, "attributes">, type: string) =>
  attr(e, "project") === PROJECT && attr(e, "schema") === SCHEMA && attr(e, "type") === type && attr(e, "demo") === true

const me = (w: Wallet) => { const a = w.account?.address; if (!a) throw new Error("Wallet has no account"); return a }
const json = (o: object) => ({ payload: jsonToPayload(o), contentType: "application/json" as const })
const atLeastHour = { atLeast: ExpirationTime.fromHours(1) }

export async function blockAt(pub: Pub, ms: number) {
  const t = await pub.getBlockTiming()
  return t.currentBlock + BigInt(Math.max(1, Math.ceil((ms / 1000 - t.currentBlockTime) / t.blockDuration)))
}
const until = async (pub: Pub, ms: number) => ExpirationTime.atBlock(await blockAt(pub, ms), atLeastHour)

function moveCreate(salt: bigint, m: { lot: Hex; root: Hex; kind: string; from: string; to: string; qty: number; pricePaise?: number }, expires: ReturnType<typeof ExpirationTime.atBlock>) {
  return {
    ...json({ note: `${m.kind} ${m.qty}` }),
    attributes: {
      ...base("move"), lot: key(m.lot), root: key(m.root), kind: str(m.kind),
      from: addr(m.from as Hex), to: addr(m.to as Hex), qty: u64(m.qty), price_paise: u64(m.pricePaise ?? 0), at: u64(Date.now()),
    },
    expires, flags: { readonly: true, permissionlessExtension: true }, salt,
  }
}

// ---- Official prices (oracle) ----
export type PriceInput = {
  source: "doca" | "agmarknet"; commodity: string; label: string; category: string; unit: string; pricePaise: number; date: string
  trend1mBp?: number; trend1yBp?: number; state?: string; market?: string; minPaise?: number; maxPaise?: number; raw: unknown; url: string
}
export async function postPrices(pub: Pub, wallet: Wallet, prices: PriceInput[]) {
  const expires = await until(pub, Date.now() + PRICE_LIFETIME)
  const txs: string[] = []
  for (let i = 0; i < prices.length; i += 20) {
    const res = await wallet.executeBatch({
      creates: prices.slice(i, i + 20).map((p) => ({
        ...json({ source_url: p.url, raw: p.raw }),
        attributes: {
          ...base("price"), source: str(p.source), commodity: str(p.commodity), label: str(p.label.slice(0, 100)), category: str(p.category),
          unit: str(p.unit), price_paise: u64(p.pricePaise), date: str(p.date), as_of: u64(Date.now()),
          ...(p.trend1mBp !== undefined ? { trend_1m_bp: i32(p.trend1mBp) } : {}),
          ...(p.trend1yBp !== undefined ? { trend_1y_bp: i32(p.trend1yBp) } : {}),
          ...(p.state ? { state: str(p.state.slice(0, 60)) } : {}), ...(p.market ? { market: str(p.market.slice(0, 80)) } : {}),
          ...(p.minPaise !== undefined ? { min_paise: u64(p.minPaise) } : {}), ...(p.maxPaise !== undefined ? { max_paise: u64(p.maxPaise) } : {}),
        },
        expires,
      })),
    })
    txs.push(res.txHash)
  }
  return txs
}

// ---- Licence registry (regulator) ----
export async function registerParticipant(pub: Pub, wallet: Wallet, p: { wallet: Hex; role: string; name: string; licence: string; state: string; validDays: number }) {
  const r = await wallet.createEntity({
    ...json({ note: "Synthetic demo licence" }),
    attributes: { ...base("participant"), wallet: addr(p.wallet), role: str(p.role), name: str(p.name), licence: str(p.licence), state: str(p.state) },
    expires: await until(pub, Date.now() + p.validDays * 86_400_000),
  })
  return { key: r.entityKey, txHash: r.txHash }
}

// ---- Catalog (maker) ----
export async function createProduct(pub: Pub, wallet: Wallet, p: { brand: string; name: string; category: string; commodity: string; unit: string; mrpPaise: number; sku: string }) {
  const r = await wallet.createEntity({
    ...json({ description: `${p.brand} ${p.name}` }),
    attributes: { ...base("product"), brand: str(p.brand), name: str(p.name), category: str(p.category), commodity: str(p.commodity), unit: str(p.unit), mrp_paise: u64(p.mrpPaise), sku: str(p.sku) },
    expires: await until(pub, Date.now() + PRODUCT_LIFETIME), flags: { permissionlessExtension: true },
  })
  return { key: r.entityKey, txHash: r.txHash }
}

// ---- Make a root lot: lot + "made" move, burned, in one batch ----
export type LotInput = { product: Pick<Entity, "key" | "attributes">; batch: string; qty: number; mfgAt: number; bestBefore: number; originState: string }
export async function makeLot(pub: Pub, wallet: Wallet, l: LotInput) {
  const [lotK, mvK] = await pub.predictEntityKeys({ owner: me(wallet), count: 2 })
  const a = (n: string) => String(attr(l.product, n))
  const res = await wallet.executeBatch({
    creates: [
      {
        ...json({ note: `Batch ${l.batch}` }),
        attributes: {
          ...base("lot"), product: key(l.product.key! as Hex), sku: str(a("sku")), brand: str(a("brand")), category: str(a("category")),
          commodity: str(a("commodity")), batch: str(l.batch), qty: u64(l.qty), unit: str(a("unit")), mfg_at: u64(l.mfgAt),
          best_before: u64(l.bestBefore), origin_state: str(l.originState), root: key(lotK.key),
        },
        expires: await until(pub, l.bestBefore), salt: lotK.salt,
      },
      moveCreate(mvK.salt, { lot: lotK.key, root: lotK.key, kind: "made", from: me(wallet), to: me(wallet), qty: l.qty }, await until(pub, Date.now() + MOVE_LIFETIME)),
    ],
    ownershipChanges: [{ entityKey: mvK.key, newOwner: BURN }],
  })
  return { lotKey: lotK.key, moveKey: mvK.key, txHash: res.txHash }
}

function childLot(parent: Entity, salt: bigint, qty: number, expires: ReturnType<typeof ExpirationTime.atBlock>) {
  const a = (n: string) => String(attr(parent, n))
  return {
    ...json({ note: `Split from ${a("batch")}` }),
    attributes: {
      ...base("lot"), product: key(a("product") as Hex), sku: str(a("sku")), brand: str(a("brand")), category: str(a("category")),
      commodity: str(a("commodity")), batch: str(a("batch")), qty: u64(qty), unit: str(a("unit")), mfg_at: u64(Number(attr(parent, "mfg_at"))),
      best_before: u64(Number(attr(parent, "best_before"))), origin_state: str(a("origin_state")), root: key(a("root") as Hex), parent: key(parent.key!),
    },
    expires, salt,
  }
}

async function ownedLot(pub: Pub, wallet: Wallet, lotKey: Hex) {
  const lot = await pub.getEntity(lotKey)
  if (!isSetu(lot, "lot")) throw new Error("Not a Supply Setu lot")
  if (lot.owner.toLowerCase() !== me(wallet).toLowerCase()) throw new Error(`Only the current holder ${lot.owner} can do this`)
  return lot
}

// ---- Split a lot into smaller lots kept by the holder ----
export async function splitLot(pub: Pub, wallet: Wallet, lotKey: Hex, parts: number[]) {
  const lot = await ownedLot(pub, wallet, lotKey)
  const total = Number(attr(lot, "qty"))
  const sum = parts.reduce((x, y) => x + y, 0)
  if (!parts.length || parts.some((p) => !Number.isSafeInteger(p) || p <= 0) || sum >= total) throw new Error(`Parts must be positive and total less than ${total}`)
  const keys = await pub.predictEntityKeys({ owner: me(wallet), count: parts.length * 2 })
  const lotExp = ExpirationTime.atBlock(lot.expiresAt)
  const mvExp = await until(pub, Date.now() + MOVE_LIFETIME)
  const root = String(attr(lot, "root")) as Hex
  const res = await wallet.executeBatch({
    creates: parts.flatMap((q, i) => [
      childLot(lot, keys[2 * i].salt, q, lotExp),
      moveCreate(keys[2 * i + 1].salt, { lot: keys[2 * i].key, root, kind: "split", from: me(wallet), to: me(wallet), qty: q }, mvExp),
    ]),
    patches: [{ entityKey: lotKey, set: { qty: u64(total - sum) } }],
    ownershipChanges: parts.map((_, i) => ({ entityKey: keys[2 * i + 1].key, newOwner: BURN })),
  })
  return { txHash: res.txHash, children: parts.map((_, i) => keys[2 * i].key) }
}

// ---- List an offer, priced against today's official price ----
export async function listOffer(pub: Pub, wallet: Wallet, o: { lotKey: Hex; qty: number; unitPricePaise: number; refPricePaise: number; sellerRole: string; state: string; validMs?: number }) {
  const lot = await ownedLot(pub, wallet, o.lotKey)
  if (o.qty <= 0 || o.qty > Number(attr(lot, "qty"))) throw new Error("Quantity exceeds the lot")
  const a = (n: string) => String(attr(lot, n))
  const r = await wallet.createEntity({
    ...json({ note: "Demo listing" }),
    attributes: {
      ...base("offer"), lot: key(o.lotKey), root: key(a("root") as Hex), sku: str(a("sku")), brand: str(a("brand")), category: str(a("category")),
      commodity: str(a("commodity")), qty: u64(o.qty), unit_price_paise: u64(o.unitPricePaise), ref_price_paise: u64(o.refPricePaise),
      markup_bp: i32(markupBp(o.unitPricePaise, o.refPricePaise)), seller: addr(me(wallet)), seller_role: str(o.sellerRole), state: str(o.state),
    },
    expires: await until(pub, Math.min(Date.now() + (o.validMs ?? OFFER_LIFETIME), Number(attr(lot, "best_before")))),
  })
  return { offerKey: r.entityKey, txHash: r.txHash }
}

// ---- Buy: seller's wallet hands the goods (lot or a split child) to the buyer, logs the sale, removes the offer. Atomic. ----
export async function fillOffer(pub: Pub, seller: Wallet, offerKey: Hex, buyer: Hex) {
  const offer = await pub.getEntity(offerKey)
  if (!isSetu(offer, "offer")) throw new Error("Not a Supply Setu offer")
  const lotKey = String(attr(offer, "lot")) as Hex
  const lot = await ownedLot(pub, seller, lotKey)
  const qty = Number(attr(offer, "qty"))
  const have = Number(attr(lot, "qty"))
  if (qty > have) throw new Error("Seller no longer holds enough stock")
  const root = String(attr(lot, "root")) as Hex
  const price = Number(attr(offer, "unit_price_paise"))
  const mvExp = await until(pub, Date.now() + MOVE_LIFETIME)
  if (qty === have) {
    const [mvK] = await pub.predictEntityKeys({ owner: me(seller), count: 1 })
    const res = await seller.executeBatch({
      creates: [moveCreate(mvK.salt, { lot: lotKey, root, kind: "sold", from: me(seller), to: buyer, qty, pricePaise: price }, mvExp)],
      deletes: [{ entityKey: offerKey }],
      ownershipChanges: [{ entityKey: mvK.key, newOwner: BURN }, { entityKey: lotKey, newOwner: buyer }],
    })
    return { txHash: res.txHash, lotKey, moved: "whole" as const }
  }
  const [childK, mvK] = await pub.predictEntityKeys({ owner: me(seller), count: 2 })
  const res = await seller.executeBatch({
    creates: [
      childLot(lot, childK.salt, qty, ExpirationTime.atBlock(lot.expiresAt)),
      moveCreate(mvK.salt, { lot: childK.key, root, kind: "sold", from: me(seller), to: buyer, qty, pricePaise: price }, mvExp),
    ],
    patches: [{ entityKey: lotKey, set: { qty: u64(have - qty) } }],
    deletes: [{ entityKey: offerKey }],
    ownershipChanges: [{ entityKey: mvK.key, newOwner: BURN }, { entityKey: childK.key, newOwner: buyer }],
  })
  return { txHash: res.txHash, lotKey: childK.key, moved: "split" as const }
}

// ---- Recall a batch (regulator or the maker) ----
export async function recallBatch(pub: Pub, wallet: Wallet, rootKey: Hex, r: { reason: string; severity: "class1" | "class2" }) {
  const root = await pub.getEntity(rootKey)
  if (!isSetu(root, "lot")) throw new Error("Not a Supply Setu lot")
  const [rcK, mvK] = await pub.predictEntityKeys({ owner: me(wallet), count: 2 })
  const a = (n: string) => String(attr(root, n))
  const res = await wallet.executeBatch({
    creates: [
      {
        ...json({ notice: r.reason }),
        attributes: { ...base("recall"), root: key(rootKey), sku: str(a("sku")), brand: str(a("brand")), batch: str(a("batch")), reason: str(r.reason.slice(0, 120)), severity: str(r.severity), at: u64(Date.now()) },
        expires: await until(pub, Date.now() + RECALL_LIFETIME), salt: rcK.salt,
      },
      moveCreate(mvK.salt, { lot: rootKey, root: rootKey, kind: "recalled", from: me(wallet), to: me(wallet), qty: 0 }, await until(pub, Date.now() + MOVE_LIFETIME)),
    ],
    ownershipChanges: [{ entityKey: mvK.key, newOwner: BURN }],
  })
  return { recallKey: rcK.key, txHash: res.txHash }
}

// ---- Anyone: permissionless Lifetime Extension of a product listing by 30 days ----
export async function keepProductAlive(pub: Pub, wallet: Wallet, productKey: Hex) {
  const p = await pub.getEntity(productKey)
  if (!isSetu(p, "product")) throw new Error("Not a Supply Setu product")
  const t = await pub.getBlockTiming()
  const target = p.expiresAt + BigInt((30 * 86_400) / t.blockDuration)
  const res = await wallet.extendEntity({ entityKey: productKey, expires: ExpirationTime.atBlock(target) })
  return { txHash: res.txHash, previousExpiry: p.expiresAt, newExpiry: res.expiresAt }
}
