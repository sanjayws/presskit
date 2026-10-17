/** Administrator-provisioned D1 passwords; no self-registration or plaintext storage. */
import type { Env } from "../env";
import { identityFromVerifiedClaims } from "./google";
export const PASSWORD_ITERATIONS = 100000;
export interface PasswordAccount { email: string; salt: string; password_hash: string; version: number; enabled: number }
export function passwordConfigured(env: Env): boolean {
  return env.PASSWORD_LOGIN_ENABLED === "true" && env.SESSION_SECRET?.length >= 32 && Boolean(env.APP_BASE_URL);
}
export async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bytes = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: PASSWORD_ITERATIONS, salt: Uint8Array.from(salt.match(/../g) || [], b => parseInt(b, 16)) }, key, 256);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export async function checkPassword(env: Env, email: string, password: string): Promise<PasswordAccount | null> {
  const row = await env.DB.prepare("SELECT * FROM password_accounts WHERE email=?").bind(email).first<PasswordAccount>();
  // Unknown accounts pay the same password derivation cost.
  const hash = await passwordHash(password, row?.salt || "00".repeat(32));
  const expected = row?.password_hash || "00".repeat(32);
  let diff = hash.length ^ expected.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  if (diff || !row?.enabled) return null;
  try { identityFromVerifiedClaims({ email, email_verified: true }, env.ALLOWED_EMAIL_DOMAIN); } catch { return null; }
  return row;
}
export async function loginAllowed(env: Env, email: string, ip: string): Promise<boolean> {
  const now = Date.now(), start = now - 15 * 60_000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ids = await Promise.all([`email:${email}`, `ip:${ip}`].map(async value => {
    const hash = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  }));
  const results = await env.DB.batch(ids.map(id => env.DB.prepare(`INSERT INTO login_attempts(id,window_start,attempts) VALUES(?,?,1)
    ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts`).bind(id, now, start, start)));
  return results.every((result, i) => Number((result.results[0] as { attempts: number }).attempts) <= (i === 0 ? 10 : 30));
}
export function passwordLoginPage(google: boolean): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Presskit</title><style>body{font:17px system-ui;max-width:440px;margin:10vh auto;padding:24px;color:#172b42;background:#f6f8fb}input,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0 20px;font:inherit}button{color:white;background:#123b55;border:0;border-radius:8px}a{display:block;text-align:center;padding:16px}p{line-height:1.5}</style><main><h1>Sign in to Presskit</h1><p>Use the email and password provided by your administrator. A Google account is not required.</p><form method="post" action="/auth/password"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button type="submit">Sign in</button></form>${google ? '<a href="/auth/google">Continue with Google</a>' : ''}<p>Forgot your password? Ask your administrator to reset it.</p></main></html>`;
}
