import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestTripsCsv } from "../src/ingest/trips.js";

function writeTempCsv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trips-test-"));
  const path = join(dir, "meridian_trips.csv");
  writeFileSync(path, content, "utf-8");
  return path;
}

const HEADER =
  "trip_id,created_at,route_type,origin_center,origin_name,dest_center,dest_name,dispatch_time,delivery_time,osrm_distance_km,osrm_time_min,actual_time_min,vehicle_reg,driver_id,client,status,billed_amount";

describe("ingestTripsCsv", () => {
  it("normalizes vehicle_reg to the same canonical form fleet ingestion uses", () => {
    const csv = [
      HEADER,
      'trip-1,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-17 02:01:10.784442,23.66,36.0,50.0,"UK 79 WJ 9666",DRV-040,Internal,COMPLETED,87963.0',
    ].join("\n");

    const result = ingestTripsCsv(writeTempCsv(csv));
    expect(result.trips).toHaveLength(1);
    expect(result.trips[0]!.vehicleRegistration).toBe("UK79WJ9666");
  });

  it("parses all three confirmed timestamp formats without quarantining", () => {
    // Confirmed real formats: plain, ISO-with-Z, and offset-suffixed.
    const csv = [
      HEADER,
      "trip-1,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-17 02:01:10.784442,1,1,1,DL13XI5012,DRV-001,Internal,COMPLETED,100",
      "trip-2,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-21T22:01:08.807677Z,1,1,1,DL13XI5012,DRV-001,Internal,COMPLETED,100",
      "trip-3,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-24 22:28:58.730261+05:30,1,1,1,DL13XI5012,DRV-001,Internal,COMPLETED,100",
    ].join("\n");

    const result = ingestTripsCsv(writeTempCsv(csv));
    expect(result.trips).toHaveLength(3);
    for (const trip of result.trips) {
      expect(trip.deliveryTime).not.toBeNull();
    }
  });

  it("does not quarantine a row with a blank origin_name", () => {
    // Confirmed real case: origin_name can be empty without the row
    // being unusable — only trip_id and vehicle_reg are load-bearing.
    const csv = [
      HEADER,
      "trip-1,2018-09-26 00:17:21.242320,FTL,IND282002AAD,,IND281004AAA,Mathura_DC,2018-09-26 00:17:21.242320,2018-09-26 03:14:24.195861,67.79,77,45,UK12XR1853,DRV-006,Internal,COMPLETED,72258.0",
    ].join("\n");

    const result = ingestTripsCsv(writeTempCsv(csv));
    expect(result.trips).toHaveLength(1);
    expect(result.trips[0]!.originName).toBeNull();
  });

  it("quarantines a row with a missing vehicle_reg, never throws", () => {
    const csv = [
      HEADER,
      "trip-1,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-17 02:01:10.784442,1,1,1,,DRV-001,Internal,COMPLETED,100",
    ].join("\n");

    const result = ingestTripsCsv(writeTempCsv(csv));
    expect(result.trips).toHaveLength(0);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]!.reason).toContain("vehicle_reg");
  });

  it("collects the distinct client names seen, for later cross-checking", () => {
    const csv = [
      HEADER,
      "trip-1,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-17 02:01:10.784442,1,1,1,DL13XI5012,DRV-001,Shakti Cement,COMPLETED,100",
      "trip-2,2018-09-16 20:25:58.989263,Carting,IND1,A,IND2,B,2018-09-16 20:25:58.989263,2018-09-17 02:01:10.784442,1,1,1,HR21SN1520,DRV-002,Vertex Retail,COMPLETED,100",
    ].join("\n");

    const result = ingestTripsCsv(writeTempCsv(csv));
    expect(result.clientNamesSeen.has("Shakti Cement")).toBe(true);
    expect(result.clientNamesSeen.has("Vertex Retail")).toBe(true);
    expect(result.clientNamesSeen.size).toBe(2);
  });
});
