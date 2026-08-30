# Meridian Breakdown Pipeline

Breakdown-to-resolution automation for Meridian Freight (Synq AI Forward
Deployment Challenge). Ingests messy fleet data, resolves entities, and
runs a ticket queue through an unattended pipeline with a human approval
gate before any client message is sent.

## Setup (one command on a clean machine)

```bash
npm run setup
```

This installs dependencies, generates the Prisma client, and runs the
initial migration (creates `dev.db`, a local SQLite file — no separate
database server required).

Copy `.env.example` to `.env` and fill in a Gemini API key before running
the pipeline (free tier: https://aistudio.google.com/).

## Running the pipeline

```bash
npm run pipeline
```

Processes `tickets.json` from the configured `CANDIDATE_BUNDLE_PATH`,
end to end. Outputs are written to `outputs/` and `audit/` in this
project root. Running this command twice, back to back, produces
identical output files — state persists in `dev.db` between runs.

## Querying the context store

```bash
npm run query
```

Interactive CLI. Ask a question about a vehicle, client, or driver;
answers are returned with citations to source records, or an explicit
"insufficient data" if the store can't support a confident answer.

## Tests

```bash
npm test
```

Covers: idempotency (double-run produces identical output), quarantine
handling of broken records, the dispatcher rule engine (one test per
encoded rule), PII-masking guarantees, and change tolerance against a
mock reformatted ticket file.

## Project structure

```
src/
  schemas/     Zod schemas — ticket validation drives quarantine logic
  lib/         normalize.ts (registration formats), mask.ts (PII)
  rules/       dispatcher's encoded rules, one function per rule, cited
  pipeline/    the 7-step breakdown-to-resolution pipeline
  query/       Part A query interface + CLI
prisma/
  schema.prisma  entity store, idempotency ledger, audit log
tests/
outputs/       generated: work_orders.jsonl, comms_pending.jsonl,
               comms_sent.jsonl, quarantine.jsonl
audit/         generated: audit.jsonl
```

## Design notes (for the defense round)

- **Idempotency** is enforced at the database level via unique
  constraints (`ticketId` unique on `WorkOrder` and `ClientMessage`),
  not just application logic — a duplicate can't slip through even on
  a code bug.
- **PII masking** happens at ingestion, not as an output filter. Raw
  phone/DL/Aadhaar values are hashed (SHA-256, one-way) and mapped to
  masked tokens; the raw value is never persisted. A second regex-based
  scan runs on every outbound string as defense in depth.
- **SQLite via `@prisma/adapter-libsql`, not `better-sqlite3`.** The
  latter ships native compiled bindings gated to specific Node
  versions; on a newer Node runtime with no prebuilt binary, install
  silently falls back to compiling from source and can fail on a
  machine without build tools. libsql's driver avoids native bindings
  entirely, which is a better fit for "one-command deploy on a clean
  machine."
- **Dispatcher rules** live in `src/rules/` as individually testable,
  citable TypeScript functions — not embedded in an LLM prompt — so
  every decision can be traced to a specific rule and interview
  citation in the audit log.
