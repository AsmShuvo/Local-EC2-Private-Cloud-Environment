import { useState, useEffect, useCallback } from "react";
import api, { API_BASE_URL, TIMEOUTS, describeError } from "./api";
import TerminalModal from "./TerminalModal";
import MonitoringModal from "./MonitoringModal";
import KeyModal from "./KeyModal";
import "./App.css";

// Trigger a browser download of a text file (the private key .pem).
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/x-pem-file" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFileName = (n) =>
  String(n || "instance")
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "instance";

function StatusBadge({ status }) {
  const s = (status || "RUNNING").toUpperCase();
  const cls = s === "RUNNING" ? "running" : "stopped";
  return (
    <span className={`status-badge ${cls}`}>
      <span className="status-dot-sm" />
      {s}
    </span>
  );
}

function App() {
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(null);
  // Per-row action in flight: { [id]: "start" | "stop" | "terminate" }
  const [rowBusy, setRowBusy] = useState({});
  // Which instance (if any) has its terminal / monitoring modal open.
  const [terminalProject, setTerminalProject] = useState(null);
  const [monitorProject, setMonitorProject] = useState(null);
  // Set once after a create returns a private key (drives the download + modal).
  const [keyModal, setKeyModal] = useState(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/api/projects");
      setProjects(Array.isArray(data) ? data : []);
      setOnline(true);
    } catch (err) {
      console.error(err);
      setError(describeError(err));
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const { data } = await api.post(
        "/api/projects",
        { name: name.trim(), description: description.trim() },
        { timeout: TIMEOUTS.launch }
      );
      // The private key comes back exactly once — download it, never store it.
      const { privateKey, ...project } = data;
      setProjects((prev) => [project, ...prev]);
      setName("");
      setDescription("");
      setOnline(true);

      if (privateKey) {
        const filename = `${safeFileName(project.name)}-key.pem`;
        downloadTextFile(filename, privateKey);
        setKeyModal({
          filename,
          keyName: project.keyName,
          instanceName: project.instanceName,
          ipAddress: project.ipAddress,
        });
      }
    } catch (err) {
      console.error(err);
      setError(describeError(err));
      setOnline(false);
    } finally {
      setSubmitting(false);
    }
  };

  const setBusy = (id, action) =>
    setRowBusy((prev) => {
      const next = { ...prev };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });

  // Start / stop -> POST, then swap the returned row into place.
  const changeStatus = async (id, action) => {
    if (rowBusy[id]) return;
    setBusy(id, action);
    setError("");
    try {
      const { data } = await api.post(
        `/api/projects/${id}/${action}`,
        {},
        { timeout: TIMEOUTS.action }
      );
      setProjects((prev) => prev.map((p) => (p.id === id ? data : p)));
      setOnline(true);
    } catch (err) {
      console.error(err);
      setError(describeError(err));
      setOnline(false);
    } finally {
      setBusy(id, null);
    }
  };

  // Terminate -> DELETE, then drop the row.
  const terminate = async (id) => {
    if (rowBusy[id]) return;
    if (
      !window.confirm(
        "Terminate this instance? This permanently deletes the record."
      )
    )
      return;
    setBusy(id, "terminate");
    setError("");
    try {
      await api.delete(`/api/projects/${id}`, { timeout: TIMEOUTS.terminate });
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setOnline(true);
    } catch (err) {
      console.error(err);
      setError(describeError(err));
      setOnline(false);
    } finally {
      setBusy(id, null);
    }
  };

  const formatDate = (iso) => {
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

  const statusLabel =
    online === false ? "Offline" : online ? "Healthy" : "Connecting";
  const statusDot = online === false ? "down" : online ? "up" : "idle";
  const latest = projects[0];
  const runningCount = projects.filter(
    (p) => (p.status || "RUNNING").toUpperCase() === "RUNNING"
  ).length;

  return (
    <div className="app">
      {/* Top navigation */}
      <nav className="topnav">
        <span className="brandmark">S</span>
        <span className="brandname">
          Stratus <span className="thin">Console</span>
        </span>
        <span className="topnav-divider" />
        <span className="topnav-crumb">Instance Manager</span>
        <span className="topnav-spacer" />
        <div className="topnav-right">
          <span className="pill-status">
            <span className={`dot ${statusDot}`} />
            {statusLabel}
          </span>
          <span className="topnav-region">local-ec2 · vm</span>
        </div>
      </nav>

      {/* Service header */}
      <div className="subhead">
        <div className="breadcrumb">
          <a href="#">Stratus</a> &nbsp;/&nbsp; <a href="#">Deployments</a>{" "}
          &nbsp;/&nbsp; Instances
        </div>
        <h1>Instances</h1>
        <p className="subtitle">
          Provision, start, stop and terminate project instances stored in your
          Neon database, served by the Local EC2 backend.
        </p>
      </div>

      <div className="content">
        {/* Dashboard stats */}
        <div className="stats">
          <div className="stat">
            <span className="stat-chip indigo">◈</span>
            <div>
              <div className="stat-label">Total instances</div>
              <div className="stat-value">{loading ? "—" : projects.length}</div>
            </div>
          </div>
          <div className="stat">
            <span className="stat-chip mint">▶</span>
            <div>
              <div className="stat-label">Running</div>
              <div className="stat-value">{loading ? "—" : runningCount}</div>
            </div>
          </div>
          <div className="stat">
            <span className="stat-chip amber">◷</span>
            <div>
              <div className="stat-label">Latest</div>
              <div className="stat-value sm">
                {loading ? "—" : latest ? latest.name : "None yet"}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="flashbar" role="alert">
            <span className="flash-icon">⛔</span>
            <span className="flash-text">
              <strong>Could not complete the request</strong>
              {error}
            </span>
            <button onClick={fetchProjects}>Retry</button>
          </div>
        )}

        {/* Create instance */}
        <section className="panel">
          <div className="panel-header">
            <div className="htitle">
              <span className="accent-bar" />
              <div>
                <h2>Launch instance</h2>
                <p className="hdesc">Provision a new project instance.</p>
              </div>
            </div>
          </div>
          <div className="panel-body">
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <label htmlFor="p-name">Instance name</label>
                <input
                  id="p-name"
                  className="input"
                  type="text"
                  placeholder="e.g. edge-render-node"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="form-row">
                <label htmlFor="p-desc">
                  Description <span className="opt">— optional</span>
                </label>
                <textarea
                  id="p-desc"
                  className="textarea"
                  placeholder="What is this instance for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="form-actions">
                {submitting && (
                  <span className="launch-hint">
                    Provisioning a real VM — this can take ~30–90s…
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setName("");
                    setDescription("");
                  }}
                  disabled={submitting}
                >
                  Clear
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
          </div>
        </section>

        {/* Instances table */}
        <section className="panel">
          <div className="panel-header">
            <div className="htitle">
              <span className="accent-bar" />
              <div>
                <h2>Instances</h2>
                <p className="hdesc">Loaded from the database on start.</p>
              </div>
            </div>
            <span className="count-badge">{projects.length}</span>
          </div>

          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="col-id">ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Description</th>
                  <th>Created</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2].map((i) => (
                    <tr className="skeleton-row" key={i}>
                      <td>
                        <span style={{ width: "50%" }} />
                      </td>
                      <td>
                        <span style={{ width: "60%" }} />
                      </td>
                      <td>
                        <span style={{ width: "70%" }} />
                      </td>
                      <td>
                        <span style={{ width: "80%" }} />
                      </td>
                      <td>
                        <span style={{ width: "55%" }} />
                      </td>
                      <td>
                        <span style={{ width: "90%" }} />
                      </td>
                    </tr>
                  ))
                ) : projects.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">
                        <span className="emoji">🗂️</span>
                        <strong>No instances yet</strong>
                        Launch your first one using the form above.
                      </div>
                    </td>
                  </tr>
                ) : (
                  projects.map((p) => {
                    const busy = rowBusy[p.id];
                    const status = (p.status || "RUNNING").toUpperCase();
                    return (
                      <tr key={p.id} className={busy ? "row-busy" : ""}>
                        <td className="col-id">
                          <span className="id-chip">#{p.id}</span>
                        </td>
                        <td className="col-name">
                          <span className="name-row">
                            <a href="#">{p.name}</a>
                            {p.keyName && (
                              <span
                                className="key-badge"
                                title={`Secured with key pair: ${p.keyName}`}
                              >
                                🔑
                              </span>
                            )}
                          </span>
                          <div className="ip-line">
                            <span className="ip-label">IPv4</span>
                            {p.ipAddress ? (
                              <span className="ip-addr">{p.ipAddress}</span>
                            ) : (
                              <span className="ip-addr muted">
                                {status === "STOPPED" ? "—" : "pending…"}
                              </span>
                            )}
                          </div>
                          {p.instanceName && (
                            <div className="inst-name">{p.instanceName}</div>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={status} />
                        </td>
                        <td
                          className={`col-desc ${p.description ? "" : "empty"}`}
                        >
                          {p.description || "No description"}
                        </td>
                        <td className="col-date">{formatDate(p.createdAt)}</td>
                        <td className="col-actions">
                          <div className="row-actions">
                            <button
                              className="rbtn connect"
                              onClick={() => setTerminalProject(p)}
                              disabled={status !== "RUNNING"}
                              title="Instance Connect (web terminal)"
                            >
                              Connect
                            </button>
                            <button
                              className="rbtn"
                              onClick={() => setMonitorProject(p)}
                              title="Monitoring"
                            >
                              Monitor
                            </button>
                            <button
                              className="rbtn"
                              onClick={() => changeStatus(p.id, "start")}
                              disabled={!!busy || status === "RUNNING"}
                              title="Start instance"
                            >
                              {busy === "start" ? (
                                <span className="spinner dark" />
                              ) : (
                                "Start"
                              )}
                            </button>
                            <button
                              className="rbtn"
                              onClick={() => changeStatus(p.id, "stop")}
                              disabled={!!busy || status === "STOPPED"}
                              title="Stop instance"
                            >
                              {busy === "stop" ? (
                                <span className="spinner dark" />
                              ) : (
                                "Stop"
                              )}
                            </button>
                            <button
                              className="rbtn danger"
                              onClick={() => terminate(p.id)}
                              disabled={!!busy}
                              title="Terminate instance"
                            >
                              {busy === "terminate" ? (
                                <span className="spinner dark" />
                              ) : (
                                "Terminate"
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="footer">
          Stratus Console · connected to <code>{API_BASE_URL}</code>
        </footer>
      </div>

      {terminalProject && (
        <TerminalModal
          project={terminalProject}
          onClose={() => setTerminalProject(null)}
        />
      )}
      {monitorProject && (
        <MonitoringModal
          project={monitorProject}
          onClose={() => setMonitorProject(null)}
        />
      )}
      {keyModal && (
        <KeyModal info={keyModal} onClose={() => setKeyModal(null)} />
      )}
    </div>
  );
}

export default App;
