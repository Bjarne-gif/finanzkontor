"""Datenzugriff für den Ledger: CRUD + Ver-/Entschlüsselung.

Sensible Werte (Name, Betrag, Notiz) liegen verschlüsselt in der DB.
Beträge werden serverseitig geparst und validiert -> das Sicherheitsnetz,
durch das auch die KI später schreibt.
"""
import re
from datetime import datetime, timezone

from core import crypto
from modules.ledger.calc import INTERVALS

MAX_NAME = 80
MAX_NOTE = 300


def _now():
    return datetime.now(timezone.utc).isoformat()


def parse_amount(raw):
    """Akzeptiert '800', '800,00', '1.234,56', '1234.56'. Gibt float >= 0 zurück."""
    if isinstance(raw, (int, float)):
        val = float(raw)
    else:
        s = str(raw).strip().replace("€", "").replace(" ", "")
        if not s:
            raise ValueError("Betrag fehlt.")
        # Deutsche Konvention: Komma = Dezimal, Punkt = Tausender.
        if "," in s:                          # Komma vorhanden -> Punkte sind Tausender
            s = s.replace(".", "").replace(",", ".")
        elif "." in s:                        # nur Punkt(e): mehrdeutig
            if s.count(".") > 1:              # mehrere Punkte -> Tausender (1.234.567)
                s = s.replace(".", "")
            else:
                head, tail = s.split(".")
                if len(tail) == 3:            # genau 3 Ziffern -> Tausender (1.500 = 1500)
                    s = head + tail
                # sonst Dezimalpunkt beibehalten (1234.56, 1.5, 1.50)
        if not re.fullmatch(r"-?\d+(\.\d+)?", s):
            raise ValueError("Betrag ist keine gültige Zahl.")
        val = float(s)
    if val < 0:
        raise ValueError("Betrag darf nicht negativ sein.")
    return round(val, 2)


def _clean_name(raw):
    name = (raw or "").strip()
    if not name:
        raise ValueError("Name fehlt.")
    return name[:MAX_NAME]


def _clean_interval(raw):
    iv = (raw or "monatlich").strip()
    if iv not in INTERVALS:
        raise ValueError("Unbekanntes Intervall.")
    return iv


def _clean_tags(raw):
    if raw is None:
        return None
    if isinstance(raw, list):
        parts = raw
    else:
        parts = str(raw).split(",")
    parts = [re.sub(r"[^a-z0-9_]", "", t.strip().lower()) for t in parts]
    parts = [t for t in parts if t]
    return ",".join(sorted(set(parts))) or None


# ---- Kategorien -----------------------------------------------------------
def list_categories(conn):
    rows = conn.execute("SELECT * FROM categories ORDER BY sort, id").fetchall()
    return [{"id": r["id"], "kind": r["kind"], "name": crypto.decrypt(r["name_enc"]),
             "color": r["color"], "sort": r["sort"]} for r in rows]


def add_category(conn, kind, name, color=None):
    if kind not in ("income", "expense"):
        raise ValueError("Typ muss Einnahme oder Ausgabe sein.")
    name = _clean_name(name)
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM categories").fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO categories(kind, name_enc, color, sort, created_at) VALUES(?,?,?,?,?)",
        (kind, crypto.encrypt(name), color, nxt, _now()))
    conn.commit()
    return cur.lastrowid


