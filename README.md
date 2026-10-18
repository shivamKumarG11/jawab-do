# Jawab Do — an RTI deadline demo on Arkiv

Jawab Do demonstrates a public deadline clock and department scorecard using **Arkiv, the Web3 database**, on the Tiramisu testnet (`chainId 7738577`).

- Data contract: [`arkiv/schema.md`](arkiv/schema.md)
- Friction report: [`arkiv/friction.md`](arkiv/friction.md)
- Frozen on-chain snapshot: [`arkiv/demo-evidence.json`](arkiv/demo-evidence.json)
- License: [MIT](LICENSE)
- Live app: not deployed; do not infer a URL.

> **Synthetic and unauthenticated demo.** Jawab Do does not submit official RTI applications or verify real-world filing, delivery, replies, or decisions. Departments and topics are generic. Do not enter personal or confidential information. Arkiv entities are public.

## Why this demo

The Right to Information Act, 2005 sets reply windows: 30 days for a standard request (s.7(1)), 48 hours for life or liberty (s.7(1) proviso), 35 days via an Assistant PIO (s.5(2)), and 40 days for third-party information (s.11(3)). No reply by `due_at` is a deemed refusal under s.7(2). The Act also provides first- and second-appeal procedures; late appeals may be admitted for sufficient cause.

Jawab Do records **synthetic examples** so a reader can inspect a deadline filter, creator provenance, ownership hand-off, and event history. The app records what its demo desk submits; it cannot prove that an office received or acted on an application. It is not legal advice.

## Why Arkiv, not Postgres?

Postgres can build a dashboard, but these examples would otherwise depend on a trusted service, custom trigger, contract, or indexer to enforce and expose the same protocol-level behavior.

| Need | Arkiv feature | What it demonstrates |
|---|---|---|
| Queryable case data | Typed attributes, payloads, compound queries, numeric ranges | Filter by state/stage/category and compare `due_at` without treating JSON payloads as queryable |
| Publicly inspectable retention | Entity Expiration per entity | Give requests and timeline events separate product retention policies |
| Keep active cases available | Lifetime Extension and `permissionlessExtension` | Any funded wallet can extend a request without gaining patch rights |
| Provenance and custody | Immutable `$creator`, mutable `$owner`, `createdBy()` and `changeOwnership` | Spoofs remain visible but are excluded from the trusted scorecard; second appeal transfers request ownership to legal aid |
| Timeline integrity | `readonly` event transferred to the burn address in the same atomic batch | The desks cannot patch or delete those events during their chosen lifetime |
| Live notifications | Browser `watchEntityEvents` over WebSocket without `fromBlock` | The browser uses an actual `eth_subscribe` stream and filters event owner fields before refreshing |

These primitives do not prove that a real public authority received or acted on a filing. The server relay is a convenience for a synthetic demo, not citizen authentication. Relay limits are 8 writes per IP per 10 minutes and a configured 300 writes per day; these limits do not turn it into a production filing portal.

## Entity Expiration is retention, not the statutory clock

`due_at` is the numeric reply deadline used by the demo's overdue filter. Entity Expiration is a separate retention policy based on ordinary appeal periods, **not** an exact statutory deadline or legal cutoff:

| Stage/action | Candidate retention target |
|---|---|
| File / `awaiting_reply` | `due_at + 30 days` |
| Mark replied | `replied_at + 30 days` |
| First appeal | current time + 45 days for the decision + 90 days for the ordinary second-appeal period |
| Escalate to second appeal | current time + 90 days as a minimum target |
| Commission hearing | add 90 days beyond the later of current expiry and current block |
| Permissionless keep-alive | add 30 days beyond current expiry |
| Timeline event | 365 days from creation |

Transitions never shorten existing request retention. Replies and escalations can therefore leave expiry unchanged. A hearing adds 90 days to accrued retention. A one-hour minimum creation lifetime applies when a new entity's target is already past. Events are readonly and burn-owned during their lifetime, but they expire unless extended. Late appeals may still be admitted for sufficient cause.

## How we use Arkiv

