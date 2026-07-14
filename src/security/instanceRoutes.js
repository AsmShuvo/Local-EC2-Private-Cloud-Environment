// Instance <-> SecurityGroup binding (the many-to-many surface).
// Mounted under /api/projects.
const express = require("express");
const service = require("./service");

const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Instance or security group not found" });
    }
    const status = err.status || 500;
    if (status === 500) console.error("[SG] instance-binding error:", err);
    res.status(status).json({ error: err.message || "Request failed" });
  }
};

function instanceId(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n)) {
    throw Object.assign(new Error("Invalid instance id"), { status: 400 });
  }
  return n;
}

function groupIds(req) {
  const raw = req.body?.groupIds ?? req.body?.securityGroupIds ?? [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("groupIds must be an array"), { status: 400 });
  }
  const ids = raw.map((v) => Number(v));
  if (ids.some((n) => !Number.isInteger(n))) {
    throw Object.assign(new Error("groupIds must be integers"), { status: 400 });
  }
  return ids;
}

// What groups are attached to this instance?
router.get(
  "/:id/security-groups",
  handle(async (req, res) => {
    const groups = await service.getInstanceGroups(instanceId(req));
    if (groups === null) return res.status(404).json({ error: "Instance not found" });
    res.json(groups);
  })
);

// Replace the whole set — what the UI multi-select sends.
router.put(
  "/:id/security-groups",
  handle(async (req, res) => {
    const groups = await service.setInstanceGroups(instanceId(req), groupIds(req));
    res.json(groups);
  })
);

router.post(
  "/:id/security-groups/attach",
  handle(async (req, res) => {
    const groups = await service.attachGroups(instanceId(req), groupIds(req));
    res.json(groups);
  })
);

router.post(
  "/:id/security-groups/detach",
  handle(async (req, res) => {
    const groups = await service.detachGroups(instanceId(req), groupIds(req));
    res.json(groups);
  })
);

module.exports = router;
