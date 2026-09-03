"""Verträge-API (Blueprint). Operiert immer auf der aktiven DB.

/state fügt die Vertragsprofile mit ihren Ledger-Posten zusammen und liefert den
serientauglichen Zustand + Kennzahlen (nächste Kündigungsfrist, Handlungsbedarf,
Kosten, Bestand, Sparpotenzial). Betrag, Intervall und Kategorie kommen aus EINER
Quelle (Ledger), werden hier also nicht dupliziert.

Datei-Upload/-Auslieferung für den PDF-Viewer folgt im nächsten Schritt.
"""
import os
from contextlib import contextmanager
from urllib.parse import quote

from flask import Blueprint, jsonify, make_response, request

from core import auth, db
from modules.ledger import repo as ledger_repo
from modules.contracts import calc, repo, storage

bp = Blueprint("contracts", __name__, url_prefix="/api/contracts")


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
        calc.auto_reactivate(c)  # abgelaufene Pausen reaktivieren
        posten = {p["id"]: p for p in ledger_repo.list_posten(c)}
        categories = repo.list_categories(c)
        contracts = repo.list_contracts(c)
        storage.cleanup_orphans(repo.all_stored_names(c))
    return jsonify(calc.compute_contracts(posten, categories, contracts))


@bp.get("/linkable")
@auth.login_required
def linkable():
    """Kosten-Posten, die noch KEINEN Vertrag tragen – für die Neuanlage."""
    with _conn() as c:
        cats = {cat["id"]: cat for cat in ledger_repo.list_categories(c)}
        taken = {ct["posten_id"] for ct in repo.list_contracts(c)}
        out = []
        for p in ledger_repo.list_posten(c):
            cat = cats.get(p["category_id"])
            if not cat or cat["kind"] != "expense" or p["id"] in taken:
                continue
            out.append({"id": p["id"], "name": p["name"], "amount": p["amount"],
                        "interval": p["interval"], "category": cat["name"]})
    return jsonify({"posten": out})


@bp.post("/contract")
@auth.login_required
def add_contract():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            cid = repo.add_contract(c, d)
    except (ValueError, KeyError) as e:
        return _err(str(e) if str(e) else "Ungültige Eingabe.")
    return jsonify({"ok": True, "id": cid})


@bp.patch("/contract/<int:cid>")
@auth.login_required
def patch_contract(cid):
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_contract(c, cid, d)
    except ValueError as e:
        return _err(str(e))
    return jsonify({"ok": True})


@bp.post("/contract/reorder")
@auth.login_required
def reorder_contracts():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    with _conn() as c:
        repo.reorder_contracts(c, ids)
    return jsonify({"ok": True})


@bp.delete("/contract/<int:cid>")
@auth.login_required
def del_contract(cid):
    with _conn() as c:
        repo.delete_contract(c, cid)
    return jsonify({"ok": True})


# ---- Vertragskategorien (wie asset_classes) -------------------------------
@bp.post("/category")
@auth.login_required
def add_category():
    d = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            cid = repo.add_category(c, d)
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
def reorder_categories():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    with _conn() as c:
        repo.reorder_categories(c, ids)
    return jsonify({"ok": True})


# ---- Dokumente (verschlüsselt auf dem Pi) ---------------------------------
@bp.post("/contract/<int:cid>/doc")
@auth.login_required
def upload_doc(cid):
    f = request.files.get("file")
    if not f or not f.filename:
        return _err("Keine Datei erhalten.")
    name = os.path.basename(f.filename)
    if not storage.is_allowed(name):
        return _err("Dateityp nicht erlaubt (PDF, Bild, Office-Dokument, Text).")
    data = f.read()
    if len(data) == 0:
        return _err("Datei ist leer.")
    if len(data) > storage.MAX_BYTES:
        return _err("Datei zu groß (max. 15 MB).")
    try:
        with _conn() as c:
            stored = storage.save(data)
            try:
                did = repo.add_doc(c, cid, name, stored, len(data))
            except ValueError as e:
                storage.delete(stored)  # verwaiste Datei aufräumen
                return _err(str(e))
    except Exception:
        return _err("Speichern fehlgeschlagen.", 500)
    return jsonify({"ok": True, "id": did, "filename": name, "size": len(data)})


@bp.get("/doc/<int:doc_id>")
@auth.login_required
def get_doc(doc_id):
    with _conn() as c:
        doc = repo.get_doc(c, doc_id)
    if not doc:
        return _err("Dokument nicht gefunden.", 404)
    try:
        data = storage.read(doc["stored_name"])
    except FileNotFoundError:
        return _err("Datei fehlt auf der Platte.", 404)
    mimetype, inline = storage.content_info(doc["filename"])
    resp = make_response(data)
    resp.headers["Content-Type"] = mimetype
    disp = "inline" if inline else "attachment"
    fallback = doc["filename"].encode("ascii", "ignore").decode() or "dokument"
    resp.headers["Content-Disposition"] = (
        f"{disp}; filename=\"{fallback}\"; "
        f"filename*=UTF-8''{quote(doc['filename'])}")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@bp.delete("/doc/<int:doc_id>")
@auth.login_required
def delete_doc(doc_id):
    with _conn() as c:
        stored = repo.delete_doc(c, doc_id)
    storage.delete(stored)
    return jsonify({"ok": True})
