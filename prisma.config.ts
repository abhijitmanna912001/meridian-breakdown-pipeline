import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma ORM 7: the connection URL lives here, not in schema.prisma.
// Migrate reads this file directly; PrismaClient at runtime is
// instantiated separately with a driver adapter (see src/lib/db.ts) —
// this config only governs the CLI (generate/migrate/studio).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
