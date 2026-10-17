import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-10-11",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_AUTH_EMAIL: "dev@example.com",
            ALLOWED_EMAIL_DOMAIN: "example.com",
            ANTHROPIC_MODEL: "claude-opus-5-5",
            ANTHROPIC_EFFORT: "low",
            OPENAI_DOCUMENT_MODEL: "gpt-6-luna",
            OPENAI_IMAGE_MODEL: "gpt-image-2.5-sunburst",
            OPENAI_IMAGE_QUALITY: "medium",
            OPENAI_API_KEY: "test-openai-key",
            ANTHROPIC_API_KEY: "test-anthropic-key",
            READY_EMAIL_ENABLED: "false",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-secret",
            SESSION_SECRET: "test-session-secret-at-least-32-bytes-long!!",
            APP_BASE_URL: "https://presskit.test",
          },
          d1Databases: { DB: "blog_studio_test" },
          r2Buckets: { ASSETS: "blog-studio-assets-test" },
          queueProducers: { PIPELINE: "pipeline-test" },
        },
      },
    },
  },
});
