# How to Run — EC2-Replica

A small full-stack project:

- **Backend** — Node.js + Express + Prisma, talking to a **Neon** PostgreSQL database. Runs on port **5000**.
- **Frontend** — React + Vite dashboard (axios), runs on port **5173**.
- **"EC2" host** — the backend is meant to run inside a **multipass VM** (`my-local-ec2`), which acts as your local EC2 instance. The frontend runs on your host machine and talks to the VM over the network.

---

## Prerequisites

- Node.js 18+ and npm (host has v24, VM has v22 — both fine)
- A `.env` file in the project root with the Neon connection string:
  ```
  DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require&channel_binding=require"
  PORT=5000
  ```
- (For the VM path) multipass with the `my-local-ec2` instance running, and the SSH key `my-ec2-key.pem`.

---

## Option A — Run everything on your host (simplest, for local dev)

### 1. Backend
```bash
cd ~/projects/EC2-Replica
npm install          # first time only
npx prisma generate  # first time / after schema changes
npm start            # → "Server running on 5000 (0.0.0.0 ...)"
```
Verify:
```bash
curl http://localhost:5000/api/projects   # → []
```

### 2. Frontend
Open a **second terminal**:
```bash
cd ~/projects/EC2-Replica/frontend
npm install          # first time only
npm run dev          # → http://localhost:5173
```

> If you run this way, point the frontend at the host: set `API_BASE_URL` in
> `frontend/src/api.js` to `http://localhost:5000`.

---

## Option B — Run the backend inside the multipass VM ("real EC2 replica")

This matches the intended architecture: backend on the VM, frontend on the host.

### 1. Find / confirm the VM IP (it uses DHCP and can change!)
```bash
multipass list
# Name           State     IPv4              Image
# my-local-ec2   Running   10.176.164.96     Ubuntu 26.04 LTS
```
The frontend must point at this IP — `API_BASE_URL` in `frontend/src/api.js`
is currently `http://10.176.164.96:5000`. Update it if the IP changed.

### 2. Sync the latest code into the VM (from the host)
`multipass mount/transfer/exec` are broken on this setup (SSH auth error),
so sync over direct SSH with the key:
```bash
cd ~/projects/EC2-Replica
KEY=my-ec2-key.pem
VM=ubuntu@10.176.164.96
RSH="ssh -i $KEY -o StrictHostKeyChecking=no"

rsync -az -e "$RSH" server.js prisma.config.ts package.json package-lock.json .env $VM:~/app/
rsync -az -e "$RSH" prisma/schema.prisma $VM:~/app/prisma/
```

### 3. Install deps + generate the Prisma client (inside the VM)
```bash
ssh -i my-ec2-key.pem ubuntu@10.176.164.96
cd ~/app
npm install
npx prisma generate
```

### 4. Start the backend inside the VM

**Recommended — survives SSH logout** (plain `npm start` gets killed by
systemd-logind when you disconnect):
```bash
sudo systemd-run --unit=ec2-backend --working-directory=/home/ubuntu/app /usr/bin/node server.js
```
Manage it:
```bash
systemctl is-active ec2-backend        # check it's running
sudo journalctl -u ec2-backend -f      # live logs
sudo systemctl stop ec2-backend        # stop
```

**Simple alternative (dies when you close the terminal):**
```bash
cd ~/app && npm start
```

### 5. Verify from the host
```bash
curl http://10.176.164.96:5000/api/projects   # → [] (or your projects)
```

### 6. Start the frontend on the host
```bash
cd ~/projects/EC2-Replica/frontend
npm run dev            # → http://localhost:5173
```
Open **http://localhost:5173** — the status badge should read **CONNECTED**.

---

## API reference

| Method | Route             | Body                        | Returns                    |
|--------|-------------------|-----------------------------|----------------------------|
| GET    | `/`               | —                           | `{ message: "..." }`       |
| GET    | `/api/projects`   | —                           | `200` array of projects    |
| POST   | `/api/projects`   | `{ name, description }`      | `201` created project      |

---

## Troubleshooting

- **`ERR_CONNECTION_REFUSED` / "Cannot reach the backend"**
  - You're likely opening `localhost:5000` on the host while the server runs in the VM. Use the **VM IP** (`http://10.176.164.96:5000`), not `localhost`.
  - The server may not be running. Check with `systemctl is-active ec2-backend` (or `curl http://10.176.164.96:5000/`).
  - The VM IP may have changed (DHCP). Re-check with `multipass list` and update `frontend/src/api.js`.

- **Backend keeps stopping after you log out of the VM**
  - Don't use plain `npm start` over SSH — systemd-logind kills it on disconnect. Use the `systemd-run` command in step B4.

- **`ETIMEDOUT` from Prisma / `/api/projects` fails intermittently**
  - Neon auto-suspends when idle; the first request wakes it (~1–2s). The Neon adapter handles this — just retry.
  - The VM needs outbound access to `*.neon.tech:443` (the adapter uses WebSockets over 443).

- **After changing `prisma/schema.prisma`**
  - Run `npx prisma generate` (and `npx prisma db push` to apply schema changes to Neon).

---

## Troubleshooting: Neon DB connection timeout inside the VM (IPv6 / DNS)

**Symptom.** The API works perfectly on the host, but inside the multipass VM
every database call fails. `GET`/`POST /api/projects` return `500`
(`{"error":"Failed to fetch projects"}` / `{"error":"Failed to create project"}`),
and the server logs show a WebSocket `ETIMEDOUT` / `ENETUNREACH` connecting to
`wss://...neon.tech:443`.

**Root cause.** The VM resolves the Neon hostname to **IPv6 (AAAA) records**
(e.g. `2600:1f10:...`), but multipass VMs have **no IPv6 default route**. Node's
default DNS ordering hands those IPv6 addresses to the Neon serverless driver
first, so the connection hangs until it times out. Neon itself is healthy — the
problem is purely IPv6 egress from the VM.

Confirm it inside the VM:
```bash
getent hosts ep-<your-endpoint>.aws.neon.tech   # returns only 2600:... (IPv6)
ip -6 route show default                          # empty → no IPv6 route
```

**The fix.** Force Node to prefer IPv4 when resolving hostnames. Add this at the
very top of `server.js` (right after `require("dotenv/config")`, before any
Prisma/Neon code):
```js
require("node:dns").setDefaultResultOrder("ipv4first");
```
This makes the Neon driver connect over IPv4, which the VM *can* route. It is a
no-op on the host (which has working IPv4/IPv6), so it is safe everywhere.

After adding it, restart the backend in the VM:
```bash
sudo systemctl restart ec2-backend        # if running as the systemd service
# then verify from the host:
curl http://<VM_IP>:5000/api/projects       # → 200 [] instead of 500
```

> Equivalent alternative (no code change): start Node with
> `NODE_OPTIONS="--dns-result-order=ipv4first" node server.js`. The in-code
> version is preferred so the fix travels with the app.

---

## Notes / architecture

- This is **Prisma 7**: the generator is `prisma-client-js` and the client is
  built with a **driver adapter** (`@prisma/adapter-neon`) — see `server.js`.
- The backend binds to `0.0.0.0:5000` so the host (and other machines) can reach the VM.
- The VM's app lives at `/home/ubuntu/app` and is kept in sync from the host project folder.
