import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { passwordHash } from "../src/auth/password";
import { readSession } from "../src/auth/google";
const bindings = { ...env, DEV_AUTH_EMAIL: undefined, PASSWORD_LOGIN_ENABLED: "true" };
const password = "synthetic-password-for-tests";
async function account() {
  const email = `password-${crypto.randomUUID()}@example.com`, salt = "ab".repeat(32);
  await env.DB.prepare("INSERT INTO password_accounts(email,salt,password_hash) VALUES(?,?,?)").bind(email,salt,await passwordHash(password,salt)).run();
  return email;
}
function login(email: string, secret = password, origin = "https://x.test") {
  return worker.fetch(new Request("https://x.test/auth/password", { method:"POST", headers:{origin,"cf-connecting-ip":email},body:new URLSearchParams({email,password:secret}) }),bindings);
}
describe("administrator-managed password login",()=>{
  it("offers password login with or without Google",async()=>{
    const page=await worker.fetch(new Request("https://x.test/auth/login"),{...bindings,GOOGLE_CLIENT_SECRET:""});
    const html=await page.text(); expect(html).toContain('autocomplete="current-password"');expect(html).not.toContain("Continue with Google");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });
  it("authenticates and revokes the session on reset or disable",async()=>{
    const email=await account();const response=await login(email);
    expect(response.status).toBe(302);const cookie=response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");expect(cookie).toContain("Secure");expect(cookie).not.toContain(password);
    const token=cookie.match(/__Host-session=([^;]+)/)![1]!;
    expect(await readSession(bindings,token)).toBe(email);
    await env.DB.prepare("UPDATE password_accounts SET version=version+1 WHERE email=?").bind(email).run();
    expect(await readSession(bindings,token)).toBeNull();
    await env.DB.prepare("UPDATE password_accounts SET enabled=0 WHERE email=?").bind(email).run();
    expect((await login(email)).status).toBe(401);
  });
  it("returns identical errors for unknown users and incorrect passwords",async()=>{
    const email=await account();const bad=await login(email,"wrong"),unknown=await login(`missing-${crypto.randomUUID()}@example.com`);
    expect(bad.status).toBe(401);expect(unknown.status).toBe(401);expect(await bad.text()).toBe(await unknown.text());
  });
  it("enforces account rate limits and blocks cross-origin login",async()=>{
    const email=`missing-${crypto.randomUUID()}@example.com`;
    expect((await login(email,password,"https://evil.test")).status).toBe(403);
    for(let i=0;i<10;i++)expect((await login(email)).status).toBe(401);
    const response=await login(email);expect(response.status).toBe(429);expect(response.headers.get("retry-after")).toBe("900");
  });
  it("respects the domain restriction and disabled feature flag",async()=>{
    const email=await account();
    const req=()=>new Request("https://x.test/auth/password",{method:"POST",headers:{origin:"https://x.test"},body:new URLSearchParams({email,password})});
    expect((await worker.fetch(req(),{...bindings,ALLOWED_EMAIL_DOMAIN:"other.test"})).status).toBe(401);
    expect((await worker.fetch(req(),{...bindings,PASSWORD_LOGIN_ENABLED:"false"})).status).toBe(503);
  });
});
