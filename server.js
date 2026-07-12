require("dotenv/config");

// Prefer IPv4 when resolving hostnames. The multipass VM resolves Neon to
// IPv6 (AAAA) addresses but has no IPv6 route, so the Neon WebSocket driver
// would otherwise hang/ETIMEDOUT. This forces the IPv4 path (works on host too).
require("node:dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");
const pty = require("node-pty");
const { PrismaClient } = require("@prisma/client");
const { PrismaNeon } = require("@prisma/adapter-neon");
const { neonConfig } = require("@neondatabase/serverless");
const ws = require("ws");
const { WebSocketServer } = ws;

const execFileP = promisify(execFile);

// The Neon serverless driver needs a WebSocket implementation in Node.
neonConfig.webSocketConstructor = ws;

const app = express();
app.use(cors());
app.use(express.json());

// Prisma 7 uses driver adapters. The Neon adapter handles Neon's pooler and
// wake-from-idle behavior, avoiding intermittent ETIMEDOUT errors.
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Neon transient-failure retry
//
// Neon's pooler intermittently drops the WebSocket (close code 1006 / ETIMEDOUT),
// especially when the compute is waking from auto-suspend. Those failures are
// transient and succeed on a retry, so wrap every DB call rather than letting a
// blip surface to the user. Logical errors (P2xxx, e.g. "record not found") are
// NOT retried — they rethrow immediately.
// ---------------------------------------------------------------------------
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
      await sleep(delayMs * attempt); // linear backoff
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Multipass orchestration
//
// IMPORTANT: this server must run ON THE HOST where Multipass is installed.
// It shells out to the host's `multipass` CLI to manage real VMs. A backend
// running *inside* a VM cannot reach the host's multipassd socket — if
// `multipass` is not found, every orchestration call returns a clear error.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Candidate binaries: env override first, then PATH, then the snap location
// (snap installs to /snap/bin which is often missing from a service PATH).
const MP_CANDIDATES = [
  process.env.MULTIPASS_BIN,
  "multipass",
  "/snap/bin/multipass",
].filter(Boolean);
let resolvedMultipassBin = null;

