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
