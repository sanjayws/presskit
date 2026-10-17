/** Bound provider payloads before buffering them in the Worker. */
export async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Provider returned an empty response");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body.cancel();
    throw new Error("Provider response exceeded the size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Provider response exceeded the size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // JSON parser errors may contain response fragments. Never echo those.
    throw new Error("Provider returned invalid JSON");
  }
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
