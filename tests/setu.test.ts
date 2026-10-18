import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"
import type { Entity } from "@arkiv-network/sdk"
import type { Hex } from "viem"

process.env.SKIP_INGEST = "1"
const { classify, markupBp, ROLES, PROJECT, SCHEMA } = await import("../src/shared/setu")
const { isSetu } = await import("../src/shared/setuOps")
const { offersQuery, pub, verify } = await import("../server/setu")
const { handle, redact } = await import("../server/handler")

const K = (c: string) => `0x${c.repeat(64)}` as Hex
const ent = (creator: string, attrs: Record<string, unknown>, extra: Partial<Entity> = {}) => ({
  key: extra.key ?? K("a"), creator, owner: creator, expiresAt: 10n, creationFlags: { readonly: false, permissionlessExtension: false },
  attributes: Object.fromEntries(Object.entries({ project: PROJECT, schema: SCHEMA, demo: true, ...attrs }).map(([k, v]) => [k, { value: v }])), ...extra,
}) as unknown as Entity

function replace(target: object, name: string, value: unknown) {
  const d = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, { configurable: true, writable: true, value })
  return () => { if (d) Object.defineProperty(target, name, d); else Reflect.deleteProperty(target, name) }
}
async function call(method: string, url: string, body?: string) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as import("node:http").IncomingMessage
  Object.assign(req, { method, url, headers: { "x-forwarded-for": `t-${Math.random()}` }, socket: { remoteAddress: "127.0.0.1" } })
  const res = { statusCode: 0, body: "", setHeader() {}, end(v?: unknown) { this.body = String(v ?? "") } }
  await handle(req, res as unknown as import("node:http").ServerResponse)
  return res
}

test("DoCA commodity names map to stable slugs and categories", () => {
  assert.deepEqual(classify("Tur/Arhar Dal"), { slug: "tur-dal", category: "pulses" })
  assert.deepEqual(classify("Turmeric (powder)"), { slug: "turmeric", category: "spices" })
  assert.deepEqual(classify("Gram Dal(Bharat Dal Adjusted)"), { slug: "gram-dal-bharat", category: "pulses" })
  assert.deepEqual(classify("Mustard Oil (Packed)"), { slug: "mustard-oil", category: "edible-oils" })
  assert.deepEqual(classify("Milk (₹/ltr)"), { slug: "milk", category: "dairy" })
  assert.deepEqual(classify("Salt Pack (Iodised)"), { slug: "salt", category: "sugar-salt" })
})

test("markup against the official price is computed in basis points", () => {
  assert.equal(markupBp(17_831, 13_111), 3600)
  assert.equal(markupBp(13_111, 13_111), 0)
  assert.equal(markupBp(9_178, 13_111), -3000)
  assert.equal(markupBp(5000, 0), 0)
})

test("overpriced marketplace filter is a numeric range on markup_bp", () => {
  assert.match(offersQuery({ price: "overpriced" }).toString(), /markup_bp > i32\(2000\)/)
  assert.match(offersQuery({ price: "fair", category: "pulses" }).toString(), /category = str\('pulses'\).*markup_bp <= i32\(2000\)/)
})

test("isSetu rejects entities from other projects", () => {
  assert.equal(isSetu(ent(ROLES.maker_food.address, { type: "lot" }), "lot"), true)
  assert.equal(isSetu(ent(ROLES.maker_food.address, { type: "lot", project: "other" }), "lot"), false)
})

test("a lot copied by an unlicensed wallet is counterfeit; the maker's lot is genuine", async () => {
  const product = ent(ROLES.maker_food.address, { type: "product", brand: "Annapurna" }, { key: K("p") })
  const genuineRoot = ent(ROLES.maker_food.address, { type: "lot" }, { key: K("r") })
  const fakeRoot = ent(ROLES.counterfeiter.address, { type: "lot" }, { key: K("f") })
  const byKey: Record<string, Entity> = { [K("p")]: product, [K("r")]: genuineRoot, [K("f")]: fakeRoot }
  const restore = replace(pub, "getEntity", async (k: string) => { if (!byKey[k]) throw new Error("NoEntityFound"); return byKey[k] })
  const reg = new Map([[ROLES.maker_food.address.toLowerCase(), { key: "", wallet: ROLES.maker_food.address, role: "maker", name: ROLES.maker_food.name, licence: "", state: "", expiresAt: "1" }]])
  const base = { product: K("p"), sku: "ANN-TUR1", brand: "Annapurna", category: "pulses", commodity: "tur-dal", batch: "B", qty: 1, unit: "1 Kg", mfgAt: 0, bestBefore: 0, originState: "MP", expiresAt: "1" }
  try {
    const good = await verify({ ...base, key: K("r"), root: K("r"), owner: ROLES.maker_food.address, creator: ROLES.maker_food.address }, reg)
    assert.equal(good.genuine, true)
    const fake = await verify({ ...base, key: K("f"), root: K("f"), owner: ROLES.counterfeiter.address, creator: ROLES.counterfeiter.address }, reg)
    assert.equal(fake.genuine, false)
    assert.ok(fake.reasons.some((r) => /no live licence/.test(r)))
  } finally { restore() }
})

test("roles cannot perform actions outside their permissions", async () => {
  const r = await call("POST", "/api/act/counterfeiter/make", "{}")
  assert.equal(r.statusCode, 400)
  const r2 = await call("POST", "/api/act/retailer/recall", "{}")
  assert.equal(r2.statusCode, 400)
})

test("bodies must be small JSON objects", async () => {
  const id = Object.keys(ROLES).find((k) => k === "retailer")!
  if (!process.env.RETAILER_KEY) process.env.RETAILER_KEY = `0x${"1".repeat(64)}`
  const arr = await call("POST", `/api/act/${id}/buy`, "[]")
  assert.ok([400, 503].includes(arr.statusCode))
  const big = await call("POST", `/api/act/${id}/buy`, `{"x":"${"y".repeat(5000)}"}`)
  assert.ok([400, 503].includes(big.statusCode))
})

test("secrets and access-key patterns are redacted", () => {
  process.env.ORACLE_KEY = "artificial-oracle-secret-value"
  assert.doesNotMatch(redact("fail artificial-oracle-secret-value at ark_live_abc-123"), /artificial|ark_live_/)
})
