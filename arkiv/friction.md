# Friction and smooth paths: building Supply Setu on Arkiv

Windows 11 · Node 22.20.0 · npm 10.9.3 · `@arkiv-network/sdk` 0.8.1 · viem 2.57.3 · tsx 4.23.15 · Tiramisu (chain 7738577), public RPC + Hub access key. Every item below was hit or tested by us on 18–19 Oct 2026; human-observed Hub UI is marked as such.

## F1 · `watchEntityEvents` has no server-side filter · Medium
- **Surface:** TypeScript SDK `watchEntityEvents`, WebSocket RPC.
- **Expected:** subscribe only to our project (by `$creator`/`$owner` or an attribute such as `project`), like `select()` filters.
- **Actual:** no filter parameter. An anonymous 30 s watch received 31 events from other projects. `EntityCreated`/`EntityPatched` logs carry `entityKey` and `owner` only (no attributes), so filtering by project needs an extra `getEntity()` per foreign event.
- **Repro:** `npx tsx scripts/probe-read.ts`. Our workaround: `startFeed()` in `src/web/main.ts` filters `owner`/`previousOwner`/`newOwner` against the 7 role wallets.
- **Suggested fix:** accept `owner`/`creator` (already indexed log topics) in `watchEntityEvents`, and ideally an attribute predicate.

## F2 · Live Events docs don't show the WebSocket push path · Medium
- **Surface:** <https://docs.arkiv.network/typescript-sdk/live-events/> vs SDK.
- **Expected:** docs show `webSocket()` as the real-time transport and warn about `fromBlock`.
- **Actual:** the page says it "polls the chain" and every example uses `http()`. In the browser we observed a real `eth_subscribe` frame followed by `eth_subscription` frames with `webSocket()` and no `fromBlock`. Passing `fromBlock` switches viem to `eth_newFilter` / `eth_blockNumber` / `eth_getLogs` polling even on a WebSocket client.
- **Repro:** instrument the transport in `watchEntityEvents` with and without `fromBlock` (see `scripts/probe-write.ts` step 10).
- **Suggested fix:** document `webSocket()` + no `fromBlock` as the push mode; add a callout that `fromBlock` forces polling.

## F3 · `ne()` / `exists()` compile but fail only at runtime · Low
- **Surface:** `@arkiv-network/sdk/query` exports vs Tiramisu query engine.
- **Expected:** unsupported predicates are marked in the types (e.g. `@deprecated`) or not exported.
- **Actual:** `select().where(ne("project", str("x"))).fetch()` and `exists("project")` throw `QueryError kind "type" code -32002: Requested resource not available` at runtime. (Docs also list `hasType()` as unsupported; we did not execute it.)
- **Repro:** run either predicate against the public RPC.
- **Suggested fix:** JSDoc warning on the exports and a clearer node message ("operator != not supported; use NOT (a = b)").

## F4 · No built-in "latest by attribute" for daily feeds · Low
- **Surface:** query language (no `orderBy`, documented).
- **Expected:** a cheap way to get the newest `price` per `commodity`.
- **Actual:** we fetch all live oracle prices and pick max `as_of` per commodity in JS. Entity Expiration (48 h) keeps this bounded, which is exactly why we chose it, but an `orderBy`/`distinct` would remove client work.
- **Repro:** `latestPrices()` in `server/setu.ts`.
- **Suggested fix:** server-side `orderBy` on a numeric attribute + limit, or "first per group".

## F5 · Faucet cooldown applies across recipients from one session (human-observed) · Low
- **Surface:** Arkiv Hub faucet UI.
- **Observed:** after claiming 10 GLM for one wallet, the UI showed "Next claim in 60m — Cooldown: 1 hour per wallet" when the next recipient address was entered.
- **Workaround that worked:** plain GLM transfers from the funded wallet. Six role wallets were funded with 0.6 GLM each (e.g. tx `0xac2d347fb755839fd04602adb13af7935fab665dfc349a1c660e128ffdf255f0`), despite the fundamentals page saying transactions to non-Arkiv addresses revert.
- **Suggested fix:** clarify in docs that native GLM transfers work, and say whether the faucet cooldown is per recipient or per connected wallet.

## Smooth paths (tested, worked as documented)

- **Custody as `$owner` inside one batch.** `fillOffer` in one `executeBatch`: create child lot + patch parent `qty` + create burn-bound `move` + **delete the offer** + two `ownershipChanges` (move → burn, child → buyer). Atomic, one tx. Example sale: maker → distributor 800 units, tx `0x3afc319a74a5a17de7400714bf3bdb735eb52f508c93e3083918d584b35297d5`.
- **`predictEntityKeys({ count: 2N })`** for splits: child lots and their moves referenced each other by predicted key in the same batch; keys always matched.
- **Entity Expiration as shelf life.** Root lots use `ExpirationTime.atBlock(blockAt(best_before))`; split children reuse the parent's exact `expiresAt` block, so a split can never outlive its batch. A 12-second probe entity was readable, then `getEntity` raised `NoEntityFoundError` once the chain passed its expiry block, with no delete.
- **`$creator` as the counterfeit signal.** The counterfeiter copied the genuine product key, brand and batch number (`ANN-TUR1-B2611`); `$creator` alone separates it. Counterfeit lot tx `0xd8a640e3272d87167075a66f97df4a3047a67a56431c045b08377d456a39e2d6`.
- **Numeric range on `i32`.** `markup_bp > i32(2000)` returns exactly the one +36% offer; same query works from the browser against the public RPC.
- **Burn-owned readonly moves.** Earlier probe: owner (desk) patch/delete of a burn-owned readonly entity was rejected; any wallet could still extend it. Equal-expiry extension was a no-op, earlier-expiry rejected.
- **Real govt data.** 42 DoCA prices posted in 3 batches of ≤20 creates (e.g. tx `0x28fccec1fd6d68f5908acf7e7a75b66df54815f6d7541c71b90767fa403ed071`).

## Our own bug (not Arkiv), kept for honesty
DoCA's "Turmeric (powder)" matched our `^tur` rule for Tur dal, so tur dal briefly showed ₹16.36/kg. Fixed the mapping, added a test, and re-made the tur dal chain (`scripts/fix-tur.ts`, deleting only our own synthetic offers/lots).

## Surfaces used
TypeScript SDK, JSON-RPC (HTTP), WebSocket events, Docs, Hub (access key), Faucet, Block Explorer. Not used: Data Explorer, Arkiv MCP, Arkiv skills, Arkiv plugin.
