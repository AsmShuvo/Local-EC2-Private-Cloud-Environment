require('dotenv').config();

const express = require('express');
const cors = require('cors');
const prisma = require('./config/prisma');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', async (req, res) => {
  let database = 'DOWN';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'UP';
  } catch (err) {
    console.error(`Health check DB probe failed: ${err.message}`);
  }

  const healthy = database === 'UP';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'UP' : 'DEGRADED',
    database,
    timestamp: new Date().toISOString(),
    environment: 'Production-Replica',
  });
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    res.status(200).json({ count: users.length, users });
  } catch (err) {
    console.error(`GET /api/users failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// Neon can time out on a cold start, so retry a few times before giving up.
async function connectWithRetry(retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();
      console.log('Prisma connected to Neon Postgres.');
      return;
    } catch (err) {
      console.error(
        `DB connect attempt ${attempt}/${retries} failed: ${err.message || err.code || 'unknown error'}`
      );
      if (attempt < retries) {
        console.log(`Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

async function startServer() {
  try {
    await connectWithRetry();

    const server = app.listen(PORT, HOST, () => {
      console.log(`Server listening on http://${HOST}:${PORT}`);
    });

    const shutdown = async (signal) => {
      console.log(`\n${signal} received, shutting down...`);
      server.close(async () => {
        await prisma.$disconnect();
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Could not establish a database connection at startup.');
    console.error(err.message || err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

startServer();

module.exports = { app, prisma };
