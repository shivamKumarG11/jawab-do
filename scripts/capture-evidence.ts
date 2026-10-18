import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createPublicClient } from "@arkiv-network/sdk"
import { str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { ENTITY_EVENTS_ABI } from "@arkiv-network/sdk/entity"
import { eq, lt } from "@arkiv-network/sdk/query"
import { decodeEventLog, http, parseAbiItem, type Hex } from "viem"

const DESK = "0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2" as const
const LEGAL = "0xb114Ab157311e6C15B74fb08789632671d45D9c2" as const
const BURN = "0x000000000000000000000000000000000000dEaD"
const REGISTRY = "0x4400000000000000000000000000000000000044" as const
const A = "0x0e3d5aca9e4960bcbe9dedffc0a4f8337184323d3c169a69c5db598d79b6aab9" as const
const B = "0x60ab8b4243c393d43245dda52e6986431fd99d3d69ef60f06c8af9c84059edc3" as const
const FIRST = "0x9b2753f771317c12d6052d191e0541455a7e9bd482baecae737cbd2fa48a875d" as const
const LAST = "0x210fca57ba476f922ec30064e26d51ff4c4b26c040d678d738ae1538ad5f3ab9" as const
const manifest = JSON.parse(readFileSync("../toolchain/evidence/seed-manifest.json", "utf8").replace(/^\uFEFF/, "")) as {
  created: { ref: string; key: Hex; tx: Hex }[]
  spoof: { key: Hex; tx: Hex }
}
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()
const pub = createPublicClient({
  chain: tiramisu,
  transport: http(undefined, accessKey ? { fetchOptions: { headers: { "X-API-KEY": accessKey } } } : {}),
})
const serialize = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n"

async function recoverReceipts() {
  const path = "../toolchain/evidence/recovered-browser-receipts.json"
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"))
  const first = await pub.getTransactionReceipt({ hash: FIRST })
  const last = await pub.getTransactionReceipt({ hash: LAST })
  assert.equal(first.status, "success")
  assert.equal(last.status, "success")
  const candidates = new Set<Hex>()
  for (const entityKey of [A, B]) {
    const filters = { address: REGISTRY, args: { entityKey }, fromBlock: first.blockNumber, toBlock: last.blockNumber, strict: true } as const
    const patches = await pub.getLogs({ ...filters, event: parseAbiItem("event EntityPatched(bytes32 indexed entityKey, address indexed owner)") })
    const transfers = await pub.getLogs({ ...filters, event: parseAbiItem("event OwnershipTransferred(bytes32 indexed entityKey, address indexed previousOwner, address indexed newOwner)") })
    const extensions = await pub.getLogs({ ...filters, event: parseAbiItem("event ExpiryExtended(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt)") })
    for (const log of [...patches, ...transfers, ...extensions]) candidates.add(log.transactionHash)
  }
  const wanted = new Map<string, string>([
    [`${A}:replied`, "A relay reply"],
    [`${A}:handed_over`, "A relay handover"],
    [`${B}:first_appeal`, "B relay first appeal"],
    [`${B}:second_appeal`, "B relay second appeal"],
    [`${B}:hearing`, "B relay hearing"],
  ])
  const recovered: { label: string; tx: Hex; block: bigint; eventKey: Hex; requestKey: Hex; kind: string; status: string }[] = []
  for (const hash of candidates) {
    const receipt = await pub.getTransactionReceipt({ hash })
    assert.equal(receipt.status, "success")
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== REGISTRY.toLowerCase()) continue
      const decoded = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics })
      if (decoded.eventName !== "EntityCreated") continue
      const event = await pub.getEntity(decoded.args.entityKey)
      const requestKey = event.attributes.request?.value as Hex
      const kind = String(event.attributes.kind?.value)
      const label = wanted.get(`${requestKey}:${kind}`)
      if (!label) continue
      assert.equal(event.owner.toLowerCase(), BURN.toLowerCase())
      assert.equal(event.creationFlags.readonly, true)
      assert.ok([DESK.toLowerCase(), LEGAL.toLowerCase()].includes(event.creator.toLowerCase()))
      recovered.push({ label, tx: hash, block: receipt.blockNumber, eventKey: event.key, requestKey, kind, status: receipt.status })
    }
  }
  assert.equal(recovered.length, wanted.size)
  assert.equal(new Set(recovered.map((item) => item.label)).size, wanted.size)
  const capture = { fromBlock: first.blockNumber, toBlock: last.blockNumber, recovered }
  writeFileSync(path, serialize(capture))
  return capture
}

