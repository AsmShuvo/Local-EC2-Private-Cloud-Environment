# Stratus Console — Project Explanation & Functional Requirements

---

## 1. What This Project Is

**Stratus Console** is a self-hosted **IaaS (Infrastructure-as-a-Service) platform** — a
working miniature of **AWS EC2** that runs entirely on a single laptop.

From a web dashboard, a user can create, control, connect to, monitor, and secure
**real virtual machines** running on their own hardware. Nothing is mocked: clicking
"Launch" boots a genuine Ubuntu VM via **Multipass** (QEMU/KVM).

> **One-line summary:** A browser-based cloud console that turns your laptop into a
> personal cloud provider — like a tiny AWS EC2.

### The core idea
| Real AWS | Stratus Console |
|----------|-----------------|
| AWS data centre | Your laptop |
| Hypervisor (Nitro / KVM) | **Multipass** (QEMU/KVM) |
| EC2 Control Plane (API) | **Express backend** |
| Control-plane database | **Neon PostgreSQL + Prisma** |
| AWS Management Console | **React dashboard** |
| EC2 Instances | **Multipass VMs** |

---

## 2. System Architecture

```
    ┌──────────────────────────────────────────────────────┐
    │  BROWSER  (laptop, phone, any device on the Wi-Fi)   │
    │  React + Vite dashboard  ·  xterm.js  ·  Recharts    │
    └───────────────┬──────────────────────┬───────────────┘
             HTTP (axios)            WebSocket (terminal)
                    │                      │
    ┌───────────────▼──────────────────────▼───────────────┐
    │  BACKEND — Express (runs ON THE HOST, port 5000)     │
    │  ├── Security-group firewall (intercepts requests)   │
    │  ├── Instance controller  (child_process → CLI)      │
    │  ├── Key-pair generator   (node:crypto)              │
    │  └── PTY bridge           (node-pty)                 │
    └───────┬──────────────────────────────┬───────────────┘
            │ multipass CLI                │ Prisma
            ▼                              ▼
    ┌───────────────┐              ┌──────────────────┐
    │  MULTIPASS    │              │  NEON POSTGRES   │
    │  (hypervisor) │              │ (control-plane   │
    │  real Ubuntu  │              │   database)      │
    │     VMs       │              └──────────────────┘
    └───────────────┘
```

### Critical architectural decision: the backend runs on the **HOST**, not inside a VM
The backend shells out to the host's `multipass` CLI to create VMs. The `multipass`
binary exists **only on the host**, and a VM can never reach the host's `multipassd`
socket. Therefore a VM-resident backend could never orchestrate anything.

This mirrors reality: **an EC2 instance cannot tell the hypervisor to create more
EC2 instances.** You must manage from *outside* the thing you are managing.

### Why a database at all?
Multipass only knows the raw machine (name, state, IP). It has no concept of the
*project*: the friendly name, the description, the instance-type label, which key
pair was issued, or which security groups apply. The database stores that
**business meaning**, exactly as AWS's control plane stores instance metadata
separately from the hypervisor. `GET /api/projects` reads the database, not the
hypervisor — just like `DescribeInstances`.

---

## 3. Functional Requirements

### FR-1 — Launch a real instance
- The user enters a **name**, an optional **description**, and selects an **instance type**.
- The backend sanitises the name into a valid hostname and appends a unique suffix
  (`My Server` → `my-server-a3f9`), preventing collisions.
- It executes: `multipass launch --name <n> --cpus <c> --memory <m> --cloud-init -`
- It then polls `multipass info --format json` to read the VM's real **IPv4 address**.
- The instance is saved with status `RUNNING`.
- **Acceptance:** a genuine Ubuntu VM exists on the host and is reachable at the IP shown.

### FR-2 — Instance types (AWS-style sizing)
The user chooses vCPU/RAM through familiar named types:

| Type | vCPU | RAM |
|------|------|-----|
| `t2.micro` (default) | 1 | 1 GB |
| `t2.small` | 1 | 2 GB |
| `t2.medium` | 2 | 4 GB |

