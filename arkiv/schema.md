# Jawab Do data contract: `rti.v1`

Network: Tiramisu testnet, chain `7738577`; TypeScript SDK `@arkiv-network/sdk` 0.8.1; viem 2.57.3.

This public schema describes the synthetic demo entities. All entities use `project = "jawab-do"`, `schema = "rti.v1"` and `demo = true`. No applicant identity, contact detail, ID number or real application text is stored, hashed or encrypted on Arkiv.

## Trust and demo boundary

Anyone can create an Arkiv entity with Jawab Do's project attributes. The scorecard trusts the immutable `$creator` field, not those attributes. The trusted filing desk is `0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2`; the trusted legal-aid desk is `0xb114Ab157311e6C15B74fb08789632671d45D9c2`. A third wallet creates a visible but untrusted spoof.

`$owner` controls current write authority and may change. `$creator` does not. The app is an unauthenticated synthetic demo: it records what its demo desk submits, not whether an office received or acted on an official filing.

## Statutory clock and product retention are different

The Act sets reply windows: standard 30 days (s.7(1)), life or liberty 48 hours (s.7(1) proviso), via Assistant PIO 35 days (s.5(2)), and third-party information 40 days (s.11(3)). `due_at` is the numeric reply deadline used by the overdue filter. An overdue demo status is not itself a legal ruling. Late appeals may be admitted for sufficient cause under the Act; the UI is not legal advice.

| `basis` | Reply window | Section |
|---|---:|---|
| `standard` | 30 days | s.7(1) |
| `life_liberty` | 48 hours | s.7(1) proviso |
| `via_apio` | 35 days | s.5(2) |
| `third_party` | 40 days | s.11(3) |

The ordinary first-appeal period is 30 days (s.19(1)); the appellate authority ordinarily decides within 30 days, at most 45 (s.19(6)); and the ordinary second-appeal period is 90 days (s.19(3)). These are modeled as demo retention targets, not cutoff logic.

Entity Expiration is a separate **product retention policy** based on ordinary appeal periods. It is not an exact statutory deadline, a legal cutoff, or proof that a remedy is unavailable. New request/event creation has a one-hour minimum lifetime. Transitions never shorten an existing request expiry:

| Stage/action | Candidate retention target |
|---|---|
| File / `awaiting_reply` | `due_at + 30 days` |
| `replied` | `replied_at + 30 days` |
| `first_appeal` | current time + 45 days for decision + 90 days for ordinary second-appeal period |
| Escalate to `second_appeal` | current time + 90 days as a minimum target |
| Commission hearing | 90 days beyond the later of current expiry and current block |
| `keepAlive` | 30 days beyond current expiry |
| Timeline `event` | 365 days from creation |

A target transition expiry is applied only if it is later than the current expiry. A reply or escalation can therefore leave expiry unchanged. A hearing adds 90 days beyond accrued retention. Events are readonly and burn-owned for their lifetime; `permissionlessExtension` allows anyone to extend an event or request, so the lifetime is not permanent.

## Entity types

### Common attributes

| Attribute | Type | Value |
|---|---|---|
| `project` | `str` | `"jawab-do"` |
| `schema` | `str` | `"rti.v1"` |
| `type` | `str` | `"request"` or `"event"` |
| `demo` | `bool` | `true` |

### `request`

| Attribute | Type | Example | Purpose |
|---|---|---|---|
| `ref` | `str` | `"JD-BR-4F2K"` | Public reference lookup |
| `state` | `str` | `"BR"` | State filter |
| `authority` | `str` | `"br-food"` | Scorecard grouping/filter |
| `level` | `str` | `"state"` or `"central"` | Authority class |
| `basis` | `str` | `"standard"` | Reply window category |
| `category` | `str` | `"ration"` | Topic category |
| `stage` | `str` | `"awaiting_reply"` | `awaiting_reply`, `replied`, `first_appeal`, `second_appeal` |
| `filed_at` | `u64` | milliseconds since epoch | Synthetic filing time |
| `due_at` | `u64` | milliseconds since epoch | Reply deadline used by overdue filters |
| `appeal_by` | `u64` | milliseconds since epoch | Ordinary first-appeal window |
| `replied_at` | `u64` | milliseconds since epoch | Present after a reply |
| `faa_due_at` | `u64` | milliseconds since epoch | First appellate authority target |

