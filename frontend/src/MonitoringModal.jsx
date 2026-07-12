import { useEffect, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import api from "./api";

const MAX_POINTS = 30; // ~1 minute of history at 2s cadence
const POLL_MS = 2000;

const COLORS = {
  cpu: "#6c5ce7", // indigo
  memory: "#00c2a8", // mint
  disk: "#f0a500", // amber
  netIn: "#3aa0ff", // blue
  netOut: "#b026ff", // purple
  diskRead: "#16a34a", // green
  diskWrite: "#ff2d95", // pink
};

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString(undefined, {
    minute: "2-digit",
    second: "2-digit",
  });

function StatTile({ label, value, unit, color }) {
  return (
    <div className="metric-tile">
      <span className="metric-tile-dot" style={{ background: color }} />
      <div>
        <div className="metric-tile-label">{label}</div>
        <div className="metric-tile-value">
          {value}
          <span className="metric-tile-unit">{unit}</span>
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <div className="chart-body">
        <ResponsiveContainer width="100%" height={190}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const axis = { stroke: "#9aa0b8", fontSize: 11 };
const grid = "#e6e8f0";

export default function MonitoringModal({ project, onClose }) {
  const [series, setSeries] = useState([]);
  const [error, setError] = useState("");
  const timer = useRef(null);

  useEffect(() => {
    if (!project) return;
    let active = true;

    const tick = async () => {
      try {
        const { data } = await api.get(`/api/projects/${project.id}/metrics`, {
          timeout: 10000,
        });
        if (!active) return;
        setError("");
        setSeries((prev) => {
          const next = [...prev, { ...data, t: fmtTime(data.timestamp) }];
          return next.slice(-MAX_POINTS);
        });
      } catch (err) {
        if (active) setError("Metrics unavailable — is the backend running?");
      }
    };

    tick();
    timer.current = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer.current);
    };
  }, [project]);

  if (!project) return null;
  const latest = series[series.length - 1] || {};

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal monitor-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="htitle">
            <span className="accent-bar" />
            <div>
              <h2>Monitoring — {project.name}</h2>
              <p className="hdesc">
                {project.instanceName}
                {project.ipAddress ? ` · ${project.ipAddress}` : ""} · live, every 2s
              </p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="monitor-body">
          {error && <div className="flashbar mini">{error}</div>}

          <div className="metric-tiles">
            <StatTile label="CPU" value={latest.cpu ?? "—"} unit="%" color={COLORS.cpu} />
            <StatTile
              label="Memory"
              value={latest.memory ?? "—"}
              unit="%"
              color={COLORS.memory}
            />
            <StatTile label="Disk" value={latest.disk ?? "—"} unit="%" color={COLORS.disk} />
            <StatTile
              label="Net In"
              value={latest.networkIn ?? "—"}
              unit=" KB/s"
              color={COLORS.netIn}
            />
            <StatTile
              label="Net Out"
              value={latest.networkOut ?? "—"}
              unit=" KB/s"
              color={COLORS.netOut}
            />
          </div>

          <div className="chart-grid">
            <ChartCard title="CPU & Memory utilization (%)">
              <LineChart data={series} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="t" tick={axis} minTickGap={28} />
                <YAxis domain={[0, 100]} tick={axis} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="cpu"
                  name="CPU %"
                  stroke={COLORS.cpu}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="memory"
                  name="Memory %"
                  stroke={COLORS.memory}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartCard>

            <ChartCard title="Network (KB/s)">
              <AreaChart data={series} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.netIn} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={COLORS.netIn} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.netOut} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={COLORS.netOut} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="t" tick={axis} minTickGap={28} />
                <YAxis tick={axis} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="networkIn"
                  name="In"
                  stroke={COLORS.netIn}
                  fill="url(#gIn)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="networkOut"
                  name="Out"
                  stroke={COLORS.netOut}
                  fill="url(#gOut)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Disk I/O (KB/s)">
              <LineChart data={series} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="t" tick={axis} minTickGap={28} />
                <YAxis tick={axis} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="diskRead"
                  name="Read"
                  stroke={COLORS.diskRead}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="diskWrite"
                  name="Write"
                  stroke={COLORS.diskWrite}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  );
}
