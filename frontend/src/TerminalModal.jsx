import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { WS_BASE_URL } from "./api";

// Full-screen "Instance Connect" terminal: xterm.js <-> backend WebSocket <-> VM shell.
export default function TerminalModal({ project, onClose }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState("connecting"); // connecting | open | closed

  useEffect(() => {
    if (!project) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", "SFMono-Regular", ui-monospace, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0b0d17",
        foreground: "#e7ecf5",
        cursor: "#00c2a8",
        selectionBackground: "#33407a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    term.focus();

    const ws = new WebSocket(`${WS_BASE_URL}/api/ws/terminal/${project.id}`);

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      setStatus("open");
      sendResize();
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => {
      setStatus("closed");
      term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
    };
    ws.onerror = () => setStatus("closed");

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onWindowResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [project]);

  if (!project) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal terminal-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head terminal-head">
          <div className="term-title">
            <span className="term-dots">
              <i /> <i /> <i />
            </span>
            <span className="term-name">
              Instance Connect — <strong>{project.name}</strong>
              <span className="term-inst">
                {project.instanceName}
                {project.ipAddress ? ` · ${project.ipAddress}` : ""}
              </span>
            </span>
          </div>
          <div className="term-right">
            <span className={`term-status ${status}`}>
              {status === "open"
                ? "● connected"
                : status === "connecting"
                ? "○ connecting…"
                : "○ disconnected"}
            </span>
            <button className="modal-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="terminal-host" ref={containerRef} />
      </div>
    </div>
  );
}
