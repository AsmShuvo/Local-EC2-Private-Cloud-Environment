import axios from 'axios'

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

const apiClient = axios.create({
  baseURL,
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

function normalizeError(error) {
  if (error.response) {
    return {
      code: `HTTP_${error.response.status}`,
      message:
        error.response.data?.error ||
        `Server responded with ${error.response.status}`,
    }
  }
  if (error.request) {
    return {
      code: error.code || 'NETWORK_ERROR',
      message:
        error.code === 'ECONNABORTED'
          ? 'Request timed out — the backend did not respond in time.'
          : 'Network error — cannot reach the backend API.',
    }
  }
  return { code: 'CLIENT_ERROR', message: error.message || 'Unexpected error.' }
}

export async function getHealth() {
  try {
    const { data } = await apiClient.get('/health')
    return data
  } catch (error) {
    // Backend returns 503 with a body when the DB is down — pass it through.
    if (error.response?.data) return error.response.data
    throw normalizeError(error)
  }
}

export async function getUsers() {
  try {
    const { data } = await apiClient.get('/users')
    return data.users ?? []
  } catch (error) {
    throw normalizeError(error)
  }
}

export default apiClient
