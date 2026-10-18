// Server-side Arkiv access: reads use the Hub access key (kept off the browser), writes use the desk keys.
import { createPublicClient, createWalletClient, type Entity } from "@arkiv-network/sdk"
import { addr, key, str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte, lt, lte, or } from "@arkiv-network/sdk/query"
import { http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { attr, isDemoRequest, num } from "../src/shared/ops"
import { collectPages } from "../src/shared/pages"
import { PROJECT, isOverdue, type Basis, type EventKind, type EventView, type RequestView, type Stage } from "../src/shared/rti"

const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()
const rpcUrl = accessKey ? `${tiramisu.rpcUrls.default.http[0]}/${accessKey}` : undefined
export const usingAccessKey = Boolean(accessKey)

export const pub = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) })

const walletFor = (envName: string) => {
  const pk = process.env[envName]?.trim()
  return pk ? createWalletClient({ chain: tiramisu, transport: http(rpcUrl), account: privateKeyToAccount(pk as Hex) }) : undefined
}
export const deskWallet = walletFor("DESK_KEY")
export const legalWallet = walletFor("LEGAL_AID_KEY")

// Trusted creators: from env (public addresses), falling back to the relay keys' addresses.
export const DESK = (process.env.DESK_ADDRESS?.trim() || deskWallet?.account.address || "0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2") as Hex
export const LEGAL_AID = (process.env.LEGAL_AID_ADDRESS?.trim() || legalWallet?.account.address || "0xb114Ab157311e6C15B74fb08789632671d45D9c2") as Hex
const TRUSTED = new Set([DESK, LEGAL_AID].map((a) => a.toLowerCase()))
export const isTrusted = (a: string) => TRUSTED.has(a.toLowerCase())

const REQ_FIELDS = { key: true, owner: true, creator: true, expiresAt: true, creationFlags: true, attributes: true, payload: true } as const

function toRequest(e: Entity): RequestView {
  return {
    key: e.key!,
    ref: String(attr(e, "ref")),
    state: String(attr(e, "state")),
    authority: String(attr(e, "authority")),
    level: String(attr(e, "level")),
    basis: String(attr(e, "basis")) as Basis,
    category: String(attr(e, "category")),
    stage: String(attr(e, "stage")) as Stage,
    filedAt: num(e, "filed_at") ?? 0,
    dueAt: num(e, "due_at") ?? 0,
    appealBy: num(e, "appeal_by"),
    repliedAt: num(e, "replied_at"),
    faaDueAt: num(e, "faa_due_at"),
    summary: safeJson(e)?.summary,
    owner: e.owner!,
    creator: e.creator!,
    expiresAt: String(e.expiresAt),
    permissionlessExtension: Boolean(e.creationFlags?.permissionlessExtension),
    trusted: isTrusted(e.creator!),
  }
}

function safeJson(e: Entity) {
  try {
    return e.payload?.length ? e.toJson() : undefined
  } catch {
    return undefined
  }
}

// Converts expiry blocks to wall-clock ms for display, using the chain's own timing.
async function withExpiryMs<T extends { expiresAt: string; expiresAtMs?: number }>(items: T[]) {
  const t = await pub.getBlockTiming()
  for (const i of items) i.expiresAtMs = (t.currentBlockTime + Number(BigInt(i.expiresAt) - t.currentBlock) * t.blockDuration) * 1000
  return items
}

export type ListFilter = {
  state?: string
  authority?: string
  stage?: string
  category?: string
  due?: "overdue" | "week"
  scope?: "all" | "trusted"
  cursor?: string
  asOf?: number
}

export function listQuery(f: ListFilter) {
  const now = f.asOf ?? Date.now()
  const preds = [eq("project", str(PROJECT)), eq("type", str("request"))]
  if (f.state) preds.push(eq("state", str(f.state)))
  if (f.authority) preds.push(eq("authority", str(f.authority)))
  if (f.category) preds.push(eq("category", str(f.category)))
  if (f.stage) preds.push(eq("stage", str(f.stage)))
  if (f.due === "overdue") preds.push(eq("stage", str("awaiting_reply")), lt("due_at", u64(now)))
  if (f.due === "week") preds.push(eq("stage", str("awaiting_reply")), gte("due_at", u64(now)), lte("due_at", u64(now + 7 * 86_400_000)))
  let q = pub.select(REQ_FIELDS).where(and(preds)).limit(25)
  if (f.scope === "trusted") q = q.createdBy(DESK)
  if (f.cursor) q = q.cursor(f.cursor)
  return q
}

