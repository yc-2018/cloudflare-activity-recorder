import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      INGEST_TOKEN: string;
      DASHBOARD_PASSWORD: string;
      SESSION_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
