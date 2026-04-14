import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOverviewStats, getCalendarStats, getTrades } from '../api'
import { useAccount } from '../AccountContext'
import { getAppSettings } from '../appSettings'
import Calendar from './Calendar'
import EquityCurve from './EquityCurve'
import TradeChart from './TradeChart'
import { AlertTriangle, ChevronLeft, ChevronRight, CalendarDays, TrendingUp } from 'lucide-react'
import { CARD, SECTION_LABEL, BADGE_CALL, BADGE_PUT, pnlColor, fmt } from '../styles'

function StatCell({ label, value, sub, color = 'text-foreground' }) {
  return (
    <div className="stat-cell flex flex-col gap-1 px-5 py-3 min-w-0 flex-1">
      <span className={`${SECTION_LABEL} whitespace-nowrap`}>{label}</span>
      <span className={`font-mono text-xl font-medium leading-none tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground mt-0.5">{sub}</span>}
    </div>
  )
}

function StatBandSkeleton() {
  return (
    <div className="border border-border bg-card flex">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="stat-cell flex-1 px-5 py-3">
          <div className="h-2 w-14 bg-muted animate-pulse mb-2.5" />
          <div className="h-6 w-24 bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState('calendar')
  const [chartTrade, setChartTrade] = useState(null)
  const { accountId } = useAccount()

  const today    = new Date()
  const viewDate = new Date(today.getFullYear(), today.getMonth() + offset, 1)
  const monthStr = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}`

  const {
    overtradingMultiplier,
    processWinThreshold = 30,
    accountBalance    = 0,
    dailyRiskMode     = 'pct',
    dailyRiskPct      = 5,
    dailyRiskFixed    = 500,
    dailyTargetMode   = 'pct',
    dailyTargetPct    = 5,
    dailyTargetFixed  = 500,
  } = getAppSettings()

  const riskAmount   = dailyRiskMode   === 'pct' ? accountBalance * dailyRiskPct   / 100 : dailyRiskFixed
  const targetAmount = dailyTargetMode === 'pct' ? accountBalance * dailyTargetPct / 100 : dailyTargetFixed

  const { data: stats,    isLoading: statsLoading } = useQuery({ queryKey: ['stats-overview', accountId, overtradingMultiplier], queryFn: () => getOverviewStats(null, accountId, overtradingMultiplier) })
  const { data: calendar, isLoading: calLoading   } = useQuery({ queryKey: ['stats-calendar', accountId],  queryFn: () => getCalendarStats(accountId) })
  const { data: trades }                             = useQuery({ queryKey: ['trades', accountId],           queryFn: () => getTrades(null, accountId) })

  const isLoading = statsLoading || calLoading

  const monthCalendar = useMemo(
    () => (calendar ?? []).filter(d => d.date.startsWith(monthStr)),
    [calendar, monthStr]
  )

  const monthStats = useMemo(() => {
    const totalPnl    = monthCalendar.reduce((s, d) => s + d.total_pnl, 0)
    const totalWins   = monthCalendar.reduce((s, d) => s + d.win_count, 0)
    const totalLosses = monthCalendar.reduce((s, d) => s + d.loss_count, 0)
    const totalTrades = monthCalendar.reduce((s, d) => s + d.trade_count, 0)
    const closed      = totalWins + totalLosses
    const winRate     = closed > 0 ? (totalWins / closed * 100) : 0
    const tradingDays = monthCalendar.length

    const mClosed = (trades ?? []).filter(t => t.date.startsWith(monthStr) && t.status === 'closed')
    const mWins   = mClosed.filter(t => t.total_pnl > 0)
    const mLosses = mClosed.filter(t => t.total_pnl <= 0)
    const avgWin      = mWins.length   ? mWins.reduce((s, t) => s + t.total_pnl, 0)   / mWins.length   : 0
    const avgLoss     = mLosses.length ? mLosses.reduce((s, t) => s + t.total_pnl, 0) / mLosses.length : 0
    const grossWin    = mWins.reduce((s, t) => s + t.total_pnl, 0)
    const grossLoss   = Math.abs(mLosses.reduce((s, t) => s + t.total_pnl, 0))
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 0

    return { totalPnl, totalTrades, winRate, avgWin, avgLoss, profitFactor, totalWins, totalLosses, tradingDays }
  }, [monthCalendar, trades, monthStr])

  const openTrades   = useMemo(() => (trades ?? []).filter(t => t.status === 'open'),            [trades])
  const recentClosed = useMemo(() => (trades ?? []).filter(t => t.status === 'closed').slice(0, 20), [trades])
  const openExposure = useMemo(() => openTrades.reduce((s, t) => s + t.total_cost, 0),           [openTrades])

  // Merge trade-count overtrading days with risk/target breach days
  const overtradingDays = useMemo(() => {
    const freqDays = stats?.high_freq_days ?? []
    if (riskAmount <= 0 && targetAmount <= 0) return freqDays
    const pnlDays = (calendar ?? [])
      .filter(d => (riskAmount > 0 && d.total_pnl <= -riskAmount) || (targetAmount > 0 && d.total_pnl >= targetAmount))
      .map(d => d.date)
    return [...new Set([...freqDays, ...pnlDays])]
  }, [stats, calendar, riskAmount, targetAmount])

  const adjWinRate = useMemo(() => {
    const closed = (trades ?? []).filter(t => t.status === 'closed')
    if (!closed.length) return null
    const adjWins = closed.filter(t => {
      if (t.total_pnl > 0) return true
      const lastMfe = t.exits?.filter(e => e.mfe != null).at(-1)?.mfe ?? null
      return lastMfe != null && lastMfe >= processWinThreshold
    })
    return (adjWins.length / closed.length * 100).toFixed(1)
  }, [trades, processWinThreshold])

  const atPnl      = stats?.total_pnl ?? 0
  const pfValue    = stats?.profit_factor > 0 ? stats.profit_factor : null
  const mPfValue   = monthStats.profitFactor > 0 ? monthStats.profitFactor : null

  return (
    <div className="h-full overflow-hidden flex flex-col p-5 gap-3">

      {/* Overtrading alert — today only */}
      {overtradingDays.includes(new Date().toISOString().slice(0, 10)) && (
        <div className="shrink-0 flex items-start gap-3 border border-amber-500/25 bg-amber-500/5 px-4 py-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">
            Overtrading signal — you've hit your risk or target limit, or exceeded your average trade frequency for today.
          </p>
        </div>
      )}

      {/* Stats — shrink-0 */}
      <div className="shrink-0 space-y-2.5">
        {/* All-time */}
        <div>
          <p className={`${SECTION_LABEL} mb-2`}>All time</p>
          {isLoading ? <StatBandSkeleton /> : (
            <div className="border border-border bg-card flex flex-wrap">
              <StatCell label="Total P&L"      value={fmt(atPnl)}                                    sub={`${stats?.closed_count ?? 0} closed`}  color={pnlColor(atPnl)} />
              <StatCell label="Win Rate"        value={`${stats?.win_rate ?? 0}%`}                   sub="actual"                                 color={(stats?.win_rate ?? 0) >= 50 ? 'text-emerald-400' : 'text-rose-500'} />
              <StatCell label="Adj. Win Rate"   value={adjWinRate != null ? `${adjWinRate}%` : '—'} sub={`MFE ≥ ${processWinThreshold}%`}        color={adjWinRate != null && parseFloat(adjWinRate) >= 50 ? 'text-emerald-400' : adjWinRate != null ? 'text-rose-500' : 'text-muted-foreground'} />
              <StatCell label="Profit Factor"   value={pfValue ? pfValue.toFixed(2) + '×' : '—'}    sub="win / loss"                             color={pfValue && pfValue >= 1.5 ? 'text-emerald-400' : pfValue ? 'text-amber-400' : 'text-muted-foreground'} />
              <StatCell label="Avg Win"         value={fmt(stats?.avg_win ?? 0)}                     sub="per trade"                              color="text-emerald-400" />
              <StatCell label="Avg Loss"        value={fmt(stats?.avg_loss ?? 0)}                    sub="per trade"                              color="text-rose-500" />
            </div>
          )}
        </div>

        {/* Monthly */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className={SECTION_LABEL}>{viewDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</p>
            <div className="flex items-center gap-0">
              <button onClick={() => setOffset(o => o - 1)} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setOffset(o => o + 1)} disabled={offset >= 0} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-25">
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {isLoading ? <StatBandSkeleton /> : (
            <div className="border border-border bg-card flex flex-wrap">
              <StatCell label="P&L"           value={monthCalendar.length ? fmt(monthStats.totalPnl)                  : '—'} sub={monthCalendar.length ? `${monthStats.tradingDays}d`                                 : 'no activity'} color={pnlColor(monthStats.totalPnl)} />
              <StatCell label="Win Rate"      value={monthCalendar.length ? `${monthStats.winRate.toFixed(1)}%`        : '—'} sub={monthCalendar.length ? `${monthStats.totalWins}W / ${monthStats.totalLosses}L`     : ''}            color={monthStats.winRate >= 50 ? 'text-emerald-400' : 'text-rose-500'} />
              <StatCell label="Profit Factor" value={mPfValue              ? mPfValue.toFixed(2) + '×'                : '—'} sub="win / loss"                                                                                          color={mPfValue && mPfValue >= 1.5 ? 'text-emerald-400' : mPfValue ? 'text-amber-400' : 'text-muted-foreground'} />
              <StatCell label="Avg Win"       value={monthStats.avgWin !== 0 ? fmt(monthStats.avgWin)                 : '—'} sub="per trade"                                                                                           color="text-emerald-400" />
              <StatCell label="Avg Loss"      value={monthStats.avgLoss !== 0 ? fmt(monthStats.avgLoss)               : '—'} sub="per trade"                                                                                           color="text-rose-500" />
            </div>
          )}
        </div>
      </div>

      {/* Main grid — 2 rows */}
      <div className="flex-1 min-h-0 grid grid-cols-[7fr_3fr] grid-rows-[1fr_auto] gap-3">

        {/* Row 1 — view-switched panel */}
        <div className="col-span-2 min-h-0 flex flex-col gap-0">
          {/* View toggle */}
          <div className="shrink-0 flex items-center gap-0 mb-2 w-fit border border-border">
            <button
              onClick={() => setView('calendar')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
                view === 'calendar'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              <CalendarDays className="w-3 h-3" />
              Calendar
            </button>
            <button
              onClick={() => setView('equity')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors border-l border-border ${
                view === 'equity'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              <TrendingUp className="w-3 h-3" />
              Equity Curve
            </button>
          </div>

          {/* Panel content */}
          <div className="flex-1 min-h-0">
            {view === 'calendar' ? (
              <div className="h-full overflow-y-auto">
                <Calendar
                  data={calendar ?? []}
                  highFreqDays={overtradingDays}
                  offset={offset}
                  setOffset={setOffset}
                />
              </div>
            ) : (
              <EquityCurve data={calendar ?? []} />
            )}
          </div>
        </div>

        {/* Row 2 col 1 — Open Positions (70%) */}
        <div className={`${CARD} flex flex-col max-h-52`}>
          <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
            <span className={SECTION_LABEL}>Open Positions</span>
            {openTrades.length > 0 && (
              <span className="font-mono text-xs text-amber-400">${openExposure.toFixed(0)} exposure</span>
            )}
          </div>
          <div className="overflow-y-auto">
            {openTrades.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No open positions.</p>
            ) : (
              <div>
                {openTrades.map((t) => (
                  <div key={t.id} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={t.option_type === 'Call' ? BADGE_CALL : BADGE_PUT}>{t.option_type[0]}</span>
                      <span className="font-semibold text-foreground text-sm">{t.ticker}</span>
                      <span className="font-mono text-xs text-muted-foreground">${t.strike}</span>
                      <span className="text-xs text-muted-foreground">exp {t.expiry}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground shrink-0">{t.qty}× @${Number(t.fill).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Row 2 col 2 — Recent Closed (30%) */}
        <div className={`${CARD} flex flex-col max-h-52`}>
          <div className="px-4 py-2.5 border-b border-border shrink-0">
            <span className={SECTION_LABEL}>Recent Closed</span>
          </div>
          <div className="overflow-y-auto">
            {recentClosed.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No closed trades yet.</p>
            ) : (
              <div>
                {recentClosed.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => setChartTrade(t)}
                    className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={t.option_type === 'Call' ? BADGE_CALL : BADGE_PUT}>{t.option_type[0]}</span>
                      <span className="font-semibold text-sm text-foreground">{t.ticker}</span>
                      <span className="font-mono text-xs text-muted-foreground">${t.strike}</span>
                    </div>
                    <span className={`font-mono text-sm font-medium shrink-0 ${pnlColor(t.total_pnl)}`}>
                      {fmt(t.total_pnl)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
      {chartTrade && (
        <TradeChart
          trade={chartTrade}
          onClose={() => setChartTrade(null)}
        />
      )}
    </div>
  )
}
