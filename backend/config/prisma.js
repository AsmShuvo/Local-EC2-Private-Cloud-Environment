/**
 * config/prisma.js
 * ------------------------------------------------------------------
 * Centralized Prisma Client instance (singleton).
 *
 * Architectural notes:
 *  - We export ONE PrismaClient for the whole process. Instantiating a new
 *    client per request/module would open redundant connection pools and
 *    quickly exhaust Neon's connection limit. A single shared instance is
 *    the officially recommended pattern.
 *  - In watch-mode (nodemon) the module can be re-evaluated on reload; we
 *    stash the instance on `globalThis` so hot-reloads reuse the same
 *    client instead of leaking a new pool on every restart.
 *  - Query/error logging is wired through Prisma's event system so we get
 *    clear, structured messages on what the DB layer is doing.
 * ------------------------------------------------------------------
 */

const { PrismaClient } = require('@prisma/client');

// Reuse an existing instance across hot-reloads (dev) to avoid pool leaks.
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    // Emit as events so we control formatting/verbosity ourselves.
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
      // 'query' is noisy; enable only when debugging.
      // { level: 'query', emit: 'event' },
    ],
  });

// Structured logging hooks — clear, consistent DB-layer messages.
prisma.$on('warn', (e) => {
  console.warn(`⚠️  [prisma] ${e.message}`);
});

prisma.$on('error', (e) => {
  console.error(`❌ [prisma] ${e.message}`);
});

// Preserve the singleton across nodemon reloads in non-production.
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
