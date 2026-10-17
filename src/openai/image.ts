/** OpenAI Image API; one bounded, moderated PNG per article. */
import type { Env } from "../env";
import { RetryableError, isRetryableStatus } from "../errors";
import { logEvent } from "../log";
import { validatedImageMime } from "../content/validate";
import { readJsonBounded, recordOf } from "../providers/http";

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length > 8_000_000) throw new Error("Generated image exceeded the size limit");
  const binary = atob(b64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function generateImage(env: Env, prompt: string, size: "1536x1024" | "1024x1024" = "1536x1024"): Promise<GeneratedImage> {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI image generation is not configured");
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst";
  const quality = ["low", "medium", "high"].includes(env.OPENAI_IMAGE_QUALITY)
    ? env.OPENAI_IMAGE_QUALITY : "medium";
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model, prompt, n: 1, size, quality,
        output_format: "png", background: "opaque", moderation: "auto",
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    logEvent("openai.image", { model, ok: false, ms: Date.now() - startedAt, reason: "network" });
    throw new RetryableError("OpenAI image request timed out or could not connect");
  }
  const requestId = response.headers.get("x-request-id");
  if (!response.ok) {
    const payload = recordOf(await readJsonBounded(response, 32_000).catch(() => ({})));
    const error = recordOf(payload.error);
    const code = typeof error.code === "string" && /^[a-z0-9_]{1,80}$/i.test(error.code)
      ? error.code : "provider_error";
    const param = typeof error.param === "string" && /^[a-z0-9_]{1,80}$/i.test(error.param) ? error.param : null;
    logEvent("openai.image", { model, ok: false, status: response.status, code, param, request_id: requestId, ms: Date.now() - startedAt });
    // Never expose provider messages: they may echo source material or prompts.
    const message = code === "moderation_blocked"
      ? "The image brief could not be processed. Revise it and try again."
      : `OpenAI image generation failed (${response.status}, ${code})`;
    if (isRetryableStatus(response.status) && code !== "insufficient_quota" && code !== "moderation_blocked") {
      throw new RetryableError(message);
    }
    throw new Error(message);
  }
  const payload = recordOf(await readJsonBounded(response, 8_100_000));
  const first = Array.isArray(payload.data) ? recordOf(payload.data[0]) : {};
  if (typeof first.b64_json !== "string") throw new Error("OpenAI returned no image");
  const bytes = base64ToBytes(first.b64_json);
  if (validatedImageMime(bytes) !== "image/png") throw new Error("OpenAI returned an invalid PNG image");
  const usage = recordOf(payload.usage);
  const tokens = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  logEvent("openai.image", {
    model, quality, ok: true, bytes: bytes.byteLength, request_id: requestId, ms: Date.now() - startedAt,
    input_tokens: tokens(usage.input_tokens), output_tokens: tokens(usage.output_tokens), total_tokens: tokens(usage.total_tokens),
  });
  return { bytes, mimeType: "image/png" };
}
