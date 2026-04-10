import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createTrade, updateTrade, addExit, updateExit, getStrategies } from '../api'
import { X, ChevronDown } from 'lucide-react'
import { getTimezone } from '../timezone'
import { useAccount } from '../AccountContext'

const INPUT = 'w-full border border-border bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/40'
const LABEL = 'block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground mb-1.5'

function Field({ label, children }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
    </div>
  )
}

function nowTime() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: getTimezone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).slice(0, 5)
}

function nowDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: getTimezone() })
}

// Auto-inserts ":" — accepts "1450" → "14:50", "935" → "09:35", "14:50" unchanged
function formatTime(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return digits.slice(0, 2) + ':' + digits.slice(2)
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return dt.toLocaleDateString('en-CA')
}

function diffDays(expiryStr, dateStr) {
  const [ey, em, ed] = expiryStr.split('-').map(Number)
  const [dy, dm, dd] = dateStr.split('-').map(Number)
  const expDate = new Date(ey, em - 1, ed)
  const tradeDate = new Date(dy, dm - 1, dd)
  return Math.max(0, Math.round((expDate - tradeDate) / (1000 * 60 * 60 * 24)))
}

function invalidate(qc) {
  qc.invalidateQueries({ queryKey: ['trades'] })
  qc.invalidateQueries({ queryKey: ['stats-overview'] })
  qc.invalidateQueries({ queryKey: ['stats-calendar'] })
}

// ── Add / Edit Exit ───────────────────────────────────────────────────────────
function ExitForm({ trade, exit, onClose }) {
  const qc = useQueryClient()
  const isEdit = !!exit
  const remaining = isEdit
    ? trade.qty - trade.exits.filter(e => e.id !== exit.id).reduce((s, e) => s + e.qty, 0)
    : trade.qty - trade.exits.reduce((s, e) => s + e.qty, 0)

  const [form, setForm] = useState({
    date:  isEdit ? (exit.date ?? nowDate()) : nowDate(),
    time:  isEdit ? exit.time                : nowTime(),
    qty:   isEdit ? String(exit.qty)         : '',
    price: isEdit ? String(exit.price)       : '',
    notes: '',
  })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const previewPnl = form.price && form.qty
    ? (parseFloat(form.price) - trade.fill) * parseInt(form.qty) * 100
    : null

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        return updateExit(exit.id, { date: form.date, time: formatTime(form.time), qty: parseInt(form.qty), price: parseFloat(form.price) })
      }
      await addExit({ trade_id: trade.id, date: form.date, time: formatTime(form.time), qty: parseInt(form.qty), price: parseFloat(form.price) })
      if (form.notes.trim()) {
        const exitIndex = trade.exits.length + 1
        const section = `Exit ${exitIndex}:\n${form.notes.trim()}`
        const updatedNotes = trade.notes ? `${trade.notes.trim()}\n\n${section}` : section
        await updateTrade(trade.id, {
          date: trade.date, time: trade.time, fill: trade.fill,
          qty: trade.qty, total_cost: trade.total_cost, notes: updatedNotes,
        })
      }
    },
    onSuccess: () => { invalidate(qc); onClose() },
  })

  return (
    <div className="space-y-4">
      <div className="bg-muted/30 border border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{trade.ticker} ${trade.strike} {trade.option_type}</span>
        {' · '}Fill: <span className="font-mono text-foreground">${trade.fill}</span>
        {' · '}Available: <span className="font-mono text-amber-400 font-semibold">{remaining}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Exit Date">
          <input className={INPUT} type="date" value={form.date} onChange={set('date')} />
        </Field>
        <Field label="Time ET (HH:MM)">
          <input className={INPUT} value={form.time} onChange={e => setForm(f => ({ ...f, time: formatTime(e.target.value) }))} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={`Qty (max ${remaining})`}>
          <input className={INPUT} type="number" min="1" max={remaining} value={form.qty} onChange={set('qty')} />
        </Field>
        <Field label="Exit Price">
          <input className={INPUT} type="number" step="0.01" value={form.price} onChange={set('price')} />
        </Field>
      </div>

      {previewPnl !== null && (
        <div className={`font-mono text-sm font-semibold text-center py-2.5 border ${
          previewPnl >= 0 ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-400' : 'border-rose-500/20 bg-rose-500/8 text-rose-400'
        }`}>
          {previewPnl >= 0 ? '+' : ''}${previewPnl.toFixed(2)}
          {' '}({(((parseFloat(form.price) - trade.fill) / trade.fill) * 100).toFixed(1)}%)
        </div>
      )}

      {!isEdit && (
        <Field label="Comment (optional)">
          <textarea
            className={`${INPUT} resize-none`}
            rows={2}
            placeholder="Why did you exit here?"
            value={form.notes}
            onChange={set('notes')}
          />
        </Field>
      )}

      {mutation.error && <p className="text-xs text-rose-400">{mutation.error.message}</p>}

      <button
        onClick={() => mutation.mutate()}
        disabled={!form.date || !form.time || !form.qty || !form.price || mutation.isPending}
        className="w-full bg-primary text-primary-foreground py-2.5 text-sm font-bold disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {mutation.isPending ? 'Saving…' : isEdit ? 'Save Exit' : 'Add Exit'}
      </button>
    </div>
  )
}