export async function listRequests(f: ListFilter) {
  const asOf = f.asOf ?? Date.now()
  const q = listQuery({ ...f, asOf })
  const page = await q.fetch()
  const items = await withExpiryMs(page.entities.map((e) => toRequest(e as Entity)))
  items.sort((a, b) => a.dueAt - b.dueAt)
  return { items, cursor: page.cursor ?? null, block: page.blockNumber.toString(), query: q.toString(), asOf }
}

// Department scorecard: trusted requests only. Overdue uses a numeric range on due_at.
export async function scorecard() {
  const now = Date.now()
  const allQ = pub
    .select({ key: true, attributes: { authority: true, stage: true, due_at: true } })
    .where(eq("project", str(PROJECT)), eq("type", str("request")))
    .createdBy(DESK)
    .limit(200)
  const overdueQ = pub
    .select({ key: true, attributes: { authority: true } })
    .where(eq("project", str(PROJECT)), eq("type", str("request")), eq("stage", str("awaiting_reply")), lt("due_at", u64(now)))
    .createdBy(DESK)
    .limit(200)
  const rows = new Map<string, { authority: string; total: number; overdue: number; awaiting: number; replied: number; appeals: number }>()
  const row = (a: string) => rows.get(a) ?? rows.set(a, { authority: a, total: 0, overdue: 0, awaiting: 0, replied: 0, appeals: 0 }).get(a)!
  let block = ""
  for await (const e of allQ) {
    const r = row(String(attr(e as Entity, "authority")))
    const stage = String(attr(e as Entity, "stage")) as Stage
    r.total++
    if (stage === "awaiting_reply") r.awaiting++
    if (stage === "replied") r.replied++
    if (stage === "first_appeal" || stage === "second_appeal") r.appeals++
  }
  for await (const e of overdueQ) row(String(attr(e as Entity, "authority"))).overdue++
  const out = [...rows.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total)
  return { rows: out, block, now, queries: { all: allQ.toString(), overdue: overdueQ.toString() } }
}

export async function requestDetail(k: Hex) {
  const e = await pub.getEntity(k)
  if (!isDemoRequest(e)) throw new Error("Request not found")
  const [request] = await withExpiryMs([toRequest(e)])
  const evQ = pub
    .select({ key: true, owner: true, creator: true, expiresAt: true, creationFlags: true, attributes: true, payload: true })
    .where(eq("project", str(PROJECT)), eq("type", str("event")), eq("request", key(k)))
    .where(or(eq("$creator", addr(DESK)), eq("$creator", addr(LEGAL_AID)), eq("$creator", addr(e.owner))))
    .limit(50)
  const page = await collectPages(await evQ.fetch())
  const events: EventView[] = page.entities.map((x) => ({
    key: x.key,
    kind: String(attr(x as Entity, "kind")) as EventKind,
    at: num(x as Entity, "at") ?? 0,
    note: safeJson(x as Entity)?.note,
    owner: x.owner,
    creator: x.creator,
    expiresAt: x.expiresAt.toString(),
    readonly: Boolean(x.creationFlags?.readonly),
    trusted: isTrusted(x.creator),
  }))
  events.sort((a, b) => a.at - b.at)
  return { request: { ...request, overdue: isOverdue(request) }, events, query: evQ.toString() }
}

export async function findByRef(ref: string) {
  const q = pub.select(REQ_FIELDS).where(eq("project", str(PROJECT)), eq("type", str("request")), eq("ref", str(ref))).limit(10)
  const page = await q.fetch()
  return { items: await withExpiryMs(page.entities.map((e) => toRequest(e as Entity))), query: q.toString() }
}
