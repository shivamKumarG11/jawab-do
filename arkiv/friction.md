# Friction and smooth paths on Arkiv

Observed on Windows 11 with Node.js 22.20.0, npm 10.9.3, `@arkiv-network/sdk` 0.8.1, viem 2.57.3 and tsx 4.23.15 on Tiramisu (`chainId 7738577`). The report separates agent tests from human-observed Hub UI.

## F1 — `watchEntityEvents` has no server-side project filter

- **Surface:** TypeScript SDK and Tiramisu WebSocket.
- **Expected:** subscribe only to one app's events, for example by `project`, creator or owner.
- **Observed:** `watchEntityEvents` accepts no such filter. The anonymous read probe observed 31 chain events in 30 seconds. Event frames do not carry arbitrary entity attributes, so filtering by project requires an additional entity read for events that cannot be screened by their owner fields.
- **Reproduction:** `npm ci`, then `npx tsx scripts/probe-read.ts`. The app's `startFeed()` in [`src/web/main.ts`](../src/web/main.ts) filters on owner/previousOwner/newOwner.
- **Suggested improvement:** support indexed owner/creator or project-topic filters, or include enough attributes for a client to filter without a read per foreign event.

## F2 — Live Events documentation does not show the WebSocket push path

- **Surface:** [TypeScript SDK Live Events documentation](https://docs.arkiv.network/typescript-sdk/live-events/) and `watchEntityEvents`.
- **Expected:** show `webSocket()` as the real-time transport and explain the `fromBlock` behavior.
- **Observed:** the documentation describes polling and its examples use HTTP. The browser was observed sending an actual `eth_subscribe` frame with no `fromBlock`; incoming `eth_subscription` frames followed. SDK transport inspection found that supplying `fromBlock` switches the watcher to filter/block/log polling (`eth_newFilter`, `eth_blockNumber`, `eth_getLogs`) instead.
- **Reproduction:** inspect `startFeed()` in [`src/web/main.ts`](../src/web/main.ts) and the browser frame record in `../../toolchain/evidence/ws-diagnostic.log`. For the polling path, compare the SDK's `watchEntityEvents` calls with and without `fromBlock`.
- **Suggested improvement:** document WebSocket push as a distinct no-`fromBlock` mode and describe the polling fallback.

## F3 — Exported query predicates may fail only when run on Tiramisu

- **Surface:** SDK query exports and the Tiramisu query engine.
- **Expected:** exported predicates work on the connected network, or are clearly marked unsupported.
- **Observed:** actual `ne()` and `exists()` queries failed at runtime with `QueryError` code `-32002`. The docs also list `hasType()` as unsupported, but we did **not** execute `hasType()`.
- **Reproduction:** using a public client for Tiramisu, run `pub.select({ key: true }).where(ne("project", str("jawab-do"))).limit(1).fetch()`; the tested `exists()` predicate also fails at runtime. Do not infer a result for `hasType()`.
- **Suggested improvement:** make the supported operator set consistent across SDK exports, documentation and the node's runtime errors.

## F4 — Faucet cooldown was visible in the Hub UI

- **Surface:** Arkiv Hub faucet.
- **Expected:** the UI makes the claim cooldown clear when funding multiple test wallets.
- **Human-observed:** after a desk faucet claim, the UI displayed “Next claim in 60m — Cooldown: 1 hour per wallet” while attempting the next recipient. This records that observed UI state; it is not a claim about every recipient or a universal faucet policy. All three wallets were later funded.
- **Reproduction/evidence:** human-observed faucet UI during funding; no screenshot path is included in this repository.

## F5 — Successful GLM transfers contradicted an overly broad offline statement

- **Surface:** Tiramisu transfers and offline fundamentals documentation.
- **Expected:** documentation should distinguish general guidance from transactions actually observed on the network.
- **Observed:** a 2.5 GLM legal-aid transfer succeeded in transaction `0xec75a254d0eb3a0641f53f7af5b782162b73c860ed74d7c295e1a28ed74f04c4`; a 1 GLM spoofer transfer succeeded in transaction `0x0dfdea6da5163d8a6806417fd278f6408b785b2dabff29c984191228c03c2cce`. These two transactions establish those outcomes, not universal behavior for every transfer.
- **Evidence:** public hashes above and the wallet funding record in the workspace session log.

## Smooth paths verified

### Anonymous reads and actual WebSocket subscription

Anonymous `getBlockNumber()`, a typed `select().where(eq("project", str("jawab-do")))`, and a WebSocket watcher worked without an access key. A real browser `framesent` record showed `eth_subscribe`; no inference from a transport spy is needed. The browser UI filters events by owner fields and refreshes through its existing API.

### Probe behavior

The author-written `npm run probe` completed once with exit status 0 and no `FAILED` or `UNEXPECTED OK` lines. It created the first probe entity and a batch whose predicted entity keys matched. The created event was burn-owned, readonly and permissionlessly extendable. Desk delete/patch attempts were rejected; a spoofer extended the event successfully. Legal aid extended a permissionless request; an entity without that flag rejected the non-owner extension. Ownership moved from desk to legal aid while creator stayed desk; the old owner could not patch and the new owner could. The spoof appeared in the all-creators query but not the desk-created query; the `$creator` OR query and `key(request)` event query returned results.

Passing the current expiry as an extension target succeeded as a no-op rather than reverting. An earlier target was rejected. The app therefore skips equal/earlier extensions and reports the actual retained expiry.

### Seed, readonly events and automatic expiry

The single seed run produced 18 request creations plus a spoof. Frozen evidence at block `735905` (`2026-10-18T11:06:14.215Z`) records 19 successful creation receipts and 27 seed timeline events, all readonly and burn-owned. The same snapshot records 20 trusted requests, 2 untrusted requests and 7 overdue requests at that time; these are point-in-time counts.

The 12 browser action receipts are all successful: 7 captured in the browser run and 5 recovered by receipt plus matching burn-owned event. The five recovered relay receipts are in `../../toolchain/evidence/recovered-browser-receipts.json`; the combined public snapshot is [`demo-evidence.json`](demo-evidence.json).

An automatic-expiration proof created only the approved synthetic 12-second entity. Its creation receipt succeeded, it was initially readable, and lookup later raised `NoEntityFoundError` after the chain passed expiry block `735200`; no delete was issued. Proof: `../../toolchain/evidence/expiration-proof.log`.

### Funding and read-only startup

The agent-observed wallet balances were approximately 6.5 GLM for desk, 2.5 GLM for legal aid and 1 GLM for spoofer. The successful transfer hashes and amounts are listed under F5. With no `.env` relay keys or address overrides, the app now uses the canonical public creator addresses for reads and leaves `writesEnabled` false.

## Surfaces used

- **TypeScript SDK / HTTP JSON-RPC:** clients, typed attributes, queries, batches, receipts and block timing.
- **WebSocket:** direct browser `watchEntityEvents`; actual `eth_subscribe` frame observed.
- **Docs:** official TypeScript SDK and network docs were consulted; F2 records a discrepancy.
- **Hub / access keys:** a human-generated Hub key was saved locally and tested; its value is never recorded here.
- **Faucet:** human-observed cooldown UI and subsequently funded wallets (F4).
- **Block Explorer:** public address/transaction links are exposed by the app; transaction receipt verification for the frozen evidence used RPC.
- **Not used:** Arkiv Data Explorer, Arkiv MCP, Arkiv skills or Arkiv plugin.
