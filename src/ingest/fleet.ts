import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { normalizeRegistration, looksLikeValidRegistration } from "../lib/normalize.js";

/**
 * fleet_master.csv columns (confirmed from the real file):
 *   vehicle_id,registration_number,model,year,bs_stage,engine_heater,
 *   home_hub,capacity_tonnes,status
 *
 * CONFIRMED DATA ISSUE (not hypothetical — found by reading the real
 * file): every vehicle appears TWICE. Once as a clean row with an
 * MF-0XX vehicle_id, and once as a "duplicate" row with:
 *   - vehicle_id BLANK
 *   - the same registration in a different raw format (dashes,
 *     spaces, or lowercase — e.g. "HR-41-FO-7216" vs "HR41FO7216")
 *   - sometimes missing capacity_tonnes and/or engine_heater
 *
 * These are the SAME physical vehicle, not two vehicles. Ingestion
 * must merge on normalized registration number, keeping whichever
 * row has more complete data, and recording every raw registration
 * string seen for that vehicle (for audit / citation purposes).
 */

export interface RawFleetRow {
  vehicle_id: string;
  registration_number: string;
  model: string;
  year: string;
  bs_stage: string;
  engine_heater: string;
  home_hub: string;
  capacity_tonnes: string;
  status: string;
}

export interface ResolvedVehicleRecord {
  vehicleId: string | null; // null if never seen with a clean MF-0XX id
  registrationNumber: string; // normalized, canonical
  rawRegistrations: string[]; // every raw string form seen
  model: string | null;
  year: number | null;
  bsStage: string | null;
  engineHeater: boolean;
  homeHub: string | null;
  capacityTonnes: number | null;
  status: string | null;
}

export interface FleetIngestResult {
  vehicles: ResolvedVehicleRecord[];
  quarantined: Array<{ rawRecord: RawFleetRow; reason: string }>;
  duplicateRowsMerged: number;
}

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "yes";
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Merges two candidate records for the SAME normalized registration.
 * Prefers non-null/non-empty values; when both rows have a value for
 * a field, prefers the row that also carries a vehicle_id (the
 * "primary" row), on the assumption the primary row is the more
 * authoritative source. This is a documented, deterministic
 * precedence rule — not a silent guess.
 */
function mergeVehicleRecords(
  a: ResolvedVehicleRecord,
  b: ResolvedVehicleRecord
): ResolvedVehicleRecord {
  const primary = a.vehicleId ? a : b.vehicleId ? b : a;
  const secondary = primary === a ? b : a;

  return {
    vehicleId: primary.vehicleId ?? secondary.vehicleId,
    registrationNumber: primary.registrationNumber,
    rawRegistrations: [
      ...new Set([...a.rawRegistrations, ...b.rawRegistrations]),
    ],
    model: primary.model ?? secondary.model,
    year: primary.year ?? secondary.year,
    bsStage: primary.bsStage ?? secondary.bsStage,
    engineHeater: primary.engineHeater || secondary.engineHeater,
    homeHub: primary.homeHub ?? secondary.homeHub,
    capacityTonnes: primary.capacityTonnes ?? secondary.capacityTonnes,
    status: primary.status ?? secondary.status,
  };
}

export function ingestFleetCsv(filePath: string): FleetIngestResult {
  const raw = readFileSync(filePath, "utf-8");
  const rows: RawFleetRow[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const quarantined: FleetIngestResult["quarantined"] = [];
  const byNormalizedReg = new Map<string, ResolvedVehicleRecord>();
  let duplicateRowsMerged = 0;

  for (const row of rows) {
    const rawReg = row.registration_number?.trim();

    if (!rawReg) {
      quarantined.push({ rawRecord: row, reason: "registration_number missing or empty" });
      continue;
    }

    const normalized = normalizeRegistration(rawReg);

    if (!looksLikeValidRegistration(normalized)) {
      quarantined.push({
        rawRecord: row,
        reason: `registration_number "${rawReg}" does not match expected pattern after normalization ("${normalized}")`,
      });
      continue;
    }

    const candidate: ResolvedVehicleRecord = {
      vehicleId: parseOptionalString(row.vehicle_id),
      registrationNumber: normalized,
      rawRegistrations: [rawReg],
      model: parseOptionalString(row.model),
      year: parseOptionalNumber(row.year),
      bsStage: parseOptionalString(row.bs_stage),
      engineHeater: parseBoolean(row.engine_heater),
      homeHub: parseOptionalString(row.home_hub),
      capacityTonnes: parseOptionalNumber(row.capacity_tonnes),
      status: parseOptionalString(row.status),
    };

    const existing = byNormalizedReg.get(normalized);
    if (existing) {
      byNormalizedReg.set(normalized, mergeVehicleRecords(existing, candidate));
      duplicateRowsMerged += 1;
    } else {
      byNormalizedReg.set(normalized, candidate);
    }
  }

  return {
    vehicles: [...byNormalizedReg.values()],
    quarantined,
    duplicateRowsMerged,
  };
}
