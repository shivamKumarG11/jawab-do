// One HTTP handler for local dev (Vite middleware) and production (server/main.ts).
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Hex } from "viem"
import { attr, fillOffer, isSetu, listOffer, makeLot, postPrices, recallBatch, splitLot } from "../src/shared/setuOps"
import { CATEGORIES, CHAIN_ID, DOCA_URL, EXPLORER, PROJECT, ROLES, SCHEMA, WS_URL, type RoleId } from "../src/shared/setu"
import { fetchAgmarknet, fetchDoca } from "./prices"
import {
  findBatch, forget, latestPrices, lots, offers, officialPrice, participants, products, pub, recalls, stats, trace, usingAccessKey, wallets,
  type OfferFilter,
} from "./setu"

// --- Rate limits: protect the testnet GLM in the relay wallets ---
const PER_IP = { max: 12, windowMs: 10 * 60_000 }
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_WRITES_PER_DAY ?? 400)
const hits = new Map<string, number[]>()
let day = { start: Date.now(), count: 0 }
function rateLimit(ip: string): string | undefined {
  const now = Date.now()
  if (now - day.start > 86_400_000) day = { start: now, count: 0 }
  if (day.count >= GLOBAL_PER_DAY) return "The demo's daily write budget is used up; reads still work. Try again tomorrow."
  const list = (hits.get(ip) ?? []).filter((t) => now - t < PER_IP.windowMs)
  if (list.length >= PER_IP.max) return `Max ${PER_IP.max} writes per ${PER_IP.windowMs / 60_000} minutes per visitor.`
  list.push(now); hits.set(ip, list); day.count++
}

// --- One write at a time per wallet: keeps nonces and predicted keys valid ---
const queues = new Map<string, Promise<unknown>>()
function serial<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(wallet) ?? Promise.resolve()).catch(() => {}).then(fn)
  queues.set(wallet, next)
  return next
}

// --- Read cache ---
const cache = new Map<string, { at: number; value: unknown }>()
async function cached<T>(k: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < ms) return hit.value as T
  const value = await fn()
  cache.set(k, { at: Date.now(), value })
  return value
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.setHeader("cache-control", "no-store")
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.byteLength
    if (size > 4096) throw new Error("Body too large")
    chunks.push(chunk)
  }
  const s = Buffer.concat(chunks, size).toString("utf8")
  const body: unknown = s ? JSON.parse(s) : {}
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Body must be a JSON object")
  return body as Record<string, unknown>
}

export function redact(text: string) {
  const values = [...Object.values(ROLES).map((r) => r.env), "ARKIV_ACCESS_KEY", "DATA_GOV_IN_KEY", "ADMIN_TOKEN", "DESK_KEY", "LEGAL_AID_KEY"]
    .flatMap((n) => { const v = process.env[n]?.trim(); return v ? [v] : [] })
    .sort((a, b) => b.length - a.length)
  return values.reduce((t, v) => t.replaceAll(v, "[REDACTED]"), text).replace(/ark_live_[A-Za-z0-9_-]+/g, "[REDACTED]")
}

const ipOf = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim()
const isKey = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s)
const posInt = (v: unknown, max = 1_000_000) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : undefined }

// --- Official price ingest (oracle). Idempotent per DoCA date. ---
let ingesting: Promise<unknown> | undefined
export async function ingestPrices(force = false) {
  const oracle = wallets.oracle
  if (!oracle) return { skipped: "no oracle key" }
  const doca = await fetchDoca()
  const have = await latestPrices("doca")
  const fresh = new Set(have.items.filter((p) => p.date === doca.date).map((p) => p.commodity))
  const todo = doca.prices.filter((p) => force || !fresh.has(p.commodity))
  const out: { date: string; doca: number; agmarknet: number; txs: string[]; note?: string } = { date: doca.date, doca: 0, agmarknet: 0, txs: [] }
  if (todo.length) { out.txs.push(...(await serial(oracle.account.address, () => postPrices(pub, oracle, todo)))); out.doca = todo.length }
  const k = process.env.DATA_GOV_IN_KEY?.trim()
  if (k) {
    try {
      const mandiHave = await latestPrices("agmarknet")
      if (force || !mandiHave.items.some((p) => p.date >= doca.date)) {
        const m = await fetchAgmarknet(k)
        if (m.length) { out.txs.push(...(await serial(oracle.account.address, () => postPrices(pub, oracle, m)))); out.agmarknet = m.length }
      }
    } catch (e) { out.note = `Mandi prices skipped: ${redact((e as Error).message)}` }
  }
  cache.clear(); forget()
  return out
}
export function ingestOnce() {
  ingesting ??= ingestPrices().catch((e) => console.error("[ingest]", redact((e as Error).message))).finally(() => { ingesting = undefined })
  return ingesting
}

