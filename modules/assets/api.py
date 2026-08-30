"""Vermögens-API (Blueprint). Operiert immer auf der aktiven DB.

/state liefert den kompletten, serientauglichen Zustand: Klassen (Besitz/Schuld)
mit Positionen und Anteilen, Gesamt-/Nettowerte, Aufteilung und Kennzahlen –
inkl. Notgroschen-Reichweite. Die monatlichen Ausgaben kommen aus EINER Quelle
(Ledger build_summary), damit nicht doppelt gerechnet wird.
"""
from contextlib import contextmanager

from flask import Blueprint, jsonify, request

from core import auth, db
from modules.ledger import calc as ledger_calc, repo as ledger_repo
from modules.assets import calc, repo

bp = Blueprint("assets", __name__, url_prefix="/api/assets")


@contextmanager
def _conn():
    c = db.connect(db.active_db())
    try:
        yield c
    finally:
        c.close()


def _err(msg, code=400):
    return jsonify({"error": msg}), code


def _monthly_expenses(conn):
    """Monatliche Gesamtkosten aus dem Ledger (eine Quelle der Wahrheit)."""
    cats = ledger_repo.list_categories(conn)
    posten = ledger_repo.list_posten(conn)
    summary = ledger_calc.build_summary(cats, posten)
    return summary["totals"]["kosten"]["monthly"]


@bp.get("/state")
@auth.login_required
def state():
    with _conn() as c:
        classes = repo.list_classes(c)
        positions = repo.list_positions(c)
        expenses = _monthly_expenses(c)
    return jsonify(calc.compute_assets(classes, positions, expenses))


# ---- Klassen --------------------------------------------------------------
@bp.post("/class")
@auth.login_required
def add_class():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            cid = repo.add_class(c, d)
    except (ValueError, KeyError) as e:
        return _err(str(e) if str(e) else "Ungültige Eingabe.")
    return jsonify({"ok": True, "id": cid})


@bp.patch("/class/<int:cid>")
@auth.login_required
def patch_class(cid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_class(c, cid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.delete("/class/<int:cid>")
@auth.login_required
def del_class(cid):
    try:
        with _conn() as c:
            repo.delete_class(c, cid)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.post("/class/reorder")
@auth.login_required
def reorder_class():
    d = request.get_json(silent=True) or {}
    with _conn() as c:
        repo.reorder_classes(c, d.get("ids", []))
    return jsonify({"ok": True})


# ---- Positionen -----------------------------------------------------------
@bp.post("/position")
@auth.login_required
def add_position():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            pid = repo.add_position(c, d)
    except (ValueError, KeyError) as e:
        return _err(str(e) if str(e) else "Ungültige Eingabe.")
    return jsonify({"ok": True, "id": pid})


@bp.patch("/position/<int:pid>")
@auth.login_required
def patch_position(pid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_position(c, pid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.delete("/position/<int:pid>")
@auth.login_required
def del_position(pid):
    with _conn() as c:
        repo.delete_position(c, pid)
    return jsonify({"ok": True})


@bp.post("/position/reorder")
@auth.login_required
def reorder_position():
    d = request.get_json(silent=True) or {}
    with _conn() as c:
        repo.reorder_positions(c, d.get("ids", []))
    return jsonify({"ok": True})
