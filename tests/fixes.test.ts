import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { Readable } from "node:stream"
import test from "node:test"
import type { Entity, PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk"
import { isAddress, type Hex } from "viem"

for (const [name, value] of [["DESK_KEY", "1"], ["LEGAL_AID_KEY", "2"], ["SPOOFER_KEY", "3"]] as const) {
  if (!process.env[name]?.trim()) process.env[name] = `0x${value.repeat(64)}`
}

const { BURN, PROJECT, SCHEMA } = await import("../src/shared/rti")
const { keepAlive, markReplied, recordHearing } = await import("../src/shared/ops")
const { collectPages } = await import("../src/shared/pages")
const { DESK, listQuery, listRequests, pub } = await import("../server/arkiv")
const { handle, redact } = await import("../server/handler")

const TEST_KEY = `0x${"a".repeat(64)}` as Hex
const TEST_TX = `0x${"b".repeat(64)}` as Hex
const DEMO_APPLICANT = "0x00000000000000000000000000000000a11ce000"
let ipId = 0

function demoRequest(overrides: {
  owner?: string
  expiresAt?: bigint
  stage?: string
  project?: string
  schema?: string
  type?: string
  demo?: unknown
  dueAt?: number
} = {}) {
  return {
    key: TEST_KEY,
    owner: overrides.owner ?? DESK,
    creator: DESK,
    expiresAt: overrides.expiresAt ?? 100_000n,
    creationFlags: { permissionlessExtension: true },
    attributes: {
      project: { value: overrides.project ?? PROJECT },
      schema: { value: overrides.schema ?? SCHEMA },
      type: { value: overrides.type ?? "request" },
      demo: { value: overrides.demo ?? true },
      stage: { value: overrides.stage ?? "awaiting_reply" },
      ref: { value: "JD-TEST" },
      authority: { value: "br-food" },
      state: { value: "BR" },
      due_at: { value: overrides.dueAt ?? Date.now() + 30 * 86_400_000 },
    },
  } as unknown as Entity
}

function mockClients(entity: Entity, currentBlock = 10_000n, blockDuration = 12) {
  const batches: unknown[] = []
  let timingCalls = 0
  const pubMock = {
    getEntity: async () => entity,
    getBlockTiming: async () => {
      timingCalls++
      return { currentBlock, currentBlockTime: Date.now() / 1000, blockDuration }
    },
    predictEntityKeys: async () => [{ key: `0x${"c".repeat(64)}` as Hex, salt: 1n }],
  } as unknown as PublicArkivClient
  const walletMock = {
    account: { address: DESK },
    executeBatch: async (batch: unknown) => {
      batches.push(batch)
      return { txHash: TEST_TX }
    },
    extendEntity: async () => ({ txHash: TEST_TX, expiresAt: entity.expiresAt }),
  } as unknown as WalletArkivClient
  return { pubMock, walletMock, batches, timingCalls: () => timingCalls }
}

function replaceMethod(target: object, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, { configurable: true, writable: true, value })
  return () => {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
}

function makeRequest(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as import("node:http").IncomingMessage
  Object.assign(req, {
    method,
    url,
    headers: { ...headers, "x-forwarded-for": `test-${++ipId}` },
    socket: { remoteAddress: "127.0.0.1" },
  })
  return req
}

async function callHandle(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const response = {
    statusCode: 0,
    headersSent: false,
    body: "",
    setHeader() {},
    end(value?: unknown) {
      this.body = String(value ?? "")
      this.headersSent = true
    },
  }
  await handle(makeRequest(method, url, body, headers), response as unknown as import("node:http").ServerResponse)
  return response
}

test("each hearing renews from the existing expiry by 90 days", async () => {
  const blockDuration = 12
  const currentBlock = 10_000n
  const initialExpiry = currentBlock + BigInt(135 * 86_400 / blockDuration)
  const entity = demoRequest({ stage: "second_appeal", expiresAt: initialExpiry })
  const { pubMock, walletMock, batches } = mockClients(entity, currentBlock, blockDuration)

  const result = await recordHearing(pubMock, walletMock, TEST_KEY)

  assert.equal(result.previousExpiry, initialExpiry)
  assert.equal(result.newExpiry, initialExpiry + BigInt(90 * 86_400 / blockDuration))
  assert.equal(result.extended, true)
  assert.equal(batches.length, 1)
})

test("an early reply reports the preserved expiry rather than an unapplied target", async () => {
  const blockDuration = 12
  const currentBlock = 10_000n
  const initialExpiry = currentBlock + BigInt(135 * 86_400 / blockDuration)
  const entity = demoRequest({ expiresAt: initialExpiry })
  const { pubMock, walletMock, batches } = mockClients(entity, currentBlock, blockDuration)

  const result = await markReplied(pubMock, walletMock, TEST_KEY)

  assert.equal(result.extended, false)
  assert.equal(result.newExpiry, result.previousExpiry)
  assert.equal(result.newExpiry, initialExpiry)
  assert.equal((batches[0] as { extensions: unknown[] }).extensions.length, 0)
})

test("shared transition and keep-alive helpers reject entities outside Jawab Do demo provenance", async () => {
  const entity = demoRequest({ stage: "second_appeal", project: "other-project" })
  const { pubMock, walletMock, batches, timingCalls } = mockClients(entity)

  await assert.rejects(recordHearing(pubMock, walletMock, TEST_KEY), /Jawab Do demo requests/)
  await assert.rejects(keepAlive(pubMock, walletMock, TEST_KEY), /Jawab Do demo requests/)
  assert.equal(batches.length, 0)
  assert.equal(timingCalls(), 0)
})

test("list query uses a stable asOf across wall-clock changes and cursors", () => {
  const originalNow = Date.now
  try {
    Date.now = () => 100_000
    const first = listQuery({ due: "week", scope: "trusted", cursor: "next-page", asOf: 200_000 }).toString()
    Date.now = () => 900_000
    const second = listQuery({ due: "week", scope: "trusted", cursor: "next-page", asOf: 200_000 }).toString()
    assert.equal(first, second)
    assert.match(first, /200000/)
  } finally {
    Date.now = originalNow
  }
})

test("listRequests captures and returns one asOf value", async () => {
  const builder = {
    where() { return this },
    limit() { return this },
    createdBy() { return this },
    cursor() { return this },
    toString() { return "mock-list-query" },
    async fetch() { return { entities: [], cursor: null, blockNumber: 734_308n } },
  }
  const restoreSelect = replaceMethod(pub, "select", () => builder)
  const restoreTiming = replaceMethod(pub, "getBlockTiming", async () => ({
    currentBlock: 1n,
    currentBlockTime: 1,
    blockDuration: 12,
  }))
  const originalNow = Date.now
  let calls = 0
  Date.now = () => 200_000 + ++calls
  try {
    const result = await listRequests({ due: "overdue" })
    assert.equal(result.asOf, 200_001)
    assert.equal(calls, 1)
    assert.equal(result.query, "mock-list-query")
  } finally {
    Date.now = originalNow
    restoreTiming()
    restoreSelect()
  }
})

test("page collection includes all 201 entities and authority groups", async () => {
  const second = {
    entities: [{ authority: "mh-municipal" }],
    blockNumber: 734_308n,
    hasNextPage: () => false,
    async next() { throw new Error("unexpected next page") },
  }
  const first = {
    entities: Array.from({ length: 200 }, () => ({ authority: "br-food" })),
    blockNumber: 734_308n,
    hasNextPage: () => true,
    async next() { return second },
  }

  const result = await collectPages(first)
  const byAuthority = new Map<string, number>()
  for (const entity of result.entities) byAuthority.set(entity.authority, (byAuthority.get(entity.authority) ?? 0) + 1)
  assert.equal(result.entities.length, 201)
  assert.equal(result.blockNumber, 734_308n)
  assert.deepEqual([...byAuthority], [["br-food", 200], ["mh-municipal", 1]])
})

test("detail requests reject entities outside demo provenance", async () => {
  const restore = replaceMethod(pub, "getEntity", async () => demoRequest({ project: "another-app" }))
  try {
    const response = await callHandle("GET", `/api/request/${TEST_KEY}`)
    assert.equal(response.statusCode, 404)
    assert.equal(JSON.parse(response.body).error, "Request not found")
  } finally {
    restore()
  }
})

test("actions revalidate owner inside the serialized relay operation", async () => {
  const request = demoRequest({ owner: DESK })
  let reads = 0
  const restore = replaceMethod(pub, "getEntity", async () => {
    reads++
    return reads === 1 ? request : { ...request, owner: BURN }
  })
  try {
    const response = await callHandle("POST", `/api/request/${TEST_KEY}/reply`, "{}")
    assert.equal(response.statusCode, 409)
    assert.match(JSON.parse(response.body).error, /owner changed/)
    assert.equal(reads, 2)
  } finally {
    restore()
  }
})

test("body parsing accepts only JSON objects and enforces the streaming limit", async () => {
  const arrayResponse = await callHandle("POST", "/api/requests", "[]")
  assert.equal(arrayResponse.statusCode, 400)
  assert.equal(JSON.parse(arrayResponse.body).error, "Body must be a JSON object")

  const oversized = `{"padding":"${"x".repeat(5_000)}"}`
  const oversizedResponse = await callHandle("POST", "/api/requests", oversized)
  assert.equal(oversizedResponse.statusCode, 400)
  assert.equal(JSON.parse(oversizedResponse.body).error, "Body too large")
})

test("filing enums reject inherited object keys", async () => {
  const response = await callHandle("POST", "/api/requests", JSON.stringify({
    state: "BR",
    dept: "toString",
    basis: "standard",
    category: "ration",
  }))
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error, "Unknown state, department, basis or category")
})

