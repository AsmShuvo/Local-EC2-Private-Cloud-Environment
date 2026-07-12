import axios from "axios";

// The backend now runs ON THE HOST (it shells out to the host's Multipass CLI
// to manage real VMs — a VM-resident backend can't reach the host's multipassd).
// If you run the frontend on a different machine, point this at the host's LAN IP.
export const API_BASE_URL = "http://localhost:5000";

// WebSocket base for the Instance Connect terminal (http -> ws, https -> wss).
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, "ws");

// Real VM operations are slow, so use generous per-operation timeouts.
export const TIMEOUTS = {
  read: 20000, // GET list
  launch: 300000, // multipass launch (image boot) — up to 5 min
  action: 150000, // start / stop — up to 2.5 min
  terminate: 150000, // delete + purge
};

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: TIMEOUTS.read,
  headers: { "Content-Type": "application/json" },
});

// Turn raw axios failures into short, human-friendly messages.
export function describeError(error) {
  if (error.code === "ECONNABORTED") {
    return "The operation took too long. A real VM can take a while to change state — it may still be finishing on the host. Refresh in a moment.";
  }
  if (error.code === "ERR_NETWORK") {
    return `Cannot reach the backend at ${API_BASE_URL}. Is the server running on the host?`;
  }
  if (error.response) {
    const detail = error.response.data?.error;
    return detail || `Server responded with ${error.response.status}.`;
  }
  return "Something went wrong. Please try again.";
}

export default api;