def update_category(conn, cid, patch):
    sets, vals = [], []
    if "name" in patch:
        sets.append("name_enc=?"); vals.append(crypto.encrypt(_clean_name(patch["name"])))
    if "color" in patch:
        sets.append("color=?"); vals.append(patch["color"])
    if "sort" in patch:
        sets.append("sort=?"); vals.append(int(patch["sort"]))
    if not sets:
        return
    vals.append(cid)
    conn.execute(f"UPDATE categories SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_category(conn, cid):
    n = conn.execute("SELECT COUNT(*) AS c FROM posten WHERE category_id=?", (cid,)).fetchone()["c"]
    if n > 0:
        raise ValueError("Kategorie enthält noch Posten – erst leeren.")
    conn.execute("DELETE FROM categories WHERE id=?", (cid,))
    conn.commit()


def reorder_categories(conn, ids):
    for i, cid in enumerate(ids):
        conn.execute("UPDATE categories SET sort=? WHERE id=?", (i, int(cid)))
    conn.commit()


# ---- Posten ---------------------------------------------------------------
def list_posten(conn):
    rows = conn.execute("SELECT * FROM posten ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "category_id": r["category_id"],
            "name": crypto.decrypt(r["name_enc"]),
            "amount": parse_amount(crypto.decrypt(r["amount_enc"])),
            "interval": r["interval"], "active": bool(r["active"]),
            "note": crypto.decrypt(r["note_enc"]) if r["note_enc"] else "",
            "tags": r["tags"] or "", "income_role": r["income_role"], "sort": r["sort"],
        })
    return out


def add_posten(conn, data):
    cid = int(data["category_id"])
    cat = conn.execute("SELECT kind FROM categories WHERE id=?", (cid,)).fetchone()
    if not cat:
        raise ValueError("Kategorie nicht gefunden.")
    name = _clean_name(data.get("name"))
    amount = parse_amount(data.get("amount", 0))
    interval = _clean_interval(data.get("interval"))
    active = 1 if data.get("active", True) else 0
    note = (data.get("note") or "").strip()[:MAX_NOTE]
    tags = _clean_tags(data.get("tags"))
    role = None
    if cat["kind"] == "income":
        role = "sparen" if data.get("income_role") == "sparen" else "einnahme"
    nxt = conn.execute(
        "SELECT COALESCE(MAX(sort)+1,0) AS s FROM posten WHERE category_id=?", (cid,)).fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO posten(category_id,name_enc,amount_enc,interval,active,note_enc,tags,income_role,sort,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (cid, crypto.encrypt(name), crypto.encrypt(f"{amount:.2f}"), interval, active,
         crypto.encrypt(note) if note else None, tags, role, nxt, _now(), _now()))
    conn.commit()
    return cur.lastrowid


def update_posten(conn, pid, patch):
    row = conn.execute("SELECT * FROM posten WHERE id=?", (pid,)).fetchone()
    if not row:
        raise ValueError("Posten nicht gefunden.")
    sets, vals = [], []
    if "name" in patch:
        sets.append("name_enc=?"); vals.append(crypto.encrypt(_clean_name(patch["name"])))
    if "amount" in patch:
        sets.append("amount_enc=?"); vals.append(crypto.encrypt(f"{parse_amount(patch['amount']):.2f}"))
    if "interval" in patch:
        sets.append("interval=?"); vals.append(_clean_interval(patch["interval"]))
    if "active" in patch:
        sets.append("active=?"); vals.append(1 if patch["active"] else 0)
    if "note" in patch:
        note = (patch["note"] or "").strip()[:MAX_NOTE]
        sets.append("note_enc=?"); vals.append(crypto.encrypt(note) if note else None)
    if "tags" in patch:
        sets.append("tags=?"); vals.append(_clean_tags(patch["tags"]))
    if "income_role" in patch:
        sets.append("income_role=?")
        vals.append("sparen" if patch["income_role"] == "sparen" else "einnahme")
    if "category_id" in patch:
        sets.append("category_id=?"); vals.append(int(patch["category_id"]))
    if not sets:
        return
    sets.append("updated_at=?"); vals.append(_now())
    vals.append(pid)
    conn.execute(f"UPDATE posten SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_posten(conn, pid):
    conn.execute("DELETE FROM posten WHERE id=?", (pid,))
    conn.commit()


def reorder_posten(conn, ids):
    for i, pid in enumerate(ids):
        conn.execute("UPDATE posten SET sort=? WHERE id=?", (i, int(pid)))
    conn.commit()
