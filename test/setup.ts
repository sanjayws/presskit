import { beforeAll, afterAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { network, fetchMock } from "./network";

// Apply D1 schema once before the suite.
beforeAll(async () => {
  await network.enable();
  fetchMock.activate();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterAll(()=>network.disable());
