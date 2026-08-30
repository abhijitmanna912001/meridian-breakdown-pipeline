import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFleetCsv } from "../src/ingest/fleet.js";

function writeTempCsv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  const path = join(dir, "fleet_master.csv");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("ingestFleetCsv", () => {
  it("merges a duplicate row (same vehicle, different registration format) into one vehicle", () => {
    // Mirrors the real confirmed pattern: a primary row with a clean
    // vehicle_id, and a duplicate row with blank vehicle_id and a
    // dashed/lowercase registration format for the SAME vehicle.
    const csv = [
      "vehicle_id,registration_number,model,year,bs_stage,engine_heater,home_hub,capacity_tonnes,status",
      "MF-034,HR16SP9238,Ashok Leyland 3520,2024,BS6,Yes,Gurgaon,31,Active",
      ",hr-16-sp-9238,Ashok Leyland 3520,2024,BS6,Yes,Gurgaon,31,Active",
    ].join("\n");

    const result = ingestFleetCsv(writeTempCsv(csv));

    expect(result.vehicles).toHaveLength(1);
    expect(result.duplicateRowsMerged).toBe(1);

    const vehicle = result.vehicles[0]!;
    expect(vehicle.vehicleId).toBe("MF-034"); // preserved from the primary row
    expect(vehicle.registrationNumber).toBe("HR16SP9238");
    expect(vehicle.rawRegistrations).toContain("HR16SP9238");
    expect(vehicle.rawRegistrations).toContain("hr-16-sp-9238");
  });

  it("fills a missing field on the primary row from the duplicate row", () => {
    // Confirmed pattern: some duplicate rows have blank capacity_tonnes
    // or engine_heater on ONE of the two rows.
    const csv = [
      "vehicle_id,registration_number,model,year,bs_stage,engine_heater,home_hub,capacity_tonnes,status",
      "MF-100,DL30AN8381,Eicher Pro 6028,2022,BS6,,Delhi,,Active",
      ",dl-30-an-8381,Eicher Pro 6028,2022,BS6,Yes,Delhi,21,Active",
    ].join("\n");

    const result = ingestFleetCsv(writeTempCsv(csv));

    expect(result.vehicles).toHaveLength(1);
    const vehicle = result.vehicles[0]!;
    // primary row's blanks should be backfilled from the secondary row
    expect(vehicle.engineHeater).toBe(true);
    expect(vehicle.capacityTonnes).toBe(21);
  });

  it("quarantines a row with a missing registration number, never throws", () => {
    const csv = [
      "vehicle_id,registration_number,model,year,bs_stage,engine_heater,home_hub,capacity_tonnes,status",
      "MF-999,,Eicher Pro 6028,2022,BS6,Yes,Delhi,21,Active",
    ].join("\n");

    const result = ingestFleetCsv(writeTempCsv(csv));

    expect(result.vehicles).toHaveLength(0);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]!.reason).toContain("registration_number");
  });

  it("keeps two genuinely different vehicles separate", () => {
    const csv = [
      "vehicle_id,registration_number,model,year,bs_stage,engine_heater,home_hub,capacity_tonnes,status",
      "MF-001,DL13XI5012,Ashok Leyland 3520,2016,BS4,No,Delhi,16,Active",
      "MF-002,HR21SN1520,Tata LPT 3118,2012,BS4,No,Ambala,21,Active",
    ].join("\n");

    const result = ingestFleetCsv(writeTempCsv(csv));

    expect(result.vehicles).toHaveLength(2);
    expect(result.duplicateRowsMerged).toBe(0);
  });
});
