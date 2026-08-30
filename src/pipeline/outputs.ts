import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes the standardized output files the brief requires, in the
 * exact record shapes CANDIDATE_README.md specifies. Each write
 * function TRUNCATES its target file at the start of a run (see
 * resetOutputFiles) and then appends one line per record — this,
 * combined with the DB-level idempotency guarantees upstream, is what
 * makes "run the pipeline twice, get identical output files" true:
 * the files are always fully regenerated from the current DB state,
 * never incrementally appended to across separate runs.
 */

const OUTPUTS_DIR = "outputs";
const AUDIT_DIR = "audit";

export function resetOutputFiles(): void {
  mkdirSync(OUTPUTS_DIR, { recursive: true });
  mkdirSync(AUDIT_DIR, { recursive: true });
  for (const file of ["work_orders.jsonl", "comms_pending.jsonl", "comms_sent.jsonl", "quarantine.jsonl"]) {
    writeFileSync(join(OUTPUTS_DIR, file), "");
  }
  writeFileSync(join(AUDIT_DIR, "audit.jsonl"), "");
}

function appendJsonLine(dir: string, file: string, record: unknown): void {
  appendFileSync(join(dir, file), JSON.stringify(record) + "\n");
}

export function appendWorkOrder(record: {
  work_order_id: string;
  ticket_id: string;
  vehicle_reg: string;
  created_at: string;
  citations: unknown[];
}): void {
  appendJsonLine(OUTPUTS_DIR, "work_orders.jsonl", record);
}

export function appendCommsPending(record: {
  message_id: string;
  ticket_id: string;
  recipient: string;
  body: string;
  citations: unknown[];
}): void {
  appendJsonLine(OUTPUTS_DIR, "comms_pending.jsonl", record);
}

export function appendCommsSent(record: {
  message_id: string;
  ticket_id: string;
  recipient: string;
  body: string;
  approved_by: string;
  sent_at: string;
}): void {
  appendJsonLine(OUTPUTS_DIR, "comms_sent.jsonl", record);
}

export function appendQuarantine(record: { ticket_id: string | null; reason: string; raw_record: unknown }): void {
  appendJsonLine(OUTPUTS_DIR, "quarantine.jsonl", record);
}

export function appendAuditLine(record: {
  ticket_id: string;
  step: string;
  decision: string;
  rule_cited: string | null;
  actor: string;
  timestamp: string;
}): void {
  appendJsonLine(AUDIT_DIR, "audit.jsonl", record);
}

export function ensureOutputDirsExist(): void {
  if (!existsSync(OUTPUTS_DIR)) mkdirSync(OUTPUTS_DIR, { recursive: true });
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
}
