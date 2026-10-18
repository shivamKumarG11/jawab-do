// Seeds SYNTHETIC demo data through the same code paths the app uses.
// Filing dates are backdated (as when a desk logs paper filings) so overdue and appeal states exist today.
// Run: npx tsx --env-file=.env scripts/seed.ts
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { bool, str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { escalateSecondAppeal, fileFirstAppeal, fileRequest, handOver, keepAlive, markReplied, recordHearing } from "../src/shared/ops"
import { DAY, PROJECT, SCHEMA, SUMMARIES, authorityId, dueAt, newRef, type Basis } from "../src/shared/rti"

const key = process.env.ARKIV_ACCESS_KEY?.trim()
const rpc = key ? `${tiramisu.rpcUrls.default.http[0]}/${key}` : undefined
const pub = createPublicClient({ chain: tiramisu, transport: http(rpc) })
const w = (k: string) => createWalletClient({ chain: tiramisu, transport: http(rpc), account: privateKeyToAccount(process.env[k] as Hex) })
const desk = w("DESK_KEY")
const legal = w("LEGAL_AID_KEY")
const spoof = w("SPOOFER_KEY")
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

type Row = { state: string; dept: string; basis: Basis; category: string; daysAgo: number; then?: string[] }
const rows: Row[] = [
  { state: "BR", dept: "food", basis: "standard", category: "ration", daysAgo: 41 },
  { state: "BR", dept: "food", basis: "standard", category: "ration", daysAgo: 36 },
  { state: "BR", dept: "collectorate", basis: "standard", category: "land", daysAgo: 52, then: ["appeal"] },
  { state: "BR", dept: "rural", basis: "via_apio", category: "pension", daysAgo: 38 },
  { state: "UP", dept: "municipal", basis: "standard", category: "water", daysAgo: 33 },
  { state: "UP", dept: "power", basis: "standard", category: "electricity", daysAgo: 12 },
  { state: "UP", dept: "education", basis: "standard", category: "scholarship", daysAgo: 44, then: ["reply"] },
  { state: "MH", dept: "municipal", basis: "standard", category: "roads", daysAgo: 58, then: ["appeal", "escalate", "hearing"] },
  { state: "MH", dept: "pwd", basis: "third_party", category: "roads", daysAgo: 20 },
  { state: "MH", dept: "collectorate", basis: "standard", category: "land", daysAgo: 27 },
  { state: "DL", dept: "municipal", basis: "standard", category: "health", daysAgo: 5 },
  { state: "DL", dept: "pf", basis: "standard", category: "pension", daysAgo: 39, then: ["handover"] },
  { state: "KA", dept: "education", basis: "standard", category: "scholarship", daysAgo: 15, then: ["reply"] },
  { state: "KA", dept: "rural", basis: "standard", category: "pension", daysAgo: 34 },
  { state: "TN", dept: "food", basis: "standard", category: "ration", daysAgo: 2 },
  { state: "WB", dept: "railway", basis: "standard", category: "roads", daysAgo: 31 },
  { state: "RJ", dept: "collectorate", basis: "life_liberty", category: "health", daysAgo: 0 },
  { state: "RJ", dept: "pwd", basis: "standard", category: "water", daysAgo: 47, then: ["reply", "appeal"] },
]

// A demo applicant wallet (public address only; nobody holds this key in the app).
const DEMO_APPLICANT = "0x00000000000000000000000000000000a11ce000" as Hex

const created: { ref: string; key: string; tx: string }[] = []
for (const r of rows) {
  const f = await fileRequest(pub, desk, {
    state: r.state, dept: r.dept, basis: r.basis, category: r.category,
    filedAt: Date.now() - r.daysAgo * DAY - Math.floor(Math.random() * 6) * 3_600_000,
    summary: SUMMARIES[r.category][Math.floor(Math.random() * SUMMARIES[r.category].length)],
  })
  created.push({ ref: f.ref, key: f.requestKey, tx: f.txHash })
  log("filed", f.ref, f.requestKey, f.txHash)
  for (const step of r.then ?? []) {
    const k = f.requestKey
    const out =
      step === "reply" ? await markReplied(pub, desk, k)
      : step === "appeal" ? await fileFirstAppeal(pub, desk, k)
      : step === "escalate" ? await escalateSecondAppeal(pub, desk, k, legal.account.address)
      : step === "hearing" ? await recordHearing(pub, legal, k)
      : await handOver(pub, desk, k, DEMO_APPLICANT)
    log("  ", step, out.txHash, "extended:", out.extended)
  }
}

// Permissionless Lifetime Extension by a wallet that does NOT own the request (legal-aid keeps a BR case alive).
const kept = await keepAlive(pub, legal, created[0].key as Hex)
log("keep-alive by non-owner (legal-aid) on", created[0].ref, kept.txHash, kept.previousExpiry, "→", kept.newExpiry)

// The spoof: identical-looking attributes, but $creator is not a trusted desk.
const due = dueAt(Date.now() - 40 * DAY, "standard")
const sp = await spoof.createEntity({
  payload: jsonToPayload({ summary: "Status of pending ration card applications in the ward", language: "en" }),
  contentType: "application/json",
  attributes: {
    project: str(PROJECT), schema: str(SCHEMA), type: str("request"), demo: bool(true),
    ref: str(newRef("BR")), state: str("BR"), authority: str(authorityId("BR", "food")), level: str("state"),
    basis: str("standard"), category: str("ration"), stage: str("replied"),
    filed_at: u64(Date.now() - 40 * DAY), due_at: u64(due), replied_at: u64(Date.now() - 15 * DAY), appeal_by: u64(due + 30 * DAY),
  },
  expires: ExpirationTime.fromDays(30),
})
log("SPOOF by", spoof.account.address, sp.entityKey, sp.txHash)

console.log(JSON.stringify({ created, spoof: { key: sp.entityKey, tx: sp.txHash } }, null, 1))
process.exit(0)
