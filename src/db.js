// Shared database layer: one Prisma client + a transient-failure retry wrapper.
//
// Neon's pooler intermittently drops the WebSocket (close code 1006 / ETIMEDOUT),
// especially when the compute wakes from auto-suspend. Those failures are
// transient and succeed on retry, so every DB call goes through db(). Logical
// errors (P2xxx, e.g. "record not found") are NOT retried — they rethrow.
const { PrismaClient } = require("@prisma/client");
const { PrismaNeon } = require("@prisma/adapter-neon");
const { neonConfig } = require("@neondatabase/serverless");
const ws = require("ws");

neonConfig.webSocketConstructor = ws;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TRANSIENT_NET_CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
];

function isTransientDbError(err) {
  const code = err?.code;
  if (typeof code === "string") {
    if (code.startsWith("P2")) return false; // logical query error — do not retry
    if (code.startsWith("P1")) return true; // connection/engine error
    if (TRANSIENT_NET_CODES.includes(code)) return true;
  }
  // Neon's raw ws ErrorEvent arrives with an empty message and a WebSocket target.
  if (!err?.message) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db(run, { retries = 3, delayMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === retries) throw err;
      console.warn(
        `Transient DB error (attempt ${attempt}/${retries}): ${
          err.code || "neon-ws-timeout"
        } — retrying…`
      );
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

module.exports = { prisma, db, isTransientDbError };
