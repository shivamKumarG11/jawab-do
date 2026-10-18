// Write probe: checks every SDK behaviour Jawab Do depends on, on Tiramisu, before the app relies on it.
// Uses project "jawab-do-probe" and short lifetimes so it never pollutes app data.
// Run: npx tsx --env-file=.env scripts/probe-write.ts
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { addr, key, str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, or } from "@arkiv-network/sdk/query"
import { http, webSocket, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

const BURN = "0x000000000000000000000000000000000000dEaD" as const
const PROJECT = "jawab-do-probe"
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const short = (e: unknown) => (e as Error).message.split("\n").slice(0, 3).join(" | ").slice(0, 260)

const rpc = process.env.ARKIV_ACCESS_KEY
  ? `${tiramisu.rpcUrls.default.http[0]}/${process.env.ARKIV_ACCESS_KEY}`
  : undefined
const pub = createPublicClient({ chain: tiramisu, transport: http(rpc) })
const wallet = (k: string) =>
  createWalletClient({ chain: tiramisu, transport: http(rpc), account: privateKeyToAccount(process.env[k] as Hex) })
const desk = wallet("DESK_KEY")
const legal = wallet("LEGAL_AID_KEY")
const spoof = wallet("SPOOFER_KEY")
const base = { project: str(PROJECT), schema: str("rti.v1") }
const bal = async (a: Hex) => Number(await pub.getBalance({ address: a })) / 1e18

async function expect<T>(label: string, fn: () => Promise<T>, shouldFail: boolean) {
  try {
    const r = await fn()
    log(shouldFail ? "UNEXPECTED OK" : "ok", label)
    return r
  } catch (e) {
    log(shouldFail ? "rejected as expected" : "FAILED", label, "→", short(e))
  }
}

const before = await bal(desk.account.address)
log("desk balance", before, "GLM")

// 1. First entity
const first = await desk.createEntity({
  payload: jsonToPayload({ hello: "jawab-do" }),
  contentType: "application/json",
  attributes: { ...base, type: str("hello") },
  expires: ExpirationTime.fromHours(1),
})
log("FIRST ENTITY", first.entityKey, "tx", first.txHash, "expiresAt", first.expiresAt)
log("cost of one create ≈", before - (await bal(desk.account.address)), "GLM")

// 2. Batch: request + event that references it + transfer event to burn address, with predicted keys
const [reqK, evK] = await pub.predictEntityKeys({ owner: desk.account.address, count: 2 })
const b0 = await bal(desk.account.address)
const batch = await desk.executeBatch({
  creates: [
    {
      payload: jsonToPayload({ summary: "probe request" }),
      contentType: "application/json",
      attributes: { ...base, type: str("request"), ref: str("JD-PROBE-1"), due_at: u64(Date.now() + 3_600_000) },
      expires: ExpirationTime.fromHours(1),
      flags: { permissionlessExtension: true },
      salt: reqK.salt,
    },
    {
      payload: jsonToPayload({ note: "filed" }),
      contentType: "application/json",
      attributes: { ...base, type: str("event"), kind: str("filed"), request: key(reqK.key) },
      expires: ExpirationTime.fromHours(2),
      flags: { readonly: true, permissionlessExtension: true },
      salt: evK.salt,
    },
  ],
  ownershipChanges: [{ entityKey: evK.key, newOwner: BURN }],
})
log("batch tx", batch.txHash, "created", batch.createdEntities, "predicted match:",
  batch.createdEntities?.[0] === reqK.key && batch.createdEntities?.[1] === evK.key)
log("cost of batch (2 creates + 1 transfer) ≈", b0 - (await bal(desk.account.address)), "GLM")

const ev = await pub.getEntity(evK.key)
log("event owner", ev.owner, "creator", ev.creator, "flags", ev.creationFlags)

// 3. Burn-owned readonly event: nobody can delete or patch
await expect("desk deletes burn-owned event", () => desk.deleteEntity({ entityKey: evK.key }), true)
await expect("desk patches burn-owned event", () => desk.patchEntity({ entityKey: evK.key, set: { kind: str("x") } }), true)
// 4. ...but anyone can extend it (permissionlessExtension)
await expect("spoofer extends burn-owned event", () =>
  spoof.extendEntity({ entityKey: evK.key, expires: ExpirationTime.fromHours(3) }), false)

// 5. Extension rules on the request
const req = await pub.getEntity(reqK.key)
log("request expiresAt", req.expiresAt)
await expect("extend to EQUAL expiry", () =>
  desk.extendEntity({ entityKey: reqK.key, expires: ExpirationTime.atBlock(req.expiresAt) }), false)
await expect("extend to EARLIER expiry", () =>
  desk.extendEntity({ entityKey: reqK.key, expires: ExpirationTime.atBlock(req.expiresAt - 100n) }), true)
// 6. Permissionless extension by a non-owner on the request
await expect("legal-aid (non-owner) extends request", () =>
  legal.extendEntity({ entityKey: reqK.key, expires: ExpirationTime.fromHours(2) }), false)
// Control: an entity WITHOUT the flag cannot be extended by a non-owner
await expect("legal-aid extends hello entity (no flag)", () =>
  legal.extendEntity({ entityKey: first.entityKey, expires: ExpirationTime.fromHours(2) }), true)

// 7. Ownership transfer: desk → legal-aid; creator stays desk
await desk.changeOwnership({ entityKey: reqK.key, newOwner: legal.account.address })
const moved = await pub.getEntity(reqK.key)
log("after transfer owner", moved.owner, "creator", moved.creator)
await expect("old owner (desk) patches", () => desk.patchEntity({ entityKey: reqK.key, set: { ref: str("x") } }), true)
await expect("new owner (legal-aid) patches", () =>
  legal.patchEntity({ entityKey: reqK.key, set: { stage: str("second_appeal") } }), false)

// 8. Spoofer writes an identical-looking request
await spoof.createEntity({
  payload: jsonToPayload({ summary: "spoof" }),
  contentType: "application/json",
  attributes: { ...base, type: str("request"), ref: str("JD-PROBE-1") },
  expires: ExpirationTime.fromHours(1),
})

// 9. Queries: createdBy vs everyone, and OR on $creator
const all = await pub.select({ key: true, creator: true }).where(eq("project", str(PROJECT)), eq("ref", str("JD-PROBE-1"))).fetch()
const trusted = await pub.select({ key: true }).where(eq("project", str(PROJECT)), eq("ref", str("JD-PROBE-1"))).createdBy(desk.account.address).fetch()
log("ref JD-PROBE-1: all creators", all.entities.length, "| createdBy(desk)", trusted.entities.length)
const q = pub.select({ key: true, creator: true }).where(eq("project", str(PROJECT)))
  .where(or(eq("$creator", addr(desk.account.address)), eq("$creator", addr(legal.account.address))))
log("OR-on-$creator query string:", q.toString())
await expect("OR on $creator", async () => log("OR result", (await q.fetch()).entities.length), false)
const byReq = await pub.select({ key: true }).where(eq("project", str(PROJECT)), eq("request", key(reqK.key))).fetch()
log("events by key(request):", byReq.entities.length)

// 10. WebSocket: does watchEntityEvents use eth_subscribe (no polling calls)?
const methods: string[] = []
const ws = webSocket()
const spy = (opts: Parameters<typeof ws>[0]) => {
  const t = ws(opts)
  const request = t.request
  return { ...t, request: (async (args: { method: string }) => { methods.push(args.method); return request(args as never) }) as typeof request }
}
const wsPub = createPublicClient({ chain: tiramisu, transport: spy as unknown as typeof ws })
let seen = 0
const un = wsPub.watchEntityEvents({ onEvent: (e) => { if ("owner" in e && e.owner === desk.account.address) seen++ } })
await new Promise((r) => setTimeout(r, 1500))
await desk.createEntity({ payload: jsonToPayload({}), contentType: "application/json", attributes: { ...base, type: str("ping") }, expires: ExpirationTime.fromMinutes(10) })
await new Promise((r) => setTimeout(r, 6000))
un()
log("ws: own events seen", seen, "| request() methods used while watching:", [...new Set(methods)])
log("desk balance after", await bal(desk.account.address), "| legal", await bal(legal.account.address), "| spoof", await bal(spoof.account.address))
process.exit(0)
