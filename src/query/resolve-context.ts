import { prisma } from "../lib/db.js";
import { normalizeRegistration, looksLikeValidRegistration } from "../lib/normalize.js";

/**
 * Deterministic entity resolution for a natural-language question —
 * NOT an LLM call. Finds which Vehicle/Client/Driver (if any) the
 * question is plausibly about, using simple keyword/pattern matching
 * against the DB. This keeps grounding entirely under our control:
 * the LLM never decides WHICH records are relevant, only how to
 * phrase an answer FROM records this function already found.
 */

export interface ResolvedContext {
  vehicles: Array<{
    id: string;
    registrationNumber: string;
    vehicleId: string;
    model: string | null;
    year: number | null;
    bsStage: string | null;
    homeHub: string | null;
    status: string | null;
  }>;
  clients: Array<{
    id: string;
    canonicalName: string;
    effectiveSlaHours: number | null;
    contractSlaHours: number | null;
  }>;
  facts: Array<{
    fieldName: string;
    value: string;
    sourceFile: string;
    sourceLocator: string | null;
    conflictsWith: string | null;
    precedenceRule: string | null;
  }>;
  trips: Array<{
    tripId: string;
    client: string | null;
    status: string | null;
    dispatchTime: Date | null;
    actualTimeMin: number | null;
  }>;
}

const KNOWN_CLIENTS = ["Shakti Cement", "Vertex Retail", "Apex Chemicals", "Orion Pharma"];

/**
 * Extracts any substring of the question that looks like a vehicle
 * registration (loosely — word-boundary tokens run through the same
 * normalizer/validator used everywhere else in the codebase).
 */
function extractPossibleRegistrations(question: string): string[] {
  const tokens = question.match(/[A-Za-z]{2}[\s-]?\d{1,2}[\s-]?[A-Za-z]{1,3}[\s-]?\d{1,4}/g) ?? [];
  return tokens
    .map((t) => normalizeRegistration(t))
    .filter((t) => looksLikeValidRegistration(t));
}

function extractMentionedClients(question: string): string[] {
  const lower = question.toLowerCase();
  return KNOWN_CLIENTS.filter((c) => lower.includes(c.toLowerCase()));
}

export async function resolveQuestionContext(question: string): Promise<ResolvedContext> {
  const context: ResolvedContext = { vehicles: [], clients: [], facts: [], trips: [] };

  const regCandidates = extractPossibleRegistrations(question);
  for (const reg of regCandidates) {
    const vehicle = await prisma.vehicle.findUnique({ where: { registrationNumber: reg } });
    if (vehicle) {
      context.vehicles.push({
        id: vehicle.id,
        registrationNumber: vehicle.registrationNumber,
        vehicleId: vehicle.vehicleId,
        model: vehicle.model,
        year: vehicle.year,
        bsStage: vehicle.bsStage,
        homeHub: vehicle.homeHub,
        status: vehicle.status,
      });

      const vehicleFacts = await prisma.resolvedFact.findMany({
        where: { entityType: "VEHICLE", entityId: vehicle.id },
      });
      context.facts.push(...vehicleFacts.map(toFactRecord));

      const trips = await prisma.trip.findMany({
        where: { vehicleId: vehicle.id },
        include: { client: true },
        orderBy: { dispatchTime: "desc" },
        take: 5,
      });
      context.trips.push(
        ...trips.map((t) => ({
          tripId: t.tripId,
          client: t.client?.canonicalName ?? null,
          status: t.status,
          dispatchTime: t.dispatchTime,
          actualTimeMin: t.actualTimeMin,
        }))
      );
    }
  }

  const clientNames = extractMentionedClients(question);
  for (const name of clientNames) {
    const client = await prisma.client.findUnique({ where: { canonicalName: name } });
    if (client) {
      context.clients.push({
        id: client.id,
        canonicalName: client.canonicalName,
        effectiveSlaHours: client.effectiveSlaHours,
        contractSlaHours: client.contractSlaHours,
      });

      const clientFacts = await prisma.resolvedFact.findMany({
        where: { entityType: "CLIENT", entityId: client.id },
      });
      context.facts.push(...clientFacts.map(toFactRecord));

      // Also pick up GENERAL facts extracted from a source file whose
      // name references this client (e.g. thread_01_shakti_sla.txt),
      // since some client-relevant facts land as GENERAL when the
      // entity-matching pass at extraction time didn't resolve them.
      const generalFacts = await prisma.resolvedFact.findMany({
        where: {
          entityType: "GENERAL",
          sourceFile: { contains: name.toLowerCase().split(" ")[0] ?? name },
        },
      });
      context.facts.push(...generalFacts.map(toFactRecord));
    }
  }

  return context;
}

function toFactRecord(f: {
  fieldName: string;
  value: string;
  sourceFile: string;
  sourceLocator: string | null;
  conflictsWith: string | null;
  precedenceRule: string | null;
}) {
  return {
    fieldName: f.fieldName,
    value: f.value,
    sourceFile: f.sourceFile,
    sourceLocator: f.sourceLocator,
    conflictsWith: f.conflictsWith,
    precedenceRule: f.precedenceRule,
  };
}

export function hasAnyGrounding(context: ResolvedContext): boolean {
  return context.vehicles.length > 0 || context.clients.length > 0 || context.facts.length > 0 || context.trips.length > 0;
}
