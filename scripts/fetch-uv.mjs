#!/usr/bin/env node
// Fetch the `uv` sidecar binary — the only binary we bundle (ADR-004).
//
// Output: native/binaries/uv-<target-triple>[.exe]
//
// That name is not a convention we chose; it is the exact shape Tauri's
// externalBin resolver looks for. `"externalBin": ["binaries/uv"]` in
// tauri.conf.json makes Tauri append `-<triple>` (and `.exe` on Windows) and
// fail the build if the result isn't there. Rename it and the bundle silently
// loses its Python bootstrap.
//
// Runs before `pnpm install` in CI, so it uses only the Node stdlib and the
// system `tar`. Adding an npm dependency here breaks that ordering.
//
// ## Integrity
//
// The archive digest for every supported triple is pinned in DIGESTS below.
// uv publishes a `.sha256` next to each asset, but it is served from the same
// origin as the asset, so it only proves the download wasn't truncated — it is
// not a trust anchor. A pinned digest is, and it means a re-tagged or
// substituted release fails the build here rather than shipping. This mirrors
// how every other artifact in the system is verified (ARCHITECTURE §8.4).
//
// To bump uv: change UV_VERSION, run `node scripts/fetch-uv.mjs --digests`,
// and paste the printed table over DIGESTS. Review that the digests changed
// for the reason you expect before committing.
//
// ## Flags
//
//   --verify   run `uv --version` afterwards and check it (skipped when the
//              triple isn't this host's — a foreign binary can't be executed)
//   --target   fetch for another triple instead of this host's
//   --all      fetch every supported triple
//   --force    re-fetch even when the pinned version is already present
//   --digests  print a DIGESTS table for UV_VERSION (see above)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const UV_VERSION = "0.11.29";

// sha256 of the release archive, per target triple.
const DIGESTS = {
  "x86_64-unknown-linux-gnu": "04f8b82f5d47f0512dcd32c67a4a6f16a0ea27c81537c338fd0ad6b23cebe829",
  "aarch64-unknown-linux-gnu": "94500fb064ae3c971a873cba64d94694c50677e0a4dbf78735c80509e7429919",
  "x86_64-apple-darwin": "c4c4de482da9ccdd076dc4fb5cfe7b740609029385c72f58606be3153602387d",
  "aarch64-apple-darwin": "61c04acc52a33ef0f331e494bdfbedcdb6c26c6970c022ed3699e5860f8930e3",
  "x86_64-pc-windows-msvc": "a047d55651bc3e0ca24595b25ec4cfcb10f9dca9fb56514e661269b37d4fae68",
  "aarch64-pc-windows-msvc": "55b597ae81bc29531a7c352a1431a8a73cc2755d7a5b9ec454580cbe02e5154f",
};

// process.platform-process.arch -> target triple. Tauri derives the triple it
// wants from the Rust host target; these are the same strings.
const HOST_TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "native", "binaries");

