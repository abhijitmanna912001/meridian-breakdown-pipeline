import { z } from "zod";

/**
 * The fixed shape an LLM extraction pass must produce when reading an
 * unstructured source (interview transcript, email thread) and pulling
 * out operational rules or facts.
 *
 * Design intent: the LLM's job is narrow — read text, extract facts
 * matching THIS shape. It does not decide pipeline logic, does not
 * resolve conflicts, and does not choose which rule wins. All of that
 * happens afterward in plain TypeScript (src/rules/), so every
 * decision the pipeline makes can be traced to a specific extracted
 * fact with its source excerpt, not to an opaque LLM judgment call.
 */

export const ExtractedFactSchema = z.object({
  // What kind of fact this is — keeps extraction results groupable
  // and lets the rules engine query "give me all CLIENT_SLA facts".
  category: z.enum([
    "CLIENT_SLA", // e.g. Shakti's real 36hr window vs contract's 48hr
    "CLIENT_DELIVERY_WINDOW", // e.g. Vertex's 6pm gate cutoff
    "CLIENT_ROTATION_RULE", // e.g. Apex — no same vehicle twice in a row
    "CLIENT_VEHICLE_REQUIREMENT", // e.g. Orion — 2020+ vehicles only
    "SEASONAL_ROUTE_RESTRICTION", // e.g. BS4 banned on Delhi NCR routes Oct-Feb
    "VEHICLE_ELIGIBILITY_RULE", // e.g. grounded if >30 days overdue service
    "BREAKDOWN_DISPATCH_RULE", // e.g. within 50km -> origin hub sends replacement
    "DRIVER_RULE", // e.g. new drivers <6mo no solo night runs
    "REPAIR_RULE", // e.g. jugaad fixes need permanent repair within 7 days
    "DATA_CONFLICT", // a fact that contradicts structured data (fleet_master, etc.)
    "OTHER",
  ]),

  // Plain-language statement of the rule/fact, in the extractor's own
  // words — short, unambiguous, written so the rules engine or a
  // human reviewer can act on it without re-reading the source.
  ruleText: z.string().min(1),

  // Which entity this fact is about, if identifiable. Not every fact
  // attaches to a specific entity (e.g. the jugaad-reminder email
  // named no vehicle) — appliesTo is null in that case, and the fact
  // is still recorded as a general policy statement.
  appliesTo: z
    .object({
      type: z.enum(["CLIENT", "VEHICLE", "DRIVER", "GENERAL"]),
      // canonical name for CLIENT (e.g. "Shakti Cement"), a
      // registration string for VEHICLE (any raw format — normalized
      // later), a driver_id for DRIVER, or omitted/null for GENERAL.
      // Accepts both — in practice, different LLMs emit either an
      // absent key or an explicit `null` for "no identifier", and both
      // mean the same thing here, so both are accepted rather than
      // rejecting a well-formed extraction over that stylistic choice.
      identifier: z.string().nullable().optional(),
    })
    .nullable(),

  // A short verbatim-or-near-verbatim excerpt from the source that
  // supports this fact — this is the citation. Kept short deliberately
  // (a phrase, not a paragraph) to respect copyright/quoting limits
  // and because a shorter excerpt is a more precise citation anyway.
  sourceExcerpt: z.string().min(1).max(300),

  // True if the extractor noticed this fact appears to contradict
  // something a structured data source would say (e.g. an email
  // claiming a vehicle's year that likely differs from fleet_master).
  // This does NOT mean the fact is wrong — it flags it for the
  // precedence-resolution step to check against the DB.
  possibleConflict: z.boolean().default(false),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

// An LLM extraction response is an array of zero or more facts found
// in one source document. Zero facts is a valid, non-error result —
// not every email thread necessarily contains an operational rule.
export const ExtractionResponseSchema = z.array(ExtractedFactSchema);

export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

/**
 * Validates a raw LLM response (already JSON-parsed) against the
 * schema. Never throws — mirrors the same discriminated-result
 * pattern used for ticket validation, so a malformed LLM response
 * degrades to "zero facts extracted, logged as a parse failure"
 * rather than crashing the ingestion run.
 */
export type ExtractionValidationResult =
  | { ok: true; facts: ExtractionResponse }
  | { ok: false; reason: string; rawResponse: unknown };

export function validateExtractionResponse(rawResponse: unknown): ExtractionValidationResult {
  const result = ExtractionResponseSchema.safeParse(rawResponse);

  if (result.success) {
    return { ok: true, facts: result.data };
  }

  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return { ok: false, reason, rawResponse };
}
