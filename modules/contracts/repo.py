"""Datenzugriff für Verträge: CRUD des Vertragsprofils am Posten + Dokumente.

Sensible Werte (Anbieter, Notiz, Dateiname) verschlüsselt; Struktur klar. Ein
Vertrag hängt 1:1 an einem Posten (posten_id UNIQUE). Der Betrag wird hier nicht
gehalten – er kommt aus dem Ledger-Posten.
"""
import re
from datetime import datetime, timezone

from core import crypto

MAX_VENDOR = 80
MAX_NOTE = 500
UNITS = ("Monate", "Wochen")
# Palette fuer Kategorie-Farben (fuer spaetere Kreisdiagramme gut unterscheidbar)
CAT_COLORS = ["#8f9fd9", "#6fb98a", "#d9b877", "#c49ad0", "#8fb3c9",
              "#d99a76", "#86bd8f", "#b39ddb", "#e0a13a", "#7fc4c0"]
STATUSES = ("aktiv", "pausiert", "gekündigt")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _clean_vendor(raw):
    v = (raw or "").strip()
    if not v:
        raise ValueError("Anbieter fehlt.")
    return v[:MAX_VENDOR]


def _norm_date(raw):
    """Nimmt 'TT.MM.JJJJ' oder 'JJJJ-MM-TT' -> ISO 'JJJJ-MM-TT' oder None."""
    s = (raw or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m:
        d, mo, y = (int(x) for x in m.groups())
    else:
        m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
        if not m:
            raise ValueError("Datum muss TT.MM.JJJJ sein.")
        y, mo, d = (int(x) for x in m.groups())
    from datetime import date
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        raise ValueError("Ungültiges Datum.")


def _one_of(value, allowed, field):
    v = (value or "").strip()
    if v not in allowed:
        raise ValueError(f"Ungültiger Wert für {field}.")
    return v


def _int(value, default=0):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, n)


def _profile_from(data):
    """Baut das strukturierte Profil aus Eingabedaten (mit Validierung)."""
    end = _norm_date(data.get("end_date"))
    anytime = bool(data.get("anytime")) or end is None
    out = {
        "vendor": _clean_vendor(data.get("vendor")),
        "end_date": None if anytime else end,
        "notice_n": 0 if anytime else _int(data.get("notice_n")),
        "notice_unit": _one_of(data.get("notice_unit", "Monate"), UNITS, "Einheit"),
        "renew_n": _int(data.get("renew_n")),
        "anytime": 1 if anytime else 0,
        "status": _one_of(data.get("status", "aktiv"), STATUSES, "Status"),
        "candidate": 1 if data.get("candidate") else 0,
        "label": (data.get("label") or "").strip()[:60],
        "note": (data.get("note") or "").strip()[:MAX_NOTE],
    }
    out["pause_until"] = _norm_date(data.get("pause_until")) if out["status"] == "pausiert" else None
    return out


def _cat_id(conn, value):
    """Validiert eine (optionale) Kategorie-Zuordnung. None erlaubt (= ohne Kategorie)."""
    if value in (None, "", 0, "0"):
        return None
    cid = int(value)
    if not conn.execute("SELECT id FROM contract_categories WHERE id=?", (cid,)).fetchone():
        raise ValueError("Kategorie nicht gefunden.")
    return cid


# ---- Vertragskategorien (wie asset_classes) -------------------------------
def list_categories(conn):
    rows = conn.execute(
        "SELECT * FROM contract_categories ORDER BY sort, id").fetchall()
    return [{"id": r["id"], "name": crypto.decrypt(r["name_enc"]),
             "color": r["color"], "sort": r["sort"]} for r in rows]


def add_category(conn, data):
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Name fehlt.")
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM contract_categories").fetchone()["s"]
    n_exist = conn.execute("SELECT COUNT(*) c FROM contract_categories").fetchone()["c"]
    color = data.get("color") or CAT_COLORS[n_exist % len(CAT_COLORS)]
    cur = conn.execute(
        "INSERT INTO contract_categories(name_enc,color,sort,created_at) VALUES(?,?,?,?)",
        (crypto.encrypt(name[:60]), color, nxt, _now()))
    conn.commit()
    return cur.lastrowid


