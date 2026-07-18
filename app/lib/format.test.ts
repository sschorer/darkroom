import { describe, expect, it } from "vitest";

import { formatBytes, formatDuration, formatRate } from "./format";

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

describe("formatRate", () => {
  it("shows a per-second byte figure", () => {
    expect(formatRate(5.9 * 1024 * 1024)).toBe("5.9 MB/s");
    expect(formatRate(1024)).toBe("1.0 KB/s");
  });

  it("shows a dash for a non-positive rate rather than a misleading 0 B/s", () => {
    // A download that has not yet sampled a speed, or has stalled.
    expect(formatRate(0)).toBe("—");
    expect(formatRate(-1)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders seconds, minutes, and hours coarsely", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(200)).toBe("3m 20s");
    expect(formatDuration(3900)).toBe("1h 5m");
  });

  it("rounds to whole seconds — an ETA is not a stopwatch", () => {
    expect(formatDuration(44.6)).toBe("45s");
  });

  it("shows a dash for an unknown or negative estimate", () => {
    // What an ETA computed from a zero rate (division by zero) becomes.
    expect(formatDuration(Infinity)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});
