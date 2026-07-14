require("dotenv/config");

// Prefer IPv4 when resolving hostnames. The multipass VM resolves Neon to
// IPv6 (AAAA) addresses but has no IPv6 route, so the Neon WebSocket driver
// would otherwise hang/ETIMEDOUT. This forces the IPv4 path (works on host too).
require("node:dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");
const crypto = require("node:crypto");
const pty = require("node-pty");
const ws = require("ws");
const { WebSocketServer } = ws;

// Shared data layer (Prisma client + transient-failure retry wrapper).
const { prisma, db } = require("./src/db");

// Security Groups (stateful firewall simulation).
const securityGroupRoutes = require("./src/security/routes");
const instanceSecurityRoutes = require("./src/security/instanceRoutes");
const { enforceInbound, checkWsInbound, SSH_PORT } = require("./src/security/middleware");

// OS image catalog ("AMI") + reusable key pairs.
const { listImages, resolveImage } = require("./src/images");
const keypairs = require("./src/keypairs");
const keypairRoutes = require("./src/keypairRoutes");

const execFileP = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

// req.ip should reflect the real client. We are not behind a reverse proxy, so
// the socket address IS the client; if you ever put nginx in front, enable this.
// app.set("trust proxy", true);

// Security group management API.
app.use("/api/security-groups", securityGroupRoutes);
// Instance <-> group binding (many-to-many).
app.use("/api/projects", instanceSecurityRoutes);
// Reusable key pairs.
app.use("/api/key-pairs", keypairRoutes);

// The OS image catalog the launch wizard renders (our "AMI" list).
app.get("/api/images", (req, res) => res.status(200).json(listImages()));

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
// SSH key-pair generation (like an AWS EC2 key pair)
//
// Generates a fresh RSA pair per instance. The private key (PKCS#1 .pem, the
// AWS-style "BEGIN RSA PRIVATE KEY") is returned to the client EXACTLY ONCE and
// never stored. The public key is converted to OpenSSH authorized_keys format
// and baked into the VM via cloud-init.
// ---------------------------------------------------------------------------

// SSH wire encodings: length-prefixed string and mpint (big-endian, sign-safe).
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}
function sshMpint(buf) {
  let b = buf;
  if (b.length && (b[0] & 0x80)) b = Buffer.concat([Buffer.from([0x00]), b]); // keep positive
  return sshString(b);
}
function jwkRsaToOpenSSH(jwk, comment = "") {
  const e = Buffer.from(jwk.e, "base64url");
  const n = Buffer.from(jwk.n, "base64url");
  const blob = Buffer.concat([
    sshString(Buffer.from("ssh-rsa")),
    sshMpint(e),
    sshMpint(n),
  ]);
  return `ssh-rsa ${blob.toString("base64")}${comment ? " " + comment : ""}`;
}

function generateKeyPair(comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const openssh = jwkRsaToOpenSSH(publicKey.export({ format: "jwk" }), comment);
  return { privateKeyPem, openssh };
}

// ---------------------------------------------------------------------------
// Instance types (AWS-style). The server catalog is authoritative: a known
// instanceType always resolves to its own cpu/memory, so a client can't ask for
// "t2.micro" and secretly get 8 vCPUs. Unknown types fall back to validated
// custom cpu/memory, and finally to the default type.
// ---------------------------------------------------------------------------
const INSTANCE_TYPES = {
  "t2.micro": { cpu: 1, memory: "1G" },
  "t2.small": { cpu: 1, memory: "2G" },
  "t2.medium": { cpu: 2, memory: "4G" },
};
const DEFAULT_INSTANCE_TYPE = "t2.micro";

function resolveSpec(body = {}) {
  const requested =
    typeof body.instanceType === "string" ? body.instanceType.trim() : "";

  if (INSTANCE_TYPES[requested]) {
    return { instanceType: requested, ...INSTANCE_TYPES[requested] };
  }

  // Allow an explicit custom spec, but validate it hard.
  const cpuNum = parseInt(body.cpu, 10);
  const cpu = Number.isInteger(cpuNum) && cpuNum >= 1 && cpuNum <= 8 ? cpuNum : null;
  const mem =
    typeof body.memory === "string" && /^[1-9][0-9]?G$/.test(body.memory.trim())
      ? body.memory.trim()
      : null;
  if (cpu && mem) return { instanceType: "custom", cpu, memory: mem };

  return {
    instanceType: DEFAULT_INSTANCE_TYPE,
    ...INSTANCE_TYPES[DEFAULT_INSTANCE_TYPE],
  };
}