def update_category(conn, cid, patch):
    sets, vals = [], []
    if "name" in patch:
        nm = (patch["name"] or "").strip()
        if not nm:
            raise ValueError("Name fehlt.")
        sets.append("name_enc=?"); vals.append(crypto.encrypt(nm[:60]))
    if "color" in patch:
        sets.append("color=?"); vals.append(patch["color"] or None)
    if not sets:
        return
    vals.append(cid)
    conn.execute(f"UPDATE contract_categories SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_category(conn, cid):
    """Wie beim Vermögen: blockiert, solange noch Verträge dranhängen."""
    n = conn.execute("SELECT COUNT(*) c FROM contracts WHERE category_id=?", (cid,)).fetchone()["c"]
    if n:
        raise ValueError("Kategorie enthält noch Verträge – zuerst leeren oder umhängen.")
    conn.execute("DELETE FROM contract_categories WHERE id=?", (cid,))
    conn.commit()


def reorder_categories(conn, ids):
    for i, cid in enumerate(ids):
        conn.execute("UPDATE contract_categories SET sort=? WHERE id=?", (i, int(cid)))
    conn.commit()


# ---- Verträge -------------------------------------------------------------
def list_contracts(conn):
    rows = conn.execute("SELECT * FROM contracts ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "posten_id": r["posten_id"],
            "category_id": r["category_id"],
            "vendor": crypto.decrypt(r["vendor_enc"]),
            "end_date": r["end_date"], "notice_n": r["notice_n"],
            "notice_unit": r["notice_unit"], "renew_n": r["renew_n"],
            "anytime": bool(r["anytime"]), "status": r["status"],
            "pause_until": r["pause_until"], "candidate": bool(r["candidate"]),
            "label": crypto.decrypt(r["label_enc"]) if r["label_enc"] else "",
            "note": crypto.decrypt(r["note_enc"]) if r["note_enc"] else "",
            "docs": list_docs(conn, r["id"]),
        })
    return out


def get_by_posten(conn, posten_id):
    r = conn.execute("SELECT id FROM contracts WHERE posten_id=?", (posten_id,)).fetchone()
    return r["id"] if r else None


def add_contract(conn, data):
    posten_id = int(data["posten_id"])
    if not conn.execute("SELECT id FROM posten WHERE id=?", (posten_id,)).fetchone():
        raise ValueError("Posten nicht gefunden.")
    if get_by_posten(conn, posten_id):
        raise ValueError("Für diesen Posten gibt es schon einen Vertrag.")
    p = _profile_from(data)
    cat_id = _cat_id(conn, data.get("category_id"))
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM contracts").fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO contracts(posten_id,category_id,vendor_enc,label_enc,end_date,notice_n,notice_unit,"
        "renew_n,anytime,status,pause_until,candidate,note_enc,sort,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (posten_id, cat_id, crypto.encrypt(p["vendor"]),
         crypto.encrypt(p["label"]) if p["label"] else None, p["end_date"], p["notice_n"],
         p["notice_unit"], p["renew_n"], p["anytime"], p["status"], p["pause_until"],
         p["candidate"], crypto.encrypt(p["note"]) if p["note"] else None, nxt,
         _now(), _now()))
    conn.commit()
    return cur.lastrowid