test("due cursor requests require a valid asOf", async () => {
  const missing = await callHandle("GET", "/api/requests?cursor=next&due=week")
  assert.equal(missing.statusCode, 400)
  const invalid = await callHandle("GET", "/api/requests?cursor=next&due=week&asOf=9007199254740992")
  assert.equal(invalid.statusCode, 400)
})

test("server redacts header secrets and access-key patterns from logs and responses", async () => {
  const secret = "artificial-access-secret"
  const originalAccessKey = process.env.ARKIV_ACCESS_KEY
  const originalConsoleError = console.error
  const logged: string[] = []
  process.env.ARKIV_ACCESS_KEY = secret
  console.error = (...values: unknown[]) => logged.push(values.map(String).join(" "))
  const restore = replaceMethod(pub, "getEntity", async () => {
    throw new Error(`RPC failed for ${secret}/ark_live_fake-token_123`)
  })
  try {
    const response = await callHandle("GET", `/api/request/${TEST_KEY}`, undefined, { authorization: secret })
    assert.equal(response.statusCode, 400)
    assert.doesNotMatch(response.body, /artificial-access-secret|ark_live_/)
    assert.doesNotMatch(logged.join(" "), /artificial-access-secret|ark_live_/)
    assert.match(response.body, /\[REDACTED\]/)
    assert.match(logged.join(" "), /\[REDACTED\]/)
  } finally {
    restore()
    console.error = originalConsoleError
    if (originalAccessKey === undefined) delete process.env.ARKIV_ACCESS_KEY
    else process.env.ARKIV_ACCESS_KEY = originalAccessKey
  }
})

test("the lowercase demo applicant address is valid", () => {
  assert.equal(isAddress(DEMO_APPLICANT), true)
})

test("malformed static paths return 400 and do not stop the server", async () => {
  const child: ChildProcess = spawn(process.execPath, [
    "--import", "tsx", "--env-file-if-exists=.env", "server/main.ts",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr!.on("data", (chunk: Buffer) => { stderr += redact(chunk.toString()) })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(redact(`server start timeout: ${stdout} ${stderr}`))), 15_000)
      child.stdout!.on("data", (chunk: Buffer) => {
        const match = `${stdout}${chunk.toString()}`.match(/Jawab Do on :(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(new Error(redact(error.message)))
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(redact(`server exited ${code}: ${stdout} ${stderr}`)))
      })
    })

    const malformed = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`)
    assert.equal(malformed.status, 400)
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(health.status, 200)
    assert.equal(child.exitCode, null)
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await once(child, "exit")
    }
  }
})
