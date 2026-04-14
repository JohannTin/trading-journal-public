import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, ScrollText, Sun, Moon, Calculator, BarChart2, Settings2, ChevronDown, BookOpen } from 'lucide-react'
import Dashboard from './components/Dashboard'
import TradeLog from './components/TradeLog'
import KellyCalculator from './components/KellyCalculator'
import Analytics from './components/Analytics'
import Settings from './components/Settings'
import Journal from './components/Journal'
import { AccountProvider, useAccount } from './AccountContext'

const ROUTE_TITLES = {
  '/':          'Dashboard',
  '/trades':    'Trade Log',
  '/analytics': 'Analytics',
  '/journal':   'Journal',
  '/kelly':     'Calculator',
  '/settings':  'Settings',
}

function TopBar() {
  const { pathname } = useLocation()
  const title = ROUTE_TITLES[pathname] ?? ''
  return (
    <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border bg-card">
      <span className="text-base font-bold uppercase tracking-[0.2em] text-foreground">{title}</span>
      <AccountDropdown />
    </div>
  )
}

function AccountDropdown() {
  const { accountId, accounts, select } = useAccount()
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!accounts.length) return null

  const label = accountId === null
    ? 'All accounts'
    : accounts.find(a => a.id === accountId)?.name ?? 'All accounts'

  const handleOpen = () => {
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect())
    setOpen(o => !o)
  }

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="flex items-center gap-2 px-3 py-1.5 border border-border bg-card text-xs font-semibold text-foreground hover:bg-accent transition-colors"
      >
        {label}
        <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && rect && (
        <div
          style={{ position: 'fixed', top: rect.bottom + 4, right: window.innerWidth - rect.right }}
          className="z-[9999] border border-border bg-card shadow-xl min-w-[140px]"
        >
          {[{ id: null, name: 'All accounts' }, ...accounts].map(a => (
            <button
              key={a.id ?? 'all'}
              onClick={() => { select(a.id); setOpen(false) }}
              className={`w-full text-left px-4 py-2 text-xs font-semibold transition-colors ${
                accountId === a.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('theme')
    return saved ? saved === 'dark' : true
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  const navCls = ({ isActive }) =>
    `flex items-center gap-3 px-4 py-2.5 text-sm font-semibold tracking-wide transition-all border-l-2 ${
      isActive
        ? 'border-primary text-primary bg-primary/5'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/60'
    }`

  return (
    <AccountProvider>
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-background min-w-[900px]">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 border-r border-border flex flex-col bg-card">
          {/* Logo */}
          <div className="flex items-center gap-3 px-4 py-5 border-b border-border">
            <div className="w-7 h-7 bg-primary flex items-center justify-center shrink-0">
              <span className="font-mono font-bold text-primary-foreground text-xs leading-none">↗</span>
            </div>
            <span className="font-bold text-foreground text-base tracking-tight">TIN Trades</span>
          </div>

          {/* Nav */}
          <nav className="flex flex-col py-3 gap-0.5">
            <NavLink to="/" end className={navCls}>
              <LayoutDashboard className="w-4 h-4 shrink-0" />
              Dashboard
            </NavLink>
            <NavLink to="/trades" className={navCls}>
              <ScrollText className="w-4 h-4 shrink-0" />
              Trade Log
            </NavLink>
            <NavLink to="/analytics" className={navCls}>
              <BarChart2 className="w-4 h-4 shrink-0" />
              Analytics
            </NavLink>
            <NavLink to="/journal" className={navCls}>
              <BookOpen className="w-4 h-4 shrink-0" />
              Journal
            </NavLink>
            <NavLink to="/kelly" className={navCls}>
              <Calculator className="w-4 h-4 shrink-0" />
              Calculator
            </NavLink>
            <NavLink to="/settings" className={navCls}>
              <Settings2 className="w-4 h-4 shrink-0" />
              Settings
            </NavLink>
          </nav>

          {/* Bottom */}
          <div className="mt-auto border-t border-border p-3">
            <button
              onClick={() => setDark(d => !d)}
              className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors w-full"
            >
              {dark ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
              {dark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </aside>

        {/* Main — each page manages its own scroll */}
        <main className="flex-1 overflow-hidden h-full flex flex-col">
          {/* Top bar */}
          <TopBar />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/trades" element={<TradeLog />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/journal" element={<Journal />} />
            <Route path="/kelly" element={<KellyCalculator />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
    </AccountProvider>
  )
}

export default App