Queryable fields use typed attributes. The `application/json` payload contains a synthetic one-line `summary` and `language: "en"`; payload text is not queryable. Requests are created with `permissionlessExtension: true`.

### `event`

| Attribute | Type | Purpose |
|---|---|---|
| `request` | `key` | Parent request entity key |
| `ref` | `str` | Parent public reference |
| `kind` | `str` | `filed`, `replied`, `first_appeal`, `second_appeal`, `hearing`, or `handed_over` |
| `at` | `u64` | Event timestamp in milliseconds |
| `authority` | `str` | Parent authority |
| `state` | `str` | Parent state |

The payload contains a synthetic event note. Events use `readonly: true` and `permissionlessExtension: true`; their ownership is transferred to `0x000000000000000000000000000000000000dEaD` in the creation batch. This prevents the desks from patching/deleting events during their lifetime, but the 365-day expiry and possible Lifetime Extension still apply.

## Atomic writes and ownership

Each filing/transition creates its event, and any request patch, extension or ownership change, in one `executeBatch`. `predictEntityKeys()` provides the event key/salt for its `request: key(requestKey)` reference.

| Action | Request change | Event |
|---|---|---|
| File | Create request | Create `filed`; transfer event to burn |
| Reply | Set stage/timestamps; extend only if later | Create `replied`; transfer event to burn |
| First appeal | Set stage/FAA target; extend only if later | Create `first_appeal`; transfer event to burn |
| Second appeal | Set stage; preserve any later existing expiry; transfer request to legal aid | Create `second_appeal`; transfer event to burn |
| Hearing | Extend expiry by 90 days from the later of current expiry/current block | Create `hearing`; transfer event to burn |
| Hand over | Transfer request to synthetic applicant | Create `handed_over`; transfer event to burn |
| Keep alive | `extendEntity` by 30 days from current expiry | No event |

`transition()` and `keepAlive()` only mutate a request with the expected `project`, `schema`, `type = "request"` and `demo = true` attributes. Detail/actions enforce the same provenance boundary. These app checks are not authentication or a smart-contract rule.

## Queries used by the app

The query predicates/projections are shown here as produced by the SDK builders in [`server/arkiv.ts`](../server/arkiv.ts), [`src/web/main.ts`](../src/web/main.ts) and [`scripts/verify.ts`](../scripts/verify.ts). Dynamic timestamps are represented by `<asOfMs>`.

Trusted scorecard requests:

```text
project = str('jawab-do') AND type = str('request') AND $creator = addr(0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2)
```

Overdue trusted requests (`asOfMs` is `Date.now()` for a new query):

```text
project = str('jawab-do') AND type = str('request') AND stage = str('awaiting_reply') AND due_at < u64(<asOfMs>) AND $creator = addr(0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2)
```

Due in the next seven days:

```text
project = str('jawab-do') AND type = str('request') AND stage = str('awaiting_reply') AND due_at >= u64(<asOfMs>) AND due_at <= u64(<asOfMs + 604800000>)
```

Request list query with state and trusted scope:

```text
project = str('jawab-do') AND type = str('request') AND state = str('BR') AND $creator = addr(0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2)
```

Reference lookup:

```text
project = str('jawab-do') AND type = str('request') AND ref = str('JD-BR-KRZD')
```

Timeline event query:

```text
project = str('jawab-do') AND type = str('event') AND request = key(<requestKey>) AND ($creator = addr(0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2) OR $creator = addr(0xb114Ab157311e6C15B74fb08789632671d45D9c2) OR $creator = addr(<currentOwner>))
```

The list query's predicates/projections are unchanged. It requests 25 items per page; due-filter cursors reuse the response's `asOf` so the numeric predicate is stable. The app sorts each fetched page by `due_at`, not the full concatenated cursor walk. Timeline detail uses its existing query and 50-item pages, collects all pages, then sorts by `at`. Direct browser verification retains its existing query and 200-item pages, collects all pages, and reports the block from the first page.

## Frozen evidence

[`demo-evidence.json`](demo-evidence.json) records the verified snapshot at block `735905` (`2026-10-18T11:06:14.215Z`): 20 trusted requests, 2 untrusted requests, 7 overdue; 19 successful seed creation receipts; and 27 readonly, burn-owned seed events. It also records successful receipts for the browser actions and the automatic-expiration proof. These counts describe that snapshot only; they are not immutable totals.
