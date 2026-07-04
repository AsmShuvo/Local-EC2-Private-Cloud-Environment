/**
 * index.js
 * ------------------------------------------------------------------
 * Application entry point.
 *
 * Architectural notes:
 *  - We bind explicitly to host 0.0.0.0 (all network interfaces) rather
 *    than the default localhost. On an EC2 / Ubuntu Server instance this
 *    is required so the service is reachable from outside the VM once the
 *    relevant Security Group / firewall port is opened.
 *  - The DB layer is Prisma (Neon Postgres). We verify connectivity with
 *    prisma.$connect() BEFORE binding the HTTP port, so the process fails
 *    fast on a genuine misconfiguration instead of accepting traffic it
 *    can't serve. Transient network timeouts are retried a few times.
 *  - Configuration is sourced from environment variables (12-factor style)
 *    via dotenv, so no secrets are hard-coded.
 * ------------------------------------------------------------------
 */

// Load environment variables from .env as early as possible, before any
// other module (e.g. the Prisma client) reads process.env.
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Single shared Prisma Client instance (see config/prisma.js).
const prisma = require('./config/prisma');

const app = express();

// ------------------------------------------------------------------
// Global middleware
// ------------------------------------------------------------------

// CORS: allow all origins for now. Tighten this to an explicit whitelist
// (e.g. { origin: ['https://app.example.com'] }) before real production use.
app.use(cors());

// Parse incoming JSON request bodies into req.body.
app.use(express.json());

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

/**
 * Health-check endpoint.
 * Reports both process liveness AND database reachability. We run a
 * trivial `SELECT 1` through Prisma so monitors can distinguish "app up
 * but DB down" (503) from a fully healthy service (200).
 */
app.get('/api/health', async (req, res) => {
  let database = 'DOWN';
  try {
    // Cheapest possible round-trip that proves the connection is live.
    await prisma.$queryRaw`SELECT 1`;
    database = 'UP';
  } catch (err) {
    console.error(`❌ Health check DB probe failed: ${err.message}`);
  }

  const healthy = database === 'UP';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'UP' : 'DEGRADED',
    database,
    timestamp: new Date().toISOString(),
    environment: 'Production-Replica',
  });
});

// ------------------------------------------------------------------
// Server bootstrap
// ------------------------------------------------------------------

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

/**
 * Verify DB connectivity before serving traffic.
 * Neon is serverless and its pooler hostname resolves to multiple IPs;
 * an initial connect can time out (ETIMEDOUT) on a cold start. We retry
 * a few times with backoff so a transient network blip doesn't abort boot.
 */
async function connectWithRetry(retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();
      console.log('✅ Prisma connected to Neon Postgres.');
      return;
    } catch (err) {
      console.error(
        `❌ DB connect attempt ${attempt}/${retries} failed: ${err.message || err.code || 'unknown error'}`
      );
      if (attempt < retries) {
        console.log(`   Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        // Re-throw so the caller can decide to abort startup.
        throw err;
      }
    }
  }
}

async function startServer() {
  try {
    await connectWithRetry();

    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 Server listening on http://${HOST}:${PORT}`);
      console.log(`   Health check: http://${HOST}:${PORT}/api/health`);
    });

    // Graceful shutdown: close HTTP server + DB pool on termination so we
    // don't leak Neon connections when systemd/pm2/Docker stops the process.
    const shutdown = async (signal) => {
      console.log(`\n${signal} received — shutting down gracefully...`);
      server.close(async () => {
        await prisma.$disconnect();
        console.log('👋 HTTP server closed and Prisma disconnected.');
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('❌ FATAL: Could not establish a database connection at startup.');
    console.error(`   ${err.message || err}`);
    // Ensure the pool is released, then exit so an orchestrator can restart.
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

startServer();

// Export for potential integration testing.
module.exports = { app, prisma };