- **Attributes and payloads:** `project`, `schema`, `type`, `demo`, references, authority fields, stages, timestamps and request links are typed attributes. Synthetic summaries and event notes are JSON payloads. See [`src/shared/ops.ts`](src/shared/ops.ts).
- **Queries:** the scorecard uses `createdBy(DESK)`; overdue means `stage = awaiting_reply AND due_at < asOf`. The existing query predicates are shown in the UI and [`server/arkiv.ts`](server/arkiv.ts).
- **Stable cursor pages:** due-filter responses return one `asOf` value, reused with the cursor on appended pages. Each list page is sorted by `due_at`; the concatenated cursor walk is not promised to be globally sorted by that field.
- **Direct verification and timelines:** the browser verifier collects all pages while retaining its existing predicate and projection. Request detail collects every page of its existing timeline query, then sorts events by `at`.
- **Atomic writes:** filing and transition batches use `executeBatch` and keys from `predictEntityKeys()` to link each request and event.
- **Creator and owner:** `$creator` records who created an entity; `$owner` controls current write authority. Creator remains unchanged when a request moves to legal aid or the synthetic applicant.
- **WebSocket:** the browser calls `watchEntityEvents` without `fromBlock`; the verified browser frame used `eth_subscribe`. The app does not claim the stream is project-filtered by Arkiv.

## Frozen snapshot

[`arkiv/demo-evidence.json`](arkiv/demo-evidence.json) records a Tiramisu snapshot at block `735905`, captured `2026-10-18T11:06:14.215Z`: 20 trusted requests, 2 untrusted requests, and 7 overdue requests. It records 19 successful seed creation receipts, 27 readonly burn-owned seed timeline events, and all seeded request expirations estimated beyond the 23 October judging window.

This is a point-in-time snapshot, not a claim that the live counts never change.

## Public wallet roles

| Role | Address | Purpose |
|---|---|---|
| Filing desk | `0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2` | Trusted request creator; initial owner |
| Legal-aid desk | `0xb114Ab157311e6C15B74fb08789632671d45D9c2` | Receives request ownership on second appeal; records hearings |
| Spoofer | `0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58` | Untrusted creator used for the spoof and wallet demonstrations |
| Burn address | `0x000000000000000000000000000000000000dEaD` | Owner of readonly timeline events during their lifetime |
| Demo applicant | `0x00000000000000000000000000000000a11ce000` | Public synthetic hand-over recipient; no app-held key |

The [filing desk](https://tiramisu.explorer.arkiv.network/address/0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2), [legal-aid desk](https://tiramisu.explorer.arkiv.network/address/0xb114Ab157311e6C15B74fb08789632671d45D9c2), [spoofer](https://tiramisu.explorer.arkiv.network/address/0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58) and [burn address](https://tiramisu.explorer.arkiv.network/address/0x000000000000000000000000000000000000dEaD) have public Tiramisu explorer links.

## Local setup

Requires Node.js `22.20.x`. A clean clone can read public Tiramisu data without `.env` or private keys:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
npm run verify
```

`npm start` loads `.env` only if present. Without relay keys, the app is read-only and write actions are disabled. `npm run verify` reads public data using the canonical filing-desk creator address; it does not automatically switch to newly generated wallet addresses.

For your own testnet writes, copy `.env.example` to `.env`, then run `npm exec -- tsx scripts/gen-wallets.ts`. The generator fills missing or blank role keys, preserves nonblank keys, and prints public addresses only. Fund your own test wallets at the [Tiramisu faucet](https://hub.arkiv.network/faucet). An [Arkiv Hub access key](https://hub.arkiv.network/api-keys) is optional for higher read limits. Keep `.env` private and out of source control.

`npm run probe` and `npm run seed` create public Tiramisu entities. The probe writes to `jawab-do-probe`; the seed writes 18 synthetic requests plus a spoof to `jawab-do`. Use these only when you intend those public writes.

## Render deployment

`render.yaml` pins Node `22.20.0`, builds with `npm ci --include=dev && npm run build`, starts with `npm start`, and health-checks `/api/health`. A host needs only `ARKIV_ACCESS_KEY`, `DESK_KEY`, and `LEGAL_AID_KEY`; it does not need `SPOOFER_KEY`.

Render's Free web service can sleep after 15 minutes without traffic. Its 750 monthly instance-hours are shared with the builder's other project. The repository's GitHub Actions keep-warm workflow schedules a best-effort ping every 10 minutes until 24 October 2026 UTC and requires the `LIVE_URL` repository variable to hold a verified HTTPS Render service origin. GitHub schedule delays and Render limits mean this does not guarantee uptime or availability.

After an authorized push, use Render's official [deploy guide](https://render.com/docs/deploy-to-render) or [quick-deploy link](https://render.com/deploy?repo=https://github.com/shivamKumarG11/jawab-do). No generated service URL is listed until deployment is completed and verified.
