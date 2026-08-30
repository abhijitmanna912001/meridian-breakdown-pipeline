/**
 * Every function here encodes exactly one rule from the dispatcher's
 * interview transcript (dispatcher_interview.txt), cited by a short
 * quoted excerpt in the RuleCitation returned alongside each result.
 *
 * Design intent, per the challenge brief: "the transcript's rules
 * must be structured, queryable logic that the pipeline consults and
 * cites" — not vibes, and not embedded in an LLM prompt. Every
 * function is pure, synchronous, and independently testable, so a
 * defense-round question ("why did the system pick this vehicle?")
 * can be answered by pointing at one function and its test.
 *
 * A RuleCitation is the unit these functions return so the pipeline's
 * audit log always has something concrete to attach to a decision.
 */

export interface RuleCitation {
  rule: string; // short machine-readable rule id, e.g. "BS4_WINTER_DELHI_BAN"
  sourceExcerpt: string; // short quote from the transcript supporting this rule
  passed: boolean;
  reason: string; // human-readable explanation of the outcome
}

const DELHI_NCR_HUBS = new Set(["Delhi", "Gurgaon", "Faridabad", "Noida"]);
const HILL_ROUTE_DESTINATIONS = new Set(["Rudrapur", "Nainital"]);

/**
 * Rule: October–February, no BS4 vehicle on any route touching
 * Delhi/Gurgaon/Faridabad/Noida — BS6 only, no exceptions for
 * proximity or convenience.
 */
export function checkWinterDelhiNcrBsRestriction(params: {
  bsStage: string | null;
  originHub: string | null;
  destination: string | null;
  date: Date;
}): RuleCitation {
  const rule = "BS4_WINTER_DELHI_NCR_BAN";
  const sourceExcerpt =
    "October to February, no BS4 vehicle goes on any Delhi NCR route... BS6 only on Delhi routes in winter, I don't care if the BS4 truck is parked twenty meters from the loading dock";

  const month = params.date.getMonth() + 1; // 1-12
  const isWinter = month >= 10 || month <= 2;
  const touchesDelhiNcr =
    (params.originHub && DELHI_NCR_HUBS.has(params.originHub)) ||
    (params.destination && DELHI_NCR_HUBS.has(params.destination));

  if (!isWinter || !touchesDelhiNcr) {
    return { rule, sourceExcerpt, passed: true, reason: "Rule does not apply: not winter or not a Delhi NCR route." };
  }

  if (params.bsStage !== "BS6") {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: `Vehicle is ${params.bsStage ?? "unknown BS stage"}, but only BS6 is permitted on Delhi NCR routes Oct-Feb.`,
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "BS6 vehicle on a winter Delhi NCR route: compliant." };
}

/**
 * Rule: Nov–Feb, hill routes (Rudrapur / Nainital-bound), vehicle
 * must have an engine heater AND no brake work in the last 30 days.
 */
export function checkHillRouteEligibility(params: {
  destination: string | null;
  engineHeater: boolean;
  lastBrakeWorkDate: Date | null;
  date: Date;
}): RuleCitation {
  const rule = "HILL_ROUTE_WINTER_REQUIREMENTS";
  const sourceExcerpt =
    "November to February... vehicle must have an engine heater... I never send a vehicle on a hill route if it has had any brake work in the last thirty days";

  const month = params.date.getMonth() + 1;
  const isHillSeason = month >= 11 || month <= 2;
  const isHillRoute = params.destination ? HILL_ROUTE_DESTINATIONS.has(params.destination) : false;

  if (!isHillSeason || !isHillRoute) {
    return { rule, sourceExcerpt, passed: true, reason: "Rule does not apply: not hill season or not a hill route." };
  }

  if (!params.engineHeater) {
    return { rule, sourceExcerpt, passed: false, reason: "Vehicle has no engine heater — required for winter hill routes." };
  }

  if (params.lastBrakeWorkDate) {
    const daysSinceBrakeWork =
      (params.date.getTime() - params.lastBrakeWorkDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceBrakeWork < 30) {
      return {
        rule,
        sourceExcerpt,
        passed: false,
        reason: `Vehicle had brake work ${Math.floor(daysSinceBrakeWork)} days ago — requires 30 days of flat running before hill routes.`,
      };
    }
  }

  return { rule, sourceExcerpt, passed: true, reason: "Engine heater present and no recent brake work: eligible for hill route." };
}

