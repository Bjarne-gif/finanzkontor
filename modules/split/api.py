"""Aufteilungs-API (Blueprint). Operiert immer auf der aktiven DB.

/state liefert den kompletten, serientauglichen Zustand: den aus dem Ledger
berechneten Überschuss, die Töpfe mit ihren verteilten Beträgen und das Übrig –
alles monatlich UND jährlich. So ist der Baustein für Auswertungen/KI direkt
abfragbar, ohne dass das Frontend rechnen muss.
"""
from contextlib import contextmanager

from flask import Blueprint, jsonify, request

from core import auth, db
from modules.ledger import calc as ledger_calc, repo as ledger_repo
from modules.split import calc, repo

bp = Blueprint("split", __name__, url_prefix="/api/split")


@contextmanager
def _conn():
    c = db.connect(db.active_db())
    try:
        yield c
    finally:
        c.close()


def _err(msg, code=400):
    return jsonify({"error": msg}), code


def _ueberschuss(conn):
    """Monatlichen Überschuss aus dem Ledger holen (eine Quelle der Wahrheit)."""
    cats = ledger_repo.list_categories(conn)
    posten = ledger_repo.list_posten(conn)
    summary = ledger_calc.build_summary(cats, posten)
    return summary["totals"]["ueberschuss"]["monthly"]


@bp.get("/state")
@auth.login_required
def state():
    with _conn() as c:
        pots = repo.list_pots(c)
        us_m = _ueberschuss(c)
    return jsonify(calc.compute_split(us_m, pots))


@bp.post("/pot")
@auth.login_required
def add_pot():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            pid = repo.add_pot(c, d)
    except (ValueError, KeyError) as e:
        return _err(str(e) if str(e) else "Ungültige Eingabe.")
    return jsonify({"ok": True, "id": pid})


@bp.patch("/pot/<int:pid>")
@auth.login_required
def patch_pot(pid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_pot(c, pid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.delete("/pot/<int:pid>")
@auth.login_required
def del_pot(pid):
    with _conn() as c:
        repo.delete_pot(c, pid)
    return jsonify({"ok": True})


@bp.post("/pot/reorder")
@auth.login_required
def reorder_pot():
    d = request.get_json(silent=True) or {}
    with _conn() as c:
        repo.reorder_pots(c, d.get("ids", []))
    return jsonify({"ok": True})
