import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateTicket, type Ticket } from "../schemas/ticket.js";
import { normalizeRegistration, looksLikeValidRegistration } from "../lib/normalize.js";
import { prisma } from "../lib/db.js";
import { detectJugaadMention, computeJugaadWindow } from "./jugaad-detection.js";

/**
 * Step 1 (validate) and Step 2 (enrich) of the breakdown-to-resolution
 * pipeline.
 *
 * CONFIRMED from the real tickets.json:
 *   - Duplicate ticket_ids exist (TKT-0020, TKT-0009, TKT-0024 each
 *     appear twice — the second copy has "(sync copy)" appended to
 *     its resolution_note, matching the brief's "duplicate ticket ids
 *     from a sync fault").
 *   - Two genuinely broken records exist: TKT-9102 (empty origin_hub/
 *     destination/issue/severity, invalid created_at, malformed
 *     vehicle reg) and TKT-9101 (empty vehicle, null driver_id, null
 *     km_from_origin_hub).
 *   - Most tickets are status=CLOSED with a resolution_note already
 *     present; a small number are OPEN. Design decision (documented,
 *     not a silent choice): EVERY valid, non-duplicate ticket gets a
 *     work order — status informs classification (an already-CLOSED
 *     ticket's audit trail cites its resolution_note rather than
 *     treating it as an active emergency), it does not gate whether
 *     the ticket is processed at all. This matches the brief's
 *     "exactly one work order per unique valid ticket, no matter how
 *     many times it appears in the queue" — which implies coverage
 *     of the whole queue, not a filtered subset.
 */

export interface EnrichedTicket {
  ticket: Ticket;
  vehicle: {
    id: string;
    registrationNumber: string;
    bsStage: string | null;
    year: number | null;
    engineHeater: boolean;
    homeHub: string | null;
    lastServiceDate: Date | null;
    lastBrakeWorkDate: Date | null;
    jugaadPatchedAt: Date | null;
    jugaadDeadline: Date | null;
  } | null;
  driver: {
    id: string;
    isNewDriver: boolean;
    homeHub: string | null;
  } | null;
  client: {
    id: string;
    canonicalName: string;
    effectiveSlaHours: number | null;
  } | null;
  enrichmentGaps: string[]; // human-readable notes on anything that couldn't be resolved
}

export type TicketProcessingOutcome =
  | { status: "DUPLICATE"; ticketId: string }
  | { status: "QUARANTINED"; rawRecord: unknown; reason: string }
  | { status: "ENRICHED"; enriched: EnrichedTicket };

/**
 * Reads and JSON-parses the ticket queue file. Never throws past this
 * point in a way that would crash the pipeline — a malformed top-level
 * JSON file is itself a quarantine-worthy condition for the WHOLE run,
 * surfaced clearly rather than as an unhandled exception.
 */
