const { PrismaClient } = require('@prisma/client');

// Reuse one instance across nodemon reloads to avoid leaking connection pools.
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });

prisma.$on('warn', (e) => {
  console.warn(`[prisma] ${e.message}`);
});

prisma.$on('error', (e) => {
  const msg = e.message || '';

  // Neon closes idle connections on its side; Prisma reconnects on the next
  // query, so don't treat these as real errors.
  const isTransientDisconnect =
    /kind:\s*Closed/i.test(msg) ||
    /Error in PostgreSQL connection/i.test(msg) ||
    /Connection reset by peer/i.test(msg) ||
    /server closed the connection/i.test(msg) ||
    /connection closed/i.test(msg);

  if (isTransientDisconnect) {
    console.warn(`[prisma] Idle DB connection closed by Neon; reconnecting. (${msg})`);
    return;
  }

  console.error(`[prisma] ${msg}`);
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
