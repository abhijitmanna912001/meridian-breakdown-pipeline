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

  it("recovers a ticket using camelCase renamed fields (change-tolerance / surprise-file simulation)", () => {
    // Mirrors the actual reshaped format tried in test-fixtures/surprise_tickets.json
    const raw = {
      ticket_id: "TKT-9202",
      createdAt: "2026-08-26T11:00:00",
      vehicleRegistration: "CH40IK6238",
      driverId: "DRV-031",
      originHub: "Chandigarh",
      kmFromOriginHub: 18,
      destination: "Rudrapur",
      issue: "clutch slipping",
      severity: "MEDIUM",
      client: "Apex Chemicals",
      status: "OPEN",
    };

    const result = validateTicket(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.vehicle).toBe("CH40IK6238");
      expect(result.ticket.driver_id).toBe("DRV-031");
      expect(result.ticket.origin_hub).toBe("Chandigarh");
      expect(result.ticket.km_from_origin_hub).toBe(18);
    }
  });

  it("does not let an aliased field overwrite an already-present canonical field", () => {
    const raw = {
      ticket_id: "TKT-9205",
      created_at: "2026-08-26T11:00:00",
      createdAt: "SHOULD_NOT_WIN",
      vehicle: "CH40IK6238",
      driver_id: "DRV-031",
      origin_hub: "Chandigarh",
      km_from_origin_hub: 18,
      destination: "Rudrapur",
      issue: "clutch slipping",
      severity: "MEDIUM",
      client: "Apex Chemicals",
      status: "OPEN",
    };

    const result = validateTicket(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ticket.created_at).toBe("2026-08-26T11:00:00");
    }
  });

  it("still quarantines a record with a genuinely non-numeric km value, even after alias mapping", () => {
    const raw = {
      ticket_id: "TKT-9203",
      created_at: "2026-08-27T09:00:00",
      vehicle: "",
      driver_id: "DRV-999",
      origin_hub: "Delhi",
      km_from_origin_hub: "unknown",
      destination: "Jaipur",
      issue: "engine failure",
      severity: "CRITICAL",
      client: "Orion Pharma",
      status: "OPEN",
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
