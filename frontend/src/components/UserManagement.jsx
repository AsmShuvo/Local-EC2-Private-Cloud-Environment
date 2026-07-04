import { useCallback, useEffect, useState } from 'react'
import { Users, RefreshCw, AlertTriangle, Mail } from 'lucide-react'
import { motion } from 'framer-motion'
import { getUsers } from '../services/api'

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function initials(name, email) {
  const base = name || email || '?'
  return base
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')
}

export default function UserManagement() {
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getUsers()
      setUsers(data)
      setError(null)
    } catch (err) {
      setError(err.message || 'Failed to load users.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <section aria-labelledby="users-heading" className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-400" />
          <h2 id="users-heading" className="text-lg font-semibold text-slate-100">
            User Management
          </h2>
          {!loading && !error && (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-white/10">
              {users.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 disabled:opacity-50"
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="glass overflow-hidden rounded-2xl"
      >
        {error ? (
          <div className="flex items-center gap-3 px-5 py-8 text-rose-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">Couldn’t load users</p>
              <p className="text-sm text-rose-400/80">{error}</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-5 py-3 font-medium">Email</th>
                  <th className="px-5 py-3 font-medium">ID</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {loading &&
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={`sk-${i}`} className="border-b border-white/5">
                      <td className="px-5 py-4" colSpan={4}>
                        <div className="h-4 w-full animate-pulse rounded bg-white/5" />
                      </td>
                    </tr>
                  ))}

                {!loading && users.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-5 py-10 text-center text-slate-500"
                    >
                      No users found.
                    </td>
                  </tr>
                )}

                {!loading &&
                  users.map((u) => (
                    <motion.tr
                      key={u.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="border-b border-white/5 transition-colors hover:bg-white/[0.03]"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500/30 to-emerald-500/20 text-xs font-semibold text-slate-200 ring-1 ring-white/10">
                            {initials(u.name, u.email)}
                          </div>
                          <span className="font-medium text-slate-200">
                            {u.name || '—'}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-400">
                          <Mail className="h-3.5 w-3.5 text-slate-600" />
                          {u.email}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-mono text-slate-500">#{u.id}</td>
                      <td className="px-5 py-4 text-slate-500">
                        {formatDate(u.createdAt)}
                      </td>
                    </motion.tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </section>
  )
}