const isWindows = (triple) => triple.includes("windows");
const assetName = (triple) => `uv-${triple}${isWindows(triple) ? ".zip" : ".tar.gz"}`;
const assetUrl = (triple) =>
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${assetName(triple)}`;

// What Tauri's externalBin resolver looks for, and the whole point of the script.
const destPath = (triple) => join(BIN_DIR, `uv-${triple}${isWindows(triple) ? ".exe" : ""}`);

// Throws rather than exiting: process.exit() would skip the `finally` that
// removes the temp dir, leaking a ~25MB archive on every failed fetch.
class FetchUvError extends Error {}
function fail(message) {
  throw new FetchUvError(message);
}

const hostTripleOrNull = () => HOST_TRIPLES[`${process.platform}-${process.arch}`] ?? null;

function hostTriple() {
  const triple = hostTripleOrNull();
  if (!triple) {
    fail(
      `no uv build for this host (${process.platform}-${process.arch}).\n` +
        `  Supported: ${Object.values(HOST_TRIPLES).join(", ")}\n` +
        `  Pass --target <triple> to fetch for a different host.`,
    );
  }
  return triple;
}

// Node's fetch has no default timeout, so a stalled CDN hangs a build forever
// rather than failing it. These deadlines cover the body read too, not just the
// response headers: a connection that opens and then stops sending is the
// failure that actually happens. The archive deadline is deliberately loose —
// it exists to break a hang, not to police slow links (~25MB / 10min ≈ 40KB/s).
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;
const META_TIMEOUT_MS = 30 * 1000;

async function httpGet(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      fail(
        `GET ${url} returned ${res.status} ${res.statusText}.\n` +
          `  If this is a 404, UV_VERSION (${UV_VERSION}) may not name a real uv release.`,
      );
    }
    return res;
  } catch (err) {
    // Our own failures are already actionable; only translate transport errors.
    if (err instanceof FetchUvError) throw err;
    if (err?.name === "TimeoutError") {
      fail(
        `GET ${url} timed out after ${timeoutMs / 1000}s.\n` +
          `  The network stalled or GitHub is unreachable. Retry.`,
      );
    }
    return fail(`GET ${url} failed: ${err.message}`);
  }
}

async function download(url) {
  const res = await httpGet(url, ARCHIVE_TIMEOUT_MS);
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // The same signal aborts a stalled body mid-read, landing here.
    return fail(
      `GET ${url} died mid-download: ${err.message}\n` +
        `  Retry; the file is verified against a pinned digest either way.`,
    );
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Print a DIGESTS table for the pinned UV_VERSION by reading the .sha256 that
// uv publishes beside each asset. Used when bumping UV_VERSION; the printed
// values still get committed, which is what makes them a pin.
async function printDigests() {
  const lines = [];
  for (const triple of Object.keys(DIGESTS)) {
    const res = await httpGet(`${assetUrl(triple)}.sha256`, META_TIMEOUT_MS);
    // Format: "<hex>  <filename>"
    const digest = (await res.text()).trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      fail(`malformed .sha256 for ${assetName(triple)}: ${digest}`);
    }
    // Double quotes: prettier owns this file, and the point is to paste the
    // output straight in.
    lines.push(`  "${triple}": "${digest}",`);
  }
  console.log(`const UV_VERSION = "${UV_VERSION}";\n`);
  console.log("const DIGESTS = {");
  console.log(lines.join("\n"));
  console.log("};");
}

// Pull one file out of a zip using only zlib.
//
// Node has no zip reader, and the obvious shortcut — `tar -xf`, since bsdtar
// reads zip — only works where tar *is* bsdtar. GNU tar can't, so that shortcut
// fails the moment you fetch a Windows binary from Linux (`--target`). uv's zip
// is small, single-purpose, and never zip64, so reading it directly is both
// shorter than special-casing platforms and correct everywhere.
//
// No per-entry CRC check: the whole archive is verified against a pinned digest
// before we get here, which is strictly stronger.
function readZipEntry(buf, wanted) {
  // End-of-central-directory record: 22 bytes plus an optional trailing
  // comment, so scan back from the end for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) fail("not a zip file: no end-of-central-directory record.");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail("corrupt zip: bad central directory.");

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (name === wanted) {
      if (compSize === 0xffffffff || localOff === 0xffffffff) {
        fail("zip64 archive: this script only reads plain zip. uv changed its packaging.");
      }
      // The local header repeats name/extra with its own lengths — the central
      // directory's are not reliable for locating the payload.
      const start =
        localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return fail(`unsupported zip compression method ${method}.`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// The two archive kinds do not have the same shape: the tarball nests its
// payload under a `uv-<triple>/` directory, the zip is flat.
function extractUv(archive, triple, work) {
  if (isWindows(triple)) {
    const exe = readZipEntry(archive, "uv.exe");
    if (!exe) {
      fail(
        `${assetName(triple)} did not contain uv.exe.\n` +
          `  The uv archive layout changed; this script needs updating.`,
      );
    }
    return exe;
  }

  // tar.gz only ever comes from a Linux or macOS asset, and both GNU tar and
  // bsdtar read it — unlike zip, there's no portability trap here worth
  // hand-rolling a decoder for.
  const archivePath = join(work, assetName(triple));
  writeFileSync(archivePath, archive);
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", work], { stdio: "pipe" });
  } catch (err) {
    fail(
      `could not extract ${assetName(triple)}: ${err.message}\n` +
        `  This needs a working \`tar\` on PATH.`,
    );
  }

  const inner = join(work, `uv-${triple}`, "uv");
  if (!existsSync(inner)) {
    fail(
      `${assetName(triple)} did not contain uv-${triple}/uv.\n` +
        `  The uv archive layout changed; this script needs updating.`,
    );
  }
  return readFileSync(inner);
}

