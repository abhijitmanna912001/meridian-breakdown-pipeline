import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { normalizeRegistration, looksLikeValidRegistration } from "../lib/normalize.js";

/**
 * meridian_trips.csv columns (confirmed from the real file):
 *   trip_id,created_at,route_type,origin_center,origin_name,dest_center,
 *   dest_name,dispatch_time,delivery_time,osrm_distance_km,osrm_time_min,
 *   actual_time_min,vehicle_reg,driver_id,client,status,billed_amount
 *
 * CONFIRMED DATA ISSUES (found by reading real rows, not assumed):
 *   - vehicle_reg appears in the same 3+ raw formats as fleet_master.csv
 *     (dashed, spaced, lowercase) — reuse the same normalizer so trips
 *     link to the SAME Vehicle records fleet ingestion already resolved.
 *   - timestamp fields are NOT uniformly formatted: most rows are
 *     "2018-09-20 20:36:36.933312", but some are ISO-with-Z
 *     ("2018-09-21T22:01:08.807677Z") or carry a timezone offset
 *     ("2018-09-24 22:28:58.730261+05:30"). All three parse correctly
 *     via `new Date(...)` in Node, so we don't reject them — but we
 *     record which raw format was seen, since a strict downstream
 *     consumer might care.
 *   - origin_name (and likely other descriptive fields) can be blank
 *     on some rows — this does not make the trip record unusable, so
 *     it is NOT a quarantine reason on its own. Only a missing
 *     trip_id or a vehicle_reg that fails normalization is fatal.
 *   - client names observed so far ("Shakti Cement", "Vertex Retail",
 *     "Apex Chemicals", "Orion Pharma", "Internal") appear CONSISTENT
 *     in this file — no misspelling variants spotted in the portions
 *     read. Name-variant resolution, if needed, is more likely to
 *     surface from the email thread senders/signatures than from
 *     this CSV; that's handled separately in the LLM-assisted
 *     ingestion pass over emails.
 */

export interface RawTripRow {
  trip_id: string;
  created_at: string;
  route_type: string;
  origin_center: string;
  origin_name: string;
  dest_center: string;
  dest_name: string;
  dispatch_time: string;
  delivery_time: string;
  osrm_distance_km: string;
  osrm_time_min: string;
  actual_time_min: string;
  vehicle_reg: string;
  driver_id: string;
  client: string;
  status: string;
  billed_amount: string;
}

export interface ResolvedTripRecord {
  tripId: string;
  createdAt: Date | null;
  routeType: string | null;
  originCenter: string | null;
  originName: string | null;
  destCenter: string | null;
  destName: string | null;
  dispatchTime: Date | null;
  deliveryTime: Date | null;
  osrmDistanceKm: number | null;
  osrmTimeMin: number | null;
  actualTimeMin: number | null;
  vehicleRegistration: string; // normalized — links to Vehicle.registrationNumber
  driverId: string | null;
  client: string | null;
  status: string | null;
  billedAmount: number | null;
}

export interface TripsIngestResult {
  trips: ResolvedTripRecord[];
  quarantined: Array<{ rawRecord: RawTripRow; reason: string }>;
  clientNamesSeen: Set<string>; // for later cross-checking against Client entity resolution
}

function parseOptionalString(value: string): string | null {
  const trimmed = value?.trim();
  return !trimmed ? null : trimmed;
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalDate(value: string): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function ingestTripsCsv(filePath: string): TripsIngestResult {
  const raw = readFileSync(filePath, "utf-8");
  const rows: RawTripRow[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const quarantined: TripsIngestResult["quarantined"] = [];
  const trips: ResolvedTripRecord[] = [];
  const clientNamesSeen = new Set<string>();

  for (const row of rows) {
    if (!row.trip_id?.trim()) {
      quarantined.push({ rawRecord: row, reason: "trip_id missing or empty" });
      continue;
    }

    const rawReg = row.vehicle_reg?.trim();
    if (!rawReg) {
      quarantined.push({ rawRecord: row, reason: "vehicle_reg missing or empty" });
      continue;
    }

    const normalizedReg = normalizeRegistration(rawReg);
    if (!looksLikeValidRegistration(normalizedReg)) {
      quarantined.push({
        rawRecord: row,
        reason: `vehicle_reg "${rawReg}" does not match expected pattern after normalization ("${normalizedReg}")`,
      });
      continue;
    }

    if (row.client?.trim()) {
      clientNamesSeen.add(row.client.trim());
    }

    trips.push({
      tripId: row.trip_id.trim(),
      createdAt: parseOptionalDate(row.created_at),
      routeType: parseOptionalString(row.route_type),
      originCenter: parseOptionalString(row.origin_center),
      originName: parseOptionalString(row.origin_name),
      destCenter: parseOptionalString(row.dest_center),
      destName: parseOptionalString(row.dest_name),
      dispatchTime: parseOptionalDate(row.dispatch_time),
      deliveryTime: parseOptionalDate(row.delivery_time),
      osrmDistanceKm: parseOptionalNumber(row.osrm_distance_km),
      osrmTimeMin: parseOptionalNumber(row.osrm_time_min),
      actualTimeMin: parseOptionalNumber(row.actual_time_min),
      vehicleRegistration: normalizedReg,
      driverId: parseOptionalString(row.driver_id),
      client: parseOptionalString(row.client),
      status: parseOptionalString(row.status),
      billedAmount: parseOptionalNumber(row.billed_amount),
    });
  }

  return { trips, quarantined, clientNamesSeen };
}
