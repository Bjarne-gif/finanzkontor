"""Datenzugriff für die Aufteilung: CRUD der Töpfe + Ver-/Entschlüsselung.

Sensible Werte (Name, Wert) liegen verschlüsselt in der DB. Werte werden
serverseitig geparst/validiert – dasselbe Sicherheitsnetz wie im Ledger,
durch das später auch die KI schreibt (Vorschlag -> Bestätigung).
"""
import re
from datetime import datetime, timezone

from core import crypto

MAX_NAME = 60
MODES = ("fixed", "percent")


def _now():
    return datetime.now(timezone.utc).isoformat()


def parse_value(raw):
    """Akzeptiert '500', '500,00', '1.234,56', '30'. Gibt float >= 0 zurück.

    Deutsche Konvention: Komma = Dezimal, Punkt = Tausender (wie im Ledger).
    """
    if isinstance(raw, (int, float)):
        val = float(raw)
    else:
        s = str(raw).strip().replace("€", "").replace("%", "").replace(" ", "")
        if not s:
            return 0.0
        if "," in s:
            s = s.replace(".", "").replace(",", ".")
        elif "." in s:
            if s.count(".") > 1:
                s = s.replace(".", "")
            else:
                head, tail = s.split(".")
                if len(tail) == 3:
                    s = head + tail
        if not re.fullmatch(r"-?\d+(\.\d+)?", s):
            raise ValueError("Wert ist keine gültige Zahl.")
        val = float(s)
    if val < 0:
        raise ValueError("Wert darf nicht negativ sein.")
    return round(val, 2)


def _clean_name(raw):
    name = (raw or "").strip()
    if not name:
        raise ValueError("Name fehlt.")
    return name[:MAX_NAME]


def _clean_mode(raw):
    mode = (raw or "fixed").strip()
    if mode not in MODES:
        raise ValueError("Unbekannter Modus.")
    return mode


def list_pots(conn):
    rows = conn.execute("SELECT * FROM pots ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        try:
            val = float(crypto.decrypt(r["value_enc"]) or 0)
        except (ValueError, TypeError):
            val = 0.0
        out.append({
            "id": r["id"],
            "name": crypto.decrypt(r["name_enc"]),
            "color": r["color"],
            "mode": r["mode"],
            "value": round(val, 2),
            "sort": r["sort"],
        })
    return out


def add_pot(conn, data):
    name = _clean_name(data.get("name"))
    mode = _clean_mode(data.get("mode"))
    value = parse_value(data.get("value", 0))
    color = data.get("color")
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM pots").fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO pots(name_enc, color, mode, value_enc, sort, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (crypto.encrypt(name), color, mode, crypto.encrypt(str(value)), nxt, _now(), _now()))
    conn.commit()
    return cur.lastrowid


def update_pot(conn, pid, patch):
    row = conn.execute("SELECT id FROM pots WHERE id=?", (pid,)).fetchone()
    if not row:
        raise ValueError("Topf nicht gefunden.")
    sets, args = [], []
    if "name" in patch:
        sets.append("name_enc=?"); args.append(crypto.encrypt(_clean_name(patch["name"])))
    if "mode" in patch:
        sets.append("mode=?"); args.append(_clean_mode(patch["mode"]))
    if "value" in patch:
        sets.append("value_enc=?"); args.append(crypto.encrypt(str(parse_value(patch["value"]))))
    if "color" in patch:
        sets.append("color=?"); args.append(patch["color"])
    if not sets:
        return
    sets.append("updated_at=?"); args.append(_now())
    args.append(pid)
    conn.execute(f"UPDATE pots SET {', '.join(sets)} WHERE id=?", args)
    conn.commit()


def delete_pot(conn, pid):
    conn.execute("DELETE FROM pots WHERE id=?", (pid,))
    conn.commit()


def reorder_pots(conn, ids):
    for i, pid in enumerate(ids):
        conn.execute("UPDATE pots SET sort=? WHERE id=?", (i, int(pid)))
    conn.commit()
