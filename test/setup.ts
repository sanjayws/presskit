import { beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";

// Apply D1 schema once before the suite.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