/**
 * Rule: Shakti Cement's real operating SLA is 36 hours, regardless of
 * the 48-hour figure in the written contract.
 */
export function getEffectiveSlaHours(clientCanonicalName: string): RuleCitation & { hours: number | null } {
  const rule = "SHAKTI_EFFECTIVE_SLA_36H";
  const sourceExcerpt =
    "Shakti Cement's contract says 48 hour delivery window. Forget the contract... Shakti is a 36 hour client. Plan everything to 36.";

  if (clientCanonicalName === "Shakti Cement") {
    return { rule, sourceExcerpt, passed: true, reason: "Shakti Cement: effective SLA is 36 hours, overriding the 48-hour contract figure.", hours: 36 };
  }

  return { rule, sourceExcerpt: "", passed: true, reason: "No client-specific SLA override applies.", hours: null };
}

/**
 * Rule: Vertex Retail's Ludhiana warehouse gate closes at 6pm sharp.
 * A delivery that would arrive after 6pm must be held and delivered
 * the next morning at 8am — and this MUST be logged as a "scheduled
 * morning delivery," never as a failed delivery (to avoid Vertex's
 * automatic penalty note).
 */
export function checkVertexGateCutoff(params: {
  clientCanonicalName: string;
  destinationHub: string | null;
  estimatedArrival: Date;
}): RuleCitation & { action: "DELIVER_AS_PLANNED" | "HOLD_UNTIL_MORNING"; deliveryStatusLabel: string } {
  const rule = "VERTEX_LUDHIANA_GATE_CUTOFF";
  const sourceExcerpt =
    "their warehouse at Ludhiana stops accepting after 6 pm... Hold it at the last halt, deliver next morning at 8... it is never marked as a failed delivery. It is a scheduled morning delivery.";

  if (params.clientCanonicalName !== "Vertex Retail" || params.destinationHub !== "Ludhiana") {
    return {
      rule,
      sourceExcerpt,
      passed: true,
      reason: "Rule does not apply: not a Vertex Retail Ludhiana delivery.",
      action: "DELIVER_AS_PLANNED",
      deliveryStatusLabel: "DELIVERED",
    };
  }

  const arrivalHour = params.estimatedArrival.getHours() + params.estimatedArrival.getMinutes() / 60;
  if (arrivalHour >= 18) {
    return {
      rule,
      sourceExcerpt,
      passed: true,
      reason: "Estimated arrival after 6pm gate cutoff — held for scheduled morning delivery, NOT marked as failed.",
      action: "HOLD_UNTIL_MORNING",
      deliveryStatusLabel: "SCHEDULED_MORNING_DELIVERY",
    };
  }

  return {
    rule,
    sourceExcerpt,
    passed: true,
    reason: "Estimated arrival before 6pm gate cutoff — deliver as planned.",
    action: "DELIVER_AS_PLANNED",
    deliveryStatusLabel: "DELIVERED",
  };
}

/**
 * Rule: Apex Chemicals — after any issue (breakdown, late arrival,
 * etc.) on an Apex run, the same vehicle must not be sent on the very
 * next Apex dispatch. At least one different vehicle must be used in
 * between.
 */
export function checkApexRotationRule(params: {
  clientCanonicalName: string;
  candidateVehicleRegistration: string;
  lastApexVehicleRegistration: string | null; // registration used on the immediately prior Apex dispatch
  lastApexDispatchHadIssue: boolean;
}): RuleCitation {
  const rule = "APEX_VEHICLE_ROTATION";
  const sourceExcerpt =
    "If a truck has any issue on an Apex run... that same truck does not go back to Apex on the very next dispatch. Send a different vehicle at least once in between.";

  if (params.clientCanonicalName !== "Apex Chemicals") {
    return { rule, sourceExcerpt, passed: true, reason: "Rule does not apply: not an Apex Chemicals dispatch." };
  }

  if (
    params.lastApexDispatchHadIssue &&
    params.lastApexVehicleRegistration === params.candidateVehicleRegistration
  ) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: "This vehicle had an issue on the immediately prior Apex dispatch — must rotate to a different vehicle.",
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "No rotation conflict for this Apex dispatch." };
}

