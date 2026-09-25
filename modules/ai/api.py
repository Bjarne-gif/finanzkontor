"""KI-Kontext-Layer — API (read-only Test-Endpunkte).

Nur zum Anschauen der Pakete im Browser. Kein LLM, keine Freigabe-Logik, keine
schreibenden Operationen.
"""
from contextlib import contextmanager

from flask import Blueprint, jsonify, request

from core import auth, db
from . import chat, context, llm, settings, uebergabe

bp = Blueprint("ai", __name__, url_prefix="/api/ai")


@contextmanager
def _conn():
    c = db.connect(db.active_db())
    try:
        yield c
    finally:
        c.close()


@bp.get("/ping")
@auth.login_required
def ai_ping():
    """Verbindungstest zum lokalen LLM (sendet keine Finanzdaten)."""
    return jsonify(llm.ping())


@bp.get("/settings")
@auth.login_required
def get_settings():
    """KI-Einstellung der aktiven DB (an/aus + freigegebene Bereiche)."""
    with _conn() as c:
        return jsonify(settings.read(c))


@bp.post("/settings")
@auth.login_required
def set_settings():
    """Setzt an/aus und/oder freigegebene Bereiche."""
    data = request.get_json(silent=True) or {}
    try:
        with _conn() as c:
            return jsonify(settings.write(c, data))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@bp.post("/ask")
@auth.login_required
def ai_ask():
    """Frage an die KI mit dem freigegebenen Kontext (read-only)."""
    data = request.get_json(silent=True) or {}
    frage = (data.get("frage") or "").strip()
    if not frage:
        return jsonify({"ok": False, "error": "Keine Frage angegeben."}), 400
    with _conn() as c:
        st = settings.read(c)
        if not st["enabled"]:
            return jsonify({"ok": False, "error": "Die KI ist nicht aktiviert."}), 400
        vision = "dokumente" in st["allowed"] and llm.modell_kann_bilder()
        bilder = []
        ctx = uebergabe.datenuebergabe(c, st["allowed"], vision=vision, bilder_out=bilder)   # vollständig, nur freigegebene Bereiche
    res = llm.ask(frage, ctx, bilder)
    if res.get("ok"):
        with _conn() as c:
            chat.add_exchange(c, frage, res["antwort"])   # verschlüsselt, F5-fest
    return jsonify(res)


@bp.get("/chat")
@auth.login_required
def get_chat():
    """Gespeicherter Chatverlauf der aktiven DB (entschlüsselt)."""
    with _conn() as c:
        return jsonify({"messages": chat.list_messages(c)})


@bp.delete("/chat")
@auth.login_required
def clear_chat():
    with _conn() as c:
        chat.clear(c)
    return jsonify({"ok": True})


@bp.get("/uebergabe")
@auth.login_required
def uebergabe_vorschau():
    """Zeigt als Text genau das, was bei der nächsten Frage an die KI gehen würde.

    Sendet nichts an das LLM. ?alle=1 zeigt zusätzlich alle Bereiche (auch nicht freigegebene)
    – nur zum Nachsehen im eigenen Browser.
    """
    with _conn() as c:
        st = settings.read(c)
        alle = request.args.get("alle") == "1"
        bereiche = list(settings.KNOWN_AREAS) if alle else st["allowed"]
        vision = "dokumente" in bereiche and llm.modell_kann_bilder()
        bilder = []
        text = uebergabe.datenuebergabe(c, bereiche, vision=vision, bilder_out=bilder)
    system = llm.system_text(text)
    kopf = [
        "VORSCHAU – so geht es bei der nächsten Frage an die KI (hier wird nichts gesendet).",
        f"KI aktiv: {'ja' if st['enabled'] else 'nein – solange aus, wird nichts gesendet'}",
        f"Bereiche in dieser Vorschau: {', '.join(bereiche) or 'keine'}" + (" (alle, auch nicht freigegebene)" if alle else ""),
        f"Umfang: {len(system):,} Zeichen, geschätzt ~{llm.schaetze_tokens(system):,} Tokens".replace(",", "."),
        (f"Bilder: {len(bilder)} (Scans/Fotos der Dokumente, werden mitgeschickt – hier nicht angezeigt)" if vision
         else "Bilder: keine (das Modell versteht keine Bilder oder Dokumente sind nicht freigegeben)"),
        "",
    ]
    return ("\n".join(kopf) + system, 200, {"Content-Type": "text/plain; charset=utf-8"})


@bp.get("/context/haushalt")
@auth.login_required
def ctx_haushalt():
    with _conn() as c:
        return jsonify(context.haushalt_paket(c))


@bp.get("/context/vermoegen")
@auth.login_required
def ctx_vermoegen():
    with _conn() as c:
        return jsonify(context.vermoegen_paket(c))


@bp.get("/context/vertraege")
@auth.login_required
def ctx_vertraege():
    with _conn() as c:
        return jsonify(context.vertraege_paket(c))
