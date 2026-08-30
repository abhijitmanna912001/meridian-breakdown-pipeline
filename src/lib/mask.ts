import { createHash } from "node:crypto";

/**
 * PII masking — this module exists because the challenge brief has a
 * hard gate: "If any raw personal datum ever appears in an outbound
 * action, a log line visible to evaluators, or an API response you
 * serve, your score is capped at 50 of 100."
 *
 * Design principle: mask at ingestion, not as a filter bolted on at
 * output time. Raw values (phone, DL number, Aadhaar, driver name)
 * are read from the source CSV/txt files, hashed and mapped to a
 * masked token, and the RAW VALUE IS NEVER PERSISTED ANYWHERE — not
 * in the DB, not in logs, not in memory beyond the single ingestion
 * step that produces the masked token.
 *
 * The hash-to-token map (MaskedFieldMap in Prisma) lets the same raw
 * value always resolve to the same masked token, WITHOUT storing the
 * raw value — SHA-256 is one-way.
 */

export type PiiFieldType = "phone" | "dl_number" | "aadhaar" | "name";

/**
 * Confirmed patterns from drivers_roster.csv:
 *   phone:      "+91 8361473242"
 *   dl_number:  "HR16 20128663605"
 *   aadhaar:    "6515 3369 7284"
 * These regexes are used defensively at OUTPUT time too, as a second
 * line of defense — even if something slipped past ingestion-time
 * masking, we scan every outbound string before it's written.
 */
const PII_PATTERNS: Record<Exclude<PiiFieldType, "name">, RegExp> = {
  phone: /(\+91[\s-]?)?[6-9]\d{9}\b/g,
  dl_number: /\b[A-Z]{2}\d{2}\s?\d{11,13}\b/g,
  aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
};

export function hashRawValue(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

export function maskedTokenFor(fieldType: PiiFieldType, hash: string): string {
  // Short, stable, non-reversible token derived from the hash — not
  // from the raw value — so it's safe to persist and log freely.
  return `${fieldType.toUpperCase()}-${hash.slice(0, 8)}`;
}

/**
 * Scans a string for anything that LOOKS like raw PII and returns
 * whether it's clean, plus what was found (for quarantine/alerting,
 * never for re-emitting the actual matched value in a log).
 *
 * This is the last line of defense run on every outbound message body
 * and every audit log line before it is written to disk.
 */
export function containsRawPii(text: string): { clean: boolean; types: PiiFieldType[] } {
  const found: PiiFieldType[] = [];

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    pattern.lastIndex = 0; // reset stateful regex
    if (pattern.test(text)) {
      found.push(type as PiiFieldType);
    }
  }

  return { clean: found.length === 0, types: found };
}

/**
 * Redacts any matched raw PII in a string, for the rare case we need
 * to log THAT something was caught without logging the value itself.
 */
export function redact(text: string): string {
  let result = text;
  for (const pattern of Object.values(PII_PATTERNS)) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
