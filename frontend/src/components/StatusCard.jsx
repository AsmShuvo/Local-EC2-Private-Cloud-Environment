import { motion } from 'framer-motion'

export default function StatusCard({ icon: Icon, label, value, up, loading }) {
  const tone = loading
    ? {
        text: 'text-slate-300',
        ring: 'rgba(148,163,184,0.35)',
        dot: 'bg-slate-400',
      }
    : up
      ? {
          text: 'text-emerald-400',
          ring: 'rgba(16,185,129,0.55)',
          dot: 'bg-emerald-400',
        }
      : {
          text: 'text-rose-400',
          ring: 'rgba(244,63,94,0.55)',
          dot: 'bg-rose-400',
        }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass relative overflow-hidden rounded-2xl p-5"
      style={{ boxShadow: `0 0 0 1px ${tone.ring}, 0 0 28px -6px ${tone.ring}` }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-2xl"
        style={{ background: tone.ring }}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white/5 p-2.5 ring-1 ring-white/10">
            <Icon className={`h-5 w-5 ${tone.text}`} strokeWidth={2} />
          </div>
          <span className="text-sm font-medium text-slate-400">{label}</span>
        </div>

        <span className="relative flex h-2.5 w-2.5">
          {!loading && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${tone.dot}`}
            />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone.dot}`} />
        </span>
      </div>

      <div className="mt-4">
        <p className={`text-2xl font-semibold tracking-tight ${tone.text}`}>
          {loading ? 'Checking…' : value}
        </p>
      </div>
    </motion.div>
  )
}
