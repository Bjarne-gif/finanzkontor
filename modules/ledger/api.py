"""Ledger-API (Blueprint). Operiert immer auf der aktiven DB."""
from contextlib import contextmanager

from flask import Blueprint, jsonify, request

from core import auth, db
from modules.ledger import calc, repo

bp = Blueprint("ledger", __name__, url_prefix="/api/ledger")


@contextmanager
def _conn():
    c = db.connect(db.active_db())
    try:
        yield c
    finally:
        c.close()


def _err(msg, code=400):
    return jsonify({"error": msg}), code


@bp.get("/state")
@auth.login_required
def state():
    with _conn() as c:
        cats = repo.list_categories(c)
        posten = repo.list_posten(c)
    return jsonify(calc.build_summary(cats, posten))


# ---- Kategorien ----
@bp.post("/category")
@auth.login_required
def add_category():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            cid = repo.add_category(c, d.get("kind"), d.get("name"), d.get("color"))
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True, "id": cid})


@bp.patch("/category/<int:cid>")
@auth.login_required
def patch_category(cid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_category(c, cid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.delete("/category/<int:cid>")
@auth.login_required
def del_category(cid):
    try:
        with _conn() as c:
            repo.delete_category(c, cid)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.post("/category/reorder")
@auth.login_required
def reorder_category():
    d = request.get_json(silent=True) or {}
    with _conn() as c:
        repo.reorder_categories(c, d.get("ids", []))
    return jsonify({"ok": True})


# ---- Posten ----
@bp.post("/posten")
@auth.login_required
def add_posten():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            pid = repo.add_posten(c, d)
    except (ValueError, KeyError) as e:
        return _err(str(e) if str(e) else "Ungültige Eingabe.")
    return jsonify({"ok": True, "id": pid})


@bp.patch("/posten/<int:pid>")
@auth.login_required
def patch_posten(pid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_posten(c, pid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.delete("/posten/<int:pid>")
@auth.login_required
def del_posten(pid):
    with _conn() as c:
        repo.delete_posten(c, pid)
    return jsonify({"ok": True})


@bp.post("/posten/reorder")
@auth.login_required
def reorder_posten():
    d = request.get_json(silent=True) or {}
    with _conn() as c:
        repo.reorder_posten(c, d.get("ids", []))
    return jsonify({"ok": True})