/**
 * Rule: Orion Pharma — vehicle must be 2020 or later (pharma audit
 * requirement, checked against the RC), and loads must never wait at
 * a hub overnight unrefrigerated.
 */
export function checkOrionRequirements(params: {
  clientCanonicalName: string;
  vehicleYear: number | null;
  wouldWaitOvernightUnrefrigerated: boolean;
}): RuleCitation {
  const rule = "ORION_VEHICLE_AGE_AND_COLD_CHAIN";
  const sourceExcerpt =
    "their consignments always get the newest available vehicle, 2020 or later... their loads never wait at a hub overnight unrefrigerated.";

  if (params.clientCanonicalName !== "Orion Pharma") {
    return { rule, sourceExcerpt, passed: true, reason: "Rule does not apply: not an Orion Pharma dispatch." };
  }

  if (params.vehicleYear === null || params.vehicleYear < 2020) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: `Vehicle year ${params.vehicleYear ?? "unknown"} does not meet Orion's 2020+ requirement — load would be rejected at the gate.`,
    };
  }

  if (params.wouldWaitOvernightUnrefrigerated) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: "This plan would leave an Orion load unrefrigerated overnight at a hub — not permitted.",
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "Vehicle meets Orion's age requirement; no unrefrigerated overnight wait." };
}

/**
 * Rule: July–September, routes east of Lucknow, add 20% to whatever
 * the computed ETA (e.g. OSRM) says, minimum — and quote the padded
 * number to the client upfront rather than the standard SLA.
 */
export function applyMonsoonPadding(params: {
  destination: string | null;
  isEastOfLucknow: boolean; // caller determines geography; kept explicit rather than a hardcoded city list
  computedEtaMinutes: number;
  date: Date;
}): RuleCitation & { paddedEtaMinutes: number } {
  const rule = "MONSOON_EASTERN_ROUTE_PADDING";
  const sourceExcerpt =
    "July to September, anything going east of Lucknow, add twenty percent to whatever time the computer says, minimum... I quote the padded number upfront.";

  const month = params.date.getMonth() + 1;
  const isMonsoon = month >= 7 && month <= 9;

  if (!isMonsoon || !params.isEastOfLucknow) {
    return {
      rule,
      sourceExcerpt,
      passed: true,
      reason: "Rule does not apply: not monsoon season or not east of Lucknow.",
      paddedEtaMinutes: params.computedEtaMinutes,
    };
  }

  const padded = Math.ceil(params.computedEtaMinutes * 1.2);
  return {
    rule,
    sourceExcerpt,
    passed: true,
    reason: `Monsoon + eastern route: padded ETA from ${params.computedEtaMinutes} to ${padded} minutes (+20%), quoted upfront to client.`,
    paddedEtaMinutes: padded,
  };
}

/**
 * Rule: breakdown within 50km of origin hub -> origin hub sends the
 * replacement, always (not "nearest hub" as a naive system would
 * assume) — this deliberately preserves nearest-hub vehicles for
 * premium clients (Orion, Shakti).
 */
