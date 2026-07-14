// Data access for security groups. All DB calls go through db() (retry wrapper).
const { prisma, db } = require("../db");
const { isValidCidr } = require("./cidr");
const { DIRECTION } = require("./evaluator");

const PROTOCOLS = ["TCP", "UDP", "ICMP", "ALL"];

/** Present a group the way the API/UI wants it: rules split by direction. */
function serializeGroup(group) {
  const rules = group.rules || [];
  const shape = (r) => ({
    id: r.id,
    protocol: r.protocol,
    fromPort: r.fromPort,
    toPort: r.toPort,
    sourceIp: r.sourceIp,
  });
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    createdAt: group.createdAt,
    inboundRules: rules
      .filter((r) => r.direction === DIRECTION.IN)
      .map(shape),
    outboundRules: rules
      .filter((r) => r.direction === DIRECTION.OUT)
      .map(shape),
    instanceCount: group.instances ? group.instances.length : undefined,
  };
}

/** Validate + normalise one incoming rule from the client. */
function normalizeRule(raw, direction) {
  const protocol = String(raw?.protocol || "TCP").toUpperCase();
  if (!PROTOCOLS.includes(protocol)) {
    throw Object.assign(new Error(`Invalid protocol: ${raw?.protocol}`), { status: 400 });
  }

  const sourceIp = String(raw?.sourceIp || "0.0.0.0/0").trim();
  if (!isValidCidr(sourceIp)) {
    throw Object.assign(
      new Error(`Invalid sourceIp (use an IP or CIDR, e.g. 192.168.0.5 or 0.0.0.0/0): ${sourceIp}`),
      { status: 400 }
    );
  }

  // `port` (single) or fromPort/toPort (range). null/"" => all ports.
  const rawPort = raw?.port ?? raw?.fromPort;
  let fromPort = null;
  let toPort = null;
  if (rawPort !== null && rawPort !== undefined && String(rawPort).trim() !== "") {
    fromPort = parseInt(rawPort, 10);
    if (!Number.isInteger(fromPort) || fromPort < 0 || fromPort > 65535) {
      throw Object.assign(new Error(`Invalid port: ${rawPort}`), { status: 400 });
    }
    const rawTo = raw?.toPort;
    if (rawTo !== null && rawTo !== undefined && String(rawTo).trim() !== "") {
      toPort = parseInt(rawTo, 10);
      if (!Number.isInteger(toPort) || toPort < fromPort || toPort > 65535) {
        throw Object.assign(new Error(`Invalid toPort: ${rawTo}`), { status: 400 });
      }
    }
  }

  return { direction, protocol, fromPort, toPort, sourceIp };
}

async function listGroups() {
  const groups = await db(() =>
    prisma.securityGroup.findMany({
      include: { rules: true, instances: { select: { id: true } } },
      orderBy: { id: "desc" },
    })
  );
  return groups.map(serializeGroup);
}

async function getGroup(id) {
  const group = await db(() =>
    prisma.securityGroup.findUnique({
      where: { id },
      include: { rules: true, instances: { select: { id: true } } },
    })
  );
  return group ? serializeGroup(group) : null;
}

async function createGroup({ name, description, inboundRules = [], outboundRules = [] }) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error("name is required"), { status: 400 });
  }
  const rules = [
    ...inboundRules.map((r) => normalizeRule(r, DIRECTION.IN)),
    ...outboundRules.map((r) => normalizeRule(r, DIRECTION.OUT)),
  ];

  const group = await db(() =>
    prisma.securityGroup.create({
      data: {
        name: String(name).trim(),
        description: description?.trim() || null,
        rules: { create: rules },
      },
      include: { rules: true, instances: { select: { id: true } } },
    })
  );
  return serializeGroup(group);
}

async function deleteGroup(id) {
  // Rules cascade (onDelete: Cascade); the implicit M2M links are removed too.
  await db(() => prisma.securityGroup.delete({ where: { id } }));
  return { id, deleted: true };
}

async function addRule(groupId, raw, direction = DIRECTION.IN) {
  const data = normalizeRule(raw, direction);
  await db(() => prisma.securityRule.create({ data: { ...data, groupId } }));
  return getGroup(groupId);
}

async function deleteRule(groupId, ruleId) {
  await db(() =>
    prisma.securityRule.deleteMany({ where: { id: ruleId, groupId } })
  );
  return getGroup(groupId);
}

/** Attach/detach — the many-to-many operations. */
async function attachGroups(instanceId, groupIds) {
  await db(() =>
    prisma.cloudProject.update({
      where: { id: instanceId },
      data: { securityGroups: { connect: groupIds.map((id) => ({ id })) } },
    })
  );
  return getInstanceGroups(instanceId);
}

async function detachGroups(instanceId, groupIds) {
  await db(() =>
    prisma.cloudProject.update({
      where: { id: instanceId },
      data: { securityGroups: { disconnect: groupIds.map((id) => ({ id })) } },
    })
  );
  return getInstanceGroups(instanceId);
}

/** Replace the whole set in one call — what the UI dropdown uses. */
async function setInstanceGroups(instanceId, groupIds) {
  await db(() =>
    prisma.cloudProject.update({
      where: { id: instanceId },
      data: { securityGroups: { set: groupIds.map((id) => ({ id })) } },
    })
  );
  return getInstanceGroups(instanceId);
}

/** The groups (with rules) attached to an instance — used by the evaluator. */
async function getInstanceGroups(instanceId) {
  const instance = await db(() =>
    prisma.cloudProject.findUnique({
      where: { id: instanceId },
      include: { securityGroups: { include: { rules: true } } },
    })
  );
  if (!instance) return null;
  return instance.securityGroups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    rules: g.rules,
  }));
}

module.exports = {
  PROTOCOLS,
  serializeGroup,
  normalizeRule,
  listGroups,
  getGroup,
  createGroup,
  deleteGroup,
  addRule,
  deleteRule,
  attachGroups,
  detachGroups,
  setInstanceGroups,
  getInstanceGroups,
};
