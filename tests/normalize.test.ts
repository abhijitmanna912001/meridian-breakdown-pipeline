import { describe, it, expect } from "vitest";
import { normalizeRegistration, looksLikeValidRegistration } from "../src/lib/normalize.js";

describe("normalizeRegistration", () => {
  it("collapses the three raw formats confirmed in the real data to the same key", () => {
    // These three strings represent, per the challenge data, plausible
    // raw forms of the same underlying registration pattern.
    expect(normalizeRegistration("UP-40-IM-3144")).toBe("UP40IM3144");
    expect(normalizeRegistration("RJ43DD3546")).toBe("RJ43DD3546");
    expect(normalizeRegistration("UK 79 WJ 9666")).toBe("UK79WJ9666");
  });

  it("is idempotent — normalizing twice gives the same result", () => {
    const once = normalizeRegistration("UP-40-IM-3144");
    const twice = normalizeRegistration(once);
    expect(once).toBe(twice);
  });
});

describe("looksLikeValidRegistration", () => {
  it("accepts a well-formed normalized registration", () => {
    expect(looksLikeValidRegistration("UP40IM3144")).toBe(true);
    expect(looksLikeValidRegistration("RJ43DD3546")).toBe(true);
  });

  it("rejects obviously broken input for quarantine routing", () => {
    expect(looksLikeValidRegistration("")).toBe(false);
    expect(looksLikeValidRegistration("NOT-A-PLATE")).toBe(false);
  });
});
