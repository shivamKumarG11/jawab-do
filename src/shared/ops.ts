// Every Jawab Do write, each as ONE atomic executeBatch. Runs on the server (relay keys) and in the
// browser (the user's own wallet), so the same code path is what judges see on chain.
import {
  ExpirationTime,
  jsonToPayload,
  type Entity,
  type PublicArkivClient,
  type WalletArkivClient,
} from "@arkiv-network/sdk"
import { bool, key, str, u64 } from "@arkiv-network/sdk/attr"
import type { Hex } from "viem"
import {
  BASIS, BURN, DEPARTMENTS, EVENT_HORIZON, FAA_DECIDE, PROJECT, SCHEMA, SUMMARIES,
  authorityId, dueAt, newRef, requestLifetimeEnd,
  type Basis, type EventKind, type Stage,
} from "./rti"

type Pub = PublicArkivClient
type Wallet = WalletArkivClient

const common = (type: "request" | "event") => ({
  project: str(PROJECT),
  schema: str(SCHEMA),
  type: str(type),
  demo: bool(true),
})

const me = (w: Wallet) => {
  const a = w.account?.address
  if (!a) throw new Error("Wallet client has no account")
  return a
}

export const attr = (e: Pick<Entity, "attributes">, name: string) => e.attributes?.[name]?.value as unknown
export const num = (e: Pick<Entity, "attributes">, name: string) => {
  const v = attr(e, name)
  return v === undefined ? undefined : Number(v)
}
export const isDemoRequest = (e: Pick<Entity, "attributes">) =>
  attr(e, "project") === PROJECT && attr(e, "schema") === SCHEMA && attr(e, "type") === "request" && attr(e, "demo") === true

// Converts a wall-clock time to a block height using the chain's own timing, so expiry comparisons are exact.
async function blockAt(pub: Pub, ms: number) {
  const t = await pub.getBlockTiming()
  return t.currentBlock + BigInt(Math.max(1, Math.ceil((ms / 1000 - t.currentBlockTime) / t.blockDuration)))
}
const atLeastHour = { atLeast: ExpirationTime.fromHours(1) }

// An immutable timeline entry: readonly + permissionless extension, handed to the burn address in the same batch.
function eventCreate(salt: bigint, requestKey: Hex, r: Entity, kind: EventKind, note: string, expiresBlock: bigint) {
  return {
    payload: jsonToPayload({ note }),
    contentType: "application/json" as const,
    attributes: {
      ...common("event"),
      request: key(requestKey),
      ref: str(String(attr(r, "ref"))),
      kind: str(kind),
      at: u64(Date.now()),
      authority: str(String(attr(r, "authority"))),
      state: str(String(attr(r, "state"))),
    },
    expires: ExpirationTime.atBlock(expiresBlock, atLeastHour),
    flags: { readonly: true, permissionlessExtension: true },
    salt,
  }
}

export type FileInput = { state: string; dept: string; basis: Basis; category: string; filedAt?: number; summary?: string }

export async function fileRequest(pub: Pub, wallet: Wallet, input: FileInput) {
  const filedAt = input.filedAt ?? Date.now()
  const due = dueAt(filedAt, input.basis)
  const ref = newRef(input.state)
  const summary = input.summary ?? SUMMARIES[input.category][0]
  const [reqK, evK] = await pub.predictEntityKeys({ owner: me(wallet), count: 2 })
  const reqExpiry = await blockAt(pub, requestLifetimeEnd.awaitingReply(due))
  const evExpiry = await blockAt(pub, Date.now() + EVENT_HORIZON)
  const request = {
    payload: jsonToPayload({ summary, language: "en" }),
    contentType: "application/json" as const,
    attributes: {
      ...common("request"),
      ref: str(ref),
      state: str(input.state),
      authority: str(authorityId(input.state, input.dept)),
      level: str(DEPARTMENTS[input.dept].level),
      basis: str(input.basis),
      category: str(input.category),
      stage: str("awaiting_reply" satisfies Stage),
      filed_at: u64(filedAt),
      due_at: u64(due),
      appeal_by: u64(requestLifetimeEnd.awaitingReply(due)),
    },
    expires: ExpirationTime.atBlock(reqExpiry, atLeastHour),
    flags: { permissionlessExtension: true },
    salt: reqK.salt,
  }
  const pseudo = { attributes: request.attributes } as unknown as Entity
  const res = await wallet.executeBatch({
    creates: [request, eventCreate(evK.salt, reqK.key, pseudo, "filed", `Filed under ${BASIS[input.basis].section}`, evExpiry)],
    ownershipChanges: [{ entityKey: evK.key, newOwner: BURN }],
  })
  return { ref, requestKey: reqK.key, eventKey: evK.key, txHash: res.txHash }
}

type Transition = {
  kind: EventKind
  note: string
  set?: Record<string, ReturnType<typeof str> | ReturnType<typeof u64>>
  lifetimeEnd?: number
  renewDays?: number
  newOwner?: Hex
}

