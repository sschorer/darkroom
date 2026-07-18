import { describe, expect, it } from "vitest";

import { etaSeconds } from "./download";

describe("etaSeconds", () => {
  it("divides the remaining bytes by the current rate", () => {
    // 90 bytes left at 30 B/s → 3s.
    expect(etaSeconds(10, 100, 30)).toBe(3);
  });

  it("is null when no rate has been sampled yet", () => {
    // A fresh download's opening moment, or a stall — dividing by zero would be
    // Infinity, which is not an estimate worth showing.
    expect(etaSeconds(0, 100, 0)).toBeNull();
    expect(etaSeconds(0, 100, -1)).toBeNull();
  });

  it("is null once nothing is left to fetch", () => {
    // The tail of a download: no remaining bytes, so no wait to estimate.
    expect(etaSeconds(100, 100, 50)).toBeNull();
    expect(etaSeconds(120, 100, 50)).toBeNull();
  });
});
