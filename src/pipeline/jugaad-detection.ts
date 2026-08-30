/**
 * Detects a "jugaad" (temporary roadside repair) mention in a
 * ticket's resolution_note, so the dispatcher's 7-day/home-region
 * rule (checkJugaadRepairConstraint in dispatcher-rules.ts) has real
 * data to act on instead of always finding jugaadPatchedAt null.
 *
 * CONFIRMED real phrasing in tickets.json resolution_note field:
 *   "Guddu jugaad se chalu kiya, permanent repair pending."
 * (appears verbatim on at least two tickets: TKT-0017, TKT-0004)
 *
 * Deliberately a simple keyword match, not an LLM call — this is
 * exactly the kind of narrow, deterministic, citable check the rules
 * engine is built around. "jugaad" is a specific enough term in this
 * operational context that a substring match is low-risk; broader
 * free-text parsing would be a different, LLM-appropriate task, not
 * needed for this signal.
 */
export function detectJugaadMention(resolutionNote: string | undefined | null): boolean {
  if (!resolutionNote) return false;
  return /jugaad/i.test(resolutionNote);
}

/**
 * Given a ticket's created_at as the best available anchor for "when
 * this repair happened" (the data has no separate repair-completion
 * timestamp), computes the jugaad patch date and its 7-day deadline.
 * Returns null if the ticket's created_at can't be parsed — this is
 * treated the same as "date unknown," not a crash.
 */
export function computeJugaadWindow(
  ticketCreatedAt: string
): { patchedAt: Date; deadline: Date } | null {
  const patchedAt = new Date(ticketCreatedAt);
  if (Number.isNaN(patchedAt.getTime())) return null;

  const deadline = new Date(patchedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { patchedAt, deadline };
}