// Actually run the thing. A pinned digest proves we downloaded the right bytes;
// it does not prove they were unpacked into a working executable, and CI has no
// other step that would notice — externalBin only checks the file exists.
function verifyRuns(triple) {
  if (triple !== hostTripleOrNull()) {
    // A foreign binary can't be executed here; the CI job for that OS covers it.
    console.log(`fetch-uv: skipping --verify for ${triple} (not this host)`);
    return;
  }

  const dest = destPath(triple);
  let out;
  try {
    out = execFileSync(dest, ["--version"], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err) {
    fail(
      `the fetched uv did not run: ${err.message}\n` +
        `  ${dest}\n` +
        `  The download matched its digest, so suspect extraction, the file mode,\n` +
        `  or a missing system library.`,
    );
  }

  // `uv --version` prints e.g. "uv 0.11.29 (x86_64-unknown-linux-gnu)".
  if (!out.split(/\s+/).includes(UV_VERSION)) {
    fail(`sidecar reports "${out}", expected uv ${UV_VERSION}.`);
  }
  console.log(`fetch-uv: verified ${out}`);
}

async function fetchOne(triple, { force }) {
  const dest = destPath(triple);
  const stamp = `${dest}.version`;

  // Skip on an exact version match. The stamp is what makes this cheap and
  // cross-compile-safe: we can't run a foreign binary to ask its version.
  if (!force && existsSync(dest) && existsSync(stamp)) {
    if (readFileSync(stamp, "utf8").trim() === UV_VERSION) {
      console.log(`fetch-uv: uv ${UV_VERSION} already present for ${triple}`);
      return;
    }
  }

  const expected = DIGESTS[triple];
  if (!expected) {
    fail(
      `no pinned digest for ${triple}.\n` +
        `  Run \`node scripts/fetch-uv.mjs --digests\` and update DIGESTS in this script.`,
    );
  }

  console.log(`fetch-uv: downloading uv ${UV_VERSION} for ${triple}`);
  const archive = await download(assetUrl(triple));

  const actual = sha256(archive);
  if (actual !== expected) {
    fail(
      `checksum mismatch for ${assetName(triple)}.\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        `  Refusing to bundle it. If uv re-published this release, verify why\n` +
        `  before updating DIGESTS.`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "darkroom-uv-"));
  try {
    const uv = extractUv(archive, triple, work);

    mkdirSync(BIN_DIR, { recursive: true });
    // 0o755 regardless of host: the archive's own mode doesn't survive the zip
    // path, and a non-executable sidecar fails at spawn, not at build.
    writeFileSync(dest, uv, { mode: 0o755 });
    // Written last — a stamp only means anything if the binary landed first.
    writeFileSync(stamp, `${UV_VERSION}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`fetch-uv: wrote ${dest.slice(ROOT.length + 1)}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--digests")) {
    await printDigests();
    return;
  }

  const force = args.includes("--force");
  const verify = args.includes("--verify");
  const targetAt = args.indexOf("--target");
  if (targetAt !== -1 && !args[targetAt + 1]) {
    fail("--target needs a triple, e.g. --target x86_64-pc-windows-msvc");
  }

  const triples =
    targetAt !== -1
      ? [args[targetAt + 1]]
      : args.includes("--all")
        ? Object.keys(DIGESTS)
        : [hostTriple()];

  for (const triple of triples) {
    if (!(triple in DIGESTS)) {
      fail(`unknown triple "${triple}".\n  Known: ${Object.keys(DIGESTS).join(", ")}`);
    }
    await fetchOne(triple, { force });
    // Deliberately outside fetchOne: a cached binary should still be proven to
    // run, or --verify would only ever check the download that just happened.
    if (verify) verifyRuns(triple);
  }
}

main().catch((err) => {
  // An unexpected error keeps its stack; a deliberate one doesn't need it.
  console.error(
    err instanceof FetchUvError
      ? `fetch-uv: ${err.message}`
      : `fetch-uv: unexpected failure\n${err.stack ?? String(err)}`,
  );
  process.exit(1);
});