export function determineReplacementSourceHub(params: {
  kmFromOriginHub: number;
  originHub: string;
  nearestHub: string;
}): RuleCitation & { sourceHub: string } {
  const rule = "BREAKDOWN_50KM_ORIGIN_HUB_RULE";
  const sourceExcerpt =
    "If a vehicle breaks down within 50 kilometers of its origin hub, the replacement comes from the origin hub. Always... Beyond 50 km, then yes, nearest hub with an eligible vehicle.";

  if (params.kmFromOriginHub <= 50) {
    return {
      rule,
      sourceExcerpt,
      passed: true,
      reason: `Breakdown ${params.kmFromOriginHub}km from origin hub (<=50km): origin hub sends replacement, overriding naive nearest-hub logic. This preserves nearest-hub vehicles for premium client dispatches.`,
      sourceHub: params.originHub,
    };
  }

  return {
    rule,
    sourceExcerpt,
    passed: true,
    reason: `Breakdown ${params.kmFromOriginHub}km from origin hub (>50km): nearest hub with an eligible vehicle sends replacement.`,
    sourceHub: params.nearestHub,
  };
}

/**
 * Rule: any vehicle more than 30 days past its due service date is
 * grounded — absolute, no exceptions for emergencies.
 */
export function checkServiceOverdueGrounding(params: {
  dueServiceDate: Date | null;
  asOfDate: Date;
}): RuleCitation {
  const rule = "SERVICE_OVERDUE_GROUNDING";
  const sourceExcerpt =
    "any vehicle that is more than 30 days past its due service date is grounded. It does not move, I don't care what the emergency is.";

  if (!params.dueServiceDate) {
    return { rule, sourceExcerpt, passed: true, reason: "No due service date on record — cannot confirm overdue, not grounded by this rule." };
  }

  const daysOverdue =
    (params.asOfDate.getTime() - params.dueServiceDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysOverdue > 30) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: `Vehicle is ${Math.floor(daysOverdue)} days overdue on service (>30 day limit) — grounded, no exceptions.`,
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "Vehicle is within the service-overdue grace window — not grounded." };
}

/**
 * Rule: a "jugaad" (temporary roadside) repair starts a 7-day clock —
 * the vehicle must receive a permanent repair within 7 days, and
 * until then must stay within its home region (no long-distance
 * dispatch on a patched fix).
 */
export function checkJugaadRepairConstraint(params: {
  jugaadPatchedAt: Date | null;
  jugaadDeadline: Date | null;
  asOfDate: Date;
  proposedDispatchLeavesHomeRegion: boolean;
}): RuleCitation {
  const rule = "JUGAAD_7DAY_HOME_REGION_RULE";
  const sourceExcerpt =
    "every jugaad of his is a seven day clock. Whatever he patched must get a permanent repair within seven days, and until then that vehicle does not leave its home region.";

  if (!params.jugaadPatchedAt) {
    return { rule, sourceExcerpt, passed: true, reason: "No active jugaad patch on record — rule does not apply." };
  }

  const deadline = params.jugaadDeadline ?? new Date(params.jugaadPatchedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const stillWithinPatchWindow = params.asOfDate <= deadline;

  if (stillWithinPatchWindow && params.proposedDispatchLeavesHomeRegion) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: `Vehicle has an active jugaad patch (permanent repair due by ${deadline.toISOString().slice(0, 10)}) — cannot leave home region until repaired.`,
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "No jugaad-related dispatch restriction applies." };
}

/**
 * Rule: drivers with less than 6 months tenure never go solo on a
 * night run — pair them, or give them day dispatches instead.
 */
export function checkNewDriverNightRunRestriction(params: {
  isNewDriver: boolean;
  isNightRun: boolean;
  isPaired: boolean;
}): RuleCitation {
  const rule = "NEW_DRIVER_NO_SOLO_NIGHT_RUN";
  const sourceExcerpt =
    "New drivers, less than six months with us, never go solo on a night run. Pair them or give them day dispatches... Six months of days and paired nights, then they earn the night solo.";

  if (!params.isNewDriver || !params.isNightRun) {
    return { rule, sourceExcerpt, passed: true, reason: "Rule does not apply: driver is not new, or dispatch is not a night run." };
  }

  if (!params.isPaired) {
    return {
      rule,
      sourceExcerpt,
      passed: false,
      reason: "New driver (<6 months tenure) cannot be dispatched solo on a night run — must be paired or moved to a day dispatch.",
    };
  }

  return { rule, sourceExcerpt, passed: true, reason: "New driver is paired for this night run — compliant." };
}
