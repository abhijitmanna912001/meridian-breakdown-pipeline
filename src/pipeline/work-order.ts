import { prisma } from "../lib/db.js";
import type { EnrichedTicket } from "./enrich.js";
import type { ClassificationResult } from "./classify.js";
import type { VehicleSelectionResult } from "./select-vehicle.js";
import type { RuleCitation } from "../rules/dispatcher-rules.js";
import { containsRawPii, redact } from "../lib/mask.js";

/**
 * Step 5 (work order) and Step 7 (audit log) of the pipeline. Step 6
 * (draft message + human approval) lives in comms.ts since it has its
 * own CLI-facing concerns.
 *
 * Idempotency for Step 5 is enforced at TWO levels, deliberately
 * redundant:
 *   1. Application level: this function checks for an existing
 *      WorkOrder before creating one.
 *   2. Database level: WorkOrder.ticketId has a @unique constraint,
 *      so even a bug in (1) could not produce a second work order for
 *      the same ticket — the DB would reject the insert.
 * This matches the brief's framing: "a duplicate work order... is a
 * scored failure, exactly as if each write cost real money" — worth
 * a belt-and-braces guarantee, not just careful application code.
 */

export interface WorkOrderResult {
  workOrderId: string;
  alreadyExisted: boolean;
}

function generateWorkOrderId(ticketId: string): string {
  // Deterministic, not random — derived from the ticket id so that
  // even if this function were somehow called twice for the same
  // ticket without the existence check running, the generated id
  // would be identical both times (defense in depth alongside the
  // DB unique constraint).
  return `WO-${ticketId}`;
}

export async function recordWorkOrder(
  enriched: EnrichedTicket,
  classification: ClassificationResult,
  selection: VehicleSelectionResult | null // null when the ticket was already resolved (Step 4 skipped)
): Promise<WorkOrderResult> {
  const ticketId = enriched.ticket.ticket_id;

  const existing = await prisma.workOrder.findUnique({ where: { ticketId } });
  if (existing) {
    return { workOrderId: existing.workOrderId, alreadyExisted: true };
  }

  const workOrderId = generateWorkOrderId(ticketId);
  const citations = [...classification.citations];
  if (selection) citations.push(selection.sourceHubCitation);

  const vehicleRegUsed = classification.alreadyResolved
    ? enriched.vehicle?.registrationNumber ?? enriched.ticket.vehicle
    : selection?.selected?.registrationNumber ?? "NO_ELIGIBLE_VEHICLE_FOUND";

  try {
    await prisma.workOrder.create({
      data: {
        workOrderId,
        ticketId,
        vehicleRegUsed,
        vehicleId: selection?.selected?.vehicleId ?? enriched.vehicle?.id ?? null,
        citations: JSON.stringify(
          citations.map((c) => ({ rule: c.rule, reason: c.reason, sourceExcerpt: c.sourceExcerpt }))
        ),
      },
    });
  } catch (err) {
    // A unique constraint violation here means a race or a bug meant
    // to insert twice — treat it as "already existed" rather than
    // crashing, since the DB has already guaranteed exactly-once.
    const existingAfterRace = await prisma.workOrder.findUnique({ where: { ticketId } });
    if (existingAfterRace) {
      return { workOrderId: existingAfterRace.workOrderId, alreadyExisted: true };
    }
    throw err;
  }

  return { workOrderId, alreadyExisted: false };
}

/**
 * Step 7: one audit event per pipeline step per ticket. Called
 * throughout the pipeline run, not just at the end — every decision
 * gets its own row so an evaluator can reconstruct "what was decided,
 * on what data, under which rule" for any ticket in under a minute,
 * per the brief's observability requirement.
 *
 * PII safety: sourceData is JSON-stringified and scanned for raw PII
 * patterns before being written, as defense in depth alongside the
 * masking already applied at ingestion — this is the last checkpoint
 * before something becomes an "evaluator-visible log."
 */
export async function writeAuditEvent(params: {
  ticketId: string;
  step: "VALIDATE" | "ENRICH" | "CLASSIFY" | "SELECT_VEHICLE" | "WORK_ORDER" | "DRAFT_MESSAGE" | "SEND";
  decision: string;
  ruleCited?: string;
  sourceData?: unknown;
  actor: string;
}): Promise<void> {
  let sourceDataStr: string | null = null;
  if (params.sourceData !== undefined) {
    const raw = JSON.stringify(params.sourceData);
    const scan = containsRawPii(raw);
    sourceDataStr = scan.clean ? raw : redact(raw);
  }

  let decision = params.decision;
  const decisionScan = containsRawPii(decision);
  if (!decisionScan.clean) decision = redact(decision);

  await prisma.auditEvent.create({
    data: {
      ticketId: params.ticketId,
      step: params.step,
      decision,
      ruleCited: params.ruleCited ?? null,
      sourceData: sourceDataStr,
      actor: params.actor,
    },
  });
}

/**
 * Convenience: writes one audit event per rule citation collected
 * during classification or vehicle selection, so each individual rule
 * consultation — pass or fail — has its own traceable row.
 */
export async function writeCitationAuditEvents(
  ticketId: string,
  step: "CLASSIFY" | "SELECT_VEHICLE",
  citations: RuleCitation[]
): Promise<void> {
  for (const citation of citations) {
    await writeAuditEvent({
      ticketId,
      step,
      decision: citation.reason,
      ruleCited: citation.rule,
      actor: "system",
    });
  }
}
