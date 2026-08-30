import { z } from "zod";

/**
 * Schema for a raw breakdown ticket exactly as it appears in tickets.json
 * (and, at hour 7, the differently-shaped surprise file).
 *
 * Design intent: this schema is intentionally permissive on OPTIONAL
 * fields and strict on the fields required to safely process a ticket.
 * A record that fails this validation is quarantined with a specific,
 * human-readable reason — it never throws an uncaught exception that
 * would crash the pipeline.
 */
export const TicketSchema = z.object({
  ticket_id: z.string().min(1, "ticket_id missing or empty"),
  created_at: z.string().min(1, "created_at missing or empty"),
  vehicle: z.string().min(1, "vehicle registration missing"),
  driver_id: z.string().min(1, "driver_id missing"),
  origin_hub: z.string().min(1, "origin_hub missing"),
  km_from_origin_hub: z.number({
    invalid_type_error: "km_from_origin_hub must be a number",
  }),
  destination: z.string().min(1, "destination missing"),
  issue: z.string().min(1, "issue description missing"),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"], {
    errorMap: () => ({ message: "severity must be LOW | MEDIUM | HIGH" }),
  }),
  client: z.string().min(1, "client missing"),
  status: z.string().min(1, "status missing"),
  resolution_note: z.string().optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;

/**
 * The result of validating one raw record from the queue.
 * Never throws — always returns a discriminated result the caller
 * can route to either the happy path or quarantine.jsonl.
 */
export type TicketValidationResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; rawRecord: unknown; reason: string };

export function validateTicket(rawRecord: unknown): TicketValidationResult {
  const result = TicketSchema.safeParse(rawRecord);

  if (result.success) {
    return { ok: true, ticket: result.data };
  }

  // Collapse Zod's issue list into one readable quarantine reason —
  // this is what shows up in outputs/quarantine.jsonl and in the
  // audit log, so it needs to be legible to a human evaluator, not
  // a raw Zod error dump.
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return { ok: false, rawRecord, reason };
}
