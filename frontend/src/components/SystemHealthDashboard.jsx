import { useCallback, useEffect, useState } from 'react'
import { Server, Database, RefreshCw, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import StatusCard from './StatusCard'
import { getHealth } from '../services/api'

const POLL_INTERVAL_MS = 10_000

export default function SystemHealthDashboard() {
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastChecked, setLastChecked] = useState(null)

  const fetchHealth = useCallback(async (mountedRef) => {
    try {
      const data = await getHealth()
      if (mountedRef.value) {
        setHealth(data)
        setError(null)
        setLastChecked(new Date())
      }
    } catch (err) {
      if (mountedRef.value) {
        setHealth(null)
        setError(err.message || 'Cannot reach backend.')
        setLastChecked(new Date())
      }
    } finally {
      if (mountedRef.value) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const mountedRef = { value: true }
    fetchHealth(mountedRef)
    const id = setInterval(() => fetchHealth(mountedRef), POLL_INTERVAL_MS)
    return () => {
      mountedRef.value = false
      clearInterval(id)
    }
  }, [fetchHealth])

  const backendUp = !error && health?.status === 'UP'
  const dbUp = !error && health?.database === 'UP'

  return (
    <section aria-labelledby="health-heading" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 id="health-heading" className="text-lg font-semibold text-slate-100">
            System Health
          </h2>
          <p className="text-sm text-slate-500">
            Auto-refreshing every 10s
            {lastChecked && (
              <>
                {' · '}
                <span className="text-slate-400">
                  last check {lastChecked.toLocaleTimeString()}
                </span>
              </>
            )}
          </p>
        </div>
        <RefreshCw
          className={`h-4 w-4 text-slate-500 ${loading ? 'animate-spin' : ''}`}
        />
      </div>

      {error && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </motion.div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatusCard
          icon={Server}
          label="Backend Status"
          value={backendUp ? 'UP' : 'DOWN'}
          up={backendUp}
          loading={loading}
        />
        <StatusCard
          icon={Database}
          label="Database Connection"
          value={dbUp ? 'UP' : 'DOWN'}
          up={dbUp}
          loading={loading}
        />
      </div>

      {health?.environment && (
        <p className="text-right text-xs text-slate-600">
          env: <span className="text-slate-400">{health.environment}</span>
        </p>
      )}
    </section>
  )
}
