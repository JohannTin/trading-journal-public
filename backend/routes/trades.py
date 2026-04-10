from fastapi import APIRouter, HTTPException, Query
from backend.database import get_db
from backend.models import TradeCreate, TradeOut, ExitOut
from backend.compute import (
    option_ticker, entry_ts, day_bounds, nearest_macd,
    compute_mae_mfe, DEFAULT_SESSION_END
)
from typing import Any

router = APIRouter(prefix="/api/trades", tags=["trades"])


# ── Read helpers ───────────────────────────────────────────────────────────────

# Columns selected in every trade+exits JOIN query.
# Exit columns are prefixed e_ to avoid clashes with trade columns (id, time, qty…).
_JOIN_SELECT = """
    t.id, t.date, t.time, t.dte, t.ticker, t.option_type, t.strike, t.expiry,
    t.qty, t.fill, t.total_cost, t.source, t.notes, t.chart_link, t.strategy,
    t.status, t.flagged, t.account_id, t.total_pnl,
    t.entry_macd, t.entry_macd_signal, t.entry_macd_hist,
    e.id           AS e_id,
    e.trade_id     AS e_trade_id,
    e.time         AS e_time,
    e.qty          AS e_qty,
    e.price        AS e_price,
    e.pnl          AS e_pnl,
    e.pct          AS e_pct,
    e.exit_macd    AS e_exit_macd,
    e.exit_macd_signal AS e_exit_macd_signal,
    e.exit_macd_hist   AS e_exit_macd_hist,
    e.mae          AS e_mae,
    e.mfe          AS e_mfe,
    e.post_exit_mfe AS e_post_exit_mfe
"""

_JOIN_FROM = """
    FROM trades t
    LEFT JOIN exits e ON e.trade_id = t.id AND e.deleted_at IS NULL
"""


def _exit_row_to_out(r) -> ExitOut:
    d = dict(r)
    return ExitOut(
        id=d["id"],
        trade_id=d["trade_id"],
        date=d.get("date"),
        time=d["time"],
        qty=d["qty"],
        price=d["price"],
        pnl=d["pnl"],
        pct=d["pct"],
        macd=d.get("exit_macd"),
        macd_signal=d.get("exit_macd_signal"),
        macd_hist=d.get("exit_macd_hist"),
        mae=d.get("mae"),
        mfe=d.get("mfe"),
        post_exit_mfe=d.get("post_exit_mfe"),
    )


def _fetch_exits(conn, trade_id: int) -> list[ExitOut]:
    """Used for single-trade refreshes after writes."""
    rows = conn.execute(
        "SELECT * FROM exits WHERE trade_id = ? AND deleted_at IS NULL ORDER BY time",
        (trade_id,),
    ).fetchall()
    return [_exit_row_to_out(r) for r in rows]


def _row_to_trade(row, exits: list[ExitOut]) -> TradeOut:
    d = dict(row)
    return TradeOut(
        id=d["id"],
        date=d["date"],
        time=d["time"],
        dte=d.get("dte", 0),
        ticker=d["ticker"],
        option_type=d["option_type"],
        strike=d["strike"],
        expiry=d["expiry"],
        qty=d["qty"],
        fill=d["fill"],
        total_cost=d["total_cost"],
        source=d.get("source"),
        notes=d.get("notes"),
        chart_link=d.get("chart_link"),
        strategy=d.get("strategy"),
        status=d.get("status", "open"),
        flagged=bool(d.get("flagged", 0)),
        account_id=d.get("account_id"),
        total_pnl=d.get("total_pnl") or 0.0,
        entry_macd=d.get("entry_macd"),
        entry_macd_signal=d.get("entry_macd_signal"),
        entry_macd_hist=d.get("entry_macd_hist"),
        exits=exits,
    )


def _join_rows_to_trades(rows) -> list[TradeOut]:
    """
    Convert a flat JOIN result (one row per exit) into a list of TradeOut.
    Preserves the row order of trades; exits are ordered by e_time ASC.
    """
    trades: dict[int, tuple[dict, list[ExitOut]]] = {}
    order: list[int] = []

    for row in rows:
        d = dict(row)
        tid = d["id"]
        if tid not in trades:
            trades[tid] = (d, [])
            order.append(tid)
        if d["e_id"] is not None:
            trades[tid][1].append(ExitOut(
                id=d["e_id"],
                trade_id=d["e_trade_id"],
                time=d["e_time"],
                qty=d["e_qty"],
                price=d["e_price"],
                pnl=d["e_pnl"],
                pct=d["e_pct"],
                macd=d["e_exit_macd"],
                macd_signal=d["e_exit_macd_signal"],
                macd_hist=d["e_exit_macd_hist"],
                mae=d["e_mae"],
                mfe=d["e_mfe"],
                post_exit_mfe=d["e_post_exit_mfe"],
            ))

    return [_row_to_trade(trades[tid][0], trades[tid][1]) for tid in order]


