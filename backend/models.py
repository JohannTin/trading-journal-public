import re
from pydantic import BaseModel, Field, field_validator
from typing import Optional


# ── Journal ──────────────────────────────────────────────────────────────────

class JournalUpsert(BaseModel):
    date: str
    account_id: Optional[int] = None
    pre_market: Optional[str] = None
    went_well:  Optional[str] = None
    to_improve: Optional[str] = None
    mood:       Optional[str] = None  # 'focused' | 'distracted' | 'revenge' | 'fomo' | 'hesitant'
    flagged:    bool = False

class JournalOut(BaseModel):
    id: int
    date: str
    account_id: Optional[int]
    pre_market: Optional[str]
    went_well:  Optional[str]
    to_improve: Optional[str]
    mood:       Optional[str]
    flagged:    bool
    updated_at: str
    deleted_at: Optional[str] = None


# ── Accounts ─────────────────────────────────────────────────────────────────

class AccountCreate(BaseModel):
    name: str

class AccountRename(BaseModel):
    name: str

class AccountOut(BaseModel):
    id: int
    name: str


# ── Exits ────────────────────────────────────────────────────────────────────

class ExitCreate(BaseModel):
    trade_id: int
    date: Optional[str] = None  # exit date; None means same day as trade entry
    time: str
    qty: int = Field(gt=0)
    price: float = Field(gt=0)


class ExitOut(BaseModel):
    id: int
    trade_id: int
    date: Optional[str] = None  # exit date; None means same day as trade entry
    time: str
    qty: int
    price: float
    pnl: float
    pct: float
    macd: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_hist: Optional[float] = None
    mae: Optional[float] = None          # % move against entry (negative = bad)
    mfe: Optional[float] = None          # % best point during hold (positive = good)
    post_exit_mfe: Optional[float] = None  # % best point after exit until session end


# ── Trades ───────────────────────────────────────────────────────────────────

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


class TradeCreate(BaseModel):
    date: str                        # 'YYYY-MM-DD'
    time: str                        # 'HH:MM'
    dte: int = 0
    ticker: str
    option_type: str                 # 'Call' | 'Put'
    strike: float = Field(gt=0)
    expiry: str                      # 'YYYY-MM-DD'
    qty: int = Field(gt=0)
    fill: float = Field(gt=0)
    total_cost: float
    source: Optional[str] = None
    notes: Optional[str] = None
    chart_link: Optional[str] = None
    strategy: Optional[str] = None
    account_id: Optional[int] = None

    @field_validator("date", "expiry")
    @classmethod
    def validate_date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("must be YYYY-MM-DD")
        return v

    @field_validator("time")
    @classmethod
    def validate_time(cls, v: str) -> str:
        if not _TIME_RE.match(v):
            raise ValueError("must be HH:MM")
        return v

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("ticker cannot be empty")
        return v

    @field_validator("option_type")
    @classmethod
    def validate_option_type(cls, v: str) -> str:
        if v not in ("Call", "Put"):
            raise ValueError("must be 'Call' or 'Put'")
        return v

    @field_validator("dte")
    @classmethod
    def validate_dte(cls, v: int) -> int:
        if v < 0:
            raise ValueError("DTE cannot be negative")
        return v


class TradeOut(BaseModel):
    id: int
    date: str
    time: str
    dte: int
    ticker: str
    option_type: str
    strike: float
    expiry: str
    qty: int
    fill: float
    total_cost: float
    source: Optional[str]
    notes: Optional[str]
    chart_link: Optional[str]
    strategy: Optional[str]
    status: str
    flagged: bool = False
    account_id: Optional[int] = None
    total_pnl: float
    entry_macd: Optional[float] = None
    entry_macd_signal: Optional[float] = None
    entry_macd_hist: Optional[float] = None
    exits: list[ExitOut]


# ── Stats ────────────────────────────────────────────────────────────────────

class DayStats(BaseModel):
    date: str
    total_pnl: float
    trade_count: int
    win_count: int
    loss_count: int
    win_rate: float       # % of closed trades that were winners
    avg_rr: float         # avg win / abs(avg loss) for the day


class OverallStats(BaseModel):
    total_pnl: float
    win_rate: float
    avg_win: float
    avg_loss: float
    profit_factor: float
    trade_count: int
    closed_count: int
    open_count: int
    avg_trades_per_day: float
    high_freq_days: list[str]
