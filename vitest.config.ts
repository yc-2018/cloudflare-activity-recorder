import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          INGEST_TOKEN: "test-ingest-token-123456789",
          DASHBOARD_PASSWORD: "test-dashboard-password",
          DETAILS_PASSWORD: "test-details-password",
          SESSION_SECRET: "test-session-secret-123456789",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts", "worker/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
