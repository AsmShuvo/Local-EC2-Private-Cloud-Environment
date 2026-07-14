import { useState, useEffect, useCallback } from "react";
import api, { TIMEOUTS, describeError } from "./api";

const INSTANCE_TYPES = [
  { name: "t2.micro", cpu: 1, memory: "1G", disk: "5G", label: "1 vCPU · 1 GB RAM · 5 GB disk" },
  { name: "t2.small", cpu: 1, memory: "2G", disk: "10G", label: "1 vCPU · 2 GB RAM · 10 GB disk" },
  { name: "t2.medium", cpu: 2, memory: "4G", disk: "15G", label: "2 vCPU · 4 GB RAM · 15 GB disk" },
];

const PROTOCOLS = ["TCP", "UDP", "ICMP", "ALL"];
const blankRule = () => ({ protocol: "TCP", port: "22", sourceIp: "0.0.0.0/0" });

/**
 * EC2-style launch wizard.
 *  1. Name & description
 *  2. Operating system  -> Ubuntu (native) | Debian 12 (cloud-image URL)
 *  3. Instance type (vCPU / RAM / disk)
 *  4. Key pair (login)  -> existing | create new | proceed without
 *  5. Network settings  -> create new security group | select existing
 */
export default function LaunchWizard({ onClose, onLaunched, onKeyIssued }) {
  // Step 1
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Step 2 — operating system
  const [images, setImages] = useState([]);
  const [os, setOs] = useState("ubuntu");
  // Step 3
  const [instanceType, setInstanceType] = useState("t2.micro");
  // Step 4 — key pair
  const [keyPairs, setKeyPairs] = useState([]);
  const [keyMode, setKeyMode] = useState("new"); // new | existing | none
  const [keyPairId, setKeyPairId] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  // Step 5 — security groups
  const [groups, setGroups] = useState([]);
  const [sgMode, setSgMode] = useState("existing"); // existing | create
  const [selectedSgIds, setSelectedSgIds] = useState([]);
  const [newSgName, setNewSgName] = useState("");
  const [newSgDesc, setNewSgDesc] = useState("");
  const [newSgRules, setNewSgRules] = useState([blankRule()]);
  const [myIp, setMyIp] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadLookups = useCallback(async () => {
    const [img, kp, sg, who] = await Promise.all([
      api.get("/api/images").catch(() => ({ data: [] })),
      api.get("/api/key-pairs").catch(() => ({ data: [] })),
      api.get("/api/security-groups").catch(() => ({ data: [] })),
      api.get("/api/security-groups/whoami").catch(() => ({ data: {} })),
    ]);
    setImages(img.data);
    setKeyPairs(kp.data);
    setGroups(sg.data);
    setMyIp(who.data?.ip || "");
    if (kp.data.length) setKeyPairId(String(kp.data[0].id));
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  const updRule = (i, patch) =>
    setNewSgRules((p) => p.map((r, x) => (x === i ? { ...r, ...patch } : r)));

  const toggleSg = (id) =>
    setSelectedSgIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id]
    );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError("");

    try {
      // If the user is creating a new security group inline, create it first so
      // we can attach it to the instance in the same launch call.
      let sgIds = sgMode === "existing" ? selectedSgIds : [];
      if (sgMode === "create") {
        if (!newSgName.trim()) throw new Error("Give the new security group a name.");
        const { data: created } = await api.post("/api/security-groups", {
          name: newSgName.trim(),
          description: newSgDesc.trim(),
          inboundRules: newSgRules.map((r) => ({
            protocol: r.protocol,
            port: r.port === "" ? null : Number(r.port),
            sourceIp: r.sourceIp.trim() || "0.0.0.0/0",
          })),
        });
        sgIds = [created.id];
      }

      const spec =
        INSTANCE_TYPES.find((t) => t.name === instanceType) || INSTANCE_TYPES[0];

      const payload = {
        name: name.trim(),
        description: description.trim(),
        os,
        instanceType: spec.name,
        cpu: spec.cpu,
        memory: spec.memory,
        disk: spec.disk,
        securityGroupIds: sgIds,
        keyPairMode: keyMode,
      };
      if (keyMode === "existing") payload.keyPairId = Number(keyPairId);
      if (keyMode === "new") payload.keyPairName = newKeyName.trim() || `${name.trim()}-key`;

      const { data } = await api.post("/api/projects", payload, {
        timeout: TIMEOUTS.launch,
      });

      const { privateKey, ...project } = data;
      // A private key only comes back when a NEW pair was generated.
      if (privateKey) onKeyIssued(project, privateKey);
      onLaunched(project);
      onClose();
    } catch (err) {
      setError(err.message && !err.response ? err.message : describeError(err));
      setSubmitting(false);
    }
  };

  const selectedKp = keyPairs.find((k) => String(k.id) === String(keyPairId));
  const selectedImage = images.find((i) => i.id === os);

  return (
    <div className="modal-overlay" onMouseDown={() => !submitting && onClose()}>
      <section
        className="modal wizard-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="htitle">
            <span className="accent-bar" />
            <div>
              <h2>Launch an instance</h2>
              <p className="hdesc">
                Configure a new Ubuntu virtual machine — size it, secure it, launch it.
              </p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="wizard-body">
          {error && (
            <div className="flashbar mini">
              <span className="flash-icon">⛔</span>
              <span className="flash-text">{error}</span>
            </div>
          )}

          {/* 1 — Name -------------------------------------------------- */}
          <div className="wz-section">
            <div className="wz-title">
              <span className="wz-num">1</span> Name and description
            </div>
            <div className="form-row">
              <label htmlFor="w-name">Name</label>
              <input
                id="w-name"
                className="input"
                placeholder="e.g. web-server-01"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="form-row">
              <label htmlFor="w-desc">
                Description <span className="opt">— optional</span>
              </label>
              <input
                id="w-desc"
                className="input"
                placeholder="What is this instance for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>


          {/* 2 — Operating system --------------------------------------- */}
          <div className="wz-section">
            <div className="wz-title">
              <span className="wz-num">2</span> Operating system
            </div>
            <div className="os-grid">
              {images.map((img) => (
                <label
                  key={img.id}
                  className={`os-card ${os === img.id ? "is-on" : ""}`}
                >
                  <input
                    type="radio"
                    name="os"
                    value={img.id}
                    checked={os === img.id}
                    onChange={() => setOs(img.id)}
                    disabled={submitting}
                  />
                  <span className="os-body">
                    <span className="os-name">{img.name}</span>
                    <span className="os-desc">{img.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {selectedImage && (
              <span className="field-hint">
                Minimum disk for {selectedImage.name}:{" "}
                <strong>{selectedImage.minDisk} GB</strong>. Every instance type
                below satisfies it.
              </span>
            )}
          </div>

          {/* 3 — Instance type ----------------------------------------- */}
          <div className="wz-section">
            <div className="wz-title">
              <span className="wz-num">3</span> Instance type
            </div>
            <select
              className="input select"
              value={instanceType}
              onChange={(e) => setInstanceType(e.target.value)}
              disabled={submitting}
            >
              {INSTANCE_TYPES.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} — {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* 4 — Key pair ---------------------------------------------- */}
          <div className="wz-section">
            <div className="wz-title">
              <span className="wz-num">4</span> Key pair (login)
            </div>

            <div className="radio-row">
              <label className={`radio-opt ${keyMode === "existing" ? "is-on" : ""}`}>
                <input
                  type="radio"
                  checked={keyMode === "existing"}
                  onChange={() => setKeyMode("existing")}
                  disabled={submitting || keyPairs.length === 0}
                />
                <span>
                  Use an existing key pair
                  {keyPairs.length === 0 && <em> — none stored yet</em>}
                </span>
              </label>
              <label className={`radio-opt ${keyMode === "new" ? "is-on" : ""}`}>
                <input
                  type="radio"
                  checked={keyMode === "new"}
                  onChange={() => setKeyMode("new")}
                  disabled={submitting}
                />
                <span>Create a new key pair</span>
              </label>
              <label className={`radio-opt ${keyMode === "none" ? "is-on" : ""}`}>
                <input
                  type="radio"
                  checked={keyMode === "none"}
                  onChange={() => setKeyMode("none")}
                  disabled={submitting}
                />
                <span>Proceed without a key pair</span>
              </label>
            </div>

            {keyMode === "existing" && (
              <>
                <select
                  className="input select"
                  value={keyPairId}
                  onChange={(e) => setKeyPairId(e.target.value)}
                  disabled={submitting}
                >
                  {keyPairs.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
                {selectedKp && (
                  <span className="field-hint mono-hint">
                    {selectedKp.fingerprint}
                  </span>
                )}
                <span className="field-hint">
                  Its stored public key is re-used. The <code>.pem</code> you already
                  downloaded will work — nothing new is issued.
                </span>
              </>
            )}

            {keyMode === "new" && (
              <>
                <input
                  className="input"
                  placeholder={name.trim() ? `${name.trim()}-key` : "my-key"}
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  disabled={submitting}
                />
                <span className="field-hint">
                  The private key downloads <strong>once</strong> and is saved for reuse
                  on future instances.
                </span>
              </>
            )}

            {keyMode === "none" && (
              <div className="wz-warn">
                <strong>You won't be able to SSH into this instance.</strong> No public
                key is installed, so <code>ssh -i key.pem</code> will be refused. The
                browser terminal still works (it connects through Multipass, not SSH).
              </div>
            )}
          </div>

          {/* 5 — Network / security groups ------------------------------ */}
          <div className="wz-section">
            <div className="wz-title">
              <span className="wz-num">5</span> Network settings
              <span className="wz-sub">(firewall / security groups)</span>
            </div>

            <div className="radio-row">
              <label className={`radio-opt ${sgMode === "existing" ? "is-on" : ""}`}>
                <input
                  type="radio"
                  checked={sgMode === "existing"}
                  onChange={() => setSgMode("existing")}
                  disabled={submitting}
                />
                <span>Select existing security group</span>
              </label>
              <label className={`radio-opt ${sgMode === "create" ? "is-on" : ""}`}>
                <input
                  type="radio"
                  checked={sgMode === "create"}
                  onChange={() => setSgMode("create")}
                  disabled={submitting}
                />
                <span>Create security group</span>
              </label>
            </div>

            {sgMode === "existing" &&
              (groups.length === 0 ? (
                <div className="sg-launch-empty">
                  No security groups exist. Choose “Create security group”, or launch
                  with none — the instance will be unrestricted.
                </div>
              ) : (
                <div className="sg-launch-picker">
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className={`sg-launch-option ${
                        selectedSgIds.includes(g.id) ? "is-on" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSgIds.includes(g.id)}
                        onChange={() => toggleSg(g.id)}
                        disabled={submitting}
                      />
                      <span>
                        <span className="sg-launch-name">🛡️ {g.name}</span>
                        <span className="sg-launch-rules">
                          {g.inboundRules.length === 0
                            ? "no inbound rules — denies everything"
                            : g.inboundRules
                                .map(
                                  (r) =>
                                    `${r.protocol}/${
                                      r.fromPort == null ? "all" : r.fromPort
                                    } ← ${r.sourceIp}`
                                )
                                .join(" · ")}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}

            {sgMode === "create" && (
              <div className="rules-editor">
                <div className="form-row">
                  <label>Security group name</label>
                  <input
                    className="input"
                    placeholder="e.g. web-tier"
                    value={newSgName}
                    onChange={(e) => setNewSgName(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="form-row">
                  <label>
                    Description <span className="opt">— optional</span>
                  </label>
                  <input
                    className="input"
                    value={newSgDesc}
                    onChange={(e) => setNewSgDesc(e.target.value)}
                    disabled={submitting}
                  />
                </div>

                <div className="rules-head">
                  <span>Inbound rules</span>
                  <button
                    type="button"
                    className="rbtn"
                    onClick={() => setNewSgRules((p) => [...p, blankRule()])}
                    disabled={submitting}
                  >
                    + Add rule
                  </button>
                </div>
                <div className="rule-grid rule-grid-head">
                  <span>Protocol</span>
                  <span>Port</span>
                  <span>Source</span>
                  <span />
                </div>
                {newSgRules.map((r, i) => (
                  <div className="rule-grid wz-rule" key={i}>
                    <select
                      className="input select sm"
                      value={r.protocol}
                      onChange={(e) => updRule(i, { protocol: e.target.value })}
                      disabled={submitting}
                    >
                      {PROTOCOLS.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                    <input
                      className="input sm"
                      placeholder="all"
                      value={r.port}
                      onChange={(e) => updRule(i, { port: e.target.value })}
                      disabled={submitting}
                    />
                    <div className="src-cell">
                      <input
                        className="input sm"
                        placeholder="0.0.0.0/0"
                        value={r.sourceIp}
                        onChange={(e) => updRule(i, { sourceIp: e.target.value })}
                        disabled={submitting}
                      />
                      {myIp && (
                        <button
                          type="button"
                          className="mini-link"
                          onClick={() => updRule(i, { sourceIp: `${myIp}/32` })}
                          disabled={submitting}
                        >
                          My IP
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="rbtn danger sm"
                      onClick={() =>
                        setNewSgRules((p) => p.filter((_, x) => x !== i))
                      }
                      disabled={submitting || newSgRules.length === 1}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer ------------------------------------------------------ */}
          <div className="wizard-foot">
            {submitting && (
              <span className="launch-hint">
                Provisioning a real VM — this can take ~30–90s…
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || !name.trim()}
            >
              {submitting ? (
                <>
                  <span className="spinner" /> Launching…
                </>
              ) : (
                "Launch instance"
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
