import { prisma } from "../lib/db.js";
import type { ExtractedFact } from "./schema.js";
import { normalizeRegistration, looksLikeValidRegistration } from "../lib/normalize.js";

/**
 * Takes validated ExtractedFact objects (already checked against
 * ExtractedFactSchema) and writes them to ResolvedFact, resolving
 * entity references and checking for conflicts against structured
 * data already in the DB.
 *
 * Precedence rule (documented, applied deterministically — never a
 * silent LLM guess): when an extracted fact's possibleConflict flag
 * is set AND it concerns a field the structured CSVs also populate
 * (currently: Vehicle.year), the STRUCTURED SOURCE WINS. This mirrors
 * the real confirmed case in the data: an internal email claims
 * vehicle RJ43DD3546 is a "2021 model," but fleet_master.csv says
 * 2017 — and the email thread's own reply says "check the RC... verify
 * against fleet master," i.e. the humans in the scenario already
 * encode this precedence themselves. We follow the same rule instead
 * of inventing one.
 *
 * For facts with no structured-data counterpart (SLA windows, gate
 * cutoffs, rotation rules, etc.), there is nothing to conflict with —
 * these are simply recorded, since fleet_master/trips/drivers never
 * claim to know a client's real SLA.
 */

export interface PersistFactOutcome {
  stored: boolean;
  conflictDetected: boolean;
  reason?: string; // set when stored is false
}

async function resolveClientEntityId(identifier: string): Promise<string | null> {
  const client = await prisma.client.findUnique({ where: { canonicalName: identifier } });
  return client?.id ?? null;
}

async function resolveVehicleEntityId(identifier: string): Promise<string | null> {
  const normalized = normalizeRegistration(identifier);
  if (!looksLikeValidRegistration(normalized)) return null;
  const vehicle = await prisma.vehicle.findUnique({ where: { registrationNumber: normalized } });
  return vehicle?.id ?? null;
}

/**
 * Checks a DATA_CONFLICT-flagged fact against the one structured
 * field we currently know how to cross-check: Vehicle.year. Returns
 * the structured value if a conflict is confirmed, so it can be
 * recorded alongside the extracted claim.
 */
async function checkVehicleYearConflict(
  vehicleEntityId: string,
  ruleText: string
): Promise<{ conflict: boolean; structuredYear?: number } > {
  const yearMatch = ruleText.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return { conflict: false };

  const claimedYear = Number(yearMatch[0]);
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleEntityId },
    select: { year: true },
  });

  if (vehicle?.year && vehicle.year !== claimedYear) {
    return { conflict: true, structuredYear: vehicle.year };
  }
  return { conflict: false };
}

export async function persistExtractedFact(
  fact: ExtractedFact,
  sourceFile: string
): Promise<PersistFactOutcome> {
  let entityType = fact.appliesTo?.type ?? "GENERAL";
  let entityId: string | null = null;

  if (fact.appliesTo?.type === "CLIENT" && fact.appliesTo.identifier) {
    entityId = await resolveClientEntityId(fact.appliesTo.identifier);
    if (!entityId) {
      // Client mentioned in text doesn't match a resolved Client
      // entity (e.g. name variant we haven't seen in trips data).
      // Still record the fact — unattached — rather than dropping it;
      // a human or a later pass can re-link it. Never silently lose
      // an extracted rule because of an entity-matching miss.
      entityType = "GENERAL";
    }
  } else if (fact.appliesTo?.type === "VEHICLE" && fact.appliesTo.identifier) {
    entityId = await resolveVehicleEntityId(fact.appliesTo.identifier);
    if (!entityId) entityType = "GENERAL";
  } else if (fact.appliesTo?.type === "DRIVER" && fact.appliesTo.identifier) {
    const driver = await prisma.driver.findUnique({
      where: { driverId: fact.appliesTo.identifier },
    });
    entityId = driver?.id ?? null;
    if (!entityId) entityType = "GENERAL";
  }

  let conflictsWith: string | null = null;
  let precedenceRule: string | null = null;
  let conflictDetected = false;

  if (fact.possibleConflict && entityType === "VEHICLE" && entityId) {
    const check = await checkVehicleYearConflict(entityId, fact.ruleText);
    if (check.conflict) {
      conflictDetected = true;
      conflictsWith = JSON.stringify({
        extractedClaim: fact.ruleText,
        structuredValue: check.structuredYear,
        structuredSource: "fleet_master.csv",
      });
      precedenceRule =
        "Structured source (fleet_master.csv) takes precedence over an unverified email/interview claim for factual fields like vehicle year. " +
        "Documented because the source material itself instructs verifying against fleet master before acting on such claims.";
    }
  }

  await prisma.resolvedFact.create({
    data: {
      entityType,
      entityId: entityId ?? "unattached",
      fieldName: fact.category,
      value: fact.ruleText,
      sourceFile,
      sourceLocator: fact.sourceExcerpt,
      conflictsWith,
      precedenceRule,
    },
  });

  return { stored: true, conflictDetected };
}

export async function persistExtractedFacts(
  facts: ExtractedFact[],
  sourceFile: string
): Promise<{ stored: number; conflictsDetected: number }> {
  let stored = 0;
  let conflictsDetected = 0;

  for (const fact of facts) {
    const outcome = await persistExtractedFact(fact, sourceFile);
    if (outcome.stored) stored += 1;
    if (outcome.conflictDetected) conflictsDetected += 1;
  }

  return { stored, conflictsDetected };
}
