// The "stateful firewall" interception layer.
//
// Two entry points:
//   1. enforceInbound({ port, protocol })  -> Express middleware for HTTP routes
//   2. checkWsInbound(instanceId, rawIp)   -> called during the WS upgrade
//
// Both resolve the instance's attached groups and run the SAME pure evaluator,
// so HTTP and WebSocket can never drift apart in behaviour.

const { normalizeIp } = require("./cidr");
const { evaluateInbound } = require("./evaluator");
const { getInstanceGroups } = require("./service");

// The web terminal (Instance Connect) IS shell access to the VM, so we evaluate
// it exactly as if it were inbound TCP/22 traffic hitting the instance.
const SSH_PORT = 22;

/** Pull the real client IP off an Express request. */
function clientIpFromReq(req) {
  return normalizeIp(
    req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress
  );
}

/** Pull the real client IP off a raw WebSocket upgrade request. */
function clientIpFromSocket(req) {
  return normalizeIp(req.socket?.remoteAddress);
}

/**
 * Core check, shared by HTTP + WS.
 * @returns {{ allowed:boolean, reason:string, ip:string, unmanaged?:boolean }}
 */
async function authorizeInbound(instanceId, ip, { port, protocol = "TCP" }) {
  const groups = await getInstanceGroups(instanceId);
  if (groups === null) {
    return { allowed: false, notFound: true, ip, reason: "Instance not found" };
  }
  const verdict = evaluateInbound(groups, { ip, port, protocol });
  return { ...verdict, ip };
}

/**
 * Express middleware factory. Attach to any instance-scoped route.
 *
 *   app.post("/api/projects/:id/stop", enforceInbound({ port: 22 }), handler)
 *
 * `port: null` = an IP-level check only (matches any rule allowing that source),
 * which is what we use for management calls.
 */
function enforceInbound({ port = null, protocol = "TCP" } = {}) {
  return async (req, res, next) => {
    const instanceId = Number(req.params.id);
    if (!Number.isInteger(instanceId)) {
      return res.status(400).json({ error: "Invalid instance id" });
    }

    const ip = clientIpFromReq(req);
    try {
      const verdict = await authorizeInbound(instanceId, ip, { port, protocol });

      if (verdict.notFound) {
        return res.status(404).json({ error: "Instance not found" });
      }
      if (!verdict.allowed) {
        console.warn(`[SG] DENY ${ip} -> instance ${instanceId} (${protocol}/${port}) — ${verdict.reason}`);
        // 403 is the honest status: reached us, refused by policy.
        return res.status(403).json({
          error: "Blocked by Security Group",
          detail: verdict.reason,
          sourceIp: ip,
        });
      }

      req.securityVerdict = verdict; // available downstream if needed
      return next();
    } catch (err) {
      console.error("[SG] evaluation error:", err);
      // Fail CLOSED: if we cannot evaluate policy, we do not grant access.
      return res.status(500).json({ error: "Security group evaluation failed" });
    }
  };
}

/**
 * WebSocket gate — call during the HTTP upgrade, BEFORE completing the handshake.
 * Evaluated as inbound TCP/22 (shell access).
 */
async function checkWsInbound(instanceId, req) {
  const ip = clientIpFromSocket(req);
  try {
    return await authorizeInbound(instanceId, ip, {
      port: SSH_PORT,
      protocol: "TCP",
    });
  } catch (err) {
    console.error("[SG] ws evaluation error:", err);
    return { allowed: false, ip, reason: "Security group evaluation failed" };
  }
}

module.exports = {
  SSH_PORT,
  enforceInbound,
  checkWsInbound,
  authorizeInbound,
  clientIpFromReq,
  clientIpFromSocket,
};