async function main() {
  const { recovered } = await recoverReceipts()
  const now = Date.now()
  const block = await pub.getBlockNumber()
  const allQ = pub.select({ key: true, owner: true, creator: true, expiresAt: true, creationFlags: true, attributes: true })
    .where(eq("project", str("jawab-do")), eq("type", str("request")))
    .atBlock(block).limit(200)
  const overdueQ = pub.select({ key: true, attributes: { authority: true, ref: true, due_at: true } })
    .where(eq("project", str("jawab-do")), eq("type", str("request")), eq("stage", str("awaiting_reply")), lt("due_at", u64(now)))
    .createdBy(DESK).atBlock(block).limit(200)
  const eventsQ = pub.select({ key: true, owner: true, creator: true, expiresAt: true, creationFlags: true, attributes: true })
    .where(eq("project", str("jawab-do")), eq("type", str("event"))).atBlock(block).limit(200)
  const requests: { key: Hex; owner: Hex; creator: Hex; expiresAt: bigint; creationFlags: { readonly: boolean; permissionlessExtension: boolean }; attributes: Record<string, { value: unknown } | undefined> }[] = []
  for await (const request of allQ) requests.push(request as (typeof requests)[number])
  const overdue: { attributes: Record<string, { value: unknown } | undefined> }[] = []
  for await (const request of overdueQ) overdue.push(request as (typeof overdue)[number])
  const seedKeys = new Set(manifest.created.map((item) => item.key))
  const seedEvents = []
  for await (const event of eventsQ) {
    if (!seedKeys.has(event.attributes.request?.value as Hex)) continue
    assert.equal(event.owner.toLowerCase(), BURN.toLowerCase())
    assert.equal(event.creationFlags.readonly, true)
    assert.equal(event.creationFlags.permissionlessExtension, true)
    seedEvents.push(event)
  }
  const timing = await pub.getBlockTiming()
  const creationReceipts = []
  for (const row of [...manifest.created, manifest.spoof]) {
    const receipt = await pub.getTransactionReceipt({ hash: row.tx })
    assert.equal(receipt.status, "success")
    const request = requests.find((item) => item.key === row.key)
    assert.ok(request, `missing seed request ${row.key}`)
    const estimatedExpiry = (timing.currentBlockTime + Number(request.expiresAt - timing.currentBlock) * timing.blockDuration) * 1000
    assert.ok(estimatedExpiry > Date.parse("2026-10-24T00:00:00Z"), `seed request expires before judging finishes: ${row.key}`)
    creationReceipts.push({ key: row.key, tx: row.tx, block: receipt.blockNumber, status: receipt.status, estimatedExpiryUtc: new Date(estimatedExpiry).toISOString() })
  }
  const trusted = requests.filter((request) => request.creator.toLowerCase() === DESK.toLowerCase())
  const rows = new Map<string, { authority: string; total: number; overdue: number; awaiting: number; replied: number; appeals: number }>()
  const row = (authority: string) => rows.get(authority) ?? rows.set(authority, { authority, total: 0, overdue: 0, awaiting: 0, replied: 0, appeals: 0 }).get(authority)!
  for (const request of trusted) {
    const r = row(String(request.attributes.authority?.value))
    const stage = request.attributes.stage?.value
    r.total++
    if (stage === "awaiting_reply") r.awaiting++
    if (stage === "replied") r.replied++
    if (stage === "first_appeal" || stage === "second_appeal") r.appeals++
  }
  for (const request of overdue) row(String(request.attributes.authority?.value)).overdue++
  const scorecardRows = [...rows.values()].sort((a, b) => a.authority.localeCompare(b.authority))
  const snapshot = {
    capturedAtUtc: new Date(now).toISOString(), block, network: "Tiramisu", chainId: tiramisu.id,
    queries: { all: allQ.toString(), overdue: overdueQ.toString(), events: eventsQ.toString() },
    queryAtBlock: block, manifest, creationReceipts, requests, seedEvents, scorecardRows,
    trustedRequests: trusted.length, untrustedRequests: requests.length - trusted.length,
    overdueRequests: overdue.length, comparedWithLocalScorecard: false,
    browserReceipts: recovered,
    automaticExpirationProof: { entityKey: "0x7e2ac30e3a84399034d6387999faad56d4c84fb65a08b724f7ff37b238187c71", tx: "0x235e8055162d37e13337a65ca4f6163693c0b679ee53043334b92b53f98324d1", expiresAtBlock: "735200", evidence: "creation receipt, initially readable, then NoEntityFoundError after expiry; no delete issued" },
  }
  writeFileSync("../toolchain/evidence/onchain-snapshot.json", serialize(snapshot))
  const response = await fetch("http://127.0.0.1:8080/api/scorecard")
  assert.equal(response.status, 200)
  const scorecard = await response.json()
  assert.deepEqual(scorecard.rows.sort((a: { authority: string }, b: { authority: string }) => a.authority.localeCompare(b.authority)), scorecardRows)
  snapshot.comparedWithLocalScorecard = true
  writeFileSync("../toolchain/evidence/onchain-snapshot.json", serialize(snapshot))
  writeFileSync("arkiv/demo-evidence.json", serialize(snapshot))
  console.log(serialize({ block, trustedRequests: trusted.length, untrustedRequests: requests.length - trusted.length, overdue: overdue.length, seedCreationReceipts: creationReceipts.length, recoveredBrowserReceipts: recovered, comparedWithLocalScorecard: true }))
}

main().catch((error) => {
  let message = String(error instanceof Error ? error.message : error)
  for (const name of ["ARKIV_ACCESS_KEY", "DESK_KEY", "LEGAL_AID_KEY", "SPOOFER_KEY"]) {
    const value = process.env[name]?.trim()
    if (value) message = message.replaceAll(value, "[REDACTED]")
  }
  console.error(message.replace(/ark_live_[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/0x[0-9a-f]{128,}/gi, "[REDACTED_RAW_HEX]"))
  process.exitCode = 1
})