# ── Write helpers ──────────────────────────────────────────────────────────────

def _store_entry_macd(conn, trade_id: int, trade_d: dict):
    """Compute and persist entry MACD for a trade."""
    start_ts, end_ts = day_bounds(trade_d["date"])
    ts = entry_ts(trade_d["date"], trade_d["time"])
    macd = nearest_macd(conn, trade_d["ticker"], ts, start_ts, end_ts)
    conn.execute(
        "UPDATE trades SET entry_macd = ?, entry_macd_signal = ?, entry_macd_hist = ? WHERE id = ?",
        (macd["macd"], macd["macd_signal"], macd["macd_hist"], trade_id),
    )


def _recompute_all_exits(conn, trade_id: int):
    """
    Recompute pnl/pct/mae/mfe/macd for every non-deleted exit on a trade.
    Called when the trade's fill, date, time, or ticker is updated.
    """
    trade = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
    if not trade:
        return
    t = dict(trade)
    underlying  = t["ticker"].upper()
    opt_tk      = option_ticker(t)
    fill        = t["fill"]
    date_str    = t["date"]
    start_ts, end_ts = day_bounds(date_str)
    e_ts        = entry_ts(date_str, t["time"])
    sess_end    = entry_ts(date_str, DEFAULT_SESSION_END)

    rows = conn.execute(
        "SELECT * FROM exits WHERE trade_id = ? AND deleted_at IS NULL", (trade_id,)
    ).fetchall()

    for r in rows:
        d = dict(r)
        x_ts = entry_ts(date_str, d["time"])
        pnl  = (d["price"] - fill) * d["qty"] * 100
        pct  = ((d["price"] - fill) / fill) * 100
        macd = nearest_macd(conn, underlying, x_ts, start_ts, end_ts)
        mae, mfe, post = compute_mae_mfe(conn, opt_tk, underlying, e_ts, x_ts, fill, sess_end, t["option_type"])
        conn.execute(
            """UPDATE exits
               SET pnl = ?, pct = ?,
                   exit_macd = ?, exit_macd_signal = ?, exit_macd_hist = ?,
                   mae = ?, mfe = ?, post_exit_mfe = ?
               WHERE id = ?""",
            (round(pnl, 2), round(pct, 2),
             macd["macd"], macd["macd_signal"], macd["macd_hist"],
             mae, mfe, post, d["id"]),
        )

    # Update trade total_pnl
    total = conn.execute(
        "SELECT COALESCE(SUM(pnl), 0) FROM exits WHERE trade_id = ? AND deleted_at IS NULL",
        (trade_id,),
    ).fetchone()[0]
    conn.execute("UPDATE trades SET total_pnl = ? WHERE id = ?", (round(total, 2), trade_id))


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", response_model=TradeOut, status_code=201)
def create_trade(payload: TradeCreate):
    conn = get_db()
    try:
        account_id = payload.account_id
        if account_id is None:
            row = conn.execute("SELECT id FROM accounts ORDER BY id LIMIT 1").fetchone()
            if row:
                account_id = row[0]
        cur = conn.execute(
            """INSERT INTO trades
               (date, time, dte, ticker, option_type, strike, expiry,
                qty, fill, total_cost, source, notes, chart_link, strategy, account_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                payload.date, payload.time, payload.dte, payload.ticker,
                payload.option_type, payload.strike, payload.expiry,
                payload.qty, payload.fill, payload.total_cost,
                payload.source, payload.notes, payload.chart_link, payload.strategy,
                account_id,
            ),
        )
        trade_id = cur.lastrowid
        conn.commit()

        row = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
        _store_entry_macd(conn, trade_id, dict(row))
        conn.commit()

        row = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
        return _row_to_trade(row, [])
    finally:
        conn.close()


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[TradeOut])
def list_trades(
    status: str | None = None,
    account_id: int | None = Query(None),
    session_end: str = Query("15:30"),  # kept for API compat; stored values use 15:30
):
    conn = get_db()
    try:
        conditions = ["t.deleted_at IS NULL"]
        params = []
        if status:
            conditions.append("t.status = ?")
            params.append(status)
        if account_id is not None:
            conditions.append("t.account_id = ?")
            params.append(account_id)
        where = "WHERE " + " AND ".join(conditions)
        rows = conn.execute(
            f"SELECT {_JOIN_SELECT} {_JOIN_FROM} {where}"
            f" ORDER BY t.date DESC, t.time DESC, e.time ASC",
            params,
        ).fetchall()
        return _join_rows_to_trades(rows)
    finally:
        conn.close()


# ── Deleted (bin) — must be registered BEFORE /{trade_id} ────────────────────

@router.get("/deleted")
def list_deleted_trades(account_id: int | None = Query(None)):
    conn = get_db()
    try:
        conditions = ["deleted_at IS NOT NULL"]
        params = []
        if account_id is not None:
            conditions.append("account_id = ?")
            params.append(account_id)
        where = "WHERE " + " AND ".join(conditions)
        rows = conn.execute(
            f"SELECT id, date, time, ticker, option_type, strike, expiry, qty, fill, "
            f"strategy, status, account_id, deleted_at, total_pnl FROM trades {where} ORDER BY deleted_at DESC",
            params,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Get one ───────────────────────────────────────────────────────────────────

@router.get("/{trade_id}", response_model=TradeOut)
def get_trade(trade_id: int, session_end: str = Query("15:30")):
    conn = get_db()
    try:
        rows = conn.execute(
            f"SELECT {_JOIN_SELECT} {_JOIN_FROM}"
            f" WHERE t.id = ? AND t.deleted_at IS NULL ORDER BY e.time ASC",
            (trade_id,),
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="Trade not found")
        result = _join_rows_to_trades(rows)
        return result[0]
    finally:
        conn.close()


# ── Update ────────────────────────────────────────────────────────────────────

@router.patch("/{trade_id}", response_model=TradeOut)
def update_trade(trade_id: int, payload: dict[str, Any]):
    allowed = {"notes", "source", "chart_link", "strategy", "status", "flagged",
               "date", "time", "dte", "ticker", "option_type",
               "strike", "expiry", "qty", "fill", "total_cost", "account_id"}
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    conn = get_db()
    try:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(
            f"UPDATE trades SET {set_clause} WHERE id = ?",
            (*updates.values(), trade_id),
        )
        conn.commit()

        row = conn.execute(
            "SELECT * FROM trades WHERE id = ? AND deleted_at IS NULL", (trade_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Trade not found")

        # Recompute entry MACD if time-related fields changed
        if any(k in updates for k in ("date", "time", "ticker")):
            _store_entry_macd(conn, trade_id, dict(row))

        # Recompute all exit pnl/stats if fill or date/time/ticker changed
        if any(k in updates for k in ("fill", "date", "time", "ticker")):
            _recompute_all_exits(conn, trade_id)

        conn.commit()
        row = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
        return _row_to_trade(row, _fetch_exits(conn, trade_id))
    finally:
        conn.close()


@router.patch("/{trade_id}/restore", status_code=204)
def restore_trade(trade_id: int):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM trades WHERE id = ? AND deleted_at IS NOT NULL", (trade_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Deleted trade not found")
        conn.execute("UPDATE trades SET deleted_at = NULL WHERE id = ?", (trade_id,))
        conn.execute("UPDATE exits SET deleted_at = NULL WHERE trade_id = ?", (trade_id,))
        # Recompute total_pnl now that exits are restored
        total = conn.execute(
            "SELECT COALESCE(SUM(pnl), 0) FROM exits WHERE trade_id = ? AND deleted_at IS NULL",
            (trade_id,),
        ).fetchone()[0]
        conn.execute("UPDATE trades SET total_pnl = ? WHERE id = ?", (round(total, 2), trade_id))
        conn.commit()
    finally:
        conn.close()


@router.delete("/{trade_id}/permanent", status_code=204)
def permanent_delete_trade(trade_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM exits WHERE trade_id = ?", (trade_id,))
        conn.execute("DELETE FROM trades WHERE id = ?", (trade_id,))
        conn.commit()
    finally:
        conn.close()


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{trade_id}", status_code=204)
def delete_trade(trade_id: int):
    conn = get_db()
    try:
        conn.execute(
            "UPDATE trades SET deleted_at = datetime('now') WHERE id = ?", (trade_id,)
        )
        conn.execute(
            "UPDATE exits SET deleted_at = datetime('now') WHERE trade_id = ?", (trade_id,)
        )
        conn.commit()
    finally:
        conn.close()
