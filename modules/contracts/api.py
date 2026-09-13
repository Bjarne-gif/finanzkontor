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
        result = calc.compute_contracts(posten, categories, contracts)
        result["partners"] = repo.partner_options(c)
        result["linkable"] = repo.list_linkable(c)
        # KEIN automatisches cleanup_orphans mehr: mehrere DBs teilen sich EINEN
        # docs-Ordner, aber all_stored_names(c) kennt nur die aktive DB -> es löschte
        # die Dateien aller anderen DBs. Aufräumen läuft jetzt nur noch gezielt beim
        # expliziten Löschen (delete_doc / Vertrag entfernen).
    return jsonify(result)


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


# ---- Dateiverwaltung (alle Dokumente der aktiven DB) ---------------------
@bp.get("/docs")
@auth.login_required
def list_docs_all():
    """Alle Dokumente der aktiven DB + Verträge (auch leere) + Kategorien für die Gruppierung."""
    with _conn() as c:
        return jsonify({
            "docs": repo.list_all_docs(c),
            "contracts": repo.list_contracts_brief(c),
            "categories": repo.list_categories(c),
            "db": db.active_db(),
        })


@bp.patch("/doc/<int:doc_id>")
@auth.login_required
def patch_doc(doc_id):
    """Umbenennen (filename) und/oder Umhängen (contract_id=None => verwaist)."""
    data = request.get_json(silent=True) or {}
    with _conn() as c:
        if not repo.get_doc(c, doc_id):
            return _err("Dokument nicht gefunden.", 404)
        if "filename" in data:
            repo.rename_doc(c, doc_id, data.get("filename"))
        if "contract_id" in data:
            try:
                cid = data.get("contract_id")
                repo.move_doc(c, doc_id, int(cid) if cid is not None else None)
            except ValueError as e:
                return _err(str(e))
    return jsonify({"ok": True})


@bp.post("/docs/reorder")
@auth.login_required
def reorder_docs_ep():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    with _conn() as c:
        repo.reorder_docs(c, ids)
    return jsonify({"ok": True})


@bp.get("/doc/<int:doc_id>/download")
@auth.login_required
def download_doc(doc_id):
    with _conn() as c:
        doc = repo.get_doc(c, doc_id)
    if not doc:
        return _err("Dokument nicht gefunden.", 404)
    try:
        data = storage.read(doc["stored_name"])
    except FileNotFoundError:
        return _err("Datei fehlt auf der Platte.", 404)
    resp = make_response(data)
    resp.headers["Content-Type"] = "application/octet-stream"
    fallback = doc["filename"].encode("ascii", "ignore").decode() or "dokument"
    resp.headers["Content-Disposition"] = (
        f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(doc['filename'])}")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@bp.get("/docs/zip")
@auth.login_required
def docs_zip():
    """Alle Dokumente der aktiven DB als ZIP (Original-Dateinamen, Konflikte nummeriert)."""
    import io
    import zipfile
    with _conn() as c:
        docs = repo.list_all_docs(c)
    buf = io.BytesIO()
    seen = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d in docs:
            try:
                data = storage.read(d["stored_name"])
            except FileNotFoundError:
                continue
            name = (d["filename"] or "dokument").replace("/", "_").replace("\\", "_")
            if name in seen:
                seen[name] += 1
                base, dot, ext = name.rpartition(".")
                name = f"{base or name} ({seen[name]}){dot + ext if dot else ''}"
            else:
                seen[name] = 0
            z.writestr(name, data)
    buf.seek(0)
    resp = make_response(buf.read())
    resp.headers["Content-Type"] = "application/zip"
    resp.headers["Content-Disposition"] = 'attachment; filename="dokumente.zip"'
    return resp


@bp.delete("/docs/orphans")
@auth.login_required
def delete_orphans():
    """Alle verwaisten Dokumente (ohne Vertrag) endgültig löschen."""
    with _conn() as c:
        names = repo.delete_orphan_docs(c)
    for n in names:
        storage.delete(n)
    return jsonify({"ok": True, "deleted": len(names)})


# ==== Vertragspartner-API ==================================================
@bp.get("/partners")
@auth.login_required
def partners():
    with _conn() as c:
        return jsonify({"partners": repo.list_partners(c), "suggest": repo.partner_suggest(c)})


@bp.post("/partner")
@auth.login_required
def add_partner():
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            pid = repo.add_partner(c, data)
        return jsonify({"id": pid})
    except ValueError as e:
        return _err(str(e))


@bp.patch("/partner/<int:pid>")
@auth.login_required
def patch_partner(pid):
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_partner(c, pid, data)
        return jsonify({"ok": True})
    except ValueError as e:
        return _err(str(e))


@bp.delete("/partner/<int:pid>")
@auth.login_required
def delete_partner(pid):
    with _conn() as c:
        repo.delete_partner(c, pid)
    return jsonify({"ok": True})


@bp.post("/partners/reorder")
@auth.login_required
def reorder_partners():
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    with _conn() as c:
        repo.reorder_partners(c, ids)
    return jsonify({"ok": True})


@bp.post("/partner/merge")
@auth.login_required
def merge_partners():
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.merge_partners(c, data.get("from_id"), data.get("into_id"))
        return jsonify({"ok": True})
    except (ValueError, TypeError) as e:
        return _err(str(e))


@bp.post("/partner/<int:pid>/field")
@auth.login_required
def add_field(pid):
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            fid = repo.add_field(c, pid, data)
        return jsonify({"id": fid})
    except ValueError as e:
        return _err(str(e))


@bp.patch("/partner/field/<int:fid>")
@auth.login_required
def patch_field(fid):
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.update_field(c, fid, data)
        return jsonify({"ok": True})
    except ValueError as e:
        return _err(str(e))


@bp.delete("/partner/field/<int:fid>")
@auth.login_required
def delete_field(fid):
    try:
        with _conn() as c:
            repo.delete_field(c, fid)
        return jsonify({"ok": True})
    except ValueError as e:
        return _err(str(e))


@bp.post("/partner/<int:pid>/fields/reorder")
@auth.login_required
def reorder_fields(pid):
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    with _conn() as c:
        repo.reorder_fields(c, pid, ids)
    return jsonify({"ok": True})


@bp.post("/contract/<int:cid>/partner")
@auth.login_required
def set_contract_partner(cid):
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.set_contract_partner(c, cid, data.get("partner_id"))
        return jsonify({"ok": True})
    except ValueError as e:
        return _err(str(e))


@bp.post("/contract/<int:cid>/posten")
@auth.login_required
def move_contract_posten(cid):
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            repo.move_contract_posten(c, cid, data.get("posten_id"))
        return jsonify({"ok": True})
    except (ValueError, TypeError) as e:
        return _err(str(e))