async function multipass(args, { timeout = 120000 } = {}) {
  const candidates = resolvedMultipassBin ? [resolvedMultipassBin] : MP_CANDIDATES;
  let sawEnoent = false;

  for (const bin of candidates) {
    try {
      const { stdout, stderr } = await execFileP(bin, args, {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
      resolvedMultipassBin = bin;
      return { stdout, stderr };
    } catch (err) {
      if (err.code === "ENOENT") {
        sawEnoent = true;
        continue; // try the next candidate binary
      }
      if (err.killed || err.signal === "SIGTERM") {
        const e = new Error(
          `multipass ${args[0]} timed out after ${Math.round(timeout / 1000)}s`
        );
        e.kind = "TIMEOUT";
        throw e;
      }
      // Non-zero exit → surface multipass's own stderr message.
      const e = new Error(
        String(err.stderr || err.message || "multipass command failed").trim()
      );
      e.kind = "CMD_FAILED";
      e.stderr = err.stderr;
      throw e;
    }
  }

  const e = new Error(
    "Multipass CLI not found. This backend must run on the host machine where " +
      "Multipass is installed (it manages the VMs). Set MULTIPASS_BIN if it lives elsewhere."
  );
  e.kind = sawEnoent ? "NO_MULTIPASS" : "NO_MULTIPASS";
  throw e;
}

// Resolve the working multipass binary path (node-pty needs an explicit path
// because /snap/bin may not be on the spawned process's PATH).
async function ensureMultipassBin() {
  if (resolvedMultipassBin) return resolvedMultipassBin;
  try {
    await multipass(["version"], { timeout: 5000 });
  } catch {
    /* ignore — fall through to a sensible default */
  }
  return resolvedMultipassBin || "/snap/bin/multipass";
}

// Poll `multipass info` until the instance reports an IPv4 address.
async function getInstanceIp(instanceName, { retries = 6, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const { stdout } = await multipass(
        ["info", instanceName, "--format", "json"],
        { timeout: 30000 }
      );
      const data = JSON.parse(stdout);
      const ip = data?.info?.[instanceName]?.ipv4?.find(Boolean);
      if (ip) return ip;
    } catch {
      // ignore and retry — the instance may still be booting
    }
    await sleep(delayMs);
  }
  return null;
}

// Turn a human name into a valid Multipass instance name (hostname-like),
// then append a short suffix so concurrent projects never collide.
function baseInstanceName(name) {
  let s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = "vm-" + s;
  s = s.slice(0, 24).replace(/-+$/g, "");
  return s || "vm";
}
function uniqueInstanceName(name) {
  return `${baseInstanceName(name)}-${Date.now().toString(36).slice(-4)}`;
}

function isNotFoundError(err) {
  return /does not exist|unknown|not found/i.test(err?.message || "");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check / welcome route.
app.get("/", (req, res) => {
  res.json({ message: "Local EC2 Backend is running.........!" });
});

// Fetch all projects.
app.get("/api/projects", async (req, res) => {
  try {
    const projects = await db(() =>
      prisma.cloudProject.findMany({ orderBy: { id: "desc" } })
    );
    res.status(200).json(projects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// Create a project == launch a real VM on the host.
app.post("/api/projects", async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const instanceName = uniqueInstanceName(name);
  try {
    // Launch is slow (image boot) — allow up to 5 minutes.
    await multipass(
      ["launch", "--name", instanceName, "--cpus", "1", "--memory", "1G"],
      { timeout: 300000 }
    );

    const ipAddress = await getInstanceIp(instanceName);

    const project = await db(() =>
      prisma.cloudProject.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          status: "RUNNING",
          instanceName,
          ipAddress,
        },
      })
    );
    res.status(201).json(project);
  } catch (err) {
    console.error("Error launching VM:", err);
    // Best-effort cleanup so a half-launched VM does not linger on the host.
    try {
      await multipass(["delete", instanceName], { timeout: 60000 });
      await multipass(["purge"], { timeout: 60000 });
    } catch {
      /* ignore cleanup failures */
    }
    const msg =
      err.kind === "NO_MULTIPASS"
        ? err.message
        : `Failed to launch VM: ${err.message}`;
    res.status(err.kind === "NO_MULTIPASS" ? 503 : 500).json({ error: msg });
  }
});

// Stop the instance == `multipass stop <name>`, then mark STOPPED.
app.post("/api/projects/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    const project = await db(() =>
      prisma.cloudProject.findUnique({ where: { id } })
    );
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.instanceName) {
      return res.status(409).json({ error: "No VM is associated with this record" });
    }

    await multipass(["stop", project.instanceName], { timeout: 120000 });

    const updated = await db(() =>
      prisma.cloudProject.update({ where: { id }, data: { status: "STOPPED" } })
    );
    res.status(200).json(updated);
  } catch (err) {
    console.error(`Error stopping project ${id}:`, err);
    res.status(err.kind === "NO_MULTIPASS" ? 503 : 500).json({
      error:
        err.kind === "NO_MULTIPASS" ? err.message : `Failed to stop VM: ${err.message}`,
    });
  }
});

// Start the instance == `multipass start <name>`, refresh IP, mark RUNNING.
app.post("/api/projects/:id/start", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    const project = await db(() =>
      prisma.cloudProject.findUnique({ where: { id } })
    );
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.instanceName) {
      return res.status(409).json({ error: "No VM is associated with this record" });
    }

    await multipass(["start", project.instanceName], { timeout: 120000 });

    // A restarted VM may come back on a new IP.
    const ipAddress = await getInstanceIp(project.instanceName, { retries: 4 });

    const updated = await db(() =>
      prisma.cloudProject.update({
        where: { id },
        data: { status: "RUNNING", ...(ipAddress ? { ipAddress } : {}) },
      })
    );
    res.status(200).json(updated);
  } catch (err) {
    console.error(`Error starting project ${id}:`, err);
    res.status(err.kind === "NO_MULTIPASS" ? 503 : 500).json({
      error:
        err.kind === "NO_MULTIPASS" ? err.message : `Failed to start VM: ${err.message}`,
    });
  }
});

