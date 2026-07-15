import { useState, useEffect } from "react";
import api, { API_BASE_URL, describeError } from "./api";

/**
 * Key Pair Details modal.
 *
 * The private key is NEVER fetched into the page — the [Download .pem] button
 * navigates to the download endpoint, which streams the decrypted file straight
 * to disk. So this window is safe to open while screen-sharing.
 */
export default function KeyPairDetailsModal({ keyName, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(""); // which button was last copied

  useEffect(() => {
    if (!keyName) return;
    let active = true;
    (async () => {
      try {
        const { data } = await api.get(`/api/key-pairs/${encodeURIComponent(keyName)}`);
        if (active) setDetail(data);
      } catch (err) {
        if (active) setError(describeError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [keyName]);

  const copy = async (label, text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Clipboard blocked by the browser. Copy manually from the field.");
    }
  };

  const download = () => {
    // A plain navigation: the browser saves the streamed attachment. The key
    // never enters JS memory, so it can't leak into the DOM or devtools.
    window.location.href = `${API_BASE_URL}/api/key-pairs/${encodeURIComponent(
      keyName
    )}/download`;
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const file = detail?.fileName || `${keyName}.pem`;
  const user = detail?.username || "ubuntu";
  const ip = detail?.instance?.ipAddress || "<instance-ip>";
  const sshCmd = `ssh -i ${file} ${user}@${ip}`;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal kp-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kp-head">
          <div>
            <h2 className="kp-title">
              Key pair <span className="kp-dot">·</span>{" "}
              <span className="kp-name">{keyName}</span>
            </h2>
            <p className="kp-sub">
              This instance has its own RSA 2048 key pair. The public half was
              installed inside the VM at first boot; the private half is what
              proves it's you. It's stored encrypted, so you can download it
              again whenever you need it.
            </p>
          </div>
          <button className="modal-close kp-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading ? (
          <div className="kp-body">
            <p className="kp-muted">Loading key pair…</p>
          </div>
        ) : error && !detail ? (
          <div className="kp-body">
            <div className="flashbar mini">{error}</div>
          </div>
        ) : (
          <div className="kp-body">
            {error && <div className="flashbar mini kp-inline-err">{error}</div>}

            {/* Metadata ------------------------------------------------- */}
            <dl className="kp-meta">
              <div className="kp-row">
                <dt>Key name</dt>
                <dd className="kp-mono">{file}</dd>
              </div>
              <div className="kp-row">
                <dt>Type</dt>
                <dd>
                  <span className="kp-badge">🔑 {detail?.algorithm || "RSA 2048"}</span>
                </dd>
              </div>
              <div className="kp-row">
                <dt>Fingerprint</dt>
                <dd className="kp-mono kp-break">{detail?.fingerprint || "—"}</dd>
              </div>
              <div className="kp-row">
                <dt>Instance ID</dt>
                <dd className="kp-mono">
                  {detail?.instance ? (
                    <>
                      #{detail.instance.id}{" "}
                      <span className="kp-muted">
                        ({detail.instance.instanceName || detail.instance.name})
                      </span>
                    </>
                  ) : (
                    <span className="kp-muted">Not attached to an instance</span>
                  )}
                </dd>
              </div>
              <div className="kp-row">
                <dt>Created</dt>
                <dd>{fmtDate(detail?.createdAt)}</dd>
              </div>
            </dl>

            {/* Terminal ------------------------------------------------- */}
            <div className="kp-section-title">Log in from a terminal</div>
            <pre className="kp-code">
              <code>
                <span className="kp-prompt">$</span> chmod 600 {file}
                {"\n"}
                <span className="kp-prompt">$</span> {sshCmd}
              </code>
            </pre>

            <p className="kp-note">
              The private key is never shown on screen — only downloaded — so this
              window is safe to open while sharing your screen.
            </p>
          </div>
        )}

        {/* Actions --------------------------------------------------- */}
        <div className="kp-actions">
          <button
            className="btn btn-ghost"
            onClick={() => copy("fp", detail?.fingerprint)}
            disabled={loading || !detail?.fingerprint}
          >
            {copied === "fp" ? "Copied ✓" : "Copy fingerprint"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => copy("pub", detail?.publicKey)}
            disabled={loading || !detail?.publicKey}
          >
            {copied === "pub" ? "Copied ✓" : "Copy public key"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => copy("ssh", sshCmd)}
            disabled={loading}
          >
            {copied === "ssh" ? "Copied ✓" : "Copy SSH command"}
          </button>
          {/* <button
            className="btn btn-primary"
            onClick={download}
            disabled={loading || !detail?.downloadable}
            title={
              detail && !detail.downloadable
                ? "This key predates encrypted storage and cannot be re-downloaded"
                : "Download the private key"
            }
          >
            ⬇ Download .pem
          </button> */}
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
