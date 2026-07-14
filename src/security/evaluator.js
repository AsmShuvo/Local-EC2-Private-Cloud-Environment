// Security-group rule evaluation engine (pure — no DB, no Express).
//
// AWS semantics we replicate:
//   * Rules are ALLOW-only. There is no explicit DENY.
//   * Attached groups are UNIONed: if ANY rule in ANY attached group matches,
//     traffic is allowed. Anything not explicitly allowed is denied.
//   * Groups are STATEFUL: we evaluate only the connection *initiation*. Once a
//     WebSocket/session is allowed, its return traffic is not re-checked.
//
// One deliberate divergence, documented:
//   * In AWS, an instance must have >= 1 group and a group with no rules denies
//     everything. Here, an instance with ZERO groups attached is treated as
//     UNMANAGED (allow all). Otherwise every pre-existing instance would
//     instantly lose terminal access the moment this feature shipped.
//     Attach one group and default-deny kicks in immediately.

const { ipInCidr, normalizeIp } = require("./cidr");

const DIRECTION = { IN: "INBOUND", OUT: "OUTBOUND" };

/**
 * Does a rule cover this port?
 *   - rule.fromPort == null  -> the rule covers ALL ports.
 *   - packet port == null    -> the CALLER is not asking about a specific port
 *     (a management-plane / IP-level check), so any rule's port qualifies and
 *     only the source IP + protocol decide. Used by enforceInbound() with no
 *     port. Traffic checks (e.g. the terminal) always pass an explicit port.
 */
function portMatches(rule, port) {
  if (rule.fromPort == null) return true; // rule = all ports
  if (port == null) return true; // caller = port-agnostic (IP-level) check
  const from = rule.fromPort;
  const to = rule.toPort ?? rule.fromPort; // null toPort => single port
  return port >= from && port <= to;
}

/** Does a rule cover this protocol? ("ALL" matches anything) */
function protocolMatches(rule, protocol) {
  const rp = String(rule.protocol || "TCP").toUpperCase();
  if (rp === "ALL") return true;
  return rp === String(protocol || "TCP").toUpperCase();
}

function ruleMatches(rule, { ip, port, protocol }) {
  return (
    protocolMatches(rule, protocol) &&
    portMatches(rule, port) &&
    ipInCidr(ip, rule.sourceIp)
  );
}

/**
 * Evaluate inbound traffic against an instance's attached security groups.
 *
 * @param {Array} groups  - [{ id, name, rules: [ { direction, protocol, fromPort, toPort, sourceIp } ] }]
 * @param {Object} packet - { ip, port, protocol }
 * @returns {{ allowed:boolean, reason:string, matched?:object, unmanaged?:boolean }}
 */
function evaluateInbound(groups, packet) {
  const ip = normalizeIp(packet.ip);
  const port = packet.port ?? null;
  const protocol = (packet.protocol || "TCP").toUpperCase();

  // No groups attached -> unmanaged instance, allow (see note above).
  if (!Array.isArray(groups) || groups.length === 0) {
    return {
      allowed: true,
      unmanaged: true,
      reason: "No security groups attached (unmanaged instance)",
    };
  }

  for (const group of groups) {
    const inbound = (group.rules || []).filter(
      (r) => String(r.direction).toUpperCase() === DIRECTION.IN
    );
    for (const rule of inbound) {
      if (ruleMatches(rule, { ip, port, protocol })) {
        return {
          allowed: true,
          reason: `Allowed by ${group.name} (${protocol}/${
            rule.fromPort ?? "all"
          } from ${rule.sourceIp})`,
          matched: { groupId: group.id, groupName: group.name, ruleId: rule.id },
        };
      }
    }
  }

  // Default deny — nothing explicitly allowed it.
  return {
    allowed: false,
    reason: `Blocked by Security Group: no inbound rule allows ${protocol}/${
      port ?? "any"
    } from ${ip}`,
  };
}

module.exports = { evaluateInbound, ruleMatches, portMatches, protocolMatches, DIRECTION };
