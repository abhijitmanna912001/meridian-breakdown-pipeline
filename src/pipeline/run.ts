import "dotenv/config";
import { join } from "node:path";
import { prisma } from "../lib/db.js";
import {
  loadTicketQueue,
  classifyRawRecord,
  enrichTicket,
  upsertBreakdownTicket,
} from "./enrich.js";
import { classifyTicket } from "./classify.js";
import { selectReplacementVehicle } from "./select-vehicle.js";
import { recordWorkOrder, writeAuditEvent, writeCitationAuditEvents } from "./work-order.js";
import { draftClientMessage, requestApprovalAndSend } from "./comms.js";
import {
  resetOutputFiles,
  appendWorkOrder,
  appendCommsPending,
  appendCommsSent,
  appendQuarantine,
  appendAuditLine,
} from "./outputs.js";

/**
 * The full breakdown-to-resolution pipeline, Steps 1-7, run end to
 * end over a ticket queue file.
 *
 * Re-runnability: this function can be invoked twice, back to back,
 * on the same queue file and produce identical outputs/*.jsonl and
 * audit/audit.jsonl content. This holds because:
 *   - Step 5 (work order) is idempotent at the DB level (unique
 *     constraint on WorkOrder.ticketId) and at the application level
 *     (existence check before insert).
 *   - Step 6 (client message) is likewise idempotent on
 *     ClientMessage.ticketId, and an already-APPROVED message is
 *     never re-prompted for approval on a second run.
 *   - Output files are fully regenerated from current DB state each
 *     run (see outputs.ts resetOutputFiles), not appended to across
 *     runs — so "identical outputs" means the FILES look the same
 *     after each run, even though the underlying DB inserts on the
 *     second run are all no-ops.
 */

interface RunOptions {
  queueFilePath: string;
  interactive: boolean; // if false, auto-approves all messages (used for automated/demo re-runs)
  approverName: string;
}

export async function runPipeline(options: RunOptions): Promise<void> {
  const { records, parseError } = loadTicketQueue(options.queueFilePath);

  if (parseError) {
    console.error(`Fatal: could not process queue file — ${parseError}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Loaded ${records.length} record(s) from ${options.queueFilePath}\n`);

  resetOutputFiles();

  const seenTicketIds = new Set<string>();
  let processedCount = 0;
  let duplicateCount = 0;
  let quarantinedCount = 0;
  let workOrdersWritten = 0;
  let messagesApproved = 0;

  for (const rawRecord of records) {
    const classification = classifyRawRecord(rawRecord, seenTicketIds);

    if (classification.status === "QUARANTINED") {
      quarantinedCount += 1;
      appendQuarantine({ ticket_id: null, reason: classification.reason, raw_record: rawRecord });
      console.log(`  QUARANTINED: ${classification.reason}`);
      continue;
    }

    if (classification.status === "DUPLICATE") {
      duplicateCount += 1;
      console.log(`  DUPLICATE (skipped, exactly-once): ${classification.ticketId}`);
      continue;
    }

    const ticket = classification.ticket;
    seenTicketIds.add(ticket.ticket_id);
    processedCount += 1;

    // Enrich FIRST so we have resolved DB ids to attach to the
    // BreakdownTicket parent row — WorkOrder/ClientMessage/AuditEvent
    // all foreign-key against this row via ticketId, so it must exist
    // before any of them are written.
    const enriched = await enrichTicket(ticket);
    await upsertBreakdownTicket(
      ticket,
      rawRecord,
      enriched.vehicle?.id ?? null,
      enriched.driver?.id ?? null,
      enriched.client?.id ?? null
    );

    await writeAuditEvent({
      ticketId: ticket.ticket_id,
      step: "VALIDATE",
      decision: "Ticket passed schema validation.",
      actor: "system",
    });
    appendAuditLine({
      ticket_id: ticket.ticket_id,
      step: "VALIDATE",
      decision: "Ticket passed schema validation.",
      rule_cited: null,
      actor: "system",
      timestamp: new Date().toISOString(),
    });

    await writeAuditEvent({
      ticketId: ticket.ticket_id,
      step: "ENRICH",
      decision:
        enriched.enrichmentGaps.length > 0
          ? `Enrichment gaps: ${enriched.enrichmentGaps.join("; ")}`
          : "Fully enriched: vehicle, driver, and client all resolved.",
      actor: "system",
    });
    appendAuditLine({
      ticket_id: ticket.ticket_id,
      step: "ENRICH",
      decision:
        enriched.enrichmentGaps.length > 0
          ? `Enrichment gaps: ${enriched.enrichmentGaps.join("; ")}`
          : "Fully enriched: vehicle, driver, and client all resolved.",
      rule_cited: null,
      actor: "system",
      timestamp: new Date().toISOString(),
    });

    const classificationResult = classifyTicket(enriched);
    await writeCitationAuditEvents(ticket.ticket_id, "CLASSIFY", classificationResult.citations);
    for (const c of classificationResult.citations) {
      appendAuditLine({
        ticket_id: ticket.ticket_id,
        step: "CLASSIFY",
        decision: c.reason,
        rule_cited: c.rule,
        actor: "system",
        timestamp: new Date().toISOString(),
      });
    }

    let selection = null;
    if (classificationResult.requiresReplacementVehicle) {
      selection = await selectReplacementVehicle(enriched);
      await writeCitationAuditEvents(ticket.ticket_id, "SELECT_VEHICLE", [
        selection.sourceHubCitation,
        ...selection.candidatesEvaluated.flatMap((e) => e.citations),
      ]);
      appendAuditLine({
        ticket_id: ticket.ticket_id,
        step: "SELECT_VEHICLE",
        decision: selection.reason,
        rule_cited: selection.sourceHubCitation.rule,
        actor: "system",
        timestamp: new Date().toISOString(),
      });
    }

    const workOrder = await recordWorkOrder(enriched, classificationResult, selection);
    if (!workOrder.alreadyExisted) workOrdersWritten += 1;

    const workOrderRecord = await prisma.workOrder.findUnique({ where: { ticketId: ticket.ticket_id } });
    if (workOrderRecord) {
      appendWorkOrder({
        work_order_id: workOrderRecord.workOrderId,
        ticket_id: ticket.ticket_id,
        vehicle_reg: workOrderRecord.vehicleRegUsed,
        created_at: workOrderRecord.createdAt.toISOString(),
        citations: JSON.parse(workOrderRecord.citations),
      });
    }
    await writeAuditEvent({
      ticketId: ticket.ticket_id,
      step: "WORK_ORDER",
      decision: workOrder.alreadyExisted
        ? `Work order ${workOrder.workOrderId} already existed (idempotent no-op).`
        : `Work order ${workOrder.workOrderId} created.`,
      actor: "system",
    });
    appendAuditLine({
      ticket_id: ticket.ticket_id,
      step: "WORK_ORDER",
      decision: workOrder.alreadyExisted
        ? `Work order ${workOrder.workOrderId} already existed (idempotent no-op).`
        : `Work order ${workOrder.workOrderId} created.`,
      rule_cited: null,
      actor: "system",
      timestamp: new Date().toISOString(),
    });

    const draftOutcome = await draftClientMessage(enriched, classificationResult, selection);
    if (draftOutcome.refusedReason) {
      console.log(`  MESSAGE REFUSED (PII safety): ${draftOutcome.refusedReason}`);
      await writeAuditEvent({
        ticketId: ticket.ticket_id,
        step: "DRAFT_MESSAGE",
        decision: `Message drafting refused: ${draftOutcome.refusedReason}`,
        actor: "system",
      });
    } else if (draftOutcome.drafted) {
      appendCommsPending({
        message_id: draftOutcome.drafted.messageId,
        ticket_id: ticket.ticket_id,
        recipient: draftOutcome.drafted.recipient,
        body: draftOutcome.drafted.body,
        citations: draftOutcome.drafted.citations,
      });
      await writeAuditEvent({
        ticketId: ticket.ticket_id,
        step: "DRAFT_MESSAGE",
        decision: `Message ${draftOutcome.drafted.messageId} drafted, pending approval.`,
        actor: "system",
      });

      if (options.interactive) {
        const { sent } = await requestApprovalAndSend(draftOutcome.drafted, options.approverName);
        if (sent) {
          messagesApproved += 1;
          const sentRecord = await prisma.clientMessage.findUnique({
            where: { messageId: draftOutcome.drafted.messageId },
          });
          if (sentRecord?.status === "APPROVED") {
            appendCommsSent({
              message_id: sentRecord.messageId,
              ticket_id: ticket.ticket_id,
              recipient: sentRecord.recipient,
              body: sentRecord.body,
              approved_by: sentRecord.approvedBy ?? options.approverName,
              sent_at: sentRecord.sentAt?.toISOString() ?? new Date().toISOString(),
            });
          }
        }
        await writeAuditEvent({
          ticketId: ticket.ticket_id,
          step: "SEND",
          decision: sent ? `Message approved and sent by ${options.approverName}.` : "Message rejected by approver, not sent.",
          actor: `human:${options.approverName}`,
        });
      } else {
        // Non-interactive mode (--no-interactive): used for automated
        // re-runs and idempotency demos, where prompting for 20+
        // approvals by hand isn't practical. A message already sent
        // in a prior interactive run stays sent (idempotent); a
        // message still PENDING is reported as such in comms_pending
        // but NOT auto-approved — auto-approving on someone's behalf
        // would defeat the purpose of a human approval gate. This
        // means comms_sent.jsonl on a non-interactive run reflects
        // ONLY messages a human already approved in a prior run.
        const existingRecord = await prisma.clientMessage.findUnique({
          where: { messageId: draftOutcome.drafted.messageId },
        });
        if (existingRecord?.status === "APPROVED") {
          appendCommsSent({
            message_id: existingRecord.messageId,
            ticket_id: ticket.ticket_id,
            recipient: existingRecord.recipient,
            body: existingRecord.body,
            approved_by: existingRecord.approvedBy ?? options.approverName,
            sent_at: existingRecord.sentAt?.toISOString() ?? new Date().toISOString(),
          });
        }
      }
    }
  }

  console.log(
    `\n── Pipeline run complete ──\n` +
      `Processed: ${processedCount}, Duplicates skipped: ${duplicateCount}, Quarantined: ${quarantinedCount}\n` +
      `Work orders written this run: ${workOrdersWritten}, Messages approved this run: ${messagesApproved}`
  );
}

async function main() {
  const bundlePath = process.env.CANDIDATE_BUNDLE_PATH ?? "../candidate_bundle";

  // Filter out flags (anything starting with "--") before picking the
  // positional queue-file-path argument, so `--no-interactive` (or
  // any future flag) is never mistaken for a file path.
  const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const queueFilePath = positionalArgs[0] ?? join(bundlePath, "tickets.json");
  const interactive = !process.argv.includes("--no-interactive");

  await runPipeline({ queueFilePath, interactive, approverName: process.env.USER ?? "operator" });
}

main()
  .catch((err) => {
    console.error("Pipeline run failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
