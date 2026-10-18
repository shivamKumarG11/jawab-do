# Jawab Do: Arkiv schema (data contract `rti.v1`)

Network: **Tiramisu** testnet (chain `7738577`) · SDK `@arkiv-network/sdk` 0.8.1 · viem 2.57.3.

This file is a public data contract. Anyone can build their own dashboard on these entities without asking us: every field below is stable within `schema = "rti.v1"`. A breaking change gets a new `schema` value.

> **All data is synthetic.** No applicant identity, phone, address, ID number or application text is ever written to Arkiv, in plaintext or hashed. Department names are generic (e.g. "District Collectorate"), and every entity carries `demo = true`.

## Trust model

Anyone can write an entity with `project = "jawab-do"`. **Only `$creator` decides what we trust**, because nobody can forge it:

| Role | Wallet | Creates | Notes |
|---|---|---|---|
| Filing desk (trusted) | `0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2` | `request`, `event` | Our write relay signs with this key on behalf of citizens |
| Legal-aid desk (trusted) | `0xb114Ab157311e6C15B74fb08789632671d45D9c2` | `event` | Receives `request` ownership on second appeal |
| Spoofer (untrusted, demo only) | `0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58` | a fake `request` | Same attributes as a real one; the app shows it as **Unverified creator** and leaves it out of the scorecard |

`$owner` is who may change a request now (filing desk → legal-aid desk on second appeal, or → the applicant's own wallet on hand-over). `$creator` never changes, so a request handed to someone else still proves which desk filed it.

## Legal windows (RTI Act 2005, checked against the official text, `docs/india/rti-act-2005.pdf` from cic.gov.in)

| `basis` | PIO must reply within | Section |
|---|---|---|
| `standard` | 30 days | s.7(1) |
| `life_liberty` | 48 hours | s.7(1) proviso |
| `via_apio` | 30 + 5 = 35 days | s.5(2) |
| `third_party` | 40 days | s.11(3) |

No reply by `due_at` → **deemed refusal**, s.7(2). First appeal: within 30 days of the deadline or the reply, s.19(1); the appellate authority decides within 30 days (at most 45), s.19(6). Second appeal to the Information Commission: within 90 days, s.19(3).

## Entity types

Common attributes on **every** entity:

| Attribute | Type | Value |
|---|---|---|
| `project` | `str` | `"jawab-do"` |
| `schema` | `str` | `"rti.v1"` |
| `type` | `str` | `"request"` or `"event"` |
| `demo` | `bool` | `true` (synthetic data marker) |

### 1. `request`: one RTI application's live state

| Attribute | Type | Example | Why it is an attribute |
|---|---|---|---|
| `ref` | `str` | `"JD-BR-4F2K"` | Public lookup handle (`eq`) |
| `state` | `str` | `"BR"` (ISO 3166-2:IN suffix) | Filter by state |
| `authority` | `str` | `"br-district-collectorate"` | Scorecard group-by and filter |
| `level` | `str` | `"state"` / `"central"` | Filter |
| `basis` | `str` | `"standard"` | Decides `due_at` |
| `category` | `str` | `"ration"` | Filter |
| `stage` | `str` | `awaiting_reply` · `replied` · `first_appeal` · `second_appeal` | Compound filters |
| `filed_at` | `u64` | ms since epoch | Range |
| `due_at` | `u64` | ms since epoch | **Range: overdue = `due_at < now`** |
| `appeal_by` | `u64` | ms | Last day to file the first appeal |
| `replied_at` | `u64` | ms (only once replied) | Range |
| `faa_due_at` | `u64` | ms (only in first appeal) | Appellate authority deadline |

Payload (`application/json`, not queryable): `{ "summary": "<synthetic one-line topic>", "language": "hi" }`.

Flags: **`permissionlessExtension: true`**, so any citizen, journalist or the legal-aid desk can keep a request alive (Lifetime Extension) without being able to change it.

**Entity Expiration = the end of the citizen's legal remedy for the current stage.** The record lives exactly as long as someone can still act on it:

| Stage | Expires at |
|---|---|
| `awaiting_reply` | `due_at` + 30 days (first-appeal window, s.19(1)) |
| `replied` | max(current, `replied_at` + 30 days) |
| `first_appeal` | appeal filed + 45 days (max decision time) + 90 days (second-appeal window) |
| `second_appeal` | a **90-day lease**, renewed by each hearing or update (Lifetime Extension renewed by activity) |

### 2. `event`: an immutable timeline entry (the evidence)

| Attribute | Type | Example |
|---|---|---|
| `request` | `key` | entity key of the `request` |
| `ref` | `str` | `"JD-BR-4F2K"` |
| `kind` | `str` | `filed` · `replied` · `first_appeal` · `second_appeal` · `hearing` · `handed_over` |
| `at` | `u64` | ms since epoch |
| `authority` | `str` | same as the request |
| `state` | `str` | same as the request |

Payload (`application/json`): `{ "note": "<synthetic>" }`.

Flags: **`readonly: true`** and **`permissionlessExtension: true`**. In the **same atomic batch** that creates it, ownership moves to the burn address `0x000000000000000000000000000000000000dEaD`. After that nobody, including us, can patch or delete it, while anyone can still extend it.

**Entity Expiration = 365 days**, a one-year public audit horizon, longer than any `request`. Anyone who needs it longer can extend it.

## Writes (atomic batches)

| User action | One `executeBatch` containing |
|---|---|
| File a request | create `request` + create `filed` event + transfer event → burn |
| Mark replied | patch `request` (stage, `replied_at`, `appeal_by`) + extend if later + create `replied` event + burn |
| File first appeal | patch `request` (stage, `faa_due_at`) + extend `request` + create `first_appeal` event + burn |
| Escalate to second appeal | patch `request` + extend 90-day lease + create `second_appeal` event + burn + **transfer `request` → legal-aid desk** |
| Hearing (legal-aid desk) | extend 90-day lease + create `hearing` event + burn |
| Hand over to applicant | transfer `request` → applicant wallet + create `handed_over` event + burn |
| Keep alive (anyone, own wallet) | `extendEntity` on `request` (permissionless) |

Keys for same-batch references come from `predictEntityKeys()` and are passed as `salt`.

## Queries the app runs

Filled in with the exact query strings (`builder.toString()`) once implemented and verified on chain. See below.
