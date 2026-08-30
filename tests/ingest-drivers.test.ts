import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDriversCsv } from "../src/ingest/drivers.js";

function writeTempCsv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "drivers-test-"));
  const path = join(dir, "drivers_roster.csv");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("ingestDriversCsv", () => {
  it("never returns a raw phone, dl_number, or aadhaar value anywhere in the result", () => {
    const csv = [
      "driver_id,name,phone,dl_number,aadhaar,joining_date,home_hub",
      "DRV-001,Advik Maharaj,+91 8361473242,HR16 20128663605,6515 3369 7284,2019-11-10,Ambala",
    ].join("\n");

    const result = ingestDriversCsv(writeTempCsv(csv));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("8361473242");
    expect(serialized).not.toContain("HR16 20128663605");
    expect(serialized).not.toContain("6515 3369 7284");
    expect(serialized).not.toContain("Advik Maharaj"); // name also excluded from the record
  });

  it("produces the same masked ref for the same driver across two ingestion runs", () => {
    const csv = [
      "driver_id,name,phone,dl_number,aadhaar,joining_date,home_hub",
      "DRV-001,Advik Maharaj,+91 8361473242,HR16 20128663605,6515 3369 7284,2019-11-10,Ambala",
    ].join("\n");

    const path = writeTempCsv(csv);
    const resultA = ingestDriversCsv(path);
    const resultB = ingestDriversCsv(path);

    expect(resultA.drivers[0]!.maskedRef).toBe(resultB.drivers[0]!.maskedRef);
  });

  it("flags a driver joined within the last 6 months as new (no solo night runs)", () => {
    const recentDate = new Date();
    recentDate.setMonth(recentDate.getMonth() - 2);
    const dateStr = recentDate.toISOString().slice(0, 10);

    const csv = [
      "driver_id,name,phone,dl_number,aadhaar,joining_date,home_hub",
      `DRV-999,New Driver,+91 9999999999,HR16 99999999999,9999 9999 9999,${dateStr},Ambala`,
    ].join("\n");

    const result = ingestDriversCsv(writeTempCsv(csv), new Date());
    expect(result.drivers[0]!.isNewDriver).toBe(true);
  });

  it("flags a driver with 14 years tenure as not new", () => {
    const csv = [
      "driver_id,name,phone,dl_number,aadhaar,joining_date,home_hub",
      "DRV-998,Veteran Driver,+91 8888888888,HR16 88888888888,8888 8888 8888,2012-01-15,Gurgaon",
    ].join("\n");

    const result = ingestDriversCsv(writeTempCsv(csv), new Date());
    expect(result.drivers[0]!.isNewDriver).toBe(false);
  });

  it("quarantines a row with a missing driver_id, never throws", () => {
    const csv = [
      "driver_id,name,phone,dl_number,aadhaar,joining_date,home_hub",
      ",Some Name,+91 8888888888,HR16 88888888888,8888 8888 8888,2012-01-15,Gurgaon",
    ].join("\n");

    const result = ingestDriversCsv(writeTempCsv(csv));
    expect(result.drivers).toHaveLength(0);
    expect(result.quarantined).toHaveLength(1);
  });
});