def update_contract(conn, cid, patch):
    if not conn.execute("SELECT id FROM contracts WHERE id=?", (cid,)).fetchone():
        raise ValueError("Vertrag nicht gefunden.")
    sets, vals = [], []
    if "vendor" in patch:
        sets.append("vendor_enc=?"); vals.append(crypto.encrypt(_clean_vendor(patch["vendor"])))
    if "label" in patch:
        lb = (patch["label"] or "").strip()[:60]
        sets.append("label_enc=?"); vals.append(crypto.encrypt(lb) if lb else None)
    if "end_date" in patch or "anytime" in patch:
        end = _norm_date(patch.get("end_date"))
        anytime = bool(patch.get("anytime")) or end is None
        sets.append("anytime=?"); vals.append(1 if anytime else 0)
        sets.append("end_date=?"); vals.append(None if anytime else end)
    if "notice_n" in patch:
        sets.append("notice_n=?"); vals.append(_int(patch["notice_n"]))
    if "notice_unit" in patch:
        sets.append("notice_unit=?"); vals.append(_one_of(patch["notice_unit"], UNITS, "Einheit"))
    if "renew_n" in patch:
        sets.append("renew_n=?"); vals.append(_int(patch["renew_n"]))
    if "status" in patch:
        st = _one_of(patch["status"], STATUSES, "Status")
        sets.append("status=?"); vals.append(st)
        if st != "pausiert":
            sets.append("pause_until=?"); vals.append(None)
    if "pause_until" in patch:
        sets.append("pause_until=?"); vals.append(_norm_date(patch["pause_until"]))
    if "candidate" in patch:
        sets.append("candidate=?"); vals.append(1 if patch["candidate"] else 0)
    if "category_id" in patch:
        sets.append("category_id=?"); vals.append(_cat_id(conn, patch["category_id"]))
    if "note" in patch:
        note = (patch["note"] or "").strip()[:MAX_NOTE]
        sets.append("note_enc=?"); vals.append(crypto.encrypt(note) if note else None)
    if not sets:
        return
    sets.append("updated_at=?"); vals.append(_now())
    vals.append(cid)
    conn.execute(f"UPDATE contracts SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def reorder_contracts(conn, ids):
    for i, cid in enumerate(ids):
        conn.execute("UPDATE contracts SET sort=? WHERE id=?", (i, int(cid)))
    conn.commit()


def delete_contract(conn, cid):
    """Entfernt nur das Vertragsprofil – der Posten bleibt im Haushalt.

    Räumt die verschlüsselten Dateien mit weg (die DB-Kaskade löscht nur die
    Metadaten-Zeilen).
    """
    from modules.contracts import storage
    for d in conn.execute("SELECT stored_name FROM contract_docs WHERE contract_id=?", (cid,)).fetchall():
        storage.delete(d["stored_name"])
    conn.execute("DELETE FROM contracts WHERE id=?", (cid,))
    conn.commit()


def all_stored_names(conn):
    """Alle aktuell referenzierten Dateinamen – für die Verwaisten-Aufräumung."""
    return [r["stored_name"] for r in conn.execute("SELECT stored_name FROM contract_docs").fetchall()]


# ---- Dokumente (Metadaten; die Datei liegt separat auf der Platte) --------
def list_docs(conn, contract_id):
    rows = conn.execute(
        "SELECT * FROM contract_docs WHERE contract_id=? ORDER BY sort, id", (contract_id,)).fetchall()
    return [{"id": r["id"], "filename": crypto.decrypt(r["filename_enc"]),
             "stored_name": r["stored_name"], "size": r["size"]} for r in rows]


def add_doc(conn, contract_id, filename, stored_name, size):
    if not conn.execute("SELECT id FROM contracts WHERE id=?", (contract_id,)).fetchone():
        raise ValueError("Vertrag nicht gefunden.")
    nxt = conn.execute(
        "SELECT COALESCE(MAX(sort)+1,0) AS s FROM contract_docs WHERE contract_id=?",
        (contract_id,)).fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO contract_docs(contract_id,filename_enc,stored_name,size,sort,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (contract_id, crypto.encrypt(filename or "Dokument.pdf"), stored_name,
         int(size or 0), nxt, _now()))
    conn.commit()
    return cur.lastrowid


def get_doc(conn, doc_id):
    r = conn.execute("SELECT * FROM contract_docs WHERE id=?", (doc_id,)).fetchone()
    if not r:
        return None
    return {"id": r["id"], "contract_id": r["contract_id"],
            "filename": crypto.decrypt(r["filename_enc"]),
            "stored_name": r["stored_name"], "size": r["size"]}


def delete_doc(conn, doc_id):
    r = conn.execute("SELECT stored_name FROM contract_docs WHERE id=?", (doc_id,)).fetchone()
    conn.execute("DELETE FROM contract_docs WHERE id=?", (doc_id,))
    conn.commit()
    return r["stored_name"] if r else None
