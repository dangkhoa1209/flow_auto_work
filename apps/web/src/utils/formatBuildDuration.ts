/** Compact build duration: `4m2s`, `1h4m3s` (omit hours when 0). */
export function formatBuildDurationMs(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const mTotal = Math.floor(sec / 60);
  const s = sec % 60;
  if (mTotal < 60) return `${mTotal}m${s}s`;
  const h = Math.floor(mTotal / 60);
  const m = mTotal % 60;
  return `${h}h${m}m${s}s`;
}
