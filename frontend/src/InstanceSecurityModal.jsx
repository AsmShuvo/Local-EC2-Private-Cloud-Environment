import { useState, useEffect } from "react";
import api, { describeError } from "./api";

// Attach / detach MULTIPLE security groups to one instance (the M2M edit surface).
export default function InstanceSecurityModal({ project, onClose, onSaved }) {
  const [allGroups, setAllGroups] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [myIp, setMyIp] = useState("");

  useEffect(() => {
    if (!project) return;
    let active = true;
    (async () => {
      try {
        const [all, attached, who] = await Promise.all([
          api.get("/api/security-groups"),
          api.get(`/api/projects/${project.id}/security-groups`),
          api.get("/api/security-groups/whoami").catch(() => ({ data: {} })),
        ]);
        if (!active) return;
        setAllGroups(all.data);
        setSelected(new Set(attached.data.map((g) => g.id)));
        setMyIp(who.data?.ip || "");
      } catch (err) {
        if (active) setError(describeError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [project]);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // One call replaces the whole set — simplest correct M2M update.
      await api.put(`/api/projects/${project.id}/security-groups`, {
        groupIds: [...selected],
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(describeError(err));
      setSaving(false);
    }
  };

  if (!project) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal sg-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="htitle">
            <span className="accent-bar" />
            <div>
              <h2>Security groups — {project.name}</h2>
              <p className="hdesc">
                Attach one or more groups. Rules are combined (union of allows).
              </p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="monitor-body">
          {error && <div className="flashbar mini">{error}</div>}

          {loading ? (
            <p className="hdesc">Loading…</p>
          ) : allGroups.length === 0 ? (
            <div className="empty">
              <span className="emoji">🛡️</span>
              <strong>No security groups exist</strong>
              Create one in the “Security Groups” tab first.
            </div>
          ) : (
            <>
              <div className="sg-picker">
                {allGroups.map((g) => (
                  <label
                    key={g.id}
                    className={`sg-option ${selected.has(g.id) ? "is-on" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(g.id)}
                      onChange={() => toggle(g.id)}
                      disabled={saving}
                    />
                    <span className="sg-option-body">
                      <span className="sg-option-name">🛡️ {g.name}</span>
                      <span className="sg-option-rules">
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

              <div
                className={`sg-warn ${selected.size === 0 ? "ok" : "warn"}`}
              >
                {selected.size === 0 ? (
                  <>
                    <strong>No groups attached.</strong> This instance is
                    unrestricted — everyone can reach it.
                  </>
                ) : (
                  <>
                    <strong>Default deny is active.</strong> Only traffic matching
                    the selected rules is allowed. Make sure a rule covers your own
                    IP {myIp && <code className="inline-ip">{myIp}</code>} on TCP/22,
                    or you will lock yourself out of the web terminal.
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
            {saving ? (
              <>
                <span className="spinner" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
