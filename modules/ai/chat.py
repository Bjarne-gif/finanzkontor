"""KI-Chatverlauf — verschlüsselt in der aktiven DB.

Nur erfolgreiche Frage/Antwort-Paare werden gespeichert. Der Text liegt
Fernet-verschlüsselt vor (`text_enc`), wie alle sensiblen Werte im Tool.
Die Länge ist begrenzt, damit der Verlauf nicht unbegrenzt wächst.
"""
from datetime import datetime, timezone

from core import crypto

MAX_MESSAGES = 300
ROLES = ("user", "assistant")


def list_messages(conn):
    rows = conn.execute("SELECT role, text_enc FROM ai_chat ORDER BY id").fetchall()
    out = []
    for r in rows:
        try:
            out.append({"role": r["role"], "text": crypto.decrypt(r["text_enc"])})
        except Exception:  # noqa: BLE001 — eine defekte Zeile soll den Verlauf nicht sprengen
            continue
    return out


def add_exchange(conn, frage, antwort):
    """Speichert Frage + Antwort als Paar und kürzt auf MAX_MESSAGES."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for role, text in (("user", frage), ("assistant", antwort)):
        conn.execute("INSERT INTO ai_chat(role, text_enc, created_at) VALUES(?,?,?)",
                     (role, crypto.encrypt(text), now))
    conn.execute(
        "DELETE FROM ai_chat WHERE id NOT IN (SELECT id FROM ai_chat ORDER BY id DESC LIMIT ?)",
        (MAX_MESSAGES,))
    conn.commit()


def clear(conn):
    conn.execute("DELETE FROM ai_chat")
    conn.commit()
