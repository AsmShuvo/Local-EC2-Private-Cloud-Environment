// REST surface for security groups. Controllers stay thin: parse -> service -> respond.
const express = require("express");
const service = require("./service");
const { DIRECTION } = require("./evaluator");
const { clientIpFromReq } = require("./middleware");

const router = express.Router();

// Small helper so every handler gets uniform error handling.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Not found" });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A security group with that name already exists" });
    }
    if (status === 500) console.error("[SG] error:", err);
    res.status(status).json({ error: err.message || "Security group request failed" });
  }
};

const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw Object.assign(new Error("Invalid id"), { status: 400 });
  }
  return n;
};

/** Handy for the UI: "what IP does the server see me as?" */
router.get(
  "/whoami",
  handle(async (req, res) => res.json({ ip: clientIpFromReq(req) }))
);

router.get(
  "/",
  handle(async (req, res) => res.json(await service.listGroups()))
);

router.get(
  "/:id",
  handle(async (req, res) => {
    const group = await service.getGroup(intParam(req.params.id));
    if (!group) return res.status(404).json({ error: "Security group not found" });
    res.json(group);
  })
);

router.post(
  "/",
  handle(async (req, res) => {
    const group = await service.createGroup(req.body || {});
    res.status(201).json(group);
  })
);

router.delete(
  "/:id",
  handle(async (req, res) => res.json(await service.deleteGroup(intParam(req.params.id))))
);

// Rules -------------------------------------------------------------------
router.post(
  "/:id/rules",
  handle(async (req, res) => {
    const direction =
      String(req.body?.direction || DIRECTION.IN).toUpperCase() === DIRECTION.OUT
        ? DIRECTION.OUT
        : DIRECTION.IN;
    const group = await service.addRule(intParam(req.params.id), req.body || {}, direction);
    res.status(201).json(group);
  })
);

router.delete(
  "/:id/rules/:ruleId",
  handle(async (req, res) => {
    const group = await service.deleteRule(
      intParam(req.params.id),
      intParam(req.params.ruleId)
    );
    res.json(group);
  })
);

module.exports = router;
