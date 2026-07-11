import { useState, useEffect, useCallback } from "react";
import api, { API_BASE_URL, describeError } from "./api";
import "./App.css";

function App() {
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [loading, setLoading] = useState(true); // initial fetch
  const [submitting, setSubmitting] = useState(false); // form POST
  const [error, setError] = useState("");
  const [online, setOnline] = useState(null); // null=unknown, true/false

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
      const { data } = await api.post("/api/projects", {
        name: name.trim(),
        description: description.trim(),
      });
      // Instant list update — prepend the freshly created project.
      setProjects((prev) => [data, ...prev]);
      setName("");
      setDescription("");
      setOnline(true);
    } catch (err) {
      console.error(err);
      setError(describeError(err));
      setOnline(false);
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-glow bg-glow--cyan" aria-hidden="true" />
      <div className="bg-glow bg-glow--purple" aria-hidden="true" />

      <div className="shell">
        <header className="topbar glass">
          <div className="brand">
            <span className="brand-mark">◈</span>
            <div>
              <h1 className="brand-title">
                CLOUD<span className="accent">OPS</span>
              </h1>
              <p className="brand-sub">Local EC2 · Project Control Deck</p>
            </div>
          </div>

          <div className="status">
            <span
              className={`status-dot ${
                online === false ? "is-down" : online ? "is-up" : "is-idle"
              }`}
            />
            <span className="status-text">
              {online === false
                ? "OFFLINE"
                : online
                ? "CONNECTED"
                : "CONNECTING"}
            </span>
            <code className="status-url">{API_BASE_URL}</code>
          </div>
        </header>

        {error && (
          <div className="banner glass" role="alert">
            <span className="banner-icon">⚠</span>
            <span className="banner-text">{error}</span>
            <button className="banner-retry" onClick={fetchProjects}>
              Retry
            </button>
          </div>
        )}

        <main className="layout">
          {/* Create form */}
          <section className="panel glass form-panel">
            <div className="panel-head">
              <h2 className="panel-title">Deploy New Project</h2>
              <p className="panel-hint">Push a record to the live backend</p>
            </div>

            <form className="form" onSubmit={handleSubmit}>
              <label className="field">
                <span className="field-label">Project Name</span>
                <input
                  className="input"
                  type="text"
                  placeholder="e.g. edge-render-node"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="field">
                <span className="field-label">Description</span>
                <textarea
                  className="input textarea"
                  placeholder="What does this project do?"
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <button
                className="btn"
                type="submit"
                disabled={submitting || !name.trim()}
              >
                {submitting ? (
                  <>
                    <span className="spinner" /> Deploying…
                  </>
                ) : (
                  <>+ Create Project</>
                )}
              </button>
            </form>
          </section>

          {/* Projects grid */}
          <section className="panel glass list-panel">
            <div className="panel-head list-head">
              <div>
                <h2 className="panel-title">Active Projects</h2>
                <p className="panel-hint">Fetched from the Neon database</p>
              </div>
              <span className="count-pill">{projects.length}</span>
            </div>

            {loading ? (
              <div className="grid">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="card card--skeleton" />
                ))}
              </div>
            ) : projects.length === 0 ? (
              <div className="empty">
                <span className="empty-mark">⌁</span>
                <p>No projects yet.</p>
                <span className="empty-sub">
                  Deploy your first one using the form.
                </span>
              </div>
            ) : (
              <div className="grid">
                {projects.map((p) => (
                  <article key={p.id} className="card">
                    <div className="card-top">
                      <span className="card-id">#{p.id}</span>
                      <span className="card-date">{formatDate(p.createdAt)}</span>
                    </div>
                    <h3 className="card-name">{p.name}</h3>
                    <p className="card-desc">
                      {p.description || "No description provided."}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>

        <footer className="footer">
          <span>CLOUDOPS · powered by Express + Prisma + Neon</span>
        </footer>
      </div>
    </div>
  );
}

export default App;
