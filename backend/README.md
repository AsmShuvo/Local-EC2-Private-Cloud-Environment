# EC2-Replica — Backend API

Node.js/Express backend that sits between the custom UI and OpenStack (DevStack + OVN).
It authenticates against Keystone, caches the token, and exposes a small REST API
over Nova for listing, launching, and controlling instances.

## Structure

```
backend/
├── package.json
├── .env                 # your real secrets (gitignored)
├── .env.example         # template
└── src/
    ├── server.js        # boots the HTTP server
    ├── app.js           # express app: middleware + routes
    ├── config/          # loads & validates env vars
    ├── services/
    │   ├── keystone.service.js   # token auth, caching, auto-renew
    │   └── nova.service.js       # compute API calls
    ├── controllers/     # thin HTTP handlers
    ├── routes/          # endpoint definitions
    ├── middlewares/     # asyncHandler + central error handler
    └── utils/           # logger
```

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then edit .env with your real values
npm run dev               # or: npm start
```

Fill in `.env` — at minimum the Keystone URL/credentials and the default
image/network IDs. Grab real IDs from the DevStack host:

```bash
openstack image list       # -> DEFAULT_IMAGE_ID (e.g. the cirros image)
openstack flavor list      # -> DEFAULT_FLAVOR_ID
openstack network list     # -> DEFAULT_NETWORK_ID (your OVN network)
```

## Endpoints

| Method | Path                        | Purpose                                  |
|--------|-----------------------------|------------------------------------------|
| GET    | `/health`                   | Liveness check                           |
| GET    | `/api/instances`            | List all instances (formatted)           |
| POST   | `/api/instances`            | Launch a new instance                    |
| POST   | `/api/instances/:id/action` | START / STOP / REBOOT / TERMINATE        |

### Examples

```bash
# List
curl http://localhost:5000/api/instances

# Launch (imageId/flavorId/networkId optional -> fall back to .env defaults)
curl -X POST http://localhost:5000/api/instances \
  -H 'Content-Type: application/json' \
  -d '{"name":"web-1"}'

# Control
curl -X POST http://localhost:5000/api/instances/<id>/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"REBOOT"}'
```

## How auth works

The first request triggers a Keystone password-auth call. The returned
`X-Subject-Token` and its `expires_at` are cached in memory. Subsequent
requests reuse it; the token is only re-fetched once it's within
`TOKEN_RENEW_BUFFER_SECONDS` of expiring. The Nova endpoint is auto-discovered
from the Keystone service catalog (override with `OS_COMPUTE_URL` if needed).
