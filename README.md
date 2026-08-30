# Meridian Breakdown Pipeline

Breakdown-to-resolution automation for Meridian Freight (Synq AI Forward
Deployment Challenge). Ingests messy fleet data, resolves entities,
extracts operational rules from unstructured sources, and runs a ticket
queue through an unattended pipeline with a human approval gate before
any client message is sent.

## Setup (one command on a clean machine)

```bash
npm run setup
```

This installs dependencies, generates the Prisma client, and runs the
initial migration (creates `dev.db`, a local SQLite file — no separate
database server required).

Copy `.env.example` to `.env` before running anything else:

```bash
cp .env.example .env
```

Fill in at least one LLM key — `GEMINI_API_KEY` (free tier:
https://aistudio.google.com/) and/or `OPENAI_API_KEY`
(https://platform.openai.com/). Both are supported; Gemini is tried
first and OpenAI is used automatically as a fallback if Gemini fails
(daily quota exhausted, rate limited, or erroring) — see "LLM provider
strategy" below. `DATABASE_URL` and `CANDIDATE_BUNDLE_PATH` already
have working defaults and don't need to be changed.

## Full run order

Run these in order the first time. Each step is idempotent — safe to
re-run, and later re-runs skip work already done.

```bash
npm run ingest              # Part A: fleet/drivers/trips CSVs -> entity store
npm run extract-knowledge   # Part A: interview transcript + 40 emails -> resolved facts (LLM)
npm run pipeline             # Part B: breakdown ticket queue -> work orders + comms
```

`npm run extract-knowledge` makes ~41 LLM calls and may need to be run
more than once if the free-tier Gemini daily quota is hit partway
through - it picks up exactly where it left off (see "LLM provider
strategy").

## Running the pipeline

```bash
npm run pipeline                                  # processes tickets.json, prompts for message approval
npm run pipeline -- --no-interactive              # skips approval prompts (for automated re-runs / idempotency checks)
npm run pipeline path/to/other_file.json          # process a different queue file (e.g. the hour-7 surprise file)
```

Outputs are written to `outputs/` (`work_orders.jsonl`,
`comms_pending.jsonl`, `comms_sent.jsonl`, `quarantine.jsonl`) and
`audit/audit.jsonl` in this project root, fully regenerated from
current database state on every run. Running the pipeline twice, back
to back, produces identical output files and reports `0` newly-created
work orders/messages on the second run - this is provable directly:

```bash
npm run pipeline -- --no-interactive
npm run pipeline -- --no-interactive   # should report 0 new work orders, 0 new messages
```

### Change-tolerance rehearsal (the hour-7 "surprise file")

Requires `npm run ingest` to have already run at least once (this
rehearsal ticket file references real vehicles from the resolved
fleet data, so the entity store must exist first).

`test-fixtures/surprise_tickets.json` is a hand-built stand-in for the
challenge's differently-formatted surprise file - it mixes a normal
ticket, a duplicate, a ticket with camelCase-renamed fields
(`vehicleRegistration`, `driverId`, etc.), and a genuinely broken
record (non-numeric distance, invalid severity). Run it the same way:

```bash
npm run pipeline test-fixtures/surprise_tickets.json -- --no-interactive
```

Expected: no crash, the renamed-field ticket is recovered via
`FIELD_ALIASES` in `src/schemas/ticket.ts`, and the genuinely broken
ticket is quarantined with a specific reason.

## Querying the context store

```bash
npm run query
```

Interactive CLI (Part A's required query interface). Ask a question
about a vehicle or client; answers are grounded in retrieved database
records and cited, or the interface explicitly says "insufficient
data" rather than guessing - enforced by a hard pre-LLM check as well
as prompt instructions, so a question with zero matching records never
reaches the LLM at all. Type `exit` to quit.

## LLM provider strategy

Two providers are wired in, in this priority order:

1. **Gemini** (`gemini-3.6-flash`, falling back to `gemini-3.7-flash`)
   - free tier, but the free tier's daily request quota is low enough
   (as low as 20/day per model, confirmed in practice) that a full
   41-document extraction pass can exhaust it partway through.
2. **OpenAI** (`gpt-4o-mini`) - used automatically whenever Gemini
   fails for any reason. At this project's document volume, a full
   run costs a fraction of a cent.

This is deliberate, not incidental: the challenge brief calls out
"APIs that rate limit, fail intermittently" as part of the scenario,
and this is a real, working answer to that rather than a single
brittle integration. The rules engine (`src/rules/dispatcher-rules.ts`)
and eligibility/idempotency logic never call an LLM - only free-text
extraction (`npm run extract-knowledge`) and the query interface's
answer-phrasing step do.

## Tests

```bash
npm test
```

67 tests covering: ticket validation and quarantine logic (including
change-tolerance field-alias recovery), CSV ingestion with duplicate-row
merging (fleet_master.csv's confirmed duplicate-row pattern), PII
masking guarantees, registration-format normalization, jugaad-mention
detection from resolution notes, the LLM extraction schema (validated
against mocked responses mirroring real extracted facts), and one
pass/fail pair per dispatcher rule in the rules engine.

## Project structure

```
src/
  schemas/     Zod schemas - ticket validation + change-tolerant field aliasing
  lib/         normalize.ts (registration formats), mask.ts (PII), db.ts (Prisma client)
  ingest/      fleet/drivers/trips CSV parsing + DB persistence
  knowledge/   LLM-assisted fact extraction from interview transcript + emails
  rules/       dispatcher's encoded rules, one function per rule, cited
  pipeline/    the 7-step breakdown-to-resolution pipeline
  query/       Part A query interface: context resolution + grounded answers + CLI
prisma/
  schema.prisma  entity store, idempotency ledger, audit log
tests/
test-fixtures/ hand-built surprise-file simulation for change-tolerance rehearsal
outputs/       generated: work_orders.jsonl, comms_pending.jsonl,
               comms_sent.jsonl, quarantine.jsonl
audit/         generated: audit.jsonl
```

## Design notes (for the defense round)

- **Idempotency** is enforced at the database level via unique
  constraints (`ticketId` unique on `WorkOrder` and `ClientMessage`),
  not just application logic - a duplicate can't slip through even on
  a code bug. Verified directly: running the pipeline twice back to
  back reports 0 newly-created work orders/messages on the second run.
- **PII masking** happens at ingestion, not as an output filter. Raw
  phone/DL/Aadhaar values are hashed (SHA-256, one-way) and mapped to
  masked tokens; the raw value is never persisted. A second regex-based
  scan runs on every outbound string (audit lines, client messages,
  query answers) as defense in depth.
- **Change tolerance** (`FIELD_ALIASES` in `src/schemas/ticket.ts`) is
  a narrow, explicit lookup table tried before validation - not fuzzy
  matching or an LLM guess - so a renamed field is recovered
  deterministically and a genuinely malformed value still quarantines
  exactly as before.
- **Query interface hallucination guard**: `hasAnyGrounding()` in
  `src/query/answer.ts` refuses to call the LLM at all when zero
  database records match the question, rather than relying solely on
  prompt instructions - the brief scores hallucination with negative
  marks, so this removes the failure mode at the code level.
- **SQLite via `@prisma/adapter-libsql`, not `better-sqlite3`.** The
  latter ships native compiled bindings gated to specific Node
  versions; on a newer Node runtime with no prebuilt binary, install
  silently falls back to compiling from source and can fail on a
  machine without build tools. libsql's driver avoids native bindings
  entirely, which is a better fit for "one-command deploy on a clean
  machine."
- **Dispatcher rules** live in `src/rules/dispatcher-rules.ts` as
  individually testable, citable TypeScript functions - not embedded
  in an LLM prompt - so every decision can be traced to a specific
  rule and interview citation in the audit log. Example of a rule
  overriding the obvious choice: Orion Pharma's 2020+ vehicle
  requirement rejects several otherwise-eligible vehicles purely on
  model year (confirmed against real tickets.json data - e.g. a 2018
  vehicle on TKT-0014).
- **Jugaad detection** (`src/pipeline/jugaad-detection.ts`) recognizes
  the real confirmed phrasing ("...jugaad se chalu kiya, permanent
  repair pending") in a ticket's resolution_note and populates
  `Vehicle.jugaadPatchedAt`/`jugaadDeadline`, so the dispatcher's
  7-day/home-region rule has real data to act on rather than always
  finding a null field. A deliberately narrow keyword match, not an
  LLM call - broader free-text parsing would be a different task.

## Known gaps (honest, not hidden)

- `Vehicle.lastServiceDate` and `lastBrakeWorkDate` are always null.
  This isn't a parsing miss - neither field exists in any structured
  source file (fleet_master.csv has no service-date column, and no
  source file records brake-work history). The service-overdue and
  hill-route-brake-work rules are fully implemented and tested, but
  never fire against the real dataset because the underlying data
  doesn't exist in the bundle. Given the 8-hour budget, priority went
  to the full 7-step pipeline and rules engine over inferring these
  dates from free text (e.g. "towed to hub workshop" doesn't imply a
  service date).
- The query interface's entity matching (`src/query/resolve-context.ts`)
  is regex/keyword-based, not fuzzy - a misspelled or unusually-phrased
  client/vehicle reference in a question won't resolve, and the
  interface correctly falls back to "insufficient data" rather than
  guessing, which is the safer failure mode given the brief's
  negative-marking on hallucination.

