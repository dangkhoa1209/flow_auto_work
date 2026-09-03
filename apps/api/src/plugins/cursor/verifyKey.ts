import { Cursor } from "@cursor/sdk";

function formatCursorKeyVerifyError(raw: string): string {
  if (/invalid user api key|unauthenticated|401|403/i.test(raw)) {
    return (
      "Cursor API key không hợp lệ — dán full secret ngay khi tạo key (Cursor Dashboard → Integrations), " +
      "không copy giá trị che trong bảng (crsr_…). Một số key chỉ có scope Admin cũng bị SDK từ chối."
    );
  }
  return `Không xác minh được Cursor API key: ${raw}`;
}

/** Verify a Cursor user API key before persisting it. */
export async function verifyCursorApiKey(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("apiKey required");
  try {
    await Cursor.me({ apiKey: key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(formatCursorKeyVerifyError(msg));
  }
}
