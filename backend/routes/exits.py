from fastapi import APIRouter, HTTPException
from backend.database import get_db
from backend.models import ExitCreate, ExitOut
from backend.compute import (
    option_ticker, entry_ts, day_bounds, nearest_macd,
    compute_mae_mfe, DEFAULT_SESSION_END
)
from backend.routes.trades import _exit_row_to_out
from typing import Any

router = APIRouter(prefix="/api/exits", tags=["exits"])


def _update_trade_pnl(conn, trade_id: int):
    total = conn.execute(
        "SELECT COALESCE(SUM(pnl), 0) FROM exits WHERE trade_id = ? AND deleted_at IS NULL",
        (trade_id,),
    ).fetchone()[0]
    conn.execute("UPDATE trades SET total_pnl = ? WHERE id = ?", (round(total, 2), trade_id))


def _auto_close(conn, trade_id: int):
    trade = conn.execute("SELECT qty FROM trades WHERE id = ?", (trade_id,)).fetchone()
    if not trade:
        return
    exited = conn.execute(
        "SELECT COALESCE(SUM(qty), 0) as total FROM exits WHERE trade_id = ? AND deleted_at IS NULL",
        (trade_id,),
    ).fetchone()["total"]
    if exited >= trade["qty"]:
        conn.execute("UPDATE trades SET status = 'closed' WHERE id = ?", (trade_id,))
    else:
        conn.execute("UPDATE trades SET status = 'open' WHERE id = ?", (trade_id,))


def _store_exit_stats(conn, exit_id: int, exit_time: str, trade_d: dict, exit_date: str | None = None):
    """Compute and persist exit MACD + MAE/MFE for a single exit."""
    entry_date = trade_d["date"]
    x_date     = exit_date or entry_date
    underlying = trade_d["ticker"].upper()
    opt_tk     = option_ticker(trade_d)
    fill       = trade_d["fill"]
    start_ts, end_ts = day_bounds(x_date)
    e_ts       = entry_ts(entry_date, trade_d["time"])
    x_ts       = entry_ts(x_date, exit_time)
    sess_end   = entry_ts(x_date, DEFAULT_SESSION_END)

    macd = nearest_macd(conn, underlying, x_ts, start_ts, end_ts)
    mae, mfe, post = compute_mae_mfe(conn, opt_tk, underlying, e_ts, x_ts, fill, sess_end, trade_d["option_type"])

    conn.execute(
        """UPDATE exits
           SET exit_macd = ?, exit_macd_signal = ?, exit_macd_hist = ?,
               mae = ?, mfe = ?, post_exit_mfe = ?
           WHERE id = ?""",
        (macd["macd"], macd["macd_signal"], macd["macd_hist"], mae, mfe, post, exit_id),
    )


# ── Add exit ──────────────────────────────────────────────────────────────────

@router.post("", response_model=ExitOut, status_code=201)
def add_exit(payload: ExitCreate):
    conn = get_db()
    try:
        trade = conn.execute(
            "SELECT * FROM trades WHERE id = ?", (payload.trade_id,)
        ).fetchone()
        if not trade:
            raise HTTPException(status_code=404, detail="Trade not found")

        trade_d = dict(trade)
        already_exited = conn.execute(
            "SELECT COALESCE(SUM(qty), 0) as total FROM exits WHERE trade_id = ? AND deleted_at IS NULL",
            (payload.trade_id,),
        ).fetchone()["total"]

        remaining = trade_d["qty"] - already_exited
        if payload.qty > remaining:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot exit {payload.qty} contracts — only {remaining} remaining",
            )

        pnl = (payload.price - trade_d["fill"]) * payload.qty * 100
        pct = ((payload.price - trade_d["fill"]) / trade_d["fill"]) * 100

        exit_date = payload.date or None
        cur = conn.execute(
            "INSERT INTO exits (trade_id, date, time, qty, price, pnl, pct) VALUES (?,?,?,?,?,?,?)",
            (payload.trade_id, exit_date, payload.time, payload.qty, payload.price,
             round(pnl, 2), round(pct, 2)),
        )
        exit_id = cur.lastrowid
        conn.commit()

        _store_exit_stats(conn, exit_id, payload.time, trade_d, exit_date)
        _update_trade_pnl(conn, payload.trade_id)
        _auto_close(conn, payload.trade_id)
        conn.commit()

        row = conn.execute("SELECT * FROM exits WHERE id = ?", (exit_id,)).fetchone()
        return _exit_row_to_out(row)
    finally:
        conn.close()


# ── Edit exit ─────────────────────────────────────────────────────────────────

@router.patch("/{exit_id}", response_model=ExitOut)
def update_exit(exit_id: int, payload: dict[str, Any]):
    conn = get_db()
    try:
        exit_row = conn.execute(
            "SELECT * FROM exits WHERE id = ?", (exit_id,)
        ).fetchone()
        if not exit_row:
            raise HTTPException(status_code=404, detail="Exit not found")

        trade = conn.execute(
            "SELECT * FROM trades WHERE id = ?", (exit_row["trade_id"],)
        ).fetchone()
        trade_d = dict(trade)

        new_qty   = int(payload.get("qty",   exit_row["qty"]))
        new_price = float(payload.get("price", exit_row["price"]))
        new_time  = payload.get("time", exit_row["time"])
        new_date  = payload.get("date", exit_row["date"]) or None

        other_exited = conn.execute(
            "SELECT COALESCE(SUM(qty), 0) as total FROM exits WHERE trade_id = ? AND id != ? AND deleted_at IS NULL",
            (exit_row["trade_id"], exit_id),
        ).fetchone()["total"]

        remaining = trade_d["qty"] - other_exited
        if new_qty > remaining:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot set qty to {new_qty} — only {remaining} contracts available",
            )

        pnl = (new_price - trade_d["fill"]) * new_qty * 100
        pct = ((new_price - trade_d["fill"]) / trade_d["fill"]) * 100

        conn.execute(
            "UPDATE exits SET date = ?, time = ?, qty = ?, price = ?, pnl = ?, pct = ? WHERE id = ?",
            (new_date, new_time, new_qty, new_price, round(pnl, 2), round(pct, 2), exit_id),
        )
        conn.commit()

        _store_exit_stats(conn, exit_id, new_time, trade_d, new_date)
        _update_trade_pnl(conn, exit_row["trade_id"])
        _auto_close(conn, exit_row["trade_id"])
        conn.commit()

        row = conn.execute("SELECT * FROM exits WHERE id = ?", (exit_id,)).fetchone()
        return _exit_row_to_out(row)
    finally:
        conn.close()


# ── Delete exit ───────────────────────────────────────────────────────────────

@router.delete("/{exit_id}", status_code=204)
def delete_exit(exit_id: int):
    conn = get_db()
    try:
        exit_row = conn.execute(
            "SELECT trade_id FROM exits WHERE id = ? AND deleted_at IS NULL", (exit_id,)
        ).fetchone()
        if not exit_row:
            raise HTTPException(status_code=404, detail="Exit not found")
        trade_id = exit_row["trade_id"]
        conn.execute(
            "UPDATE exits SET deleted_at = datetime('now') WHERE id = ?", (exit_id,)
        )
        conn.commit()
        _update_trade_pnl(conn, trade_id)
        _auto_close(conn, trade_id)
        conn.commit()
    finally:
        conn.close()
