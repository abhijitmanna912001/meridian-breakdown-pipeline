/**
 * Confirmed against the real candidate_bundle data: the same vehicle's
 * registration appears in at least three different raw forms across
 * files, e.g.:
 *   "UP-40-IM-3144"   (tickets.json)
 *   "RJ43DD3546"      (fleet_master.csv)
 *   "UK 79 WJ 9666"   (meridian_trips.csv)
 *
 * This function strips all separators and uppercases, so all three
 * shapes above collapse to one canonical key we can match entities on:
 *   "UP40IM3144", "RJ43DD3546", "UK79WJ9666"
 *
 * This is intentionally the ONLY thing this function does. Fancier
 * fuzzy matching (OCR-style corrections, etc.) is explicitly out of
 * scope — the brief rewards a documented, defensible rule over a
 * clever guess.
 */
export function normalizeRegistration(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-]/g, "")
    .trim();
}

/**
 * Basic shape check for an Indian vehicle registration once normalized.
 * Used to flag registrations that don't even loosely match the expected
 * pattern (state code + district + series + number) so they can be
 * quarantined with a clear reason rather than silently mismatched to
 * the wrong vehicle.
 */
const REGISTRATION_PATTERN = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/;

export function looksLikeValidRegistration(normalized: string): boolean {
  return REGISTRATION_PATTERN.test(normalized);
}
