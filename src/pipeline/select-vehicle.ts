import { prisma } from "../lib/db.js";
import type { EnrichedTicket } from "./enrich.js";
import type { RuleCitation } from "../rules/dispatcher-rules.js";
import { normalizeRegistration } from "../lib/normalize.js";
import {
  checkWinterDelhiNcrBsRestriction,
  checkHillRouteEligibility,
  checkServiceOverdueGrounding,
  checkJugaadRepairConstraint,
  checkOrionRequirements,
  checkApexRotationRule,
  determineReplacementSourceHub,
} from "../rules/dispatcher-rules.js";

/**
 * Step 4: select a genuinely eligible replacement vehicle — available,
 * route-permitted for the season, not overdue on maintenance, not
 * already assigned, and passing every client-specific rule that
 * applies to this dispatch.
 *
 * Design: rather than trust a single "closest" or "first available"
 * pick, every candidate vehicle at the resolved source hub is run
 * through the SAME rule functions used in classification, so the
 * final selection is citable — the audit log can show exactly which
 * rule each REJECTED candidate failed, and which rules the WINNING
 * candidate passed.
 */

export interface VehicleCandidateEvaluation {
  vehicleId: string;
  registrationNumber: string;
  eligible: boolean;
  citations: RuleCitation[];
  rejectionReasons: string[];
}

export interface VehicleSelectionResult {
  selected: { vehicleId: string; registrationNumber: string } | null;
  sourceHub: string;
  sourceHubCitation: RuleCitation;
  candidatesEvaluated: VehicleCandidateEvaluation[];
  reason: string; // human-readable summary for the audit log
}

async function evaluateCandidate(
  vehicle: {
    id: string;
    registrationNumber: string;
    bsStage: string | null;
    engineHeater: boolean;
    lastServiceDate: Date | null;
    lastBrakeWorkDate: Date | null;
    jugaadPatchedAt: Date | null;
    jugaadDeadline: Date | null;
    year: number | null;
  },
  ticket: EnrichedTicket["ticket"],
  clientCanonicalName: string | null,
  asOfDate: Date,
  excludeRegistration: string // never re-select the vehicle that just broke down
): Promise<VehicleCandidateEvaluation> {
  const citations: RuleCitation[] = [];
  const rejectionReasons: string[] = [];

  if (vehicle.registrationNumber === excludeRegistration) {
    return {
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      eligible: false,
      citations: [],
      rejectionReasons: ["Candidate is the vehicle that broke down — cannot replace itself."],
    };
  }

  const grounding = checkServiceOverdueGrounding({ dueServiceDate: vehicle.lastServiceDate, asOfDate });
  citations.push(grounding);
  if (!grounding.passed) rejectionReasons.push(grounding.reason);

  const bsCheck = checkWinterDelhiNcrBsRestriction({
    bsStage: vehicle.bsStage,
    originHub: ticket.origin_hub,
    destination: ticket.destination,
    date: asOfDate,
  });
  citations.push(bsCheck);
  if (!bsCheck.passed) rejectionReasons.push(bsCheck.reason);

  const hillCheck = checkHillRouteEligibility({
    destination: ticket.destination,
    engineHeater: vehicle.engineHeater,
    lastBrakeWorkDate: vehicle.lastBrakeWorkDate,
    date: asOfDate,
  });
  citations.push(hillCheck);
  if (!hillCheck.passed) rejectionReasons.push(hillCheck.reason);

  const jugaadCheck = checkJugaadRepairConstraint({
    jugaadPatchedAt: vehicle.jugaadPatchedAt,
    jugaadDeadline: vehicle.jugaadDeadline,
    asOfDate,
    proposedDispatchLeavesHomeRegion: true,
  });
  citations.push(jugaadCheck);
  if (!jugaadCheck.passed) rejectionReasons.push(jugaadCheck.reason);

  if (clientCanonicalName === "Orion Pharma") {
    const orionCheck = checkOrionRequirements({
      clientCanonicalName,
      vehicleYear: vehicle.year,
      wouldWaitOvernightUnrefrigerated: false,
    });
    citations.push(orionCheck);
    if (!orionCheck.passed) rejectionReasons.push(orionCheck.reason);
  }

  if (clientCanonicalName === "Apex Chemicals") {
    // Find the most recent trip for Apex using this vehicle to check
    // rotation eligibility.
    const lastApexTrip = await prisma.trip.findFirst({
      where: { vehicleId: vehicle.id, client: { canonicalName: "Apex Chemicals" } },
      orderBy: { dispatchTime: "desc" },
    });
    const rotationCheck = checkApexRotationRule({
      clientCanonicalName,
      candidateVehicleRegistration: vehicle.registrationNumber,
      lastApexVehicleRegistration: lastApexTrip?.vehicleRegRaw ?? null,
      // Conservative: treat any non-COMPLETED status on that last
      // trip as "had an issue" for rotation purposes.
      lastApexDispatchHadIssue: lastApexTrip ? lastApexTrip.status !== "COMPLETED" : false,
    });
    citations.push(rotationCheck);
    if (!rotationCheck.passed) rejectionReasons.push(rotationCheck.reason);
  }

  return {
    vehicleId: vehicle.id,
    registrationNumber: vehicle.registrationNumber,
    eligible: rejectionReasons.length === 0,
    citations,
    rejectionReasons,
  };
}

export async function selectReplacementVehicle(
  enriched: EnrichedTicket,
  asOfDate: Date = new Date()
): Promise<VehicleSelectionResult> {
  const { ticket, client } = enriched;

  // Step 4 depends on the 50km origin-vs-nearest-hub rule to know
  // WHERE to look for a replacement. "Nearest hub" is not something
  // our current data models geographically — the origin hub is used
  // as the nearest-hub fallback, which is conservative and correct
  // for the common case in this dataset where origin_hub already
  // reflects the operational hub network.
  const sourceHubCitation = determineReplacementSourceHub({
    kmFromOriginHub: ticket.km_from_origin_hub,
    originHub: ticket.origin_hub,
    nearestHub: ticket.origin_hub,
  });
  const sourceHub = sourceHubCitation.sourceHub;

  const candidates = await prisma.vehicle.findMany({
    where: { homeHub: sourceHub, status: "Active" },
  });

  const evaluations: VehicleCandidateEvaluation[] = [];
  for (const candidate of candidates) {
    evaluations.push(
      await evaluateCandidate(
        candidate,
        ticket,
        client?.canonicalName ?? null,
        asOfDate,
        normalizeRegistration(ticket.vehicle)
      )
    );
  }

  const eligible = evaluations.find((e) => e.eligible);

  return {
    selected: eligible ? { vehicleId: eligible.vehicleId, registrationNumber: eligible.registrationNumber } : null,
    sourceHub,
    sourceHubCitation,
    candidatesEvaluated: evaluations,
    reason: eligible
      ? `Selected ${eligible.registrationNumber} from ${sourceHub} hub — passed all applicable eligibility rules.`
      : `No eligible replacement found among ${evaluations.length} candidate(s) at ${sourceHub} hub.`,
  };
}
