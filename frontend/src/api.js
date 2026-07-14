import axios from "axios";

// ---------------------------------------------------------------------------
// Where is the backend?
//
// The backend runs ON THE HOST laptop (it shells out to the host's Multipass CLI
// to manage real VMs). To let OTHER DEVICES on the same Wi-Fi use it, the API
// must be reached at the laptop's LAN IP, not "localhost" — because on a phone,
// "localhost" means the phone itself.
//
// By default we AUTO-DETECT: we reuse whatever host you loaded the page from.
//   - open http://localhost:5173        -> API = http://localhost:5000
//   - open http://192.168.0.107:5173    -> API = http://192.168.0.107:5000
// This means it "just works" from any device with no edits.
//
// If you'd rather hard-code it, put your laptop's LAN IP in LAN_IP below.
// Find it with:  hostname -I | awk '{print $1}'
// ---------------------------------------------------------------------------
const LAN_IP = null; // e.g. "192.168.0.107"  (leave null to auto-detect)

const API_PORT = 5000;
const API_HOST =
  LAN_IP ||
  (typeof window !== "undefined" ? window.location.hostname : "localhost");

export const API_BASE_URL = `http://${API_HOST}:${API_PORT}`;

// WebSocket base for the Instance Connect terminal (http -> ws, https -> wss).
// Derived from API_BASE_URL, so the xterm.js terminal automatically follows the
// same LAN IP and works from other devices.
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, "ws");

// Real VM operations are slow, so use generous per-operation timeouts.
export const TIMEOUTS = {
  read: 20000, // GET list
  // Must be LONGER than the backend's own launch timeout (600s), so the server's
  // real error message reaches the user instead of the client aborting first.
  launch: 660000, // 11 min — covers a first-time OS image download
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
