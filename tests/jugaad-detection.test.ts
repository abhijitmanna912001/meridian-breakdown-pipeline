import { describe, it, expect } from "vitest";
import { detectJugaadMention, computeJugaadWindow } from "../src/pipeline/jugaad-detection.js";

describe("detectJugaadMention", () => {
  it("detects the real confirmed phrasing from tickets.json", () => {
    // Verbatim string confirmed on TKT-0017 and TKT-0004
    expect(detectJugaadMention("Guddu jugaad se chalu kiya, permanent repair pending.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectJugaadMention("JUGAAD fix applied")).toBe(true);
    expect(detectJugaadMention("Jugaad Fix Applied")).toBe(true);
  });

  it("returns false for a normal resolution note with no jugaad mention", () => {
    expect(detectJugaadMention("Resolved by roadside assistance.")).toBe(false);
    expect(detectJugaadMention("Towed to hub workshop.")).toBe(false);
  });

  it("returns false for missing or empty resolution notes, never throws", () => {
    expect(detectJugaadMention(undefined)).toBe(false);
    expect(detectJugaadMention(null)).toBe(false);
    expect(detectJugaadMention("")).toBe(false);
  });
});

describe("computeJugaadWindow", () => {
  it("computes a 7-day deadline from the patch date", () => {
    const window = computeJugaadWindow("2026-04-30T07:00:00");
    expect(window).not.toBeNull();
    if (window) {
      const daysDiff = (window.deadline.getTime() - window.patchedAt.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBe(7);
    }
  });

  it("returns null for an unparseable date, never throws", () => {
    expect(computeJugaadWindow("not-a-date")).toBeNull();
  });
});
