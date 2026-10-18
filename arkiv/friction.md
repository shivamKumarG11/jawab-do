# Friction report: building Jawab Do on Arkiv

Written while building, 18 Oct 2026. Every entry was reproduced by us; nothing here is second-hand. Entries we only heard about on Discord are not listed unless we hit them ourselves.

**Environment:** Windows 11 · Node 22.20.0 · `@arkiv-network/sdk` 0.8.1 · `viem` 2.57.3 · `tsx` 4.23.15 · Tiramisu (chain 7738577), public RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`, WebSocket `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`.

Severity: **High** = blocked us or would mislead a builder into a bug · **Medium** = cost time · **Low** = papercut. **Smooth** = a path we tested that worked as documented.

---

## F1 · `watchEntityEvents` has no filter, so every client receives the whole chain's events · Medium

- **Surface:** TypeScript SDK `watchEntityEvents`, WebSocket RPC.
- **Expected:** a way to subscribe only to our project's entities (by `owner`/`creator`, or by an attribute such as `project`), like the `select()` filters.
- **Actual:** the watcher takes no filter. In 30 s on 18 Oct 2026 (~14:20 IST) our anonymous WebSocket watcher received **31 events** from other projects. `EntityCreated`/`EntityPatched` events carry `entityKey` and `owner` but **no attributes**, so filtering by `project` needs one extra `getEntity()` per event, which also spends read budget.
- **Repro:** `npx tsx scripts/probe-read.ts` in this repo (watches for 30 s, prints the count).
- **Workaround we use:** filter on `event.owner` against our trusted desk wallets in the browser, then refetch through our API.
- **Suggested fix:** accept `owner`/`creator` (indexed as log topics) and ideally an attribute predicate in `watchEntityEvents`, or include attributes in `EntityCreated`.

## F2 · Installation page contradicts "always wrap values in a constructor" · Low

- **Surface:** Docs: *Start Here → Installation* vs *TypeScript SDK → Mutating data*.
- **Expected:** the first example a new builder copies follows the rule the docs call "highly recommended".
- **Actual:** the Hello World on the Installation page writes `attributes: { type: 'greeting' }` (bare value). *Mutating data → Always wrap values in a constructor* says to build every value with `str()`, `u64()` etc., because a type mismatch in a query "is not an error: the query runs and returns nothing".
- **Repro:** compare <https://docs.arkiv.network/start-here/installation/> (step "Write your first entity") with the "Always wrap values in a constructor" section of <https://docs.arkiv.network/typescript-sdk/mutating-data/>.
- **Suggested fix:** use `attributes: { type: str('greeting') }` in Hello World, importing `str` from `@arkiv-network/sdk/attr`.

## S1 · Smooth: anonymous read and anonymous WebSocket subscription work out of the box

- **Tested:** `getBlockNumber()`, `select().where(eq("project", str("jawab-do"))).limit(5).fetch()` and `watchEntityEvents` over `webSocket()` with no access key, using the `tiramisu` chain object's default URLs.
- **Expected / actual:** all three succeeded. The query returned in about 0.3 s, and the first WebSocket event arrived about 1 s after subscribing.
- **Repro:** `npx tsx scripts/probe-read.ts`.
