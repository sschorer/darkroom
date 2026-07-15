/**
 * Walking skeleton. Deliberately almost nothing — #11 is the first issue that
 * makes this window do real work, and #31 is the visual pass.
 */
export default function App() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Darkroom</h1>
      <p className="text-sm text-neutral-400">Generate images and video on your own GPU.</p>
      <span className="mt-2 h-2 w-2 rounded-full bg-[var(--color-safelight)]" />
    </main>
  );
}
