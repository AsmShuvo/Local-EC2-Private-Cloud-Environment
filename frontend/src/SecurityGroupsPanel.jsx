import { useState, useEffect, useCallback } from "react";
import api, { describeError } from "./api";

const PROTOCOLS = ["TCP", "UDP", "ICMP", "ALL"];

// Common presets, like AWS's "Type" dropdown (SSH, HTTP, …).
const PRESETS = [
  { label: "SSH", protocol: "TCP", port: 22 },
  { label: "HTTP", protocol: "TCP", port: 80 },
  { label: "HTTPS", protocol: "TCP", port: 443 },
  { label: "Custom TCP", protocol: "TCP", port: "" },
  { label: "All traffic", protocol: "ALL", port: "" },
];

const blankRule = () => ({ protocol: "TCP", port: "22", sourceIp: "0.0.0.0/0" });

export default function SecurityGroupsPanel() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [myIp, setMyIp] = useState("");

  // Create-form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState([blankRule()]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, who] = await Promise.all([
        api.get("/api/security-groups"),
        api.get("/api/security-groups/whoami").catch(() => ({ data: {} })),
      ]);
      setGroups(g.data);
      setMyIp(who.data?.ip || "");
      setError("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateRule = (i, patch) =>
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRule = () => setRules((prev) => [...prev, blankRule()]);
  const removeRule = (i) => setRules((prev) => prev.filter((_, idx) => idx !== i));

  const applyPreset = (i, label) => {
    const p = PRESETS.find((x) => x.label === label);
    if (p) updateRule(i, { protocol: p.protocol, port: p.port === "" ? "" : String(p.port) });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      await api.post("/api/security-groups", {
        name: name.trim(),
        description: description.trim(),
        inboundRules: rules.map((r) => ({
          protocol: r.protocol,
          port: r.port === "" ? null : Number(r.port),
          sourceIp: r.sourceIp.trim() || "0.0.0.0/0",
        })),
      });
      setName("");
      setDescription("");
      setRules([blankRule()]);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this security group? It will be detached from all instances."))
      return;
    try {
      await api.delete(`/api/security-groups/${id}`);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleDeleteRule = async (groupId, ruleId) => {
    try {
      await api.delete(`/api/security-groups/${groupId}/rules/${ruleId}`);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const portLabel = (r) =>
    r.fromPort == null
      ? "All"
      : r.toPort && r.toPort !== r.fromPort
      ? `${r.fromPort}–${r.toPort}`
      : String(r.fromPort);

  return (
    <>
      {error && (
        <div className="flashbar" role="alert">
          <span className="flash-icon">⛔</span>
          <span className="flash-text">
            <strong>Security group error</strong>
            {error}
          </span>
          <button onClick={load}>Retry</button>
        </div>
      )}

      {/* Create ------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div className="htitle">
            <span className="accent-bar" />
            <div>
              <h2>Create security group</h2>
              <p className="hdesc">
                Inbound rules are ALLOW-only. Anything not allowed is denied.
                {myIp && (
                  <>
                    {" "}
                    Your IP is <code className="inline-ip">{myIp}</code>.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="panel-body">
          <form onSubmit={handleCreate}>
            <div className="form-row">
              <label htmlFor="sg-name">Name</label>
              <input
                id="sg-name"
                className="input"
                placeholder="e.g. web-tier"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
              />
            </div>
            <div className="form-row">
              <label htmlFor="sg-desc">
                Description <span className="opt">— optional</span>
              </label>
              <input
                id="sg-desc"
                className="input"
                placeholder="What is this group for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={creating}
              />
            </div>

            <div className="rules-editor">
              <div className="rules-head">
                <span>Inbound rules</span>
                <button type="button" className="rbtn" onClick={addRule} disabled={creating}>
                  + Add rule
                </button>
              </div>

              <div className="rule-grid rule-grid-head">
                <span>Type</span>
                <span>Protocol</span>
                <span>Port</span>
                <span>Source (IP / CIDR)</span>
                <span />
              </div>

              {rules.map((r, i) => (
                <div className="rule-grid" key={i}>
                  <select
                    className="input select sm"
                    onChange={(e) => applyPreset(i, e.target.value)}
                    defaultValue="SSH"
                    disabled={creating}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.label}>{p.label}</option>
                    ))}
                  </select>
                  <select
                    className="input select sm"
                    value={r.protocol}
                    onChange={(e) => updateRule(i, { protocol: e.target.value })}
                    disabled={creating}
                  >
                    {PROTOCOLS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                  <input
                    className="input sm"
                    placeholder="all"
                    value={r.port}
                    onChange={(e) => updateRule(i, { port: e.target.value })}
                    disabled={creating}
                  />
                  <div className="src-cell">
                    <input
                      className="input sm"
                      placeholder="0.0.0.0/0"
                      value={r.sourceIp}
                      onChange={(e) => updateRule(i, { sourceIp: e.target.value })}
                      disabled={creating}
                    />
                    {myIp && (
                      <button
                        type="button"
                        className="mini-link"
                        onClick={() => updateRule(i, { sourceIp: `${myIp}/32` })}
                        disabled={creating}
                      >
                        My IP
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className="rbtn danger sm"
                    onClick={() => removeRule(i)}
                    disabled={creating || rules.length === 1}
                    title="Remove rule"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
                {creating ? (
                  <>
                    <span className="spinner" /> Creating…
                  </>
                ) : (
                  "Create security group"
                )}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* List --------------------------------------------------------- */}
      <section className="panel">
        <div className="panel-header">
          <div className="htitle">
            <span className="accent-bar" />
            <div>
              <h2>Security groups</h2>
              <p className="hdesc">Attach these to instances from the Instances tab.</p>
            </div>
          </div>
          <span className="count-badge">{groups.length}</span>
        </div>

        <div className="panel-body">
          {loading ? (
            <p className="hdesc">Loading…</p>
          ) : groups.length === 0 ? (
            <div className="empty">
              <span className="emoji">🛡️</span>
              <strong>No security groups yet</strong>
              Create one above. Instances with no group attached are unrestricted.
            </div>
          ) : (
            <div className="sg-list">
              {groups.map((g) => (
                <div className="sg-card" key={g.id}>
                  <div className="sg-card-head">
                    <div>
                      <span className="sg-name">🛡️ {g.name}</span>
                      {g.description && <span className="sg-desc">{g.description}</span>}
                    </div>
                    <div className="sg-card-actions">
                      <span className="sg-attached">
                        {g.instanceCount || 0} instance{g.instanceCount === 1 ? "" : "s"}
                      </span>
                      <button className="rbtn danger sm" onClick={() => handleDelete(g.id)}>
                        Delete
                      </button>
                    </div>
                  </div>

                  {g.inboundRules.length === 0 ? (
                    <p className="sg-norules">
                      No inbound rules — this group denies <strong>all</strong> inbound traffic.
                    </p>
                  ) : (
                    <table className="sg-rules">
                      <thead>
                        <tr>
                          <th>Protocol</th>
                          <th>Port</th>
                          <th>Source</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {g.inboundRules.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <span className="proto-chip">{r.protocol}</span>
                            </td>
                            <td className="mono">{portLabel(r)}</td>
                            <td className="mono">{r.sourceIp}</td>
                            <td className="sg-rule-x">
                              <button
                                className="mini-link danger"
                                onClick={() => handleDeleteRule(g.id, r.id)}
                              >
                                remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
