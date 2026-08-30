import type { EnrichedTicket } from "./enrich.js";
import type { RuleCitation } from "../rules/dispatcher-rules.js";
import {
  checkWinterDelhiNcrBsRestriction,
  checkHillRouteEligibility,
  getEffectiveSlaHours,
  checkApexRotationRule,
  checkOrionRequirements,
  determineReplacementSourceHub,
  checkServiceOverdueGrounding,
  checkJugaadRepairConstraint,
  checkNewDriverNightRunRestriction,
} from "../rules/dispatcher-rules.js";

/**
 * Step 3: classify a breakdown's severity and required action using
 * the dispatcher's encoded rules — every applicable rule is consulted
 * and its citation collected, so the decision is fully traceable in
 * the audit log. This function does NOT call an LLM: severity
 * classification and rule application are deterministic, citable
 * TypeScript logic per the challenge brief's explicit requirement.
 */

export type ResolvedSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface ClassificationResult {
  severity: ResolvedSeverity;
  alreadyResolved: boolean; // true when ticket.status === "CLOSED" with a resolution_note
  requiresReplacementVehicle: boolean;
  citations: RuleCitation[];
  blockingIssues: string[]; // reasons the ORIGINAL vehicle should not be redispatched, if any
}

/**
 * Escalates severity when a rule fires that the raw ticket's own
 * severity field wouldn't reflect — e.g. a LOW-severity ticket
 * involving a client with a strict rotation/age requirement the
 * current vehicle fails is functionally more urgent than the raw
 * field suggests, because it blocks the obvious "just send it again"
 * resolution.
 */
function escalateSeverity(base: ResolvedSeverity, blockingIssueCount: number): ResolvedSeverity {
  if (blockingIssueCount === 0) return base;
  if (base === "LOW") return "MEDIUM";
  return "HIGH";
}

export function classifyTicket(enriched: EnrichedTicket, asOfDate: Date = new Date()): ClassificationResult {
  const { ticket, vehicle, driver, client } = enriched;
  const citations: RuleCitation[] = [];
  const blockingIssues: string[] = [];

  const alreadyResolved = ticket.status === "CLOSED" && Boolean(ticket.resolution_note);

  // Service-overdue grounding — absolute rule, applies regardless of
  // client or route.
  if (vehicle) {
    const groundingCheck = checkServiceOverdueGrounding({
      dueServiceDate: vehicle.lastServiceDate,
      asOfDate,
    });
    citations.push(groundingCheck);
    if (!groundingCheck.passed) {
      blockingIssues.push(groundingCheck.reason);
    }
  }

  // Winter Delhi NCR BS-stage restriction.
  if (vehicle) {
    const bsCheck = checkWinterDelhiNcrBsRestriction({
      bsStage: vehicle.bsStage,
      originHub: ticket.origin_hub,
      destination: ticket.destination,
      date: asOfDate,
    });
    citations.push(bsCheck);
    if (!bsCheck.passed) blockingIssues.push(bsCheck.reason);
  }

  // Hill route (Rudrapur/Nainital) winter requirements.
  if (vehicle) {
    const hillCheck = checkHillRouteEligibility({
      destination: ticket.destination,
      engineHeater: vehicle.engineHeater,
      lastBrakeWorkDate: vehicle.lastBrakeWorkDate,
      date: asOfDate,
    });
    citations.push(hillCheck);
    if (!hillCheck.passed) blockingIssues.push(hillCheck.reason);
  }

  // Jugaad 7-day / home-region constraint.
  if (vehicle) {
    const jugaadCheck = checkJugaadRepairConstraint({
      jugaadPatchedAt: vehicle.jugaadPatchedAt,
      jugaadDeadline: vehicle.jugaadDeadline,
      asOfDate,
      // A breakdown by definition means the vehicle is mid-trip, away
      // from home — treated conservatively as "leaves home region."
      proposedDispatchLeavesHomeRegion: true,
    });
    citations.push(jugaadCheck);
    if (!jugaadCheck.passed) blockingIssues.push(jugaadCheck.reason);
  }

  // Client-specific rules.
  if (client) {
    const slaCheck = getEffectiveSlaHours(client.canonicalName);
    if (slaCheck.hours !== null) citations.push(slaCheck);

    if (client.canonicalName === "Apex Chemicals" && vehicle) {
      // Eligibility-relevant, but requires dispatch history we don't
      // have loaded here — the vehicle-selection step (Step 4) is
      // where this rule actually gates a REPLACEMENT choice; at
      // classification time we only note the SLA/requirement
      // categories that apply so the audit trail shows every rule
      // consulted for this client, not just the ones that fired.
      citations.push({
        rule: "APEX_VEHICLE_ROTATION",
        sourceExcerpt: "If a truck has any issue on an Apex run... that same truck does not go back to Apex on the very next dispatch.",
        passed: true,
        reason: "Apex Chemicals dispatch — rotation rule will be enforced at replacement vehicle selection.",
      });
    }

    if (client.canonicalName === "Orion Pharma" && vehicle) {
      const orionCheck = checkOrionRequirements({
        clientCanonicalName: client.canonicalName,
        vehicleYear: vehicle.year,
        wouldWaitOvernightUnrefrigerated: false, // breakdown ticket, not a hub-wait scenario
      });
      citations.push(orionCheck);
      if (!orionCheck.passed) blockingIssues.push(orionCheck.reason);
    }
  }

  // New driver / night run restriction. Ticket has no explicit
  // time-of-day field beyond created_at — use its hour as a proxy for
  // whether this was/is a night dispatch.
  if (driver && ticket.created_at) {
    const createdAtDate = new Date(ticket.created_at);
    if (!Number.isNaN(createdAtDate.getTime())) {
      const hour = createdAtDate.getHours();
      const isNightRun = hour >= 22 || hour < 5;
      const driverCheck = checkNewDriverNightRunRestriction({
        isNewDriver: driver.isNewDriver,
        isNightRun,
        isPaired: false, // ticket data does not indicate pairing; conservative default
      });
      citations.push(driverCheck);
      if (!driverCheck.passed) blockingIssues.push(driverCheck.reason);
    }
  }

  // Origin-hub-vs-nearest-hub rule always applies to a breakdown and
  // is always cited, since it governs Step 4 regardless of outcome.
  citations.push(
    determineReplacementSourceHub({
      kmFromOriginHub: ticket.km_from_origin_hub,
      originHub: ticket.origin_hub,
      nearestHub: ticket.origin_hub, // nearest-hub lookup happens in Step 4; placeholder citation here
    })
  );

  const baseSeverity = (ticket.severity || "MEDIUM") as ResolvedSeverity;
  const severity = escalateSeverity(baseSeverity, blockingIssues.length);

  return {
    severity,
    alreadyResolved,
    requiresReplacementVehicle: !alreadyResolved,
    citations,
    blockingIssues,
  };
}
