/** Display formatting for the UI. Pure functions, kept out of components so
 * their edge cases can be tested without a DOM. */

/**
 * Bytes as a short human string: `947 B`, `12.4 MB`, `5.9 GB`.
 *
 * One decimal below 10 of a unit, none above, so the width stays roughly
 * stable as a download climbs (`9.9 MB` → `10 MB`) rather than jittering
 * between `9.87` and `10.4`. Binary units (1024), because that's what the OS
 * and uv report; the label says KB/MB/GB rather than KiB to match what a user
 * expects to read.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * A transfer rate: `formatBytes` per second (`5.9 MB/s`). Rendered as `—` for a
 * non-positive rate, so a download that hasn't sampled a speed yet — or has
 * stalled — shows a placeholder rather than a misleading `0 B/s`.
 */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * A coarse duration for an ETA: `45s`, `3m 20s`, `1h 5m`. One decimal place is
 * pointless on an estimate that jitters with the rate, so it rounds to whole
 * seconds and drops the smallest unit once hours are in play — an ETA is a
 * reassurance that the thing will end, not a stopwatch.
 *
 * A non-finite or negative input (an ETA computed from a zero rate) is `—`, the
 * same "unknown" placeholder {@link formatRate} uses.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
