import { describe, it, expect } from "vitest";
import {
  checkWinterDelhiNcrBsRestriction,
  checkHillRouteEligibility,
  getEffectiveSlaHours,
  checkVertexGateCutoff,
  checkApexRotationRule,
  checkOrionRequirements,
  applyMonsoonPadding,
  determineReplacementSourceHub,
  checkServiceOverdueGrounding,
  checkJugaadRepairConstraint,
  checkNewDriverNightRunRestriction,
} from "../src/rules/dispatcher-rules.js";

describe("checkWinterDelhiNcrBsRestriction", () => {
  it("blocks a BS4 vehicle on a winter Delhi route (rule overrides proximity)", () => {
    const result = checkWinterDelhiNcrBsRestriction({
      bsStage: "BS4",
      originHub: "Delhi",
      destination: "Kanpur",
      date: new Date("2026-12-15"),
    });
    expect(result.passed).toBe(false);
  });

  it("allows a BS6 vehicle on the same route", () => {
    const result = checkWinterDelhiNcrBsRestriction({
      bsStage: "BS6",
      originHub: "Delhi",
      destination: "Kanpur",
      date: new Date("2026-12-15"),
    });
    expect(result.passed).toBe(true);
  });

  it("does not apply outside winter months", () => {
    const result = checkWinterDelhiNcrBsRestriction({
      bsStage: "BS4",
      originHub: "Delhi",
      destination: "Kanpur",
      date: new Date("2026-06-15"),
    });
    expect(result.passed).toBe(true);
  });
});

describe("checkHillRouteEligibility", () => {
  it("blocks a vehicle without an engine heater on a winter hill route", () => {
    const result = checkHillRouteEligibility({
      destination: "Rudrapur",
      engineHeater: false,
      lastBrakeWorkDate: null,
      date: new Date("2026-12-01"),
    });
    expect(result.passed).toBe(false);
  });

  it("blocks a vehicle with brake work in the last 30 days, even with a heater", () => {
    const result = checkHillRouteEligibility({
      destination: "Rudrapur",
      engineHeater: true,
      lastBrakeWorkDate: new Date("2026-11-25"),
      date: new Date("2026-12-01"),
    });
    expect(result.passed).toBe(false);
  });

  it("allows a heated vehicle with brake work 31+ days ago", () => {
    const result = checkHillRouteEligibility({
      destination: "Rudrapur",
      engineHeater: true,
      lastBrakeWorkDate: new Date("2026-10-01"),
      date: new Date("2026-12-01"),
    });
    expect(result.passed).toBe(true);
  });
});

describe("getEffectiveSlaHours", () => {
  it("overrides Shakti's 48hr contract with the real 36hr operating rule", () => {
    const result = getEffectiveSlaHours("Shakti Cement");
    expect(result.hours).toBe(36);
  });

  it("returns null for a client with no SLA override", () => {
    const result = getEffectiveSlaHours("Vertex Retail");
    expect(result.hours).toBeNull();
  });
});

describe("checkVertexGateCutoff", () => {
  it("holds a Vertex Ludhiana delivery arriving after 6pm and labels it a scheduled morning delivery, not failed", () => {
    const result = checkVertexGateCutoff({
      clientCanonicalName: "Vertex Retail",
      destinationHub: "Ludhiana",
      estimatedArrival: new Date("2026-05-01T18:40:00"),
    });
    expect(result.action).toBe("HOLD_UNTIL_MORNING");
    expect(result.deliveryStatusLabel).toBe("SCHEDULED_MORNING_DELIVERY");
    expect(result.deliveryStatusLabel).not.toBe("FAILED");
  });

  it("delivers as planned when arrival is before 6pm", () => {
    const result = checkVertexGateCutoff({
      clientCanonicalName: "Vertex Retail",
      destinationHub: "Ludhiana",
      estimatedArrival: new Date("2026-05-01T17:00:00"),
    });
    expect(result.action).toBe("DELIVER_AS_PLANNED");
  });
});

describe("checkApexRotationRule", () => {
  it("blocks reusing the same vehicle immediately after it had an issue on an Apex run", () => {
    const result = checkApexRotationRule({
      clientCanonicalName: "Apex Chemicals",
      candidateVehicleRegistration: "UP37UP7482",
      lastApexVehicleRegistration: "UP37UP7482",
      lastApexDispatchHadIssue: true,
    });
    expect(result.passed).toBe(false);
  });

  it("allows a different vehicle after an issue", () => {
    const result = checkApexRotationRule({
      clientCanonicalName: "Apex Chemicals",
      candidateVehicleRegistration: "HR21SN1520",
      lastApexVehicleRegistration: "UP37UP7482",
      lastApexDispatchHadIssue: true,
    });
    expect(result.passed).toBe(true);
  });
});