async function transition(pub: Pub, wallet: Wallet, requestKey: Hex, t: Transition) {
  const r = await pub.getEntity(requestKey)
  if (!isDemoRequest(r)) throw new Error("Only Jawab Do demo requests can be updated")
  if (r.owner.toLowerCase() !== me(wallet).toLowerCase())
    throw new Error(`Only the current owner ${r.owner} can update this request`)
  const [evK] = await pub.predictEntityKeys({ owner: me(wallet), count: 1 })
  const evExpiry = await blockAt(pub, Date.now() + EVENT_HORIZON)
  let target = 0n
  if (t.renewDays) {
    const timing = await pub.getBlockTiming()
    const base = r.expiresAt > timing.currentBlock ? r.expiresAt : timing.currentBlock
    target = base + BigInt(Math.ceil(t.renewDays * 86_400 / timing.blockDuration))
  } else if (t.lifetimeEnd) {
    target = await blockAt(pub, t.lifetimeEnd)
  }
  const newExpiry = target > r.expiresAt ? target : r.expiresAt
  const res = await wallet.executeBatch({
    creates: [eventCreate(evK.salt, requestKey, r, t.kind, t.note, evExpiry)],
    patches: t.set ? [{ entityKey: requestKey, set: t.set }] : [],
    // Lifetime Extension only when it moves the expiry later; the engine rejects an earlier one.
    extensions: target > r.expiresAt ? [{ entityKey: requestKey, expires: ExpirationTime.atBlock(target) }] : [],
    ownershipChanges: [
      { entityKey: evK.key, newOwner: BURN },
      ...(t.newOwner ? [{ entityKey: requestKey, newOwner: t.newOwner }] : []),
    ],
  })
  return { txHash: res.txHash, eventKey: evK.key, extended: target > r.expiresAt, previousExpiry: r.expiresAt, newExpiry }
}

const stageOf = (r: Entity) => String(attr(r, "stage")) as Stage

export async function markReplied(pub: Pub, wallet: Wallet, requestKey: Hex) {
  const r = await pub.getEntity(requestKey)
  if (stageOf(r) !== "awaiting_reply") throw new Error("Only a request awaiting reply can be marked replied")
  const now = Date.now()
  return transition(pub, wallet, requestKey, {
    kind: "replied",
    note: "PIO reply received",
    set: { stage: str("replied"), replied_at: u64(now), appeal_by: u64(requestLifetimeEnd.replied(now)) },
    lifetimeEnd: requestLifetimeEnd.replied(now),
  })
}

export async function fileFirstAppeal(pub: Pub, wallet: Wallet, requestKey: Hex) {
  const r = await pub.getEntity(requestKey)
  const stage = stageOf(r)
  const overdue = stage === "awaiting_reply" && Number(attr(r, "due_at")) < Date.now()
  if (!(stage === "replied" || overdue))
    throw new Error("A first appeal needs a reply or a missed deadline (deemed refusal, s.7(2))")
  const now = Date.now()
  return transition(pub, wallet, requestKey, {
    kind: "first_appeal",
    note: overdue ? "First appeal after deemed refusal, s.7(2) + s.19(1)" : "First appeal against the reply, s.19(1)",
    set: { stage: str("first_appeal"), faa_due_at: u64(now + FAA_DECIDE) },
    lifetimeEnd: requestLifetimeEnd.firstAppeal(now),
  })
}

export async function escalateSecondAppeal(pub: Pub, wallet: Wallet, requestKey: Hex, legalAid: Hex) {
  const r = await pub.getEntity(requestKey)
  if (stageOf(r) !== "first_appeal") throw new Error("Second appeal follows a first appeal, s.19(3)")
  return transition(pub, wallet, requestKey, {
    kind: "second_appeal",
    note: "Second appeal to the Information Commission, s.19(3); case handed to legal-aid desk",
    set: { stage: str("second_appeal") },
    lifetimeEnd: requestLifetimeEnd.secondAppealLease(Date.now()),
    newOwner: legalAid,
  })
}

export async function recordHearing(pub: Pub, wallet: Wallet, requestKey: Hex) {
  const r = await pub.getEntity(requestKey)
  if (stageOf(r) !== "second_appeal") throw new Error("Hearings happen in second appeal")
  return transition(pub, wallet, requestKey, {
    kind: "hearing",
    note: "Commission hearing recorded; demo retention extended by 90 days",
    renewDays: 90,
  })
}

export async function handOver(pub: Pub, wallet: Wallet, requestKey: Hex, applicant: Hex) {
  return transition(pub, wallet, requestKey, {
    kind: "handed_over",
    note: "Request handed to the applicant's own wallet",
    newOwner: applicant,
  })
}

// Anyone, with any wallet: permissionless Lifetime Extension of 30 days beyond the current expiry.
export async function keepAlive(pub: Pub, wallet: Wallet, requestKey: Hex) {
  const r = await pub.getEntity(requestKey)
  if (!isDemoRequest(r)) throw new Error("Only Jawab Do demo requests can be kept alive")
  const t = await pub.getBlockTiming()
  const target = r.expiresAt + BigInt((30 * 86_400) / t.blockDuration)
  const res = await wallet.extendEntity({ entityKey: requestKey, expires: ExpirationTime.atBlock(target) })
  return { txHash: res.txHash, previousExpiry: r.expiresAt, newExpiry: res.expiresAt }
}