- The **server-side catalog is authoritative**: a client cannot request `t2.micro`
  while secretly passing `cpu: 64`. The server ignores spoofed values and resolves
  specs from its own table.
- **Acceptance:** launching `t2.medium` produces a VM that genuinely reports 2 vCPUs and 4 GB.

### FR-3 — List instances
- A table shows every instance: **ID, name, instance type (+ specs), status, IPv4
  address, description, creation time, attached security groups, key indicator**.
- Loaded from the database on page load.

### FR-4 — Instance lifecycle (Start / Stop / Terminate)
| Action | Real command executed | Result |
|--------|----------------------|--------|
| **Stop** | `multipass stop <n>` | VM shuts down, disk preserved → status `STOPPED` |
| **Start** | `multipass start <n>` | VM boots; **IP is re-read and updated** (it can change, exactly like an EC2 public IP without an Elastic IP) → status `RUNNING` |
| **Terminate** | `multipass delete --purge <n>` | VM is permanently destroyed and the DB record removed |

- Every action shows a per-row loading spinner and updates the row when it completes.
- Terminate asks for confirmation first (destructive, irreversible).
- **Self-healing:** if the VM is already gone, the database record is still cleaned up
  rather than leaving an un-deletable "zombie" row.

### FR-5 — Status indicator
- A colour-coded badge per instance: **green = RUNNING**, **amber = STOPPED**.

### FR-6 — SSH key-pair management
Replicates the AWS EC2 key-pair security model exactly.

1. On launch, the backend generates a **fresh, unique RSA 2048 key pair**
   (`node:crypto`) for that instance alone.
2. The **private key** is exported as a PKCS#1 PEM (`-----BEGIN RSA PRIVATE KEY-----`)
   — the same format as an AWS `.pem`.
3. The **public key** is converted to OpenSSH `authorized_keys` format and injected
   into the VM at first boot via **cloud-init** (`ssh_authorized_keys`), landing in
   `/home/ubuntu/.ssh/authorized_keys`.
4. The private key is returned to the browser **exactly once**, auto-downloaded as
   `<project-name>-key.pem`, and is **never stored on the server**.
5. A confirmation modal warns that the key cannot be re-downloaded.
6. Instances secured with a key show a **🔑 badge** in the table.

- **Acceptance:** `ssh -i <name>-key.pem ubuntu@<instance-ip>` authenticates successfully.
- **Security property:** the server keeps only the public key. Losing the private key
  means losing key-based access — identical to AWS.

### FR-7 — Web terminal ("Instance Connect")
- Clicking **Connect** on a RUNNING instance opens a full-screen **xterm.js** terminal
  in the browser.
- The backend spawns a real **PTY** (`node-pty`) running `multipass exec <n> -- bash -l`
  and pipes stdin/stdout bidirectionally over a **WebSocket** (`/api/ws/terminal/:id`).
- The user gets a genuine interactive shell — prompts, colours, `sudo`, `vim`, `top`
  all work. Terminal resize events are forwarded to the PTY.
- **No SSH keys are required**, because the backend already has host-level Multipass
  access. This is conceptually closest to **AWS Systems Manager Session Manager**,
  which also connects without opening an SSH port.
- **Acceptance:** a user can install software and manage files inside the VM from the
  browser without ever touching a terminal on the host.

### FR-8 — Real-time monitoring (mini CloudWatch)
- Clicking **Monitor** opens live time-series charts, polled every **2 seconds** from
  `GET /api/projects/:id/metrics`.
- Charts (Recharts): **CPU & Memory utilisation (%)**, **Network In/Out**,
  **Disk Read/Write**, plus live stat tiles.

| Metric | Source |
|--------|--------|
| Memory usage | **Real** — from `multipass info` |
| Disk usage | **Real** — from `multipass info` |
| CPU utilisation | **Real** — derived from load average ÷ vCPU count |
| Network In/Out, Disk I/O | **Simulated** — bounded random walk (Multipass does not expose these) |

