import { useState, useEffect, useCallback } from "react";
import api, { API_BASE_URL, TIMEOUTS, describeError } from "./api";
import TerminalModal from "./TerminalModal";
import MonitoringModal from "./MonitoringModal";
import KeyModal from "./KeyModal";
import KeyPairDetailsModal from "./KeyPairDetailsModal";
import LaunchWizard from "./LaunchWizard";
import SecurityGroupsPanel from "./SecurityGroupsPanel";
import InstanceSecurityModal from "./InstanceSecurityModal";
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
  const [showLaunch, setShowLaunch] = useState(false); // launch wizard modal

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
  const [detailKeyName, setDetailKeyName] = useState(null); // key pair details modal
  const [securityProject, setSecurityProject] = useState(null);
  const [tab, setTab] = useState("instances"); // "instances" | "security"

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


  // Called by the launch wizard when a VM has been provisioned.
  const handleLaunched = (project) => {
    setProjects((prev) => [project, ...prev]);
    setOnline(true);
  };

  // Only fires when a NEW key pair was generated — download it once.
  const handleKeyIssued = (project, privateKey) => {
    const filename = `${safeFileName(project.keyName || project.name)}.pem`;
    downloadTextFile(filename, privateKey);
    setKeyModal({
      filename,
      keyName: project.keyName,
      instanceName: project.instanceName,
      ipAddress: project.ipAddress,
    });
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
        {/* Tabs */}
        <div className="tabs">
          <button
            className={`tab ${tab === "instances" ? "is-active" : ""}`}
            onClick={() => setTab("instances")}
          >
            Instances
          </button>
          <button
            className={`tab ${tab === "security" ? "is-active" : ""}`}
            onClick={() => setTab("security")}
          >
            🛡️ Security Groups
          </button>
        </div>

        {tab === "security" && <SecurityGroupsPanel />}

        {tab === "instances" && (
        <>
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
            <div className="panel-head-actions">
              <span className="count-badge">{projects.length}</span>
              <button className="btn btn-ghost sm" onClick={fetchProjects} title="Refresh">
                ⟳
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowLaunch(true)}
              >
                Launch instance
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="col-id">ID</th>
                  <th>Name</th>
                  <th>Instance type</th>
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
                        <span style={{ width: "65%" }} />
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
                    <td colSpan={7}>
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
                              <button
                                className="key-badge"
                                title={`View key pair: ${p.keyName}`}
                                onClick={() => setDetailKeyName(p.keyName)}
                              >
                                🔑 {p.keyName}
                              </button>
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
                          {p.securityGroups && p.securityGroups.length > 0 && (
                            <div className="sg-badges">
                              {p.securityGroups.map((g) => (
                                <span className="sg-chip" key={g.id} title="Security group">
                                  🛡️ {g.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="col-type">
                          <span className="type-badge">
                            {p.instanceType || "t2.micro"}
                          </span>
                          <div className="type-specs">
                            {(p.cpu ?? 1)} vCPU · {p.memory || "1G"} RAM · {p.disk || "5G"} disk
                          </div>
                          <span className="os-badge">
                            {p.os === "debian-12" ? "Debian 12" : "Ubuntu"}
                          </span>
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
                              className="rbtn"
                              onClick={() => setSecurityProject(p)}
                              title="Manage security groups"
                            >
                              🛡️
                            </button>
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

        </>
        )}

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
      {showLaunch && (
        <LaunchWizard
          onClose={() => setShowLaunch(false)}
          onLaunched={handleLaunched}
          onKeyIssued={handleKeyIssued}
        />
      )}
      {keyModal && (
        <KeyModal info={keyModal} onClose={() => setKeyModal(null)} />
      )}
      {detailKeyName && (
        <KeyPairDetailsModal
          keyName={detailKeyName}
          onClose={() => setDetailKeyName(null)}
        />
      )}
      {securityProject && (
        <InstanceSecurityModal
          project={securityProject}
          onClose={() => setSecurityProject(null)}
          onSaved={fetchProjects}
        />
      )}
    </div>
  );
}

export default App;