describe("checkOrionRequirements", () => {
  it("rejects a pre-2020 vehicle for Orion Pharma", () => {
    const result = checkOrionRequirements({
      clientCanonicalName: "Orion Pharma",
      vehicleYear: 2019,
      wouldWaitOvernightUnrefrigerated: false,
    });
    expect(result.passed).toBe(false);
  });

  it("accepts a 2020+ vehicle with no overnight cold-chain risk", () => {
    const result = checkOrionRequirements({
      clientCanonicalName: "Orion Pharma",
      vehicleYear: 2021,
      wouldWaitOvernightUnrefrigerated: false,
    });
    expect(result.passed).toBe(true);
  });
});

describe("applyMonsoonPadding", () => {
  it("pads ETA by 20% for eastern routes in monsoon season", () => {
    const result = applyMonsoonPadding({
      destination: "Patna",
      isEastOfLucknow: true,
      computedEtaMinutes: 100,
      date: new Date("2026-08-01"),
    });
    expect(result.paddedEtaMinutes).toBe(120);
  });

  it("does not pad outside monsoon months", () => {
    const result = applyMonsoonPadding({
      destination: "Patna",
      isEastOfLucknow: true,
      computedEtaMinutes: 100,
      date: new Date("2026-01-01"),
    });
    expect(result.paddedEtaMinutes).toBe(100);
  });
});

describe("determineReplacementSourceHub", () => {
  it("sends the ORIGIN hub for a breakdown within 50km, overriding naive nearest-hub logic", () => {
    const result = determineReplacementSourceHub({
      kmFromOriginHub: 30,
      originHub: "Gurgaon",
      nearestHub: "Delhi",
    });
    expect(result.sourceHub).toBe("Gurgaon");
  });

  it("sends the nearest hub for a breakdown beyond 50km", () => {
    const result = determineReplacementSourceHub({
      kmFromOriginHub: 80,
      originHub: "Gurgaon",
      nearestHub: "Delhi",
    });
    expect(result.sourceHub).toBe("Delhi");
  });
});

describe("checkServiceOverdueGrounding", () => {
  it("grounds a vehicle more than 30 days overdue on service, absolutely", () => {
    const result = checkServiceOverdueGrounding({
      dueServiceDate: new Date("2026-01-01"),
      asOfDate: new Date("2026-02-15"), // 45 days later
    });
    expect(result.passed).toBe(false);
  });

  it("does not ground a vehicle within the grace window", () => {
    const result = checkServiceOverdueGrounding({
      dueServiceDate: new Date("2026-02-01"),
      asOfDate: new Date("2026-02-15"), // 14 days later
    });
    expect(result.passed).toBe(true);
  });
});

describe("checkJugaadRepairConstraint", () => {
  it("blocks a long-distance dispatch within the 7-day jugaad window", () => {
    const result = checkJugaadRepairConstraint({
      jugaadPatchedAt: new Date("2026-03-01"),
      jugaadDeadline: new Date("2026-03-08"),
      asOfDate: new Date("2026-03-04"),
      proposedDispatchLeavesHomeRegion: true,
    });
    expect(result.passed).toBe(false);
  });

  it("allows a local dispatch within the jugaad window", () => {
    const result = checkJugaadRepairConstraint({
      jugaadPatchedAt: new Date("2026-03-01"),
      jugaadDeadline: new Date("2026-03-08"),
      asOfDate: new Date("2026-03-04"),
      proposedDispatchLeavesHomeRegion: false,
    });
    expect(result.passed).toBe(true);
  });
});

describe("checkNewDriverNightRunRestriction", () => {
  it("blocks a new driver from a solo night run", () => {
    const result = checkNewDriverNightRunRestriction({
      isNewDriver: true,
      isNightRun: true,
      isPaired: false,
    });
    expect(result.passed).toBe(false);
  });

  it("allows a new driver on a paired night run", () => {
    const result = checkNewDriverNightRunRestriction({
      isNewDriver: true,
      isNightRun: true,
      isPaired: true,
    });
    expect(result.passed).toBe(true);
  });
});