> Interesting note: AWS CloudWatch does **not** report memory by default either — the
> hypervisor cannot see inside the guest, so a CloudWatch Agent must be installed.
> Our platform reports real memory because Multipass exposes it.

### FR-9 — Security Groups (stateful firewall)
A full **many-to-many** security model, mirroring AWS security groups.

**Data model**
- A `SecurityGroup` has a name, description, and a list of **rules**.
- A rule has: **protocol** (TCP/UDP/ICMP/ALL), **port** (or range, or "all"), and
  **source IP** as an IP or **CIDR** (e.g. `192.168.0.0/24`, `0.0.0.0/0`).
- An **instance can have many groups; a group can be attached to many instances**
  (implicit join table).

**Evaluation semantics (matching AWS)**
- Rules are **ALLOW-only** — there is no explicit DENY.
- Attached groups are **UNIONed**: if any rule in any attached group matches, traffic
  is allowed. Anything not explicitly allowed is **denied**.
- **Stateful:** only connection *initiation* is evaluated; an established session is
  not re-checked.
- **Fail-closed:** if policy cannot be evaluated, access is refused.
- **Documented divergence:** an instance with **zero groups is unmanaged (allow-all)**.
  In AWS an instance always has at least one group; here, defaulting to deny would
  instantly lock users out of every pre-existing instance.

**Enforcement**
- The **web terminal is evaluated as inbound TCP/22 traffic** — the semantically
  correct enforcement point, since it grants shell access. A blocked client is
  **rejected during the WebSocket upgrade with HTTP 403**, before the handshake
  completes, so it sees a refused connection rather than a socket that opens and dies.
- Instance-scoped management routes additionally perform an **IP-level** check.
- Denied requests return **`403 Blocked by Security Group`** with the reason and the
  offending source IP.

**UI**
- A **Security Groups tab**: create groups and add dynamic inbound rules (with AWS-style
  presets — SSH / HTTP / HTTPS / Custom TCP / All traffic — and a **"My IP"** shortcut).
- A **🛡️ button on each instance** opens a multi-select modal to **attach/detach**
  multiple groups in real time, with a warning if the user is about to lock themselves out.
- Attached groups appear as chips under the instance name.

### FR-10 — Multi-device / LAN access
- The backend binds to `0.0.0.0`, and the Vite dev server runs with `--host`, so any
  device on the same Wi-Fi can use the console at `http://<laptop-lan-ip>:5173`.
- The frontend **auto-detects** the API host from `window.location.hostname`, so the
  REST API *and* the terminal WebSocket automatically follow the laptop's LAN IP with
  no configuration.
- **Boundary:** other devices can fully **control the VMs through the console**, but
  cannot reach the VMs' IPs (`10.176.164.x`) directly — that network exists only inside
  the host. Terminal traffic is relayed through the backend.

---

## 4. Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| **Look & feel** | A professional cloud-console experience with its own identity ("Stratus"), not a visual clone of AWS. |
| **Latency tolerance** | Real VM operations are slow (launch ≈ 30–90 s). The UI uses long per-operation timeouts (launch 5 min, actions 2.5 min) and never aborts mid-operation. |
| **Resilience** | Neon's pooler intermittently drops connections. Every DB call is wrapped in a retry helper that retries transient failures (3 attempts, backoff) but never retries logical errors (e.g. "record not found"). |
| **Security of secrets** | Private keys are never written to disk server-side and never committed (`.gitignore` covers `*.pem`, `.env`, key folders). |
| **Command safety** | All shell interaction uses `child_process.execFile`/`spawn` with argument arrays — **never a shell string** — so command injection is structurally impossible. |
| **Modularity** | Security-group logic is split into pure, testable modules (`cidr.js`, `evaluator.js`), a service layer, and middleware. The rule engine has no I/O and is unit-tested. |

---

