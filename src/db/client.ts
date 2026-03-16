import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

// Re-use the Prisma client across hot-reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Module-level Prisma client.
 *
 * - **Local dev**: initialised lazily on first property access (targets the
 *   SQLite file configured by DATABASE_URL).
 * - **Cloudflare Worker**: call `setPrisma(createD1Client(env.DB))` at the
 *   start of every request so that all service code that imports `prisma`
 *   transparently uses the D1-backed client for that request.
 *
 * The client is NOT created eagerly at import time — this avoids the
 * "PrismaClient failed to initialize" error in Cloudflare Workers where
 * the D1 adapter hasn't been configured yet at module-load time.
 */
let _prisma: PrismaClient | null = globalForPrisma.prisma ?? null;

function getOrCreateLocalClient(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"],
    });
    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.prisma = _prisma;
    }
  }
  return _prisma;
}

// Proxy that lazily initialises the PrismaClient on first use.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getOrCreateLocalClient(), prop, receiver);
  },
});

/** Replace the module-level prisma singleton (used by the Worker entry point). */
export function setPrisma(client: PrismaClient): void {
  _prisma = client;
}

/**
 * Create a Prisma client backed by a Cloudflare D1 database binding.
 */
export function createD1Client(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d1Binding: any
): PrismaClient {
  const adapter = new PrismaD1(d1Binding);
  return new PrismaClient({ adapter });
}
