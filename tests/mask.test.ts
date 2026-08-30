import { describe, it, expect } from "vitest";
import { containsRawPii, redact, hashRawValue, maskedTokenFor } from "../src/lib/mask.js";

describe("containsRawPii", () => {
  it("flags a raw phone number matching the drivers_roster.csv format", () => {
    const { clean, types } = containsRawPii("Call the driver at +91 8361473242 now.");
    expect(clean).toBe(false);
    expect(types).toContain("phone");
  });

  it("flags a raw Aadhaar-shaped number", () => {
    const { clean, types } = containsRawPii("Ref: 6515 3369 7284");
    expect(clean).toBe(false);
    expect(types).toContain("aadhaar");
  });

  it("passes a clean message with no PII patterns", () => {
    const { clean } = containsRawPii(
      "Your Vertex Retail delivery is rescheduled to tomorrow 8 AM per gate hours."
    );
    expect(clean).toBe(true);
  });
});

describe("redact", () => {
  it("removes matched PII without leaving the raw value in the string", () => {
    const input = "Driver phone: +91 8361473242";
    const output = redact(input);
    expect(output).not.toContain("8361473242");
    expect(output).toContain("[REDACTED]");
  });
});

describe("hashRawValue / maskedTokenFor", () => {
  it("produces a stable, deterministic token for the same raw input", () => {
    const hashA = hashRawValue("+91 8361473242");
    const hashB = hashRawValue("+91 8361473242");
    expect(hashA).toBe(hashB);

    const tokenA = maskedTokenFor("phone", hashA);
    const tokenB = maskedTokenFor("phone", hashB);
    expect(tokenA).toBe(tokenB);
  });

  it("never contains the raw value as a substring of the token", () => {
    const raw = "+91 8361473242";
    const token = maskedTokenFor("phone", hashRawValue(raw));
    expect(token).not.toContain("8361473242");
  });
});