## 5. Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, axios, xterm.js, Recharts |
| Backend | Node.js, Express |
| Virtualisation | Multipass (QEMU/KVM) |
| Database | Neon PostgreSQL (serverless) |
| ORM | Prisma 7 (with the Neon driver adapter) |
| Terminal bridge | `node-pty` + `ws` (WebSocket) |
| Cryptography | `node:crypto` (RSA 2048) |
| VM provisioning | cloud-init (user-data over stdin) |

---

## 6. API Reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/` | Health check |
| `GET` | `/api/projects` | List all instances (with security groups) |
| `POST` | `/api/projects` | **Launch a real VM**; returns the private key **once** |
| `POST` | `/api/projects/:id/start` | Start the VM, refresh its IP |
| `POST` | `/api/projects/:id/stop` | Stop the VM |
| `DELETE` | `/api/projects/:id` | Terminate (delete + purge) the VM |
| `GET` | `/api/projects/:id/metrics` | Point-in-time metrics (polled) |
| `GET` | `/api/instance-types` | The instance-type catalog |
| `WS` | `/api/ws/terminal/:id` | Interactive shell (firewalled as TCP/22) |
| `GET` | `/api/security-groups` | List security groups |
| `POST` | `/api/security-groups` | Create a group with rules |
| `DELETE` | `/api/security-groups/:id` | Delete a group |
| `POST` | `/api/security-groups/:id/rules` | Add a rule |
| `DELETE` | `/api/security-groups/:id/rules/:ruleId` | Remove a rule |
| `GET` | `/api/security-groups/whoami` | The caller's IP as the server sees it |
| `GET` | `/api/projects/:id/security-groups` | Groups attached to an instance |
| `PUT` | `/api/projects/:id/security-groups` | Replace the attached set (many-to-many) |

---

## 7. Data Model

**CloudProject (instance)**
`id, name, description, status, instanceName, ipAddress, keyName, cpu, memory,
instanceType, createdAt` — plus a many-to-many link to `SecurityGroup`.

**SecurityGroup**
`id, name, description, createdAt` — has many `SecurityRule`, and is attached to
many instances.

**SecurityRule**
`id, groupId, direction (INBOUND/OUTBOUND), protocol, fromPort, toPort, sourceIp (CIDR)`

---

## 8. Known Limitations (Future Work)

| AWS feature | Status here |
|-------------|-------------|
| Security Groups | ✅ Implemented — but enforced at the **application layer**. A device could still reach a VM's IP directly and bypass it. Making it a true firewall would require pushing rules into each VM's `ufw`. |
| VPC / Subnets / Route Tables | ❌ Not implemented — one flat Multipass bridge network. |
| Elastic IP (static IP) | ❌ Not implemented — IPs are DHCP and can change on restart. |
| AMI selection | ❌ Not implemented — always the default Ubuntu image. |
| EBS volumes / snapshots | ❌ Not implemented. |
| Auto Scaling / Load Balancer | ❌ Not implemented. |
| IAM / user authentication | ❌ **Not implemented** — anyone who can reach the dashboard has full control. |
| HTTPS | ❌ Not implemented — runs over HTTP on a trusted local network. |
| Billing / metering | ❌ Not implemented. |
| State reconciliation | ⚠️ Partial — the database is the *known* state and Multipass the *actual* state. If a VM is deleted manually they can drift. Terminate self-heals; AWS runs a full reconciliation loop. |

---

## 9. Summary

Stratus Console implements the **complete core lifecycle of an IaaS platform**:

> **Provision → Configure → Secure → Access → Monitor → Destroy**

Every one of those operations acts on a **real virtual machine**. The project
demonstrates hypervisor orchestration, asymmetric-key security, cloud-init
provisioning, PTY/WebSocket streaming, time-series monitoring, and a stateful
firewall with a many-to-many policy model — the same building blocks that AWS EC2
is made of, reproduced at laptop scale.

- creATE INSTNCE  btn
- securityu group mount
- how vm is created
- key pair dekha jabe
- multiple OS 