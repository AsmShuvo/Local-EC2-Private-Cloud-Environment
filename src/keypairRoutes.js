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

// List — metadata only, never key material.
router.get(
  "/",
  handle(async (req, res) => res.json(await keypairs.listKeyPairs()))
);

// Create — the private key is returned EXACTLY ONCE here (and also stored,
// encrypted, so it can be downloaded again later).
router.post(
  "/",
  handle(async (req, res) => {
    const { keyPair, privateKey } = await keypairs.createKeyPair(req.body?.name);
    res.status(201).json({ ...keypairs.serialize(keyPair), privateKey });
  })
);

// Secure download: decrypt in memory and stream as an attachment.
// NOTE: declared BEFORE "/:name" so the literal "download" segment can't be
// swallowed by the name param.
router.get(
  "/:name/download",
  handle(async (req, res) => {
    const { pem, fileName } = await keypairs.getPrivateKeyForDownload(req.params.name);
    // NOTE: res.attachment() infers Content-Type from the extension (.pem ->
    // x-x509-ca-cert), so it must run BEFORE we set the real type, or it wins.
    res.attachment(fileName);
    res.type("application/x-pem-file");
    res.setHeader("Cache-Control", "no-store"); // never cache key material
    res.send(pem);
  })
);

// Detail — used by the Key Pair Details modal.
// Returns name, fingerprint, PUBLIC key, createdAt and the linked instance.
// The private key is NEVER included.
router.get(
  "/:name",
  handle(async (req, res) => {
    const detail = await keypairs.getKeyPairDetail(req.params.name);
    if (!detail) return res.status(404).json({ error: "Key pair not found" });
    res.json(detail);
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
