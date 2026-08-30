"""Datenzugriff für das Vermögen: CRUD der Klassen + Positionen, Ver-/Entschlüsselung.

Sensible Werte (Name, Wert, Notiz) liegen verschlüsselt in der DB. Werte werden
serverseitig geparst/validiert – dasselbe Sicherheitsnetz wie im Ledger, durch
das später auch die KI schreibt (Vorschlag -> Bestätigung).

Profil (Liquidität/Risiko/Art) gilt nur für Besitz-Klassen; Schuld-Klassen haben
keins (Felder NULL).
"""
import re
from datetime import datetime, timezone

from core import crypto

MAX_NAME = 80
MAX_NOTE = 300
KINDS = ("asset", "debt")
LIQ  = ("liquide", "halb-liquide", "illiquide")
RISK = ("sicher", "mittel", "hoch")
ART  = ("Geldwert", "Sachwert")
DEFAULT_PROFILE = {"liq": "liquide", "risk": "sicher", "art": "Geldwert"}


def _now():
    return datetime.now(timezone.utc).isoformat()


def parse_value(raw):
    """'37000', '37.000', '37.000,00', '1.234.567,89' -> float >= 0 (deutsche Konvention)."""
    if isinstance(raw, (int, float)):
        val = float(raw)
    else:
        s = str(raw).strip().replace("€", "").replace(" ", "")
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


def _clean_kind(raw):
    kind = (raw or "asset").strip()
    if kind not in KINDS:
        raise ValueError("Art muss Besitz oder Schuld sein.")
    return kind


def _one_of(value, allowed, field):
    v = (value or "").strip()
    if v not in allowed:
        raise ValueError(f"Ungültiger Wert für {field}.")
    return v


# ---- Klassen --------------------------------------------------------------
def list_classes(conn):
    rows = conn.execute("SELECT * FROM asset_classes ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        cls = {
            "id": r["id"], "kind": r["kind"], "name": crypto.decrypt(r["name_enc"]),
            "color": r["color"], "sort": r["sort"],
        }
        if r["kind"] == "asset":
            cls["profile"] = {"liq": r["liq"], "risk": r["risk"], "art": r["art"]}
        else:
            cls["profile"] = None
        out.append(cls)
    return out


def add_class(conn, data):
    kind = _clean_kind(data.get("kind"))
    name = _clean_name(data.get("name"))
    color = data.get("color")
    if kind == "asset":
        prof = data.get("profile") or {}
        liq  = _one_of(prof.get("liq",  DEFAULT_PROFILE["liq"]),  LIQ,  "Liquidität")
        risk = _one_of(prof.get("risk", DEFAULT_PROFILE["risk"]), RISK, "Risiko")
        art  = _one_of(prof.get("art",  DEFAULT_PROFILE["art"]),  ART,  "Art")
    else:
        liq = risk = art = None
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM asset_classes").fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO asset_classes(kind,name_enc,liq,risk,art,color,sort,created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (kind, crypto.encrypt(name), liq, risk, art, color, nxt, _now()))
    conn.commit()
    return cur.lastrowid


