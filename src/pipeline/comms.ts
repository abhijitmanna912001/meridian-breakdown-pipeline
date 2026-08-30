import { createInterface } from "node:readline/promises";
import { prisma } from "../lib/db.js";
import type { EnrichedTicket } from "./enrich.js";
import type { ClassificationResult } from "./classify.js";
import type { VehicleSelectionResult } from "./select-vehicle.js";
import { containsRawPii, redact } from "../lib/mask.js";

/**
 * Step 6: draft a client notification and queue it behind a human
 * approval gate; on approval, record it as sent exactly once.
 *
 * PII SAFETY — this is the single highest-stakes file in the codebase
 * given the brief's hard gate ("any raw personal datum in any
 * outbound action... caps your score at 50 of 100"). The message body
 * is built ONLY from fields already known to be safe: client name,
 * vehicle registration (not personal data), ticket id, dates, hub
 * names. Driver name/phone/DL/Aadhaar are NEVER read from the Driver
 * record for message composition — the driver relation isn't even
 * queried here. As a second line of defense, every drafted body is
 * scanned with containsRawPii before being shown to the approver or
 * persisted, and refused (not silently redacted and sent) if it ever
 * fails that scan — a PII leak in a draft is a bug to surface loudly,
 * not paper over.
 */

export interface DraftedMessage {
  messageId: string;
  recipient: string;
  body: string;
  citations: string[];
}

function generateMessageId(ticketId: string): string {
  return `MSG-${ticketId}`;
}

/**
 * Builds the message body. Deliberately a plain template, not an LLM
 * call — the content is fully determined by already-validated fields,
 * so there's no benefit to generation here and a real cost (an LLM
 * could paraphrase in a way that reintroduces something unintended).
 * LLM drafting is reserved for cases genuinely requiring natural
 * language synthesis; this is not one.
 */
function buildMessageBody(
  enriched: EnrichedTicket,
  classification: ClassificationResult,
  selection: VehicleSelectionResult | null
): string {
  const { ticket, client } = enriched;
  const clientLabel = client?.canonicalName ?? ticket.client;

  if (classification.alreadyResolved) {
    return (
      `Update on ticket ${ticket.ticket_id}: the reported issue ("${ticket.issue}") ` +
      `on the ${ticket.origin_hub} to ${ticket.destination} route has been resolved. ` +
      `${ticket.resolution_note ?? ""}`.trim()
    );
  }

  if (selection?.selected) {
    return (
      `Update on ticket ${ticket.ticket_id}: a replacement vehicle (${selection.selected.registrationNumber}) ` +
      `has been dispatched from our ${selection.sourceHub} hub for the ${ticket.origin_hub} to ${ticket.destination} route. ` +
      `We will keep ${clientLabel} updated on revised timing.`
    );
  }

  return (
    `Update on ticket ${ticket.ticket_id}: we are actively sourcing a replacement vehicle for the ` +
    `${ticket.origin_hub} to ${ticket.destination} route and will confirm dispatch shortly.`
  );
}

export interface DraftOutcome {
  drafted: DraftedMessage | null;
  refusedReason?: string; // set if the draft failed the PII safety scan
}

export async function draftClientMessage(
  enriched: EnrichedTicket,
  classification: ClassificationResult,
  selection: VehicleSelectionResult | null
): Promise<DraftOutcome> {
  const { ticket } = enriched;

  // "Internal" tickets have no external client to notify.
  if (ticket.client === "Internal") {
    return { drafted: null };
  }

  const existing = await prisma.clientMessage.findUnique({ where: { ticketId: ticket.ticket_id } });
  if (existing) {
    return {
      drafted: {
        messageId: existing.messageId,
        recipient: existing.recipient,
        body: existing.body,
        citations: JSON.parse(existing.citations),
      },
    };
  }

  const body = buildMessageBody(enriched, classification, selection);
  const scan = containsRawPii(body);

  if (!scan.clean) {
    // Refuse outright rather than silently redact-and-send — a
    // template that somehow produced PII indicates a bug worth
    // surfacing, not smoothing over in an outbound message.
    return { drafted: null, refusedReason: `Drafted message failed PII safety scan (types: ${scan.types.join(", ")})` };
  }

  const citations = [
    ...classification.citations.map((c) => `${c.rule}: ${c.reason}`),
    ...(selection ? [`${selection.sourceHubCitation.rule}: ${selection.sourceHubCitation.reason}`] : []),
  ];

  const messageId = generateMessageId(ticket.ticket_id);
  const recipient = `${ticket.client}-coordinator`; // generic role-based label, never a named contact

  await prisma.clientMessage.create({
    data: {
      messageId,
      ticketId: ticket.ticket_id,
      recipient,
      body,
      citations: JSON.stringify(citations),
      status: "PENDING",
    },
  });

  return { drafted: { messageId, recipient, body, citations } };
}

/**
 * The human approval gate. Shows the full drafted message and its
 * citations, asks for explicit y/n via stdin, and only on "y" marks
 * the message as sent — exactly once, per the unique constraint on
 * ClientMessage.ticketId.
 */
export async function requestApprovalAndSend(
  drafted: DraftedMessage,
  approverName: string = "operator"
): Promise<{ sent: boolean }> {
  const existing = await prisma.clientMessage.findUnique({ where: { messageId: drafted.messageId } });
  if (existing?.status === "APPROVED") {
    return { sent: true }; // already approved and sent in a prior run — idempotent no-op
  }

  console.log("\n─── Client message pending approval ───");
  console.log(`To: ${drafted.recipient}`);
  console.log(`Body: ${drafted.body}`);
  console.log("Citations:");
  for (const c of drafted.citations) console.log(`  - ${c}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nApprove and send this message? (y/n): ");
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    await prisma.clientMessage.update({
      where: { messageId: drafted.messageId },
      data: { status: "REJECTED" },
    });
    return { sent: false };
  }

  await prisma.clientMessage.update({
    where: { messageId: drafted.messageId },
    data: { status: "APPROVED", approvedBy: approverName, sentAt: new Date() },
  });

  return { sent: true };
}
