/** Render public pages without allowing redirects or subrequests to arbitrary hosts. */
import type { Env } from "../env";
import { validateGroundingUrl } from "./ingest";
import { RetryableError, isRetryableStatus } from "../errors";
import { readJsonBounded, recordOf } from "../providers/http";
export async function renderSourcePage(env: Env, sourceUrl: string, html = ""): Promise<string> {
  if (!env.BROWSER) throw new Error("This page requires browser rendering, which is not configured");
  const url = validateGroundingUrl(sourceUrl);
  const origins = new Set([url.origin]);
  // Permit only explicitly referenced public script/style origins plus the page.
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
    if (origins.size >= 20) break;
    try { origins.add(validateGroundingUrl(new URL(match[1]!, url).href).origin); } catch { /* unsafe resource */ }
  }
  const patterns = [...origins].map((origin) => `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
  let response: Response;
  try {
    response = await env.BROWSER.quickAction("content", {
      url: url.href, gotoOptions: { waitUntil: "networkidle2", timeout: 30000 },
      actionTimeout: 10000, allowRequestPattern: patterns,
      rejectResourceTypes: ["image", "media", "font"], cacheTTL: 60,
    });
  } catch { throw new RetryableError("Browser rendering temporarily failed or timed out"); }
  if (!response.ok) {
    await response.body?.cancel();
    if (isRetryableStatus(response.status)) throw new RetryableError("Browser rendering is temporarily unavailable");
    throw new Error("The website could not be read by the browser. Upload a copy you can access.");
  }
  const result = recordOf(await readJsonBounded(response, 4_000_000));
  if (result.success !== true || typeof result.result !== "string") throw new RetryableError("Browser rendering returned no usable page");
  return result.result;
}