// Terminate == `multipass delete <name>` + `multipass purge`, then drop the row.
app.delete("/api/projects/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    const project = await db(() =>
      prisma.cloudProject.findUnique({ where: { id } })
    );
    if (!project) return res.status(404).json({ error: "Project not found" });

    if (project.instanceName) {
      try {
        await multipass(["delete", project.instanceName], { timeout: 120000 });
        await multipass(["purge"], { timeout: 120000 });
      } catch (err) {
        // If the VM is already gone, proceed to remove the DB record anyway.
        if (err.kind === "NO_MULTIPASS") throw err;
        if (!isNotFoundError(err)) {
          return res
            .status(500)
            .json({ error: `Failed to terminate VM: ${err.message}` });
        }
      }
    }

    await db(() => prisma.cloudProject.delete({ where: { id } }));
    res.status(200).json({ id, deleted: true });
  } catch (err) {
    console.error(`Error terminating project ${id}:`, err);
    res.status(err.kind === "NO_MULTIPASS" ? 503 : 500).json({
      error:
        err.kind === "NO_MULTIPASS"
          ? err.message
          : `Failed to terminate project: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Mock-CloudWatch metrics
//
// Memory / disk / CPU-from-load are read live from `multipass info`; network
// and disk I/O are simulated as a smooth bounded random walk (per instance) so
// the charts look alive. If `multipass info` fails, we degrade to simulation.
// ---------------------------------------------------------------------------
const metricState = new Map(); // id -> last simulated point
const round1 = (n) => Math.round(n * 10) / 10;
const walk = (v, min, max, step) =>
  Math.max(min, Math.min(max, v + (Math.random() * 2 - 1) * step));

async function readMetrics(project) {
  let mem = null;
  let disk = null;
  let cpuFromLoad = null;

  try {
    const { stdout } = await multipass(
      ["info", project.instanceName, "--format", "json"],
      { timeout: 8000 }
    );
    const info = JSON.parse(stdout)?.info?.[project.instanceName];
    if (info) {
      const cpuCount = Number(info.cpu_count) || 1;
      if (info.memory?.total) {
        mem = { used: Number(info.memory.used), total: Number(info.memory.total) };
      }
      const disk0 = info.disks && Object.values(info.disks)[0];
      if (disk0?.total) disk = { used: Number(disk0.used), total: Number(disk0.total) };
      const load1 = Array.isArray(info.load) ? Number(info.load[0]) : null;
      if (load1 != null && !Number.isNaN(load1)) {
        cpuFromLoad = Math.min(100, (load1 / cpuCount) * 100);
      }
    }
  } catch {
    /* fall back to simulated values */
  }

  const st =
    metricState.get(project.id) ||
    { cpu: cpuFromLoad ?? 8, netIn: 6, netOut: 4, diskRead: 3, diskWrite: 2 };

  // Blend the real load signal with jitter so the CPU line is both grounded and lively.
  const cpuTarget = cpuFromLoad != null ? cpuFromLoad * 0.5 + st.cpu * 0.5 : st.cpu;
  st.cpu = walk(cpuTarget, 1, 100, 7);
  st.netIn = walk(st.netIn, 0, 140, 14);
  st.netOut = walk(st.netOut, 0, 90, 10);
  st.diskRead = walk(st.diskRead, 0, 70, 7);
  st.diskWrite = walk(st.diskWrite, 0, 55, 6);
  metricState.set(project.id, st);

  const memPct = mem ? (mem.used / mem.total) * 100 : walk(st.cpu, 10, 60, 3);
  const diskPct = disk ? (disk.used / disk.total) * 100 : 40;

  return {
    timestamp: Date.now(),
    cpu: round1(st.cpu),
    memory: round1(memPct),
    memoryUsedMb: mem ? Math.round(mem.used / 1048576) : null,
    memoryTotalMb: mem ? Math.round(mem.total / 1048576) : null,
    disk: round1(diskPct),
    networkIn: round1(st.netIn),
    networkOut: round1(st.netOut),
    diskRead: round1(st.diskRead),
    diskWrite: round1(st.diskWrite),
  };
}

// Point-in-time metrics — the frontend polls this and builds the time series.
app.get("/api/projects/:id/metrics", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid project id" });
  }
  try {
    const project = await db(() =>
      prisma.cloudProject.findUnique({ where: { id } })
    );
    if (!project) return res.status(404).json({ error: "Project not found" });

    if (!project.instanceName || project.status !== "RUNNING") {
      return res.status(200).json({
        timestamp: Date.now(),
        state: project.status,
        cpu: 0,
        memory: 0,
        disk: 0,
        networkIn: 0,
        networkOut: 0,
        diskRead: 0,
        diskWrite: 0,
      });
    }

    const metrics = await readMetrics(project);
    res.status(200).json({ ...metrics, state: "RUNNING" });
  } catch (err) {
    console.error(`Error reading metrics for ${id}:`, err);
    res.status(500).json({ error: "Failed to read metrics" });
  }
});

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT} (0.0.0.0 — accepting external traffic)`);
});

