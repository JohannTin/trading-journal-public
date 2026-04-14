from fastapi import APIRouter, Query
from typing import Optional
from backend.database import get_db
from backend.models import DayStats, OverallStats

router = APIRouter(prefix="/api/stats", tags=["stats"])


# ── Calendar ──────────────────────────────────────────────────────────────────

@router.get("/calendar", response_model=list[DayStats])
def calendar_stats(account_id: Optional[int] = Query(None)):
    conn = get_db()
    try:
        acct_filter = "AND t.account_id = ?" if account_id is not None else ""
        acct_param  = (account_id,) if account_id is not None else ()
        # P&L grouped by exit date (COALESCE(e.date, t.date) so same-day exits fall on entry date)
        rows = conn.execute(f"""
            SELECT
                COALESCE(e.date, t.date)                           AS date,
                COALESCE(SUM(e.pnl), 0)                           AS total_pnl,
                COUNT(DISTINCT CASE
                    WHEN t.status = 'closed'
                     AND last_exit.last_exit_date = COALESCE(e.date, t.date) THEN t.id
                END)                                               AS trade_count,
                COUNT(DISTINCT CASE
                    WHEN t.status = 'closed'
                     AND last_exit.last_exit_date = COALESCE(e.date, t.date)
                     AND sub.trade_pnl > 0 THEN t.id
                END)                                               AS win_count,
                COUNT(DISTINCT CASE
                    WHEN t.status = 'closed'
                     AND last_exit.last_exit_date = COALESCE(e.date, t.date)
                     AND sub.trade_pnl <= 0 THEN t.id
                END)                                               AS loss_count,
                AVG(CASE
                    WHEN t.status = 'closed'
                     AND last_exit.last_exit_date = COALESCE(e.date, t.date)
                     AND sub.trade_pnl > 0 THEN sub.trade_pnl
                END)                                               AS avg_win_pnl,
                AVG(CASE
                    WHEN t.status = 'closed'
                     AND last_exit.last_exit_date = COALESCE(e.date, t.date)
                     AND sub.trade_pnl <= 0 THEN sub.trade_pnl
                END)                                               AS avg_loss_pnl
            FROM trades t
            JOIN exits e ON e.trade_id = t.id AND e.deleted_at IS NULL
            LEFT JOIN (
                SELECT trade_id, SUM(pnl) AS trade_pnl
                FROM exits WHERE deleted_at IS NULL GROUP BY trade_id
            ) sub ON sub.trade_id = t.id
            LEFT JOIN (
                SELECT e2.trade_id, MAX(COALESCE(e2.date, t2.date)) AS last_exit_date
                FROM exits e2
                JOIN trades t2 ON t2.id = e2.trade_id
                WHERE e2.deleted_at IS NULL
                GROUP BY e2.trade_id
            ) last_exit ON last_exit.trade_id = t.id
            WHERE t.deleted_at IS NULL {acct_filter}
            GROUP BY COALESCE(e.date, t.date)
            ORDER BY COALESCE(e.date, t.date) DESC
        """, acct_param).fetchall()

        result = []
        for r in rows:
            d = dict(r)
            closed = d["win_count"] + d["loss_count"]
            win_rate = (d["win_count"] / closed * 100) if closed > 0 else 0.0

            avg_win  = d["avg_win_pnl"]  or 0.0
            avg_loss = d["avg_loss_pnl"] or 0.0
            # R:R = avg win / abs(avg loss); 0 if no losses or no wins
            if avg_loss != 0 and avg_win != 0:
                avg_rr = avg_win / abs(avg_loss)
            else:
                avg_rr = 0.0

            result.append(DayStats(
                date=d["date"],
                total_pnl=round(d["total_pnl"], 2),
                trade_count=d["trade_count"],
                win_count=d["win_count"],
                loss_count=d["loss_count"],
                win_rate=round(win_rate, 1),
                avg_rr=round(avg_rr, 2),
            ))
        return result
    finally:
        conn.close()


