# How to Run — EC2-Replica (Stratus Console)

A local "mini-AWS": a React console that provisions **real Multipass VMs** on your
laptop, backed by Express + Prisma + a Neon Postgres database.

| Piece | Where it runs | Port |
|-------|---------------|------|
| **Backend** (Express + Prisma + Multipass orchestration) | **Your host laptop** | `5000` |
| **Frontend** (React + Vite console) | Your host laptop | `5173` |
| **Managed VMs** (`phase3-demo-xxxx`, …) | Multipass on the host | — |
| Neon Postgres (state store) | Cloud | — |

> ### ⚠️ The backend runs on the HOST — not inside a VM
> The backend shells out to the host's `multipass` CLI to launch/stop/purge VMs.
> A backend running *inside* a VM cannot reach the host's `multipassd` socket, so
> it could never orchestrate anything. **Run `node server.js` on your laptop.**
>
> The old `my-local-ec2` VM (with the `~/app` mount) was the Phase 1–2 home for the
> backend. It is **no longer needed** to run the app — you can leave it stopped, or
> keep it around as just another instance.

---

## Prerequisites

- **Node.js 18+** on the host (`node -v`)
- **Multipass** installed on the host — this is what actually creates the VMs:
  ```bash
  multipass version          # e.g. multipass 1.16.3
  ```
- A **`.env`** in the project root:
  ```
  DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require&channel_binding=require"
  PORT=5000
  ```

---

## Run it (2 terminals)

### Terminal 1 — Backend (on the host)
```bash
cd ~/projects/EC2-Replica
npm install            # first time only
npx prisma generate    # first time, and after any schema change
npm start              # → "Server running on 5000 (0.0.0.0 …)"
```

Verify:
```bash
curl http://localhost:5000/api/projects     # → []
```

### Terminal 2 — Frontend (on the host)
```bash
cd ~/projects/EC2-Replica/frontend
npm install            # first time only
npm run dev            # → http://localhost:5173
```

Open **http://localhost:5173**. The status pill should read **Healthy**.

> The frontend targets `http://localhost:5000` (`API_BASE_URL` in
> `frontend/src/api.js`). If you serve the UI from another machine, change it to
> the host's LAN IP.

---

## What the app actually does

Launching an instance in the UI runs a **real** `multipass launch` on your laptop.

| UI action | Shell command run on the host | Then |
|-----------|-------------------------------|------|
| **Launch instance** | `multipass launch --name <name> --cpus 1 --memory 1G` | reads the IPv4 via `multipass info … --format json`, saves `instanceName` + `ipAddress`, status `RUNNING` |
| **Stop** | `multipass stop <name>` | status → `STOPPED` |
| **Start** | `multipass start <name>` | refreshes IP, status → `RUNNING` |
| **Terminate** | `multipass delete <name>` + `multipass purge` | deletes the DB row |

Instance names are sanitized to valid hostnames with a unique suffix
(e.g. `Phase3 Demo` → `phase3-demo-pba6`).

**These are slow.** A launch takes ~30–90s (VM boot); start ~30s; stop/terminate
~5s. The frontend uses long per-operation timeouts (launch 5 min, actions 2.5 min)
so the UI doesn't abort mid-operation.

---

## API reference

| Method | Route | Body | Effect |
|--------|-------|------|--------|
| GET | `/` | — | health check |
| GET | `/api/projects` | — | `200` list of instances |
| POST | `/api/projects` | `{ name, description }` | **launches a real VM**, `201` |
| POST | `/api/projects/:id/start` | — | `multipass start`, `200` |
| POST | `/api/projects/:id/stop` | — | `multipass stop`, `200` |
| DELETE | `/api/projects/:id` | — | `multipass delete` + `purge`, `200` |

---

## Handy Multipass commands (host)

```bash
multipass list                       # all instances + IPs
multipass info <name>                # details (state, ipv4, mounts)
multipass shell <name>               # SSH into an instance
multipass stop <name>                # stop
multipass delete <name> && multipass purge   # destroy permanently
multipass purge                      # wipe all deleted instances
```

---

## Troubleshooting

### "Multipass CLI not found" (HTTP 503)
The backend can't find `multipass`. Either you're running the backend **inside a VM**
(it must run on the host), or `multipass` isn't on the service `PATH` — snap installs
it to `/snap/bin`, which some environments omit. Point at it explicitly:
```bash
MULTIPASS_BIN=/snap/bin/multipass npm start
```

### Neon DB connection timeout / IPv6 issue
**Symptom.** All DB calls fail — `GET`/`POST /api/projects` return `500`
(`{"error":"Failed to fetch projects"}`), and logs show a WebSocket
`ETIMEDOUT` / `ENETUNREACH` to `wss://...neon.tech:443`.

**Root cause.** The host/VM resolves the Neon hostname to **IPv6 (AAAA)** records
(`2600:1f10:...`) but has **no IPv6 route**, so the Neon driver hangs until timeout.
Neon itself is fine.

Confirm:
```bash
getent hosts ep-<your-endpoint>.aws.neon.tech   # only 2600:... (IPv6)
ip -6 route show default                          # empty → no IPv6 route
```

**The fix** (already applied) — force Node to prefer IPv4, at the top of `server.js`:
```js
require("node:dns").setDefaultResultOrder("ipv4first");
```
Equivalent without a code change:
```bash
NODE_OPTIONS="--dns-result-order=ipv4first" node server.js
```

### Occasional `500` with an empty error message
A known **transient Neon WebSocket flake** (the pooler drops a connection). It
succeeds on retry — just click the action again. Neon also **auto-suspends when
idle**, so the first request after a pause takes ~1–2s to wake it.

### `ERR_CONNECTION_REFUSED` in the browser
Nothing is listening. Start the backend (`npm start` in the project root) and the
frontend (`npm run dev` in `frontend/`). Remember the backend is on the **host** now,
so `http://localhost:5000` is correct — not a VM IP.

### After changing `prisma/schema.prisma`
```bash
npx prisma db push       # add --accept-data-loss if it warns about a new constraint
npx prisma generate
```
Then restart the backend.

---

## Notes / architecture

- **Prisma 7** with the `prisma-client-js` generator and the **`@prisma/adapter-neon`**
  driver adapter (Prisma 7 requires an adapter; the Neon one handles the pooler and
  wake-from-idle).
- The backend binds `0.0.0.0:5000` so other machines on your LAN can reach it.
- VM orchestration uses `child_process.execFile` (no shell → no injection), with
  timeouts and a `/snap/bin/multipass` fallback.
- Private keys (`*.pem`) are gitignored. They were previously committed — rotate the
  key if this repo was ever pushed.