export function loadTicketQueue(filePath: string): { records: unknown[]; parseError?: string } {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    return { records: [], parseError: `Could not read file: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { records: [], parseError: "Top-level JSON is not an array — expected a list of ticket records." };
    }
    return { records: parsed };
  } catch (err) {
    return { records: [], parseError: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function hashQueueFile(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Step 1: validate one raw record and detect duplicates against the
 * set of ticket_ids already seen in THIS run. Cross-run duplicate
 * protection (a ticket appearing again in a later pipeline execution)
 * is enforced separately at the database level via WorkOrder's unique
 * constraint on ticketId — this function only handles in-file dupes.
 */
export function classifyRawRecord(
  rawRecord: unknown,
  seenTicketIds: Set<string>
): { status: "DUPLICATE"; ticketId: string } | { status: "QUARANTINED"; reason: string } | { status: "VALID"; ticket: Ticket } {
  const validation = validateTicket(rawRecord);

  if (!validation.ok) {
    return { status: "QUARANTINED", reason: validation.reason };
  }

  if (seenTicketIds.has(validation.ticket.ticket_id)) {
    return { status: "DUPLICATE", ticketId: validation.ticket.ticket_id };
  }

  return { status: "VALID", ticket: validation.ticket };
}

/**
 * Step 2: enrich a validated ticket with full context — vehicle,
 * driver, client, and relevant history — by querying the entity
 * store built during ingestion. A vehicle/driver/client that cannot
 * be resolved is NOT a quarantine reason (the ticket is still real
 * and needs handling) — it's recorded as an enrichment gap, which the
 * classification step and audit log surface honestly rather than
 * silently proceeding as if the context were complete.
 */
/**
 * Upserts the BreakdownTicket row itself — this is the parent record
 * that WorkOrder, ClientMessage, and AuditEvent all foreign-key
 * against via ticketId. Must run before any of those three are
 * written for a given ticket. Idempotent: re-running on the same
 * ticket_id updates the existing row rather than creating a second
 * one, consistent with "duplicates processed exactly once."
 */
export async function upsertBreakdownTicket(
  ticket: Ticket,
  rawRecord: unknown,
  vehicleDbId: string | null,
  driverDbId: string | null,
  clientDbId: string | null
): Promise<void> {
  const createdAtSource = new Date(ticket.created_at);

  await prisma.breakdownTicket.upsert({
    where: { ticketId: ticket.ticket_id },
    update: {
      status: "PROCESSED",
      vehicleId: vehicleDbId,
      driverId: driverDbId,
      clientId: clientDbId,
    },
    create: {
      ticketId: ticket.ticket_id,
      status: "PROCESSED",
      rawPayload: JSON.stringify(rawRecord),
      createdAtSource: Number.isNaN(createdAtSource.getTime()) ? null : createdAtSource,
      vehicleId: vehicleDbId,
      driverId: driverDbId,
      clientId: clientDbId,
    },
  });
}

export async function enrichTicket(ticket: Ticket): Promise<EnrichedTicket> {
  const gaps: string[] = [];

  const normalizedReg = normalizeRegistration(ticket.vehicle);
  let vehicleRecord: EnrichedTicket["vehicle"] = null;

  if (!looksLikeValidRegistration(normalizedReg)) {
    gaps.push(`vehicle registration "${ticket.vehicle}" does not match expected format after normalization`);
  } else {
    const vehicle = await prisma.vehicle.findUnique({ where: { registrationNumber: normalizedReg } });
    if (!vehicle) {
      gaps.push(`vehicle ${normalizedReg} not found in resolved fleet data`);
    } else {
      let jugaadPatchedAt = vehicle.jugaadPatchedAt;
      let jugaadDeadline = vehicle.jugaadDeadline;

      // Detect a jugaad mention on THIS ticket's resolution_note and
      // persist it, so the dispatcher's 7-day/home-region rule has
      // real data to act on for future tickets involving this
      // vehicle, not just an always-null field. Only sets a NEW
      // window if one isn't already on record and still active —
      // never overwrites an existing, still-active jugaad window with
      // a stale/duplicate detection from a re-run.
      if (detectJugaadMention(ticket.resolution_note) && !jugaadPatchedAt) {
        const window = computeJugaadWindow(ticket.created_at);
        if (window) {
          await prisma.vehicle.update({
            where: { id: vehicle.id },
            data: { jugaadPatchedAt: window.patchedAt, jugaadDeadline: window.deadline },
          });
          jugaadPatchedAt = window.patchedAt;
          jugaadDeadline = window.deadline;
        }
      }

      vehicleRecord = {
        id: vehicle.id,
        registrationNumber: vehicle.registrationNumber,
        bsStage: vehicle.bsStage,
        year: vehicle.year,
        engineHeater: vehicle.engineHeater,
        homeHub: vehicle.homeHub,
        lastServiceDate: vehicle.lastServiceDate,
        lastBrakeWorkDate: vehicle.lastBrakeWorkDate,
        jugaadPatchedAt,
        jugaadDeadline,
      };
    }
  }

  let driverRecord: EnrichedTicket["driver"] = null;
  const driver = await prisma.driver.findUnique({ where: { driverId: ticket.driver_id } });
  if (!driver) {
    gaps.push(`driver ${ticket.driver_id} not found in resolved driver roster`);
  } else {
    driverRecord = { id: driver.id, isNewDriver: driver.isNewDriver, homeHub: driver.homeHub };
  }

  let clientRecord: EnrichedTicket["client"] = null;
  if (ticket.client !== "Internal") {
    const client = await prisma.client.findUnique({ where: { canonicalName: ticket.client } });
    if (!client) {
      gaps.push(`client "${ticket.client}" not found in resolved client data`);
    } else {
      clientRecord = {
        id: client.id,
        canonicalName: client.canonicalName,
        effectiveSlaHours: client.effectiveSlaHours,
      };
    }
  }

  return { ticket, vehicle: vehicleRecord, driver: driverRecord, client: clientRecord, enrichmentGaps: gaps };
}
