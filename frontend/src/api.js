import axios from "axios";

// Live "Local EC2" backend running inside the multipass VM.
export const API_BASE_URL = "http://10.176.164.96:5000";

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 12000, // fail fast instead of hanging forever on an unreachable VM
  headers: { "Content-Type": "application/json" },
});

// Turn raw axios failures into short, human-friendly messages.
export function describeError(error) {
  if (error.code === "ECONNABORTED") {
    return "Request timed out. The backend VM may be waking up or unreachable — try again.";
  }
  if (error.code === "ERR_NETWORK") {
    return `Cannot reach the backend at ${API_BASE_URL}. Is the VM up and the server running?`;
  }
  if (error.response) {
    const detail = error.response.data?.error;
    return detail || `Server responded with ${error.response.status}.`;
  }
  return "Something went wrong. Please try again.";
}

export default api;
