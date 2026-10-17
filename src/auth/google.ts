/**
 * Google sign-in (OpenID Connect) handled directly in the Worker. No Cloudflare
 * Access / Zero Trust. The user creates one Google OAuth client and supplies
 * GOOGLE_CLIENT_ID (var) + GOOGLE_CLIENT_SECRET (secret). We run the OAuth code
 * flow, verify Google's id_token, enforce the allowed email domain, and mint our
 * own signed session cookie (HS256 over SESSION_SECRET).
 */
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "../env";
import { users, type User } from "../db/repos";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function googleJwks() {
  return (jwks ??= createRemoteJWKSet(GOOGLE_JWKS_URL));
}

// __Host- prefix hardens the cookie: browser enforces Secure, Path=/, no Domain.
export const SESSION_COOKIE = "__Host-session";
export const STATE_COOKIE = "__Host-oauth_state";

const SESSION_ISSUER = "blog-draft-studio";
const SESSION_AUDIENCE = "blog-draft-studio-session";

function redirectUri(env: Env): string {
  return `${(env.APP_BASE_URL || "").replace(/\/$/, "")}/auth/callback`;
}

function sessionKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET);
}

export function googleConfigured(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      !env.GOOGLE_CLIENT_ID.startsWith("TBD") &&
      env.GOOGLE_CLIENT_SECRET &&
      // Reject a weak/short session secret outright.
      env.SESSION_SECRET &&
      env.SESSION_SECRET.length >= 32 &&
      env.APP_BASE_URL,
  );
}

export function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Build the Google consent URL. `hd` hints the allowed Workspace domain. */
export function buildAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  if (env.ALLOWED_EMAIL_DOMAIN) params.set("hd", env.ALLOWED_EMAIL_DOMAIN);
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

export interface GoogleIdentity {
  email: string;
}

/** Called only after the Google JWT signature, issuer and audience are verified. */
export function identityFromVerifiedClaims(payload: { email?: unknown; email_verified?: unknown }, allowedDomain: string): GoogleIdentity {
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("id_token has no valid email");
  if (payload.email_verified !== true) throw new Error("email not verified");
  const domain = allowedDomain.toLowerCase().trim();
  if (domain && email.split("@")[1] !== domain) throw new Error("email domain not allowed");
  return { email };
}

/** Exchange the auth code, verify the id_token, enforce the email domain. */
export async function exchangeCode(env: Env, code: string): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(env),
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange ${res.status}: ${detail.slice(0, 200)}`);
  }
  // res.json() is `unknown` under the project tsconfig, so the assertion is
  // required for typecheck (eslint's projectService types disagree; tsc wins).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("no id_token from Google");

  const { payload } = await jwtVerify(json.id_token, googleJwks(), {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
  });

  return identityFromVerifiedClaims({ email: payload.email, email_verified: payload.email_verified }, env.ALLOWED_EMAIL_DOMAIN);
}

/** Sign a 7-day session cookie value. */
export function createSessionCookie(env: Env, email: string, passwordVersion?: number): Promise<string> {
  return new SignJWT({ email, ...(passwordVersion === undefined ? {} : { auth_method: "password", password_version: passwordVersion }) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime("7d")
    .sign(sessionKey(env));
}

/** Verify a session cookie value, returning the email or null. */
export async function readSession(env: Env, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    const email = identityFromVerifiedClaims({ email: payload.email, email_verified: true }, env.ALLOWED_EMAIL_DOMAIN).email;
    if (payload.auth_method === "password") {
      if (env.PASSWORD_LOGIN_ENABLED !== "true") return null;
      const account = await env.DB.prepare("SELECT version,enabled FROM password_accounts WHERE email=?").bind(email).first<{ version: number; enabled: number }>();
      if (!account?.enabled || account.version !== payload.password_version) return null;
    }
    return email;
  } catch {
    return null;
  }
}

export function userFromEmail(env: Env, email: string): Promise<User> {
  return users.upsertByEmail(env.DB, email);
}
