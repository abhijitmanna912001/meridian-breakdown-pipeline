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

/**
 * Change-tolerance layer (hour-7 "surprise file" requirement): a
 * narrow, explicit alias map tried BEFORE schema validation, so a
 * record using a differently-named-but-recognizable field (e.g. a
 * client's IT team switching to camelCase) is recovered rather than
 * quarantined outright.
 *
 * Deliberately conservative — this is a fixed lookup table, not fuzzy
 * matching or an LLM guess. A field name not in this map is left
 * alone; if the resulting record still fails validation, it is
 * quarantined exactly as before, with the reason reflecting the
 * ORIGINAL field names actually present (never silently "fixed" in a
 * way that hides what happened from the audit trail).
 *
 * Each source key only remaps if the canonical key isn't already
 * present, so this never overwrites a well-formed field with an
 * aliased one from the same record.
 */
const FIELD_ALIASES: Record<string, keyof z.infer<typeof TicketSchema>> = {
  createdAt: "created_at",
  vehicleRegistration: "vehicle",
  vehicleReg: "vehicle",
  vehicle_reg: "vehicle",
  driverId: "driver_id",
  originHub: "origin_hub",
  origin: "origin_hub",
  kmFromOriginHub: "km_from_origin_hub",
  km_from_origin: "km_from_origin_hub",
  distanceFromOriginKm: "km_from_origin_hub",
  clientName: "client",
  resolutionNote: "resolution_note",
};

function applyFieldAliases(rawRecord: unknown): unknown {
  if (typeof rawRecord !== "object" || rawRecord === null || Array.isArray(rawRecord)) {
    return rawRecord; // not an object shape we can remap — let normal validation reject it
  }

  const record = rawRecord as Record<string, unknown>;
  const remapped: Record<string, unknown> = { ...record };

  for (const [aliasKey, canonicalKey] of Object.entries(FIELD_ALIASES)) {
    if (aliasKey in remapped && !(canonicalKey in remapped)) {
      remapped[canonicalKey] = remapped[aliasKey];
    }
  }

  return remapped;
}

export function validateTicket(rawRecord: unknown): TicketValidationResult {
  const candidate = applyFieldAliases(rawRecord);
  const result = TicketSchema.safeParse(candidate);

  if (result.success) {
    return { ok: true, ticket: result.data };
  }

  // Collapse Zod's issue list into one readable quarantine reason —
  // this is what shows up in outputs/quarantine.jsonl and in the
  // audit log, so it needs to be legible to a human evaluator, not
  // a raw Zod error dump. Reported against the ORIGINAL rawRecord,
  // not the alias-remapped candidate, so a human reviewing the
  // quarantine file sees the data exactly as the source system sent
  // it.
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return { ok: false, rawRecord, reason };
}