# ── Overall stats ─────────────────────────────────────────────────────────────

@router.get("/strategies")
def list_strategies(account_id: Optional[int] = Query(None)):
    conn = get_db()
    try:
        if account_id is not None:
            rows = conn.execute(
                "SELECT DISTINCT strategy FROM trades WHERE strategy IS NOT NULL AND strategy != '' AND account_id = ? ORDER BY strategy",
                (account_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT DISTINCT strategy FROM trades WHERE strategy IS NOT NULL AND strategy != '' ORDER BY strategy"
            ).fetchall()
        return [r["strategy"] for r in rows]
    finally:
        conn.close()


@router.get("/overview", response_model=OverallStats)
def overview_stats(
    strategy: Optional[str] = Query(None),
    account_id: Optional[int] = Query(None),
    overtrade_multiplier: float = Query(1.5),
):
    conn = get_db()
    try:
        # Build WHERE fragments (uses denormalized total_pnl — no exits join needed)
        conds = ["deleted_at IS NULL"]
        params: list = []
        if strategy:
            conds.append("strategy = ?")
            params.append(strategy)
        if account_id is not None:
            conds.append("account_id = ?")
            params.append(account_id)
        where = "WHERE " + " AND ".join(conds)

        # ── Query 1: all trade-level aggregates in one pass ──────────────────
        row = conn.execute(f"""
            SELECT
                COUNT(*)                                                        AS trade_count,
                COUNT(*) FILTER (WHERE status = 'closed')                       AS closed_count,
                COALESCE(SUM(total_pnl), 0)                                     AS total_pnl,
                AVG(CASE WHEN status='closed' AND total_pnl > 0
                         THEN total_pnl END)                                    AS avg_win,
                AVG(CASE WHEN status='closed' AND total_pnl <= 0
                         THEN total_pnl END)                                    AS avg_loss,
                COALESCE(SUM(CASE WHEN status='closed' AND total_pnl > 0
                         THEN total_pnl ELSE 0 END), 0)                         AS gross_win,
                COALESCE(SUM(CASE WHEN status='closed' AND total_pnl <= 0
                         THEN ABS(total_pnl) ELSE 0 END), 0)                   AS gross_loss,
                COUNT(*) FILTER (WHERE status='closed' AND total_pnl > 0)       AS win_count
            FROM trades {where}
        """, params).fetchone()

        d = dict(row)
        closed_count  = d["closed_count"]
        trade_count   = d["trade_count"]
        win_count     = d["win_count"]
        total_pnl     = d["total_pnl"]
        avg_win       = d["avg_win"]  or 0.0
        avg_loss      = d["avg_loss"] or 0.0
        gross_win     = d["gross_win"]
        gross_loss    = d["gross_loss"]
        win_rate      = (win_count / closed_count * 100) if closed_count else 0.0
        profit_factor = (gross_win / gross_loss)         if gross_loss   else 0.0

        # ── Query 2: daily trade counts for overtrading detection ────────────
        daily_counts = conn.execute(
            f"SELECT date, COUNT(*) AS cnt FROM trades {where} GROUP BY date",
            params,
        ).fetchall()

        if daily_counts:
            avg_per_day    = sum(r["cnt"] for r in daily_counts) / len(daily_counts)
            threshold      = avg_per_day * overtrade_multiplier
            high_freq_days = [r["date"] for r in daily_counts if r["cnt"] >= threshold]
        else:
            avg_per_day    = 0.0
            high_freq_days = []

        return OverallStats(
            total_pnl=round(total_pnl, 2),
            win_rate=round(win_rate, 1),
            avg_win=round(avg_win, 2),
            avg_loss=round(avg_loss, 2),
            profit_factor=round(profit_factor, 2),
            trade_count=trade_count,
            closed_count=closed_count,
            open_count=trade_count - closed_count,
            avg_trades_per_day=round(avg_per_day, 1),
            high_freq_days=high_freq_days,
        )
    finally:
        conn.close()
