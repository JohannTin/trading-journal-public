import os
import sqlite3
import threading
from pathlib import Path

# Use TRADING_JOURNAL_DB env var to override (e.g. point to demo DB)
_HERE = Path(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("TRADING_JOURNAL_DB", str(_HERE / "trading_journal.db"))
UPLOADS_DIR = _HERE / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)
(UPLOADS_DIR / "journal").mkdir(exist_ok=True)

_init_lock = threading.Lock()
_initialized = False
_local = threading.local()  # per-thread connection cache


class _DBConn:
    """
    Thin wrapper around a sqlite3.Connection.
    close() rolls back any open transaction but keeps the underlying
    connection alive in the thread-local cache — avoiding the overhead
    of open/close on every request.
    """
    def __init__(self, conn):
        self._c = conn

    def execute(self, *a, **kw):
        return self._c.execute(*a, **kw)

    def commit(self):
        self._c.commit()

    def close(self):
        try:
            self._c.rollback()   # discard any uncommitted writes safely
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._c, name)


def _make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db() -> _DBConn:
    """Return a per-thread persistent connection, initialising the DB on first call."""
    global _initialized
    if not _initialized:
        with _init_lock:
            if not _initialized:
                _run_init()
                _initialized = True

    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _make_conn()
        _local.conn = conn
    return _DBConn(conn)


def _table_columns(conn, table: str) -> set:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r[1] for r in rows}