def update_class(conn, cid, patch):
    row = conn.execute("SELECT kind FROM asset_classes WHERE id=?", (cid,)).fetchone()
    if not row:
        raise ValueError("Klasse nicht gefunden.")
    is_asset = row["kind"] == "asset"
    sets, vals = [], []
    if "name" in patch:
        sets.append("name_enc=?"); vals.append(crypto.encrypt(_clean_name(patch["name"])))
    if "color" in patch:
        sets.append("color=?"); vals.append(patch["color"])
    if "sort" in patch:
        sets.append("sort=?"); vals.append(int(patch["sort"]))
    prof = patch.get("profile")
    if prof and is_asset:
        if "liq" in prof:
            sets.append("liq=?");  vals.append(_one_of(prof["liq"],  LIQ,  "Liquidität"))
        if "risk" in prof:
            sets.append("risk=?"); vals.append(_one_of(prof["risk"], RISK, "Risiko"))
        if "art" in prof:
            sets.append("art=?");  vals.append(_one_of(prof["art"],  ART,  "Art"))
    if not sets:
        return
    vals.append(cid)
    conn.execute(f"UPDATE asset_classes SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_class(conn, cid):
    n = conn.execute("SELECT COUNT(*) AS c FROM asset_positions WHERE class_id=?", (cid,)).fetchone()["c"]
    if n > 0:
        raise ValueError("Klasse enthält noch Positionen – erst leeren.")
    conn.execute("DELETE FROM asset_classes WHERE id=?", (cid,))
    conn.commit()


def reorder_classes(conn, ids):
    for i, cid in enumerate(ids):
        conn.execute("UPDATE asset_classes SET sort=? WHERE id=?", (i, int(cid)))
    conn.commit()


# ---- Positionen -----------------------------------------------------------
def list_positions(conn):
    rows = conn.execute("SELECT * FROM asset_positions ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        try:
            val = float(crypto.decrypt(r["value_enc"]) or 0)
        except (ValueError, TypeError):
            val = 0.0
        out.append({
            "id": r["id"], "class_id": r["class_id"],
            "name": crypto.decrypt(r["name_enc"]),
            "value": round(val, 2),
            "note": crypto.decrypt(r["note_enc"]) if r["note_enc"] else "",
            "active": bool(r["active"]), "sort": r["sort"],
        })
    return out


def add_position(conn, data):
    cid = int(data["class_id"])
    if not conn.execute("SELECT id FROM asset_classes WHERE id=?", (cid,)).fetchone():
        raise ValueError("Klasse nicht gefunden.")
    name = _clean_name(data.get("name"))
    value = parse_value(data.get("value", 0))
    active = 1 if data.get("active", True) else 0
    note = (data.get("note") or "").strip()[:MAX_NOTE]
    nxt = conn.execute(
        "SELECT COALESCE(MAX(sort)+1,0) AS s FROM asset_positions WHERE class_id=?", (cid,)).fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO asset_positions(class_id,name_enc,value_enc,note_enc,active,sort,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (cid, crypto.encrypt(name), crypto.encrypt(f"{value:.2f}"),
         crypto.encrypt(note) if note else None, active, nxt, _now(), _now()))
    conn.commit()
    return cur.lastrowid


def update_position(conn, pid, patch):
    if not conn.execute("SELECT id FROM asset_positions WHERE id=?", (pid,)).fetchone():
        raise ValueError("Position nicht gefunden.")
    sets, vals = [], []
    if "name" in patch:
        sets.append("name_enc=?"); vals.append(crypto.encrypt(_clean_name(patch["name"])))
    if "value" in patch:
        sets.append("value_enc=?"); vals.append(crypto.encrypt(f"{parse_value(patch['value']):.2f}"))
    if "note" in patch:
        note = (patch["note"] or "").strip()[:MAX_NOTE]
        sets.append("note_enc=?"); vals.append(crypto.encrypt(note) if note else None)
    if "active" in patch:
        sets.append("active=?"); vals.append(1 if patch["active"] else 0)
    if "class_id" in patch:
        ncid = int(patch["class_id"])
        if not conn.execute("SELECT id FROM asset_classes WHERE id=?", (ncid,)).fetchone():
            raise ValueError("Zielklasse nicht gefunden.")
        sets.append("class_id=?"); vals.append(ncid)
    if "sort" in patch:
        sets.append("sort=?"); vals.append(int(patch["sort"]))
    if not sets:
        return
    sets.append("updated_at=?"); vals.append(_now())
    vals.append(pid)
    conn.execute(f"UPDATE asset_positions SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_position(conn, pid):
    conn.execute("DELETE FROM asset_positions WHERE id=?", (pid,))
    conn.commit()


def reorder_positions(conn, ids):
    for i, pid in enumerate(ids):
        conn.execute("UPDATE asset_positions SET sort=? WHERE id=?", (i, int(pid)))
    conn.commit()
