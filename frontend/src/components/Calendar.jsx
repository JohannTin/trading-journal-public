import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtPnl(n) {
  const abs = Math.abs(n)
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`
  return n >= 0 ? `+${str}` : `-${str}`
}

export default function Calendar({ data = [], highFreqDays = [], offset = 0, setOffset, onSelectDate, selectedDate, disableFutureDays = false }) {
  const today    = new Date()
  const viewDate = new Date(today.getFullYear(), today.getMonth() + offset, 1)
  const year     = viewDate.getFullYear()
  const month    = viewDate.getMonth()
  const clickable = typeof onSelectDate === 'function'

  const localTodayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const [picking, setPicking]     = useState(false)
  const [pickerYear, setPickerYear] = useState(() => viewDate.getFullYear())

  const openPicker = () => { setPickerYear(year); setPicking(true) }
  const closePicker = () => setPicking(false)

  const pickMonth = (y, m) => {
    const todayY = today.getFullYear()
    const todayM = today.getMonth()
    const newOffset = (y - todayY) * 12 + (m - todayM)
    setOffset?.(newOffset)
    setPicking(false)
  }

  const statsMap = useMemo(() => {
    const m = {}
    data.forEach((d) => { m[d.date] = d })
    return m
  }, [data])

  const maxAbs = useMemo(() =>
    Math.max(...data.map((d) => Math.abs(d.total_pnl)), 1)
  , [data])

  const firstDay    = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const slots = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  while (slots.length % 7 !== 0) slots.push(null)
  const weeks = []
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7))

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const monthData   = useMemo(() => data.filter(d => d.date.startsWith(monthPrefix)), [data, monthPrefix])
  const monthPnl    = monthData.reduce((s, d) => s + d.total_pnl, 0)
  const monthTrades = monthData.reduce((s, d) => s + d.trade_count, 0)
  const monthWins   = monthData.reduce((s, d) => s + d.win_count, 0)
  const monthLosses = monthData.reduce((s, d) => s + d.loss_count, 0)
  const monthWR     = (monthWins + monthLosses) > 0
    ? (monthWins / (monthWins + monthLosses) * 100).toFixed(0) : null

  function weekSummary(week) {
    let pnl = 0, trades = 0, days = 0
    week.forEach((day) => {
      if (!day) return
      const s = statsMap[`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`]
      if (s) { pnl += s.total_pnl; trades += s.trade_count; days++ }
    })
    return { pnl, trades, days }
  }

  function bgColor(stats) {
    if (!stats) return ''
    const pct   = Math.min(Math.abs(stats.total_pnl) / maxAbs, 1)
    const level = pct > 0.66 ? 'high' : pct > 0.33 ? 'mid' : 'low'
    if (stats.total_pnl > 0)
      return level === 'high' ? 'bg-emerald-500/80' : level === 'mid' ? 'bg-emerald-500/45' : 'bg-emerald-500/20'
    if (stats.total_pnl < 0)
      return level === 'high' ? 'bg-rose-500/80' : level === 'mid' ? 'bg-rose-500/45' : 'bg-rose-500/20'
    return ''
  }

  // pnl totals per year-month for the picker
  const monthPnlMap = useMemo(() => {
    const m = {}
    data.forEach(d => {
      const ym = d.date.slice(0, 7)
      m[ym] = (m[ym] || 0) + d.total_pnl
    })
    return m
  }, [data])

  const todayYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`

  return (
    <div className="border border-border bg-card flex flex-col min-w-[520px]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <button
          onClick={() => picking ? setPickerYear(y => y - 1) : setOffset?.((o) => o - 1)}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => picking ? closePicker() : openPicker()}
          className="text-sm font-bold uppercase tracking-[0.2em] text-foreground hover:text-primary transition-colors"
        >
          {picking ? pickerYear : viewDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={() => picking ? setPickerYear(y => y + 1) : setOffset?.((o) => o + 1)}
            disabled={!picking && offset >= 0}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setOffset?.(0); setPicking(false) }}
            className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-accent border border-border transition-colors"
          >
            Today
          </button>
        </div>
      </div>

      {/* Year picker overlay */}
      {picking && (
        <div className="flex-1 grid grid-cols-3 gap-2 p-4" style={{ gridAutoRows: '1fr' }}>
          {MONTHS_SHORT.map((name, m) => {
            const ym    = `${pickerYear}-${String(m + 1).padStart(2, '0')}`
            const pnl   = monthPnlMap[ym]
            const isFuture = ym > todayYM
            const isCurrent = year === pickerYear && month === m
            return (
              <button
                key={m}
                onClick={() => !isFuture && pickMonth(pickerYear, m)}
                disabled={isFuture}
                className={`flex flex-col items-center justify-center py-3 gap-1 border transition-colors
                  ${isCurrent
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-accent/60 text-foreground'}
                  ${isFuture ? 'opacity-25 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span className="text-xs font-bold uppercase tracking-wider">{name}</span>
                {pnl != null ? (
                  <span className={`text-[10px] font-mono font-semibold leading-none ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                    {pnl >= 0 ? '+' : ''}{Math.abs(pnl) >= 1000 ? `$${(pnl / 1000).toFixed(1)}k` : `$${pnl.toFixed(0)}`}
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/30">—</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Day-of-week headers */}
      <div className={`grid grid-cols-[repeat(7,2fr)_1fr] px-2 pt-2 pb-1 gap-1 shrink-0 ${picking ? 'hidden' : ''}`}>
        {DAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 py-0.5">{d}</div>
        ))}
        <div className="text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 py-0.5">Wk</div>
      </div>

      {/* Week rows */}
      <div className={`flex flex-col gap-1 px-2 pb-2 ${picking ? 'hidden' : ''}`}>
        {weeks.map((week, wi) => {
          const { pnl: wPnl, days: wDays } = weekSummary(week)
          const isFirstWeek = wi === 0

          return (
            <div key={wi} className="grid grid-cols-[repeat(7,2fr)_1fr] grid-rows-[90px] gap-1">
              {week.map((day, di) => {
                if (!day) return (
                  <div key={`e-${wi}-${di}`} className="bg-muted/5" />
                )

                const dateStr    = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                const stats      = statsMap[dateStr]
                const isHighFreq = highFreqDays.includes(dateStr)
                const isToday    = day === today.getDate() && month === today.getMonth() && year === today.getFullYear()
                const isSelected = selectedDate === dateStr
                const isFuture   = disableFutureDays && dateStr > localTodayStr

                return (
                  <div
                    key={dateStr}
                    onClick={() => { if (clickable && !isFuture) onSelectDate(dateStr) }}
                    role={clickable ? 'button' : undefined}
                    aria-label={clickable ? `Select ${dateStr}` : undefined}
                    className={`relative group p-2 flex flex-col justify-between overflow-hidden cursor-default transition-all hover:brightness-125 hover:z-10
                      ${bgColor(stats) || 'bg-muted/10'}
                      ${clickable ? 'cursor-pointer' : 'cursor-default'}
                      ${isToday    ? 'ring-1 ring-primary ring-inset' : ''}
                      ${isHighFreq ? 'ring-1 ring-amber-400 ring-inset' : ''}
                      ${isSelected ? 'ring-1 ring-primary ring-inset' : ''}
                      ${isFuture ? 'opacity-35 pointer-events-none' : ''}
                    `}
                  >
                    {/* Day number */}
                    <span className={`text-sm font-mono font-semibold leading-none ${
                      stats ? 'text-white/90' : isToday ? 'text-primary' : 'text-muted-foreground/40'
                    }`}>
                      {day}
                    </span>

                    {/* P&L + stats */}
                    {stats && (
                      <div className="flex flex-col gap-0.5 mt-auto">
                        <span className="text-[11px] font-mono font-bold text-white leading-none">
                          {fmtPnl(stats.total_pnl)}
                        </span>
                        <span className="text-[9px] text-white/65 leading-none font-mono">
                          {stats.trade_count}t · {stats.win_rate.toFixed(0)}%
                        </span>
                      </div>
                    )}

                    {/* Tooltip — below for first week, above otherwise; pinned at edges to avoid clipping */}
                    {stats && (
                      <div className={`absolute ${isFirstWeek ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} ${di === 0 ? 'left-0' : di >= 6 ? 'right-0' : 'left-1/2 -translate-x-1/2'} z-50 hidden group-hover:block w-48 border border-border bg-card shadow-2xl p-3 text-xs pointer-events-none`}>
                        <p className="font-mono text-[10px] font-semibold text-foreground mb-2 pb-1.5 border-b border-border">{dateStr}</p>
                        <div className="space-y-1.5">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">P&L</span>
                            <span className={`font-mono font-bold ${stats.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                              {fmtPnl(stats.total_pnl)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Trades</span>
                            <span className="font-mono text-foreground">{stats.trade_count}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">W / L</span>
                            <span className="font-mono text-foreground">{stats.win_count}W / {stats.loss_count}L</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Win rate</span>
                            <span className="font-mono text-foreground">{stats.win_rate.toFixed(1)}%</span>
                          </div>
                          {stats.avg_rr > 0 && (
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Avg R:R</span>
                              <span className="font-mono text-foreground">{stats.avg_rr.toFixed(2)}R</span>
                            </div>
                          )}
                          {isHighFreq && (
                            <p className="text-amber-400 font-bold pt-1.5 border-t border-border text-[9px] uppercase tracking-widest">⚠ Overtrading</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Weekly summary */}
              <div className={`p-2 flex flex-col justify-between overflow-hidden border-l-2 ${
                wDays > 0
                  ? wPnl >= 0
                    ? 'bg-emerald-500/15 border-l-emerald-500/60'
                    : 'bg-rose-500/15 border-l-rose-500/60'
                  : 'bg-muted/10 border-l-border'
              }`}>
                {wDays > 0 ? (
                  <>
                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60 leading-none">W{wi + 1}</span>
                    <div className="flex flex-col gap-0.5">
                      <span className={`text-xs font-mono font-bold leading-none ${wPnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                        {fmtPnl(wPnl)}
                      </span>
                      <span className="text-[9px] font-mono text-muted-foreground/60 leading-none">{wDays}d</span>
                    </div>
                  </>
                ) : (
                  <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/30">W{wi + 1}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className={`shrink-0 border-t border-border px-5 py-2 flex items-center justify-between ${picking ? 'hidden' : ''}`}>
        {monthData.length > 0 ? (
          <div className="flex items-center gap-4 text-[10px]">
            <span className={`font-mono font-bold ${monthPnl >= 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
              {fmtPnl(monthPnl)}
            </span>
            <span className="text-muted-foreground font-mono">{monthTrades} trades</span>
            {monthWR !== null && (
              <span className="text-muted-foreground font-mono">{monthWins}W / {monthLosses}L · {monthWR}%</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground/40 uppercase tracking-widest font-bold">No activity</span>
        )}
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground/50">
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 bg-emerald-500/80" /> Profit</div>
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 bg-rose-500/80" /> Loss</div>
          <div className="flex items-center gap-1.5"><div className="w-2 h-2 ring-1 ring-amber-400" /> Overtrade</div>
        </div>
      </div>
    </div>
  )
}
