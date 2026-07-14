const express = require("express");
const keypairs = require("./keypairs");

const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Key pair not found" });
    const status = err.status || 500;
    if (status === 500) console.error("[keypair] error:", err);
    res.status(status).json({ error: err.message || "Key pair request failed" });
  }
};

// List key pairs (metadata only — never the key material).
router.get(
  "/",
  handle(async (req, res) => res.json(await keypairs.listKeyPairs()))
);

// Create a standalone key pair. The private key is returned EXACTLY ONCE.
router.post(
  "/",
  handle(async (req, res) => {
    const { keyPair, privateKey } = await keypairs.createKeyPair(req.body?.name);
    res.status(201).json({ ...keypairs.serialize(keyPair), privateKey });
  })
);

router.delete(
  "/:id",
  handle(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    res.json(await keypairs.deleteKeyPair(id));
  })
);

module.exports = router;