// ── New / Edit Trade ──────────────────────────────────────────────────────────
function TradeForm({ trade, onClose }) {
  const qc = useQueryClient()
  const { accountId, accounts } = useAccount()
  const { data: strategies = [] } = useQuery({ queryKey: ['strategies'], queryFn: getStrategies })
  const isEdit = !!trade
  const today = nowDate()

  const [form, setForm] = useState({
    date:        isEdit ? trade.date           : today,
    time:        isEdit ? trade.time           : nowTime(),
    dte:         isEdit ? String(trade.dte)    : '0',
    ticker:      isEdit ? trade.ticker         : 'SPY',
    option_type: isEdit ? trade.option_type    : 'Call',
    strike:      isEdit ? String(trade.strike) : '',
    expiry:      isEdit ? trade.expiry         : today,
    qty:         isEdit ? String(trade.qty)    : '',
    fill:        isEdit ? String(trade.fill)   : '',
    source:      isEdit ? (trade.source   ?? '') : '',
    notes:       isEdit ? (trade.notes    ?? '') : '',
    strategy:    isEdit ? (trade.strategy ?? '') : '',
    account_id:  isEdit ? (trade.account_id ?? accountId) : accountId,
  })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const handleDate = (e) => {
    const date = e.target.value
    setForm((f) => ({ ...f, date, expiry: addDays(date, parseInt(f.dte) || 0) }))
  }

  const handleDte = (e) => {
    const dte = e.target.value
    setForm((f) => ({ ...f, dte, expiry: dte !== '' ? addDays(f.date, parseInt(dte) || 0) : f.expiry }))
  }

  const handleExpiry = (e) => {
    const expiry = e.target.value
    setForm((f) => ({ ...f, expiry, dte: expiry ? String(diffDays(expiry, f.date)) : f.dte }))
  }

  const totalCost = form.fill && form.qty
    ? parseFloat(form.fill) * parseInt(form.qty) * 100
    : 0

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        date: form.date, time: formatTime(form.time), dte: parseInt(form.dte),
        ticker: form.ticker.toUpperCase(), option_type: form.option_type,
        strike: parseFloat(form.strike), expiry: form.expiry,
        qty: parseInt(form.qty), fill: parseFloat(form.fill),
        total_cost: totalCost,
        source:     form.source   || null,
        notes:      form.notes    || null,
        strategy:   form.strategy || null,
        account_id: form.account_id,
      }
      return isEdit ? updateTrade(trade.id, payload) : createTrade(payload)
    },
    onSuccess: () => { invalidate(qc); onClose() },
  })

  const valid = form.time && form.ticker && form.strike && form.qty && form.fill && form.expiry

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          <input className={INPUT} type="date" value={form.date} onChange={handleDate} />
        </Field>
        <Field label="Time ET (HH:MM)">
          <input className={INPUT} value={form.time} onChange={e => setForm(f => ({ ...f, time: formatTime(e.target.value) }))} />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Ticker">
          <input 
            className={INPUT} 
            value={form.ticker} 
            onChange={e => setForm(f => ({ ...f, ticker: e.target.value.toUpperCase() }))} 
          />
        </Field>
        <Field label="Type">
          <div className="relative">
            <select className={`${INPUT} appearance-none pr-8`} value={form.option_type} onChange={set('option_type')}>
              <option>Call</option>
              <option>Put</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          </div>
        </Field>
        <Field label="DTE">
          <input className={INPUT} type="number" min="0" value={form.dte} onChange={handleDte} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Strike">
          <input className={INPUT} type="number" step="0.5" value={form.strike} onChange={set('strike')} />
        </Field>
        <Field label="Expiry">
          <input className={INPUT} type="date" value={form.expiry} onChange={handleExpiry} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Qty (contracts)">
          <input className={INPUT} type="number" min="1" value={form.qty} onChange={set('qty')} />
        </Field>
        <Field label="Fill Price">
          <input className={INPUT} type="number" step="0.01" value={form.fill} onChange={set('fill')} />
        </Field>
      </div>

      {totalCost > 0 && (
        <p className="text-xs text-muted-foreground">
          Total cost: <span className="font-mono text-foreground font-semibold">${totalCost.toFixed(2)}</span>
        </p>
      )}

      {accounts.length > 0 && (
        <Field label="Account">
          <div className="relative">
            <select
              className={`${INPUT} appearance-none pr-8`}
              value={form.account_id ?? ''}
              onChange={e => setForm(f => ({ ...f, account_id: e.target.value ? parseInt(e.target.value) : null }))}
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          </div>
        </Field>
      )}

      <Field label="Strategy (optional)">
        <input
          className={INPUT}
          list="strategy-options"
          value={form.strategy}
          onChange={set('strategy')}
          placeholder="Select or type a strategy…"
        />
        <datalist id="strategy-options">
          {strategies.map((s) => <option key={s} value={s} />)}
        </datalist>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Source (optional)">
          <input className={INPUT} value={form.source} onChange={set('source')} />
        </Field>
        <Field label="Notes (optional)">
          <input className={INPUT} value={form.notes} onChange={set('notes')} />
        </Field>
      </div>

      {mutation.error && <p className="text-xs text-rose-400">{mutation.error.message}</p>}

      <button
        onClick={() => mutation.mutate()}
        disabled={!valid || mutation.isPending}
        className="w-full bg-primary text-primary-foreground py-2.5 text-sm font-bold disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Trade'}
      </button>
    </div>
  )
}

// ── Modal Shell ───────────────────────────────────────────────────────────────
export default function TradeModal({ mode, trade, exit, onClose }) {
  const title = { exit: 'Add Exit', 'edit-exit': 'Edit Exit', edit: 'Edit Trade', trade: 'New Trade' }[mode]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md border border-border bg-card shadow-2xl p-6 z-10 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xs font-bold tracking-widest text-foreground uppercase">{title}</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {mode === 'exit' && <ExitForm trade={trade} exit={null} onClose={onClose} />}
        {mode === 'edit-exit' && <ExitForm trade={trade} exit={exit} onClose={onClose} />}
        {mode === 'edit' && <TradeForm trade={trade} onClose={onClose} />}
        {mode === 'trade' && <TradeForm trade={null} onClose={onClose} />}
      </div>
    </div>
  )
}
