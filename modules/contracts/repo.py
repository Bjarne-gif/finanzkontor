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
    pnames = {r["id"]: crypto.decrypt(r["name_enc"])
              for r in conn.execute("SELECT id, name_enc FROM contract_partners").fetchall()}
    rows = conn.execute("SELECT * FROM contracts ORDER BY sort, id").fetchall()
    out = []
    for r in rows:
        keys = r.keys()
        pid = r["partner_id"] if "partner_id" in keys else None
        out.append({
            "id": r["id"], "posten_id": r["posten_id"],
            "category_id": r["category_id"],
            "partner_id": pid, "partner_name": pnames.get(pid, "") if pid else "",
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
    partner_id = data.get("partner_id")
    prow = None
    if partner_id in (None, "", 0, "0"):
        partner_id = None
    else:
        partner_id = int(partner_id)
        prow = conn.execute("SELECT name_enc FROM contract_partners WHERE id=?", (partner_id,)).fetchone()
        if not prow:
            raise ValueError("Partner nicht gefunden.")
    # vendor_enc bleibt befüllt (NOT NULL, Anzeige-Fallback): aus Partner oder Eingabe
    vendor = crypto.decrypt(prow["name_enc"]) if prow else (data.get("vendor") or "").strip()
    if not vendor:
        vendor = "—"
    p = _profile_from({**data, "vendor": vendor})
    cat_id = _cat_id(conn, data.get("category_id"))
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) AS s FROM contracts").fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO contracts(posten_id,category_id,partner_id,vendor_enc,label_enc,end_date,notice_n,notice_unit,"
        "renew_n,anytime,status,pause_until,candidate,note_enc,sort,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (posten_id, cat_id, partner_id, crypto.encrypt(p["vendor"]),
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

    Die angehängten Dokumente werden NICHT gelöscht: durch ON DELETE SET NULL
    (Schema v10) verlieren sie nur ihre Vertrags-Verknüpfung und landen als
    'verwaist' in der Dateiverwaltung, von wo sie neu zugeordnet werden können.
    """
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


# ---- Dateiverwaltung (alle Dokumente der aktiven DB) ----------------------
def list_contracts_brief(conn):
    """Schlanke Vertrags-Liste (auch ohne Dokumente) für die Gruppierung/Drop-Ziele."""
    rows = conn.execute(
        "SELECT id, vendor_enc, label_enc, category_id, sort FROM contracts ORDER BY category_id, sort, id"
    ).fetchall()
    return [{"id": r["id"], "vendor": crypto.decrypt(r["vendor_enc"]),
             "label": crypto.decrypt(r["label_enc"]) if r["label_enc"] else None,
             "category_id": r["category_id"], "sort": r["sort"]} for r in rows]


def list_all_docs(conn):
    """Alle Dokumente der DB mit Vertrags-/Kategorie-Zuordnung.

    contract_id NULL = verwaist (Vertrag/Posten wurde gelöscht). Nach Vertrag
    gruppierbar; verwaiste ans Ende.
    """
    rows = conn.execute("""
        SELECT d.id, d.contract_id, d.filename_enc, d.stored_name, d.size, d.sort,
               c.vendor_enc, c.label_enc, c.category_id, c.posten_id
        FROM contract_docs d
        LEFT JOIN contracts c ON c.id = d.contract_id
        ORDER BY (d.contract_id IS NULL), d.contract_id, d.sort, d.id
    """).fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "contract_id": r["contract_id"],
            "filename": crypto.decrypt(r["filename_enc"]),
            "stored_name": r["stored_name"], "size": r["size"], "sort": r["sort"],
            "vendor": crypto.decrypt(r["vendor_enc"]) if r["vendor_enc"] else None,
            "label": crypto.decrypt(r["label_enc"]) if r["label_enc"] else None,
            "category_id": r["category_id"], "posten_id": r["posten_id"],
        })
    return out


def rename_doc(conn, doc_id, filename):
    name = (filename or "").strip() or "Dokument"
    conn.execute("UPDATE contract_docs SET filename_enc=? WHERE id=?", (crypto.encrypt(name), doc_id))
    conn.commit()


def move_doc(conn, doc_id, contract_id):
    """Hängt ein Dokument um (contract_id=None => verwaist). Landet am Ende des Ziels."""
    if contract_id is not None and not conn.execute(
            "SELECT id FROM contracts WHERE id=?", (contract_id,)).fetchone():
        raise ValueError("Vertrag nicht gefunden.")
    nxt = conn.execute(
        "SELECT COALESCE(MAX(sort)+1,0) AS s FROM contract_docs WHERE contract_id IS ?",
        (contract_id,)).fetchone()["s"]
    conn.execute("UPDATE contract_docs SET contract_id=?, sort=? WHERE id=?",
                 (contract_id, nxt, doc_id))
    conn.commit()


def reorder_docs(conn, ids):
    """Setzt die Sortierung anhand der übergebenen id-Reihenfolge (z. B. innerhalb eines Vertrags)."""
    for i, did in enumerate(ids or []):
        conn.execute("UPDATE contract_docs SET sort=? WHERE id=?", (i, int(did)))
    conn.commit()


def delete_orphan_docs(conn):
    """Löscht alle verwaisten Dokumente (contract_id NULL); liefert die stored_names zur Datei-Löschung."""
    rows = conn.execute("SELECT stored_name FROM contract_docs WHERE contract_id IS NULL").fetchall()
    names = [r["stored_name"] for r in rows]
    conn.execute("DELETE FROM contract_docs WHERE contract_id IS NULL")
    conn.commit()
    return names


# ==== Vertragspartner (eigene Entität wie Vertragskategorien) ==============
from modules.contracts.schema import PARTNER_CORE_FIELDS, PARTNER_COLORS

FTYPES = ("Text", "Zahl", "Datum", "E-Mail", "URL", "Telefon", "Adresse", "Freitext")
MAX_PARTNER = 80


def _partner_fields(conn, pid):
    rows = conn.execute(
        "SELECT * FROM partner_fields WHERE partner_id=? ORDER BY sort, id", (pid,)).fetchall()
    return [{"id": r["id"], "label": crypto.decrypt(r["label_enc"]),
             "ftype": r["ftype"], "value": crypto.decrypt(r["value_enc"]) if r["value_enc"] else "",
             "is_core": bool(r["is_core"]), "core_key": r["core_key"], "sort": r["sort"]}
            for r in rows]


def _partner_contracts(conn, pid):
    """Zugeordnete Verträge eines Partners – Anzeigename aus Vertragsbezeichnung
    bzw. dem Ledger-Posten-Namen."""
    rows = conn.execute(
        "SELECT c.id, c.label_enc, po.name_enc "
        "FROM contracts c JOIN posten po ON po.id=c.posten_id "
        "WHERE c.partner_id=? ORDER BY c.sort, c.id", (pid,)).fetchall()
    out = []
    for r in rows:
        label = crypto.decrypt(r["label_enc"]) if r["label_enc"] else ""
        pname = crypto.decrypt(r["name_enc"]) if r["name_enc"] else "Vertrag"
        out.append({"id": r["id"], "name": label or pname, "sub": pname if label else ""})
    return out


def list_partners(conn):
    counts = {}
    for r in conn.execute(
            "SELECT partner_id, COUNT(*) c FROM contracts WHERE partner_id IS NOT NULL GROUP BY partner_id").fetchall():
        counts[r["partner_id"]] = r["c"]
    out = []
    for r in conn.execute("SELECT * FROM contract_partners ORDER BY sort, id").fetchall():
        out.append({
            "id": r["id"], "name": crypto.decrypt(r["name_enc"]),
            "ptype": r["ptype"] or "", "branch": r["branch"] or "",
            "color": r["color"], "sort": r["sort"],
            "contract_count": counts.get(r["id"], 0),
            "contracts": _partner_contracts(conn, r["id"]),
            "fields": _partner_fields(conn, r["id"]),
        })
    return out


def partner_suggest(conn):
    """Vorschlagslisten (frei ergänzbar) für Typ/Branche – aus bereits benutzten Werten."""
    types = [r["ptype"] for r in conn.execute(
        "SELECT DISTINCT ptype FROM contract_partners WHERE ptype IS NOT NULL AND ptype<>'' ORDER BY ptype").fetchall()]
    branches = [r["branch"] for r in conn.execute(
        "SELECT DISTINCT branch FROM contract_partners WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").fetchall()]
    return {"ptypes": types, "branches": branches}


def _dup_partner(conn, name, exclude_id=None):
    norm = (name or "").strip().lower()
    for r in conn.execute("SELECT id, name_enc FROM contract_partners").fetchall():
        if exclude_id and r["id"] == exclude_id:
            continue
        if crypto.decrypt(r["name_enc"]).strip().lower() == norm:
            return r["id"]
    return None


def add_partner(conn, data):
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Name fehlt.")
    if _dup_partner(conn, name):
        raise ValueError(f"Partner „{name[:40]}“ existiert bereits.")
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) s FROM contract_partners").fetchone()["s"]
    n = conn.execute("SELECT COUNT(*) c FROM contract_partners").fetchone()["c"]
    color = (data.get("color") or "").strip() or PARTNER_COLORS[n % len(PARTNER_COLORS)]
    cur = conn.execute(
        "INSERT INTO contract_partners(name_enc,ptype,branch,color,sort,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (crypto.encrypt(name[:MAX_PARTNER]),
         (data.get("ptype") or "").strip()[:40] or None,
         (data.get("branch") or "").strip()[:40] or None,
         color, nxt, _now(), _now()))
    pid = cur.lastrowid
    for i, (ck, label, ftype) in enumerate(PARTNER_CORE_FIELDS):
        conn.execute(
            "INSERT INTO partner_fields(partner_id,label_enc,ftype,value_enc,is_core,core_key,sort) "
            "VALUES(?,?,?,?,?,?,?)",
            (pid, crypto.encrypt(label), ftype, None, 1, ck, i))
    conn.commit()
    return pid


def update_partner(conn, pid, patch):
    if not conn.execute("SELECT id FROM contract_partners WHERE id=?", (pid,)).fetchone():
        raise ValueError("Partner nicht gefunden.")
    sets, vals = [], []
    if "name" in patch:
        nm = (patch["name"] or "").strip()
        if not nm:
            raise ValueError("Name fehlt.")
        if _dup_partner(conn, nm, exclude_id=pid):
            raise ValueError(f"Partner „{nm[:40]}“ existiert bereits.")
        sets.append("name_enc=?"); vals.append(crypto.encrypt(nm[:MAX_PARTNER]))
    if "ptype" in patch:
        sets.append("ptype=?"); vals.append((patch["ptype"] or "").strip()[:40] or None)
    if "branch" in patch:
        sets.append("branch=?"); vals.append((patch["branch"] or "").strip()[:40] or None)
    if "color" in patch:
        sets.append("color=?"); vals.append((patch["color"] or "").strip() or None)
    if not sets:
        return
    sets.append("updated_at=?"); vals.append(_now())
    vals.append(pid)
    conn.execute(f"UPDATE contract_partners SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_partner(conn, pid):
    """Partner löschen. Verträge werden per DB-Constraint (SET NULL) entkoppelt,
    Felder per CASCADE mitgelöscht. Der Vertrag/Posten bleibt erhalten."""
    conn.execute("UPDATE contracts SET partner_id=NULL WHERE partner_id=?", (pid,))
    conn.execute("DELETE FROM contract_partners WHERE id=?", (pid,))
    conn.commit()


def reorder_partners(conn, ids):
    for i, pid in enumerate(ids or []):
        conn.execute("UPDATE contract_partners SET sort=? WHERE id=?", (i, int(pid)))
    conn.commit()


def merge_partners(conn, from_id, into_id):
    """Führt den Partner `from_id` in `into_id` zusammen. `into_id` bleibt bestehen,
    `from_id` wird danach entfernt. Verlustfrei: Werte, die nicht ins Ziel passen,
    werden als eigene Zusatzfelder erhalten statt verworfen."""
    from_id, into_id = int(from_id), int(into_id)
    if from_id == into_id:
        raise ValueError("Quelle und Ziel sind identisch.")
    into_row = conn.execute("SELECT * FROM contract_partners WHERE id=?", (into_id,)).fetchone()
    if not into_row:
        raise ValueError("Ziel-Partner nicht gefunden.")
    from_row = conn.execute("SELECT * FROM contract_partners WHERE id=?", (from_id,)).fetchone()
    if not from_row:
        raise ValueError("Quell-Partner nicht gefunden.")
    from_name = crypto.decrypt(from_row["name_enc"]) if from_row["name_enc"] else ""

    def _dec(v):
        return crypto.decrypt(v) if v else ""

    def _norm(v):
        return _dec(v).strip().casefold()

    # Verträge (samt ihrer Dokumente) auf das Ziel umhängen
    conn.execute("UPDATE contracts SET partner_id=? WHERE partner_id=?", (into_id, from_id))

    # --- Feste Felder über core_key abgleichen ---
    src_core = {r["core_key"]: r for r in conn.execute(
        "SELECT * FROM partner_fields WHERE partner_id=? AND core_key IS NOT NULL", (from_id,)).fetchall()}
    into_core = conn.execute(
        "SELECT * FROM partner_fields WHERE partner_id=? AND core_key IS NOT NULL", (into_id,)).fetchall()
    into_core_keys, conflicts = set(), []   # conflicts: (label, ftype, value_enc) → als eigene Felder anhängen
    for r in into_core:
        into_core_keys.add(r["core_key"])
        s = src_core.get(r["core_key"])
        if not s or not s["value_enc"]:
            continue
        if not r["value_enc"]:
            # Ziel leer → Wert der Quelle übernehmen
            conn.execute("UPDATE partner_fields SET value_enc=? WHERE id=?", (s["value_enc"], r["id"]))
        elif _norm(s["value_enc"]) != _norm(r["value_enc"]):
            # beide gefüllt & verschieden → Ziel behält seinen Wert, Quellwert als Zusatzfeld erhalten
            base = _dec(r["label_enc"]) or r["core_key"]
            conflicts.append((f"{base} (von {from_name})", s["ftype"], s["value_enc"]))
    # core_keys, die nur die Quelle kennt (Robustheit) → ebenfalls als Zusatzfeld erhalten
    for ck, s in src_core.items():
        if ck not in into_core_keys and s["value_enc"]:
            base = _dec(s["label_enc"]) or ck
            conflicts.append((f"{base} (von {from_name})", s["ftype"], s["value_enc"]))

    # --- Anhängen: eigene Felder der Quelle (Dublette-Check) + Konflikt-Zusatzfelder ---
    into_own = conn.execute(
        "SELECT label_enc, value_enc FROM partner_fields WHERE partner_id=? AND is_core=0", (into_id,)).fetchall()
    existing = {(_norm(o["label_enc"]), _norm(o["value_enc"])) for o in into_own}
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) s FROM partner_fields WHERE partner_id=?", (into_id,)).fetchone()["s"]

    def _append(label_enc, ftype, value_enc):
        nonlocal nxt
        conn.execute(
            "INSERT INTO partner_fields(partner_id,label_enc,ftype,value_enc,is_core,core_key,sort) "
            "VALUES(?,?,?,?,0,NULL,?)",
            (into_id, label_enc, ftype if ftype in FTYPES else "Text", value_enc, nxt))
        nxt += 1

    for r in conn.execute(
            "SELECT * FROM partner_fields WHERE partner_id=? AND is_core=0", (from_id,)).fetchall():
        key = (_norm(r["label_enc"]), _norm(r["value_enc"]))
        if key in existing:
            continue   # echte Dublette (Label + Wert identisch) überspringen
        existing.add(key)
        _append(r["label_enc"], r["ftype"], r["value_enc"])

    for label, ftype, value_enc in conflicts:
        _append(crypto.encrypt(label[:60]), ftype, value_enc)

    conn.execute("DELETE FROM contract_partners WHERE id=?", (from_id,))
    conn.commit()


# ---- Partner-Felder -------------------------------------------------------
def add_field(conn, pid, data):
    if not conn.execute("SELECT id FROM contract_partners WHERE id=?", (pid,)).fetchone():
        raise ValueError("Partner nicht gefunden.")
    label = (data.get("label") or "").strip()
    ftype = data.get("ftype") if data.get("ftype") in FTYPES else "Text"
    nxt = conn.execute("SELECT COALESCE(MAX(sort)+1,0) s FROM partner_fields WHERE partner_id=?", (pid,)).fetchone()["s"]
    cur = conn.execute(
        "INSERT INTO partner_fields(partner_id,label_enc,ftype,value_enc,is_core,core_key,sort) "
        "VALUES(?,?,?,?,0,NULL,?)",
        (pid, crypto.encrypt(label[:60]), ftype, None, nxt))
    conn.commit()
    return cur.lastrowid


def update_field(conn, fid, patch):
    r = conn.execute("SELECT * FROM partner_fields WHERE id=?", (fid,)).fetchone()
    if not r:
        raise ValueError("Feld nicht gefunden.")
    sets, vals = [], []
    if "label" in patch and not r["is_core"]:      # feste Feld-Überschriften bleiben fix
        lb = (patch["label"] or "").strip()[:60]
        if not lb:
            raise ValueError("Feldname fehlt.")
        sets.append("label_enc=?"); vals.append(crypto.encrypt(lb))
    if "ftype" in patch and not r["is_core"]:
        ft = patch["ftype"] if patch["ftype"] in FTYPES else "Text"
        sets.append("ftype=?"); vals.append(ft)
    if "value" in patch:
        val = (patch["value"] or "").strip()
        sets.append("value_enc=?"); vals.append(crypto.encrypt(val) if val else None)
    if not sets:
        return
    vals.append(fid)
    conn.execute(f"UPDATE partner_fields SET {', '.join(sets)} WHERE id=?", vals)
    conn.commit()


def delete_field(conn, fid):
    r = conn.execute("SELECT is_core FROM partner_fields WHERE id=?", (fid,)).fetchone()
    if not r:
        return
    if r["is_core"]:
        raise ValueError("Festes Feld kann nicht gelöscht werden.")
    conn.execute("DELETE FROM partner_fields WHERE id=?", (fid,))
    conn.commit()


def reorder_fields(conn, pid, ids):
    for i, fid in enumerate(ids or []):
        conn.execute("UPDATE partner_fields SET sort=? WHERE id=? AND partner_id=?", (i, int(fid), int(pid)))
    conn.commit()


def set_contract_partner(conn, cid, partner_id):
    """Ordnet einem Vertrag einen Partner zu (None = ohne Partner)."""
    if not conn.execute("SELECT id FROM contracts WHERE id=?", (cid,)).fetchone():
        raise ValueError("Vertrag nicht gefunden.")
    if partner_id in (None, "", 0, "0"):
        conn.execute("UPDATE contracts SET partner_id=NULL WHERE id=?", (cid,))
    else:
        pid = int(partner_id)
        if not conn.execute("SELECT id FROM contract_partners WHERE id=?", (pid,)).fetchone():
            raise ValueError("Partner nicht gefunden.")
        conn.execute("UPDATE contracts SET partner_id=? WHERE id=?", (pid, cid))
    conn.commit()


def partner_options(conn):
    """Schlanke Partnerliste (id, name, color) für die Auswahl im Vertrag."""
    return [{"id": r["id"], "name": crypto.decrypt(r["name_enc"]), "color": r["color"]}
            for r in conn.execute("SELECT id, name_enc, color FROM contract_partners ORDER BY sort, id").fetchall()]


def list_linkable(conn):
    """Freie Kosten-Posten (ohne Vertrag) – fürs Umhängen im Detail."""
    from modules.ledger import repo as ledger_repo
    cats = {c["id"]: c for c in ledger_repo.list_categories(conn)}
    taken = {r["posten_id"] for r in conn.execute("SELECT posten_id FROM contracts").fetchall()}
    out = []
    for p in ledger_repo.list_posten(conn):
        cat = cats.get(p["category_id"])
        if not cat or cat["kind"] != "expense" or p["id"] in taken:
            continue
        out.append({"id": p["id"], "name": p["name"], "amount": p["amount"],
                    "interval": p["interval"], "category": cat["name"]})
    return out


def move_contract_posten(conn, cid, new_posten_id):
    """Hängt einen Vertrag auf einen anderen (freien) Kosten-Posten um."""
    from modules.ledger import repo as ledger_repo
    if not conn.execute("SELECT id FROM contracts WHERE id=?", (cid,)).fetchone():
        raise ValueError("Vertrag nicht gefunden.")
    npid = int(new_posten_id)
    prow = next((p for p in ledger_repo.list_posten(conn) if p["id"] == npid), None)
    if not prow:
        raise ValueError("Haushaltsposten nicht gefunden.")
    cats = {c["id"]: c for c in ledger_repo.list_categories(conn)}
    cat = cats.get(prow["category_id"])
    if not cat or cat["kind"] != "expense":
        raise ValueError("Nur Kosten-Posten können einen Vertrag tragen.")
    if conn.execute("SELECT id FROM contracts WHERE posten_id=? AND id<>?", (npid, cid)).fetchone():
        raise ValueError("Dieser Posten trägt bereits einen anderen Vertrag.")
    conn.execute("UPDATE contracts SET posten_id=? WHERE id=?", (npid, cid))
    conn.commit()
