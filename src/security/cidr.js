// Pure IPv4 / CIDR utilities. No dependencies, fully unit-testable.

/**
 * Node reports IPv4 peers as IPv4-mapped IPv6 ("::ffff:192.168.0.5") and
 * loopback as "::1". Normalise to a plain dotted-quad so rules can match.
 */
function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === "::1") ip = "127.0.0.1"; // IPv6 loopback
  const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return m ? m[1] : ip; // non-IPv4 (real IPv6) returned as-is
}

function isIPv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** Dotted-quad -> unsigned 32-bit integer. */
function ipToInt(ip) {
  return (
    String(ip)
      .split(".")
      .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

/** Parse "192.168.0.0/24" or a bare "192.168.0.5" (treated as /32). */
function parseCidr(cidr) {
  if (!cidr) return null;
  const [base, bitsRaw] = String(cidr).trim().split("/");
  if (!isIPv4(base)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

/**
 * Is `ip` inside `cidr`?  "0.0.0.0/0" matches everything (AWS's "anywhere").
 */
function ipInCidr(ip, cidr) {
  const parsed = parseCidr(cidr);
  const addr = normalizeIp(ip);
  if (!parsed || !isIPv4(addr)) return false;
  if (parsed.bits === 0) return true; // 0.0.0.0/0 -> anywhere
  // Build the mask; `<<` on 32 is undefined in JS, hence the bits===0 guard above.
  const mask = (~0 << (32 - parsed.bits)) >>> 0;
  return (ipToInt(addr) & mask) === (ipToInt(parsed.base) & mask);
}

/** Validate a CIDR/IP string for the API layer. */
function isValidCidr(cidr) {
  return parseCidr(cidr) !== null;
}

module.exports = { normalizeIp, isIPv4, ipToInt, parseCidr, ipInCidr, isValidCidr };
