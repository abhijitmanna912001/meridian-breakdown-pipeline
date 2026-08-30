import { describe, it, expect } from "vitest";
import { extractFactsFromMockResponse } from "../src/knowledge/extract.js";

describe("extractFactsFromMockResponse", () => {
  it("validates a well-formed extraction matching the real Shakti SLA email", () => {
    // Mirrors the actual confirmed content of thread_01_shakti_sla.txt
    const mockLlmResponse = [
      {
        category: "CLIENT_SLA",
        ruleText:
          "Shakti Cement's real operating SLA is 36 hours door to door, despite the contract stating 48 hours.",
        appliesTo: { type: "CLIENT", identifier: "Shakti Cement" },
        sourceExcerpt: "our working window is 36 hours door to door... The 48 hour line in the contract is legacy language",
        possibleConflict: false,
      },
    ];

    const result = extractFactsFromMockResponse(mockLlmResponse, "thread_01_shakti_sla.txt");
    expect(result.validation.ok).toBe(true);
    if (result.validation.ok) {
      expect(result.validation.facts).toHaveLength(1);
      expect(result.validation.facts[0]!.category).toBe("CLIENT_SLA");
    }
  });

  it("validates an empty array response as a valid zero-fact result", () => {
    const result = extractFactsFromMockResponse([], "thread_26_internal_misc.txt");
    expect(result.validation.ok).toBe(true);
    if (result.validation.ok) {
      expect(result.validation.facts).toHaveLength(0);
    }
  });

  it("validates a fact with no identifiable entity (GENERAL), matching the jugaad-reminder email", () => {
    // Mirrors thread_25_internal_jugaad.txt, which names no specific vehicle
    const mockLlmResponse = [
      {
        category: "REPAIR_RULE",
        ruleText:
          "A temporary roadside ('jugaad') repair must receive a permanent fix within 7 days; until then the vehicle stays within its home region.",
        appliesTo: { type: "GENERAL" },
        sourceExcerpt: "permanent repair within 7 days, tab tak home region ke bahar nahi bhejenge",
        possibleConflict: false,
      },
    ];

    const result = extractFactsFromMockResponse(mockLlmResponse, "thread_25_internal_jugaad.txt");
    expect(result.validation.ok).toBe(true);
    if (result.validation.ok) {
      expect(result.validation.facts[0]!.appliesTo?.type).toBe("GENERAL");
    }
  });

  it("flags a DATA_CONFLICT fact, matching the real Jaipur year-conflict email", () => {
    // Mirrors thread_21_internal_yearconflict.txt: email claims 2021,
    // fleet_master.csv actually says 2017 for RJ43DD3546.
    const mockLlmResponse = [
      {
        category: "DATA_CONFLICT",
        ruleText: "Email claims vehicle RJ43DD3546 is a 2021 model.",
        appliesTo: { type: "VEHICLE", identifier: "RJ43DD3546" },
        sourceExcerpt: "it is the brand new 2021 model we got",
        possibleConflict: true,
      },
    ];

    const result = extractFactsFromMockResponse(
      mockLlmResponse,
      "thread_21_internal_yearconflict.txt"
    );
    expect(result.validation.ok).toBe(true);
    if (result.validation.ok) {
      expect(result.validation.facts[0]!.possibleConflict).toBe(true);
    }
  });

  it("rejects a malformed response (invalid category) without throwing", () => {
    const mockLlmResponse = [
      {
        category: "NOT_A_REAL_CATEGORY",
        ruleText: "Something",
        appliesTo: null,
        sourceExcerpt: "excerpt",
        possibleConflict: false,
      },
    ];

    const result = extractFactsFromMockResponse(mockLlmResponse, "thread_99_broken.txt");
    expect(result.validation.ok).toBe(false);
  });

  it("rejects a completely malformed response without throwing", () => {
    expect(() => extractFactsFromMockResponse(null, "x")).not.toThrow();
    expect(() => extractFactsFromMockResponse("not an array", "x")).not.toThrow();
    expect(() => extractFactsFromMockResponse({ foo: "bar" }, "x")).not.toThrow();
  });
});
