// One HTTP handler for local dev (Vite middleware) and Vercel (api/index.ts).
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Hex } from "viem"
import { isAddress } from "viem"
import {
  escalateSecondAppeal, fileFirstAppeal, fileRequest, handOver, markReplied, recordHearing,
} from "../src/shared/ops"
import { BASIS, CATEGORIES, CHAIN_ID, DEPARTMENTS, EXPLORER, PROJECT, SCHEMA, STATES, WS_URL, type Basis } from "../src/shared/rti"
import {
  DESK, LEGAL_AID, deskWallet, findByRef, legalWallet, listRequests, pub, requestDetail, scorecard, usingAccessKey,
  type ListFilter,
} from "./arkiv"

// --- Rate limits: protect the testnet GLM in the relay wallets -------------------------------------
const PER_IP = { max: 8, windowMs: 10 * 60_000 }
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_WRITES_PER_DAY ?? 300)
const hits = new Map<string, number[]>()
let day = { start: Date.now(), count: 0 }

function rateLimit(ip: string): string | undefined {
  const now = Date.now()
  if (now - day.start > 86_400_000) day = { start: now, count: 0 }
  if (day.count >= GLOBAL_PER_DAY) return "The demo's daily write budget is used up; reads still work. Try again tomorrow."
  const list = (hits.get(ip) ?? []).filter((t) => now - t < PER_IP.windowMs)
  if (list.length >= PER_IP.max) return `Max ${PER_IP.max} writes per ${PER_IP.windowMs / 60_000} minutes per visitor.`
  list.push(now)
  hits.set(ip, list)
  day.count++
}

// --- One write at a time per wallet: keeps nonces and predicted keys valid --------------------------
const queues = new Map<string, Promise<unknown>>()
function serial<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(wallet) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  queues.set(wallet, next)
  return next
}

// --- Small read cache: saves read quota when many judges open the page at once ----------------------
const cache = new Map<string, { at: number; value: unknown }>()
async function cached<T>(k: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
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
  const pre = (req as IncomingMessage & { body?: unknown }).body
  if (pre && typeof pre === "object") return pre as Record<string, unknown>
  let s = ""
  for await (const c of req) s += c
  if (s.length > 4096) throw new Error("Body too large")
  return s ? JSON.parse(s) : {}
}

const ipOf = (req: IncomingMessage) =>
  String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim()

const isKey = (s: string): s is Hex => /^0x[0-9a-fA-F]{64}$/.test(s)

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://local")
  const path = url.pathname.replace(/\/+$/, "")
  const q = Object.fromEntries(url.searchParams)
  try {
    if (req.method === "GET" && path === "/api/config")
      return json(res, 200, {
        project: PROJECT, schema: SCHEMA, chainId: CHAIN_ID, explorer: EXPLORER, wsUrl: WS_URL,
        desk: DESK, legalAid: LEGAL_AID, usingAccessKey, writesEnabled: Boolean(deskWallet && legalWallet),
        basis: BASIS, states: STATES, departments: DEPARTMENTS, categories: CATEGORIES,
      })

    if (req.method === "GET" && path === "/api/requests") {
      const f: ListFilter = {
        state: q.state || undefined, authority: q.authority || undefined, stage: q.stage || undefined,
        category: q.category || undefined, due: (q.due as ListFilter["due"]) || undefined,
        scope: q.scope === "trusted" ? "trusted" : "all", cursor: q.cursor || undefined,
      }
      if (q.ref) return json(res, 200, await findByRef(q.ref.trim().toUpperCase()))
      return json(res, 200, await cached(`list:${url.search}`, 5_000, () => listRequests(f)))
    }

    if (req.method === "GET" && path === "/api/scorecard")
      return json(res, 200, await cached("scorecard", 10_000, scorecard))

    const detail = path.match(/^\/api\/request\/(0x[0-9a-fA-F]{64})$/)
    if (req.method === "GET" && detail) return json(res, 200, await requestDetail(detail[1] as Hex))

    if (req.method === "POST") {
      if (!deskWallet || !legalWallet) return json(res, 503, { error: "Writes are not configured on this server" })
      const limited = rateLimit(ipOf(req))
      if (limited) return json(res, 429, { error: limited })
      const body = await readBody(req)

      if (path === "/api/requests") {
        const { state, dept, basis, category } = body as Record<string, string>
        const filedDaysAgo = Math.min(60, Math.max(0, Number(body.filedDaysAgo ?? 0) | 0))
        if (!STATES[state] || !DEPARTMENTS[dept] || !BASIS[basis as Basis] || !CATEGORIES[category])
          return json(res, 400, { error: "Unknown state, department, basis or category" })
        const desk = deskWallet
        const out = await serial(DESK, () =>
          fileRequest(pub, desk, { state, dept, basis: basis as Basis, category, filedAt: Date.now() - filedDaysAgo * 86_400_000 }))
        cache.clear()
        return json(res, 200, out)
      }

      const action = path.match(/^\/api\/request\/(0x[0-9a-fA-F]{64})\/(reply|appeal|escalate|hearing|handover)$/)
      if (action && isKey(action[1])) {
        const k = action[1]
        const owner = (await pub.getEntity(k)).owner.toLowerCase()
        const signer = owner === DESK.toLowerCase() ? deskWallet : owner === LEGAL_AID.toLowerCase() ? legalWallet : undefined
        if (!signer)
          return json(res, 409, { error: `This request is owned by ${owner}. Only that wallet can update it: connect it and sign in your browser.` })
        const run = {
          reply: () => markReplied(pub, signer, k),
          appeal: () => fileFirstAppeal(pub, signer, k),
          escalate: () => escalateSecondAppeal(pub, signer, k, LEGAL_AID),
          hearing: () => recordHearing(pub, signer, k),
          handover: () => {
            const to = String(body.applicant ?? "")
            if (!isAddress(to)) throw new Error("Enter a valid wallet address for the applicant")
            return handOver(pub, signer, k, to)
          },
        }[action[2] as "reply"]
        const out = await serial(signer.account.address, run)
        cache.clear()
        return json(res, 200, out)
      }
    }
    return json(res, 404, { error: "Not found" })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    console.error("[api]", req.method, path, msg.slice(0, 500))
    return json(res, /not found|NoEntityFound/i.test(msg) ? 404 : 400, { error: msg.split("\n")[0].slice(0, 300) })
  }
}
