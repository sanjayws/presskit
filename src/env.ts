import type { Queue } from "@cloudflare/workers-types";

/** A single stage message on the pipeline queue. */
export interface PipelineMessage {
  runId: string;
  stage:
    | "ingest"
    | "assess"
    | "topics"
    | "write"
    | "style"
    | "review"
    | "image"
    | "image_refresh"
    | "ready"
    | "bundle";
  /** For the "bundle" stage: rebuild just this article's download bundle. */
  articleId?: string;
  /** Image-only job identity; stale deliveries must not activate a later request. */
  imageJobId?: string;
}

/** Config bindings/vars are generated; queue payloads and secrets refine them. */
export interface Env extends Omit<WorkerBindings, "PIPELINE"> {
  PIPELINE: Queue<PipelineMessage>;

  // Secrets
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  POSTMARK_TOKEN?: string;
  POSTMARK_FROM?: string;

  /**
   * Dev-only auth bypass. When set (local dev, tests), requests are mapped to
   * this email without Google sign-in. MUST be unset in production, where
   * the signed Google OAuth session supplies the verified identity.
   */
  DEV_AUTH_EMAIL?: string;
}