def _run_init():
    """Create tables and apply migrations. Safe to call multiple times."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # persists in the DB file
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    cur.executescript("""
        CREATE TABLE IF NOT EXISTS journal_entries (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            date         TEXT    NOT NULL,
            account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
            pre_market   TEXT,
            went_well    TEXT,
            to_improve   TEXT,
            mood         TEXT,
            flagged      INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(date, account_id)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chart_data (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker       TEXT    NOT NULL,
            ts           INTEGER NOT NULL,
            open         REAL    NOT NULL,
            high         REAL    NOT NULL,
            low          REAL    NOT NULL,
            close        REAL    NOT NULL,
            volume       INTEGER,
            vwap         REAL,
            ma1          REAL,
            ma2          REAL,
            ma3          REAL,
            ma4          REAL,
            buy_signal   INTEGER DEFAULT 0,
            sell_signal  INTEGER DEFAULT 0,
            macd_hist    REAL,
            macd         REAL,
            macd_signal  REAL,
            rsi          REAL,
            cci          REAL,
            cci_ma       REAL,
            div_reg_bull REAL,
            div_hid_bull REAL,
            div_reg_bear REAL,
            div_hid_bear REAL,
            UNIQUE(ticker, ts)
        );

        CREATE TABLE IF NOT EXISTS trades (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date        TEXT    NOT NULL,
            time        TEXT    NOT NULL,
            dte         INTEGER NOT NULL DEFAULT 0,
            ticker      TEXT    NOT NULL,
            option_type TEXT    NOT NULL,
            strike      REAL    NOT NULL,
            expiry      TEXT    NOT NULL,
            qty         INTEGER NOT NULL CHECK (qty > 0),
            fill        REAL    NOT NULL,
            total_cost  REAL    NOT NULL,
            source      TEXT,
            notes       TEXT,
            chart_link  TEXT,
            strategy    TEXT,
            status      TEXT    NOT NULL DEFAULT 'open',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS exits (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
            time        TEXT    NOT NULL,
            qty         INTEGER NOT NULL CHECK (qty > 0),
            price       REAL    NOT NULL,
            pnl         REAL    NOT NULL,
            pct         REAL    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS journal_images (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date        TEXT    NOT NULL,
            account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
            filename    TEXT    NOT NULL UNIQUE,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
    """)

    # Migrate: add columns that may be missing in older DB files
    trade_cols = _table_columns(conn, "trades")
    for col, ddl in [
        ("chart_link", "TEXT"),
        ("strategy",   "TEXT"),
        ("status",     "TEXT NOT NULL DEFAULT 'open'"),
        ("created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"),
        ("flagged",    "INTEGER NOT NULL DEFAULT 0"),
    ]:
        if col not in trade_cols:
            try:
                conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise

    # Migrate: add account_id if missing
    if "account_id" not in trade_cols:
        try:
            conn.execute("ALTER TABLE trades ADD COLUMN account_id INTEGER REFERENCES accounts(id)")
        except sqlite3.OperationalError as e:
            if "duplicate column name" not in str(e).lower():
                raise

    # Seed default accounts if none exist
    count = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
    if count == 0:
        conn.execute("INSERT INTO accounts (name) VALUES ('0DTE')")
        conn.execute("INSERT INTO accounts (name) VALUES ('Swing')")

    # Backfill existing trades with no account → first account
    first_id = conn.execute("SELECT id FROM accounts ORDER BY id LIMIT 1").fetchone()[0]
    conn.execute("UPDATE trades SET account_id = ? WHERE account_id IS NULL", (first_id,))

    # Backfill status for trades whose exits fully cover the qty
    conn.execute("""
        UPDATE trades SET status = 'closed'
        WHERE id IN (
            SELECT t.id FROM trades t
            JOIN exits e ON e.trade_id = t.id
            GROUP BY t.id
            HAVING SUM(e.qty) >= t.qty
        )
    """)

    # Migrate: soft-delete support
    trade_cols = _table_columns(conn, "trades")  # re-read after earlier mutations
    if "deleted_at" not in trade_cols:
        try:
            conn.execute("ALTER TABLE trades ADD COLUMN deleted_at TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column name" not in str(e).lower():
                raise

    exit_cols = _table_columns(conn, "exits")
    for col, ddl in [
        ("created_at", "TEXT NOT NULL DEFAULT (datetime('now'))"),
        ("notes",      "TEXT"),
        ("deleted_at", "TEXT"),
        ("date",       "TEXT"),
    ]:
        if col not in exit_cols:
            try:
                conn.execute(f"ALTER TABLE exits ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise

    # Migrate: add flagged + soft-delete support for journal entries
    journal_cols = _table_columns(conn, "journal_entries")
    for col, ddl in [
        ("flagged",    "INTEGER NOT NULL DEFAULT 0"),
        ("deleted_at", "TEXT"),
    ]:
        if col not in journal_cols:
            try:
                conn.execute(f"ALTER TABLE journal_entries ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise

    # Migrate: denormalized columns on trades
    trade_cols = _table_columns(conn, "trades")
    for col, ddl in [
        ("total_pnl",          "REAL NOT NULL DEFAULT 0"),
        ("entry_macd",         "REAL"),
        ("entry_macd_signal",  "REAL"),
        ("entry_macd_hist",    "REAL"),
    ]:
        if col not in trade_cols:
            try:
                conn.execute(f"ALTER TABLE trades ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise

    # Migrate: denormalized columns on exits
    exit_cols = _table_columns(conn, "exits")
    for col, ddl in [
        ("mae",               "REAL"),
        ("mfe",               "REAL"),
        ("post_exit_mfe",     "REAL"),
        ("exit_macd",         "REAL"),
        ("exit_macd_signal",  "REAL"),
        ("exit_macd_hist",    "REAL"),
    ]:
        if col not in exit_cols:
            try:
                conn.execute(f"ALTER TABLE exits ADD COLUMN {col} {ddl}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e).lower():
                    raise

    # Indices for fast lookups
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_account_date ON trades(account_id, date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_exits_trade_id ON exits(trade_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chart_data_ticker_ts ON chart_data(ticker, ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_journal_images_date ON journal_images(date, account_id)")

    # Backfill total_pnl for trades where it is still 0 but exits exist
    conn.execute("""
        UPDATE trades
        SET total_pnl = (
            SELECT COALESCE(SUM(pnl), 0)
            FROM exits
            WHERE trade_id = trades.id AND deleted_at IS NULL
        )
        WHERE total_pnl = 0
    """)

    conn.commit()
    conn.close()
    print(f"Database ready at {DB_PATH}")


def _backfill_computed(conn):
    """Backfill denormalized MACD and MAE/MFE columns for existing rows."""
    from backend.compute import (
        option_ticker, entry_ts, day_bounds, nearest_macd, compute_mae_mfe, DEFAULT_SESSION_END
    )

    # ── Trades: backfill entry MACD where NULL ────────────────────────────────
    trades_missing = conn.execute(
        "SELECT * FROM trades WHERE entry_macd_hist IS NULL AND deleted_at IS NULL"
    ).fetchall()

    for t in trades_missing:
        d = dict(t)
        start_ts, end_ts = day_bounds(d["date"])
        ts = entry_ts(d["date"], d["time"])
        macd = nearest_macd(conn, d["ticker"], ts, start_ts, end_ts)
        conn.execute(
            "UPDATE trades SET entry_macd = ?, entry_macd_signal = ?, entry_macd_hist = ? WHERE id = ?",
            (macd["macd"], macd["macd_signal"], macd["macd_hist"], d["id"]),
        )

    # ── Exits: backfill exit MACD + MAE/MFE where NULL ───────────────────────
    exits_missing = conn.execute("""
        SELECT e.*, t.date, t.ticker, t.fill, t.time AS entry_time,
               t.expiry, t.strike, t.option_type
        FROM exits e
        JOIN trades t ON t.id = e.trade_id
        WHERE e.exit_macd_hist IS NULL AND e.deleted_at IS NULL
    """).fetchall()

    for r in exits_missing:
        d = dict(r)
        date_str   = d["date"]
        underlying = d["ticker"].upper()
        opt_tk     = option_ticker(d)
        fill       = d["fill"]
        start_ts, end_ts = day_bounds(date_str)
        e_ts       = entry_ts(date_str, d["entry_time"])
        x_ts       = entry_ts(date_str, d["time"])
        sess_end   = entry_ts(date_str, DEFAULT_SESSION_END)

        macd = nearest_macd(conn, underlying, x_ts, start_ts, end_ts)
        mae, mfe, post = compute_mae_mfe(conn, opt_tk, underlying, e_ts, x_ts, fill, sess_end, d["option_type"])

        conn.execute(
            """UPDATE exits
               SET exit_macd = ?, exit_macd_signal = ?, exit_macd_hist = ?,
                   mae = ?, mfe = ?, post_exit_mfe = ?
               WHERE id = ?""",
            (macd["macd"], macd["macd_signal"], macd["macd_hist"], mae, mfe, post, d["id"]),
        )


def run_backfill():
    """Compute and store denormalized MACD/MAE/MFE for all NULL rows. Safe to re-run."""
    conn = _make_conn()
    try:
        _backfill_computed(conn)
        conn.commit()
    finally:
        conn.close()


def run_force_recompute(date: str | None = None):
    """Recompute MACD/MAE/MFE for ALL exits regardless of NULL status.
    If date is provided (YYYY-MM-DD), only recomputes exits for trades on that date."""
    from backend.compute import (
        option_ticker, entry_ts, day_bounds, nearest_macd, compute_mae_mfe, DEFAULT_SESSION_END
    )
    conn = _make_conn()
    try:
        if date:
            exits_all = conn.execute("""
                SELECT e.*, t.date, t.ticker, t.fill, t.time AS entry_time,
                       t.expiry, t.strike, t.option_type
                FROM exits e
                JOIN trades t ON t.id = e.trade_id
                WHERE e.deleted_at IS NULL AND t.date = ?
            """, (date,)).fetchall()
        else:
            exits_all = conn.execute("""
                SELECT e.*, t.date, t.ticker, t.fill, t.time AS entry_time,
                       t.expiry, t.strike, t.option_type
                FROM exits e
                JOIN trades t ON t.id = e.trade_id
                WHERE e.deleted_at IS NULL
            """).fetchall()

        for r in exits_all:
            d = dict(r)
            date_str   = d["date"]
            underlying = d["ticker"].upper()
            opt_tk     = option_ticker(d)
            fill       = d["fill"]
            start_ts, end_ts = day_bounds(date_str)
            e_ts       = entry_ts(date_str, d["entry_time"])
            x_ts       = entry_ts(date_str, d["time"])
            sess_end   = entry_ts(date_str, DEFAULT_SESSION_END)

            macd = nearest_macd(conn, underlying, x_ts, start_ts, end_ts)
            mae, mfe, post = compute_mae_mfe(conn, opt_tk, underlying, e_ts, x_ts, fill, sess_end, d["option_type"])

            conn.execute(
                """UPDATE exits
                   SET exit_macd = ?, exit_macd_signal = ?, exit_macd_hist = ?,
                       mae = ?, mfe = ?, post_exit_mfe = ?
                   WHERE id = ?""",
                (macd["macd"], macd["macd_signal"], macd["macd_hist"], mae, mfe, post, d["id"]),
            )

        conn.commit()
        return len(exits_all)
    finally:
        conn.close()


def init_db():
    """Called at startup — ensures DB is ready."""
    _run_init()
    global _initialized
    _initialized = True
