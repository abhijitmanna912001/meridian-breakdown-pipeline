import { describe, it, expect } from "vitest";
import { validateTicket } from "../src/schemas/ticket.js";

describe("validateTicket", () => {
  it("accepts a well-formed ticket", () => {
    const raw = {
      ticket_id: "TKT-0027",
      created_at: "2026-08-11T19:00:00",
      vehicle: "UP-40-IM-3144",
      driver_id: "DRV-020",
      origin_hub: "Lucknow",
      km_from_origin_hub: 20,
      destination: "Lucknow",
      issue: "fuel line leak",
      severity: "HIGH",
      client: "Shakti Cement",
      status: "CLOSED",
      resolution_note: "Resolved by roadside assistance.",
    };

    const result = validateTicket(raw);
    expect(result.ok).toBe(true);
  });

  it("quarantines a record missing a required field, without throwing", () => {
    const raw = {
      ticket_id: "TKT-9999",
      created_at: "2026-08-11T19:00:00",
      // vehicle missing entirely
      driver_id: "DRV-020",
      origin_hub: "Lucknow",
      km_from_origin_hub: 20,
      destination: "Lucknow",
      issue: "fuel line leak",
      severity: "HIGH",
      client: "Shakti Cement",
      status: "CLOSED",
    };

    const result = validateTicket(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("vehicle");
    }
  });

  it("quarantines a record with an invalid severity value", () => {
    const raw = {
      ticket_id: "TKT-9998",
      created_at: "2026-08-11T19:00:00",
      vehicle: "UP-40-IM-3144",
      driver_id: "DRV-020",
      origin_hub: "Lucknow",
      km_from_origin_hub: 20,
      destination: "Lucknow",
      issue: "fuel line leak",
      severity: "CATASTROPHIC", // not a valid enum value
      client: "Shakti Cement",
      status: "CLOSED",
    };

    const result = validateTicket(raw);
    expect(result.ok).toBe(false);
  });

  it("never throws on completely malformed input", () => {
    expect(() => validateTicket(null)).not.toThrow();
    expect(() => validateTicket(undefined)).not.toThrow();
    expect(() => validateTicket("not an object")).not.toThrow();
    expect(() => validateTicket(42)).not.toThrow();
    expect(() => validateTicket([])).not.toThrow();
  });
});
