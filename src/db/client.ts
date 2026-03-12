import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

// Re-use the Prisma client across hot-reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Create a Prisma client backed by a Cloudflare D1 database binding.
 *
 * Use this in your Cloudflare Worker's fetch handler instead of the
 * module-level `prisma` singleton (which targets a local SQLite file):
 *
 * @example
 * // src/worker.ts  (wrangler.toml must declare [[d1_databases]] binding "DB")
 * import { createD1Client } from "./db/client";
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const db = createD1Client(env.DB);
 *     // pass db into service functions
 *   }
 * }
 */
export function createD1Client(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d1Binding: any
): PrismaClient {
  const adapter = new PrismaD1(d1Binding);
  return new PrismaClient({ adapter });
}
