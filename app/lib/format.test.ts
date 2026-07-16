import { describe, expect, it } from "vitest";

import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("keeps bytes under 1KB as a plain count", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(947)).toBe("947 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("climbs through the units at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("shows a decimal below 10 of a unit and drops it at or above", () => {
    expect(formatBytes(9.9 * 1024 * 1024)).toBe("9.9 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12 MB");
  });

  it("caps at GB rather than inventing a TB label", () => {
    // The engine is ~6GB; there is no larger unit to reach for, so a
    // hypothetical multi-terabyte value should still read in GB.
    expect(formatBytes(2048 * 1024 * 1024 * 1024)).toBe("2048 GB");
  });
});