// Expose the catalog so the UI can stay in sync with the server.
app.get("/api/instance-types", (req, res) => {
  res.status(200).json(
    Object.entries(INSTANCE_TYPES).map(([name, spec]) => ({ name, ...spec }))
  );
});

// Launch with the public key injected via cloud-init user-data, piped over
// STDIN (`--cloud-init -`). Using stdin avoids the snap-confinement problem
// where multipassd cannot read a temp file (e.g. under /tmp).
async function launchWithKey(instanceName, openssh, { cpu, memory, imageAlias }) {
  const bin = await ensureMultipassBin();
  // `multipass launch <image>` — the image alias is POSITIONAL and must come
  // first. Omitting it silently boots the default LTS, which is how the OS
  // selection was previously being ignored.
  const args = ["launch"];
  if (imageAlias) args.push(String(imageAlias));
  args.push(
    "--name",
    instanceName,
    "--cpus",
    String(cpu),
    "--memory",
    String(memory)
  );

  // "Proceed without a key pair": no cloud-init at all. The VM still works and
  // the browser terminal still connects (that goes through Multipass, not SSH),
  // but `ssh -i key.pem` will never authenticate against it.
  const cloudInit = openssh
    ? `#cloud-config\nssh_authorized_keys:\n  - ${openssh}\n`
    : null;
  if (cloudInit) args.push("--cloud-init", "-");

  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const e = new Error(
        "multipass launch timed out after 10 minutes — the OS image may still be downloading. " +
          "Pre-fetch it with: multipass launch <image> --name warmup && multipass delete --purge warmup"
      );
      e.kind = "TIMEOUT";
      reject(e);
    }, 600000);

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        const e = new Error("Multipass CLI not found.");
        e.kind = "NO_MULTIPASS";
        return reject(e);
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const e = new Error(
        String(stderr || `multipass launch exited ${code}`).trim()
      );
      e.kind = "CMD_FAILED";
      reject(e);
    });

    if (cloudInit) child.stdin.write(cloudInit);
    child.stdin.end();
  });
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
      prisma.cloudProject.findMany({
        orderBy: { id: "desc" },
        include: { securityGroups: { select: { id: true, name: true } } },
      })
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
  // Resolve the requested instance type into concrete, validated specs.
  const { instanceType, cpu, memory } = resolveSpec(req.body);

  // Resolve the OS image ("AMI"). Unsupported images are rejected, never
  // silently downgraded to Ubuntu.
  const { image, error: imageError } = resolveImage(req.body?.os);
  if (imageError) return res.status(400).json({ error: imageError });

  // Security groups chosen in the launch wizard (like AWS: attached AT creation,
  // not bolted on afterwards).
  const rawSgIds = req.body?.securityGroupIds ?? [];
  if (!Array.isArray(rawSgIds)) {
    return res.status(400).json({ error: "securityGroupIds must be an array" });
  }
  const securityGroupIds = [...new Set(rawSgIds.map((v) => Number(v)))];
  if (securityGroupIds.some((n) => !Number.isInteger(n))) {
    return res.status(400).json({ error: "securityGroupIds must be integers" });
  }

  // Validate the groups exist BEFORE we spend ~90s booting a VM. Otherwise a
  // typo'd id would only blow up at the final DB write, after all that work.
  if (securityGroupIds.length) {
    const found = await db(() =>
      prisma.securityGroup.findMany({
        where: { id: { in: securityGroupIds } },
        select: { id: true },
      })
    );
    if (found.length !== securityGroupIds.length) {
      const known = new Set(found.map((g) => g.id));
      const missing = securityGroupIds.filter((id) => !known.has(id));
      return res
        .status(400)
        .json({ error: `Unknown security group id(s): ${missing.join(", ")}` });
    }
  }

  // Resolve the key-pair choice: create a new one, reuse a stored one, or none.
  let keySel;
  try {
    keySel = await keypairs.resolveForLaunch(
      {
        mode: req.body?.keyPairMode,
        keyPairId: req.body?.keyPairId,
        keyPairName: req.body?.keyPairName,
      },
      `${instanceName}-key`
    );
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    // Launch is slow (image boot) — allow up to 5 minutes. When a key pair is
    // used, its PUBLIC key is baked into authorized_keys via cloud-init.
    await launchWithKey(instanceName, keySel.openssh, {
      cpu,
      memory,
      imageAlias: image.multipassAlias,
    });

    const ipAddress = await getInstanceIp(instanceName);

    const project = await db(() =>
      prisma.cloudProject.create({
        data: {
          name: name.trim(),
          description: description?.trim() || null,
          status: "RUNNING",
          instanceName,
          ipAddress,
          keyName: keySel.keyName,
          keyPairId: keySel.keyPairId,
          os: image.id,
          cpu,
          memory,
          instanceType,
          // Attach the selected groups in the SAME write — the instance is never
          // live for even an instant without its firewall policy applied.
          ...(securityGroupIds.length
            ? { securityGroups: { connect: securityGroupIds.map((id) => ({ id })) } }
            : {}),
        },
        include: {
          securityGroups: { select: { id: true, name: true } },
          keyPair: { select: { id: true, name: true, fingerprint: true } },
        },
      })
    );
    // The private key is sent EXACTLY ONCE and only when we just generated it.
    // Reusing an existing key pair returns nothing — the user already has it.
    res.status(201).json({ ...project, privateKey: keySel.privateKey });
  } catch (err) {
    console.error("Error launching VM:", err);
    // Best-effort cleanup so a half-launched VM does not linger on the host.
    // Scoped `delete --purge` — never the global `purge`, which can block.
    try {
      await multipass(["delete", "--purge", instanceName], { timeout: 60000 });
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
app.post("/api/projects/:id/stop", enforceInbound(), async (req, res) => {
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
app.post("/api/projects/:id/start", enforceInbound(), async (req, res) => {
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
app.delete("/api/projects/:id", enforceInbound(), async (req, res) => {
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
        // `delete --purge` is ONE atomic, per-instance command.
        //
        // We used to run `delete` then a bare `purge`. That was wrong: `purge` is
        // a GLOBAL operation over every soft-deleted instance, so it serialises
        // on the multipass daemon and can block for a long time. When it stalled,
        // the request never reached the DB delete — leaving the VM gone but the
        // row behind (a zombie the user could never terminate). One scoped
        // command avoids the global lock entirely.
        await multipass(["delete", "--purge", project.instanceName], {
          timeout: 90000, // stay well inside the client's 150s budget
        });
      } catch (err) {
        if (err.kind === "NO_MULTIPASS") throw err;

        // VM already gone (or soft-deleted by a previous half-failed attempt):
        // that's the desired end state, so fall through and clean up the row.
        // This self-heals any zombie records created by the old code path.
        if (!isNotFoundError(err)) {
          return res
            .status(500)
            .json({ error: `Failed to terminate VM: ${err.message}` });
        }
        console.warn(
          `[terminate] ${project.instanceName} was already gone — removing the DB record.`
        );
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
app.get("/api/projects/:id/metrics", enforceInbound(), async (req, res) => {
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

  // FIREWALL: evaluate the terminal as inbound TCP/22 traffic to this instance.
  // Rejected BEFORE the WebSocket handshake completes, so a blocked client sees
  // a refused connection rather than an open-then-closed socket.
  checkWsInbound(id, req)
    .then((verdict) => {
      if (!verdict.allowed) {
        console.warn(
          `[SG] DENY ws ${verdict.ip} -> instance ${id} (TCP/${SSH_PORT}) — ${verdict.reason}`
        );
        socket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
            "Content-Type: text/plain\r\n" +
            "Connection: close\r\n\r\n" +
            verdict.reason +
            "\n"
        );
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (client) => handleTerminal(client, id));
    })
    .catch((err) => {
      console.error("[SG] ws upgrade check failed:", err);
      socket.destroy(); // fail closed
    });
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