const ACTOR: Record<string, RoleId[]> = {
  make: ["maker_food", "maker_pharma"], offer: ["maker_food", "maker_pharma", "distributor", "retailer"],
  split: ["maker_food", "maker_pharma", "distributor", "retailer"], buy: ["distributor", "retailer"], recall: ["regulator", "maker_food", "maker_pharma"],
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://local")
  const path = url.pathname.replace(/\/+$/, "")
  const q = Object.fromEntries(url.searchParams)
  try {
    if (req.method === "GET") {
      if (path === "/api/health") return json(res, 200, { ok: true, project: PROJECT, schema: SCHEMA, time: Date.now() })
      if (path === "/api/config")
        return json(res, 200, {
          project: PROJECT, schema: SCHEMA, chainId: CHAIN_ID, explorer: EXPLORER, wsUrl: WS_URL, usingAccessKey, docaUrl: DOCA_URL,
          categories: CATEGORIES, mandi: Boolean(process.env.DATA_GOV_IN_KEY?.trim()),
          roles: Object.fromEntries(Object.entries(ROLES).map(([id, r]) => [id, { address: r.address, role: r.role, name: r.name, state: r.state, canWrite: Boolean(wallets[id as RoleId]) }])),
        })
      if (path === "/api/stats") return json(res, 200, await cached("stats", 15_000, stats))
      if (path === "/api/prices") return json(res, 200, await cached(`prices:${q.source}`, 30_000, () => latestPrices(q.source === "agmarknet" ? "agmarknet" : "doca")))
      if (path === "/api/participants") return json(res, 200, await cached("participants", 30_000, participants))
      if (path === "/api/products") return json(res, 200, await cached("products", 30_000, products))
      if (path === "/api/recalls") return json(res, 200, await cached("recalls", 10_000, recalls))
      if (path === "/api/offers") {
        const f: OfferFilter = {
          category: q.category && Object.hasOwn(CATEGORIES, q.category) ? q.category : undefined,
          commodity: q.commodity || undefined, state: q.state || undefined,
          price: q.price === "overpriced" || q.price === "fair" ? q.price : undefined, cursor: q.cursor || undefined,
        }
        return json(res, 200, await cached(`offers:${url.search}`, 8_000, () => offers(f)))
      }
      if (path === "/api/lots") {
        const owner = q.role && Object.hasOwn(ROLES, q.role) ? ROLES[q.role as RoleId].address : undefined
        return json(res, 200, await cached(`lots:${url.search}`, 8_000, () => lots({ owner, category: q.category || undefined })))
      }
      if (path === "/api/find") return json(res, 200, await findBatch(String(q.q ?? "")))
      const t = path.match(/^\/api\/trace\/(0x[0-9a-fA-F]{64})$/)
      if (t) return json(res, 200, await cached(`trace:${t[1]}`, 5_000, () => trace(t[1] as Hex)))
    }

    if (req.method === "POST" && path === "/api/admin/ingest") {
      const tok = process.env.ADMIN_TOKEN?.trim()
      if (!tok || req.headers["x-admin-token"] !== tok) return json(res, 403, { error: "Forbidden" })
      return json(res, 200, await ingestPrices(url.searchParams.get("force") === "1"))
    }

    const act = path.match(/^\/api\/act\/([a-z_]+)\/(make|offer|split|buy|recall)$/)
    if (req.method === "POST" && act) {
      const [, roleId, action] = act as unknown as [string, RoleId, keyof typeof ACTOR]
      if (!Object.hasOwn(ROLES, roleId) || !ACTOR[action].includes(roleId)) return json(res, 400, { error: `A ${roleId} cannot ${action}` })
      const w = wallets[roleId]
      if (!w) return json(res, 503, { error: "Writes are not configured on this server" })
      const limited = rateLimit(ipOf(req))
      if (limited) return json(res, 429, { error: limited })
      const b = await readBody(req)
      let out: unknown
      if (action === "make") {
        if (!isKey(b.product)) return json(res, 400, { error: "Pick a product" })
        const product = await pub.getEntity(b.product)
        if (!isSetu(product, "product") || product.creator.toLowerCase() !== w.account.address.toLowerCase()) return json(res, 400, { error: "You can only make lots of your own products" })
        const qty = posInt(b.qty, 100_000); const shelf = posInt(b.shelfDays, 1100)
        if (!qty || !shelf) return json(res, 400, { error: "Quantity and shelf life must be positive" })
        const batch = `${String(attr(product, "sku")).slice(0, 6)}-${Date.now().toString(36).toUpperCase().slice(-5)}`
        out = await serial(w.account.address, () => makeLot(pub, w, { product, batch, qty, mfgAt: Date.now(), bestBefore: Date.now() + shelf * 86_400_000, originState: ROLES[roleId].state }))
      } else if (action === "offer") {
        if (!isKey(b.lot)) return json(res, 400, { error: "Pick a lot" })
        const qty = posInt(b.qty, 100_000); const price = posInt(Math.round(Number(b.unitPriceRupees) * 100), 100_000_000)
        if (!qty || !price) return json(res, 400, { error: "Quantity and price must be positive" })
        const lot = await pub.getEntity(b.lot)
        const official = await officialPrice(String(attr(lot, "commodity")))
        out = await serial(w.account.address, () => listOffer(pub, w, { lotKey: b.lot as Hex, qty, unitPricePaise: price, refPricePaise: official?.pricePaise ?? 0, sellerRole: ROLES[roleId].role, state: ROLES[roleId].state }))
      } else if (action === "split") {
        if (!isKey(b.lot) || !Array.isArray(b.parts) || b.parts.length > 5) return json(res, 400, { error: "Pick a lot and up to 5 parts" })
        const parts = b.parts.map((p) => posInt(p)).filter((p): p is number => Boolean(p))
        out = await serial(w.account.address, () => splitLot(pub, w, b.lot as Hex, parts))
      } else if (action === "buy") {
        if (!isKey(b.offer)) return json(res, 400, { error: "Pick an offer" })
        const offer = await pub.getEntity(b.offer).catch(() => undefined)
        if (!offer || !isSetu(offer, "offer")) return json(res, 409, { error: "This offer was just sold or has expired. Refresh the marketplace." })
        const sellerId = Object.entries(ROLES).find(([, r]) => r.address.toLowerCase() === String(attr(offer, "seller")).toLowerCase())?.[0] as RoleId | undefined
        const sw = sellerId ? wallets[sellerId] : undefined
        if (!sw) return json(res, 409, { error: "This seller signs with their own wallet; the demo relay cannot settle it" })
        if (sw.account.address.toLowerCase() === w.account.address.toLowerCase()) return json(res, 400, { error: "You cannot buy your own offer" })
        out = await serial(sw.account.address, () => fillOffer(pub, sw, b.offer as Hex, w.account.address))
      } else {
        if (!isKey(b.root)) return json(res, 400, { error: "Pick a batch" })
        const reason = String(b.reason ?? "").trim().slice(0, 120) || "Failed quality test (demo)"
        out = await serial(w.account.address, () => recallBatch(pub, w, b.root as Hex, { reason, severity: b.severity === "class2" ? "class2" : "class1" }))
      }
      cache.clear(); forget()
      return json(res, 200, out)
    }
    return json(res, 404, { error: "Not found" })
  } catch (e) {
    const msg = redact((e as Error).message ?? String(e))
    console.error("[api]", req.method, redact(path), msg.slice(0, 500))
    return json(res, /not found|NoEntityFound/i.test(msg) ? 404 : 400, { error: msg.split("\n")[0].slice(0, 300) })
  }
}
