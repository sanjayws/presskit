/**
 * Optional "ready" email via Postmark. Behind a flag (READY_EMAIL_ENABLED),
 * default on. Sends the article title and a link back to the result screen.
 * This is a notification only. It never publishes content anywhere.
 */
import type { Env } from "../env";

const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";

export function readyEmailEnabled(env: Env): boolean {
  return String(env.READY_EMAIL_ENABLED).toLowerCase() !== "false";
}

export interface ReadyEmailInput {
  to: string;
  articleTitle: string;
  resultUrl: string;
}

/** Returns true if an email was sent, false if suppressed/misconfigured. */
export async function sendReadyEmail(
  env: Env,
  input: ReadyEmailInput,
): Promise<boolean> {
  if (!readyEmailEnabled(env)) return false;
  if (!env.POSTMARK_TOKEN || !env.POSTMARK_FROM) return false;

  const body = {
    From: env.POSTMARK_FROM,
    To: input.to,
    Subject: `Your draft is ready: ${input.articleTitle}`,
    HtmlBody: `<p>Your grounded draft is ready.</p>
<p><strong>${escape(input.articleTitle)}</strong></p>
<p><a href="${input.resultUrl}">Open the result screen</a> to copy the HTML, meta, and download the assets.</p>`,
    TextBody: `Your grounded draft is ready: ${input.articleTitle}\n\nOpen the result screen: ${input.resultUrl}`,
    MessageStream: "outbound",
  };

  const res = await fetch(POSTMARK_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Postmark ${res.status}: ${detail.slice(0, 300)}`);
  }
  return true;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
