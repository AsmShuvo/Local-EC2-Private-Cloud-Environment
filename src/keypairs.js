// Reusable key pairs — the AWS EC2 key-pair model.
//
// SECURITY MODEL (identical to AWS):
//   * We generate an RSA pair, store ONLY the public key, and hand the private
//     key to the user EXACTLY ONCE. It is never written to disk or the DB.
//   * "Use an existing key pair" re-injects the STORED PUBLIC KEY into the new
//     VM, so the .pem the user downloaded earlier keeps working. No private key
//     is returned in that case — the user already has it.
//   * Losing the private key means losing key-based access. Same as AWS.
const crypto = require("node:crypto");
const { prisma, db } = require("./db");

// --- OpenSSH wire-format encoding (no external deps) -------------------------
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}
function sshMpint(buf) {
  let b = buf;
  if (b.length && (b[0] & 0x80)) b = Buffer.concat([Buffer.from([0x00]), b]); // keep positive
  return sshString(b);
}
function jwkRsaToOpenSSH(jwk, comment = "") {
  const e = Buffer.from(jwk.e, "base64url");
  const n = Buffer.from(jwk.n, "base64url");
  const blob = Buffer.concat([
    sshString(Buffer.from("ssh-rsa")),
    sshMpint(e),
    sshMpint(n),
  ]);
  return `ssh-rsa ${blob.toString("base64")}${comment ? " " + comment : ""}`;
}

/** SHA256 fingerprint, formatted like `ssh-keygen -l` output. */
function fingerprintOf(openssh) {
  const b64 = String(openssh).split(/\s+/)[1];
  if (!b64) return null;
  const hash = crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64");
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

/** Generate a fresh RSA pair. Returns the PEM private key + OpenSSH public key. */
function generate(comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }); // AWS-style .pem
  const openssh = jwkRsaToOpenSSH(publicKey.export({ format: "jwk" }), comment);
  return { privateKeyPem, openssh, fingerprint: fingerprintOf(openssh) };
}

const sanitizeName = (n) =>
  String(n || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/**
 * Create and persist a new key pair.
 * @returns {{ keyPair, privateKey }} — privateKey is returned ONCE, never stored.
 */
async function createKeyPair(rawName) {
  const name = sanitizeName(rawName);
  if (!name) {
    throw Object.assign(new Error("A key pair name is required"), { status: 400 });
  }

  const existing = await db(() => prisma.keyPair.findUnique({ where: { name } }));
  if (existing) {
    throw Object.assign(
      new Error(`A key pair named "${name}" already exists`),
      { status: 409 }
    );
  }

  const { privateKeyPem, openssh, fingerprint } = generate(name);
  const keyPair = await db(() =>
    prisma.keyPair.create({
      data: { name, publicKey: openssh, fingerprint },
    })
  );
  return { keyPair, privateKey: privateKeyPem };
}

/** Never leaks the public key blob to list views — just the metadata. */
function serialize(kp) {
  return {
    id: kp.id,
    name: kp.name,
    fingerprint: kp.fingerprint,
    createdAt: kp.createdAt,
    instanceCount: kp.instances ? kp.instances.length : undefined,
  };
}

async function listKeyPairs() {
  const rows = await db(() =>
    prisma.keyPair.findMany({
      include: { instances: { select: { id: true } } },
      orderBy: { id: "desc" },
    })
  );
  return rows.map(serialize);
}

async function getKeyPair(id) {
  return db(() => prisma.keyPair.findUnique({ where: { id } }));
}

async function deleteKeyPair(id) {
  // Instances keep running; their keyPairId is set to null (onDelete: SetNull).
  await db(() => prisma.keyPair.delete({ where: { id } }));
  return { id, deleted: true };
}

/**
 * Resolve the launch wizard's key-pair choice into what the launcher needs.
 *
 * mode "new"      -> create + persist a key pair, return the private key ONCE
 * mode "existing" -> look up the stored PUBLIC key and reuse it (no private key)
 * mode "none"     -> no key injected (web terminal still works; SSH will not)
 *
 * @returns {{ keyPairId:number|null, keyName:string|null, openssh:string|null, privateKey:string|null }}
 */
async function resolveForLaunch({ mode, keyPairId, keyPairName }, fallbackName) {
  const choice = String(mode || "new").toLowerCase();

  if (choice === "none") {
    return { keyPairId: null, keyName: null, openssh: null, privateKey: null };
  }

  if (choice === "existing") {
    const id = Number(keyPairId);
    if (!Number.isInteger(id)) {
      throw Object.assign(new Error("A key pair must be selected"), { status: 400 });
    }
    const kp = await getKeyPair(id);
    if (!kp) {
      throw Object.assign(new Error("Selected key pair no longer exists"), { status: 400 });
    }
    // Re-inject the stored public key. The user already holds the private half.
    return {
      keyPairId: kp.id,
      keyName: kp.name,
      openssh: kp.publicKey,
      privateKey: null,
    };
  }

  // "new"
  const { keyPair, privateKey } = await createKeyPair(keyPairName || fallbackName);
  return {
    keyPairId: keyPair.id,
    keyName: keyPair.name,
    openssh: keyPair.publicKey,
    privateKey,
  };
}

module.exports = {
  generate,
  fingerprintOf,
  createKeyPair,
  listKeyPairs,
  getKeyPair,
  deleteKeyPair,
  resolveForLaunch,
  serialize,
};