// ---------------------------------------------------------------------------
// Web terminal (Instance Connect) over WebSocket
//
// Path: /api/ws/terminal/:id
// A node-pty shell (`multipass exec <instance> -- bash -l`) is piped
// bidirectionally to the browser's xterm.js. No SSH keys needed — the backend
// already has host-level Multipass access.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  const match = pathname.match(/^\/api\/ws\/terminal\/(\d+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const id = Number(match[1]);
  wss.handleUpgrade(req, socket, head, (client) => handleTerminal(client, id));
});

async function handleTerminal(client, id) {
  const say = (msg) => {
    if (client.readyState === client.OPEN) client.send(msg);
  };

  let project;
  try {
    project = await db(() => prisma.cloudProject.findUnique({ where: { id } }));
  } catch {
    say("\r\n\x1b[31m[error] database unavailable\x1b[0m\r\n");
    return client.close();
  }
  if (!project) {
    say("\r\n\x1b[31m[error] instance not found\x1b[0m\r\n");
    return client.close();
  }
  if (!project.instanceName) {
    say("\r\n\x1b[31m[error] no VM is associated with this record\x1b[0m\r\n");
    return client.close();
  }
  if (project.status !== "RUNNING") {
    say(`\r\n\x1b[33m[warning] instance is ${project.status}; start it first.\x1b[0m\r\n`);
    return client.close();
  }

  let term;
  try {
    const bin = await ensureMultipassBin();
    term = pty.spawn(bin, ["exec", project.instanceName, "--", "bash", "-l"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      env: process.env,
    });
  } catch (err) {
    say(`\r\n\x1b[31m[error] failed to open shell: ${err.message}\x1b[0m\r\n`);
    return client.close();
  }

  say(
    `\x1b[36m● Connected to ${project.instanceName}` +
      `${project.ipAddress ? " (" + project.ipAddress + ")" : ""}\x1b[0m\r\n`
  );

  term.onData((data) => say(data));
  term.onExit(() => {
    say("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
    if (client.readyState === client.OPEN) client.close();
  });

  client.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      term.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      try {
        term.resize(msg.cols, msg.rows);
      } catch {
        /* ignore resize races */
      }
    }
  });

  client.on("close", () => {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
}
