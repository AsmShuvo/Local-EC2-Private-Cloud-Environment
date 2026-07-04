import { Activity, Cpu } from 'lucide-react'
import { motion } from 'framer-motion'
import SystemHealthDashboard from './components/SystemHealthDashboard'
import UserManagement from './components/UserManagement'

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-surface/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-500 shadow-lg shadow-indigo-500/30">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-slate-100">
                EC2 Replica · Control Panel
              </h1>
              <p className="text-xs text-slate-500">Express + Prisma + Neon</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs text-slate-400 ring-1 ring-white/10 sm:flex">
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span className="font-mono">{apiUrl}</span>
          </div>
        </div>
      </header>

      <motion.main
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-6xl space-y-10 px-4 py-8 sm:px-6"
      >
        <SystemHealthDashboard />
        <UserManagement />
      </motion.main>

      <footer className="mx-auto max-w-6xl px-4 py-8 text-center text-xs text-slate-600 sm:px-6">
        System Health Dashboard — polling live from the backend API.
      </footer>
    </div>
  )
}

export default App
