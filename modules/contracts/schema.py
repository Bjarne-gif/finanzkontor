"""DB-Schema des Verträge-Bausteins (Stufe 4, Migration v5).

Ein Vertrag ist KEIN eigenes Objekt, sondern ein Vertragsprofil, das an einem
bestehenden Ledger-Posten hängt (Modell B). Deshalb 1:1 über posten_id:

  - contracts:      genau ein Profil je Posten (posten_id UNIQUE, ON DELETE CASCADE).
                    Löscht man den Posten im Ledger, verschwindet der Vertrag
                    automatisch mit – keine verwaisten Referenzen. Der BETRAG lebt
                    weiter im Posten und wird hier bewusst NICHT dupliziert.
  - contract_docs:  hinterlegte Dateien (PDFs) je Vertrag, ON DELETE CASCADE.

Sensible Werte (Anbieter, Notiz, Original-Dateiname) liegen wie im Rest des Tools
Fernet-verschlüsselt; strukturelle Felder (Datum, Frist, Status, Flags) klar zum
Rechnen und Filtern.

Additiv: legt nur neue Tabellen an, Ledger/Split/Assets bleiben unberührt.
Es werden bewusst KEINE Verträge geseedet.
"""


def migrate_v5(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contracts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            posten_id    INTEGER NOT NULL UNIQUE
                         REFERENCES posten(id) ON DELETE CASCADE,
            vendor_enc   TEXT NOT NULL,
            end_date     TEXT,                       -- ISO YYYY-MM-DD, NULL = jederzeit
            notice_n     INTEGER NOT NULL DEFAULT 0, -- Kündigungsfrist-Zahl
            notice_unit  TEXT NOT NULL DEFAULT 'Monate'
                         CHECK(notice_unit IN ('Monate','Wochen')),
            renew_n      INTEGER NOT NULL DEFAULT 0, -- Verlängerung in Monaten
            anytime      INTEGER NOT NULL DEFAULT 0, -- 1 = jederzeit kündbar
            status       TEXT NOT NULL DEFAULT 'aktiv'
                         CHECK(status IN ('aktiv','pausiert','gekündigt')),
            pause_until  TEXT,                       -- ISO YYYY-MM-DD, NULL = unbegrenzt
            candidate    INTEGER NOT NULL DEFAULT 0, -- Kündigungskandidat
            note_enc     TEXT,
            created_at   TEXT,
            updated_at   TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contract_docs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id  INTEGER NOT NULL
                         REFERENCES contracts(id) ON DELETE CASCADE,
            filename_enc TEXT NOT NULL,   -- Original-Dateiname, verschlüsselt
            stored_name  TEXT NOT NULL,   -- zufälliger Name auf der Platte
            size         INTEGER NOT NULL DEFAULT 0,
            sort         INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT
        )""")


def migrate_v6(conn):
    """Eigene Vertragskategorien (wie asset_classes) + Zuordnung am Vertrag.

    Additiv: neue Tabelle + eine Spalte. Bewusst KEIN Seed – leer starten,
    der Nutzer legt seine Kategorien selbst an (wie beim Vermögen).
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS contract_categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name_enc   TEXT NOT NULL,
            color      TEXT,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )""")
    # category_id an contracts anhängen (nullable; NULL = 'Ohne Kategorie').
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(contracts)").fetchall()]
    if "category_id" not in cols:
        conn.execute(
            "ALTER TABLE contracts ADD COLUMN category_id INTEGER "
            "REFERENCES contract_categories(id)")


def migrate_v7(conn):
    """Sortierung je Vertrag (fuer nach-oben/unten + spaeteres Drag)."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(contracts)").fetchall()]
    if "sort" not in cols:
        conn.execute("ALTER TABLE contracts ADD COLUMN sort INTEGER NOT NULL DEFAULT 0")


def migrate_v8(conn):
    """Optionale Bezeichnung/Tarif am Vertrag (z. B. 'Prime' vs 'Audible' bei gleichem Anbieter)."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(contracts)").fetchall()]
    if "label_enc" not in cols:
        conn.execute("ALTER TABLE contracts ADD COLUMN label_enc TEXT")


def migrate_v9(conn):
    """Ein-Konzept-Pause: 'pausiert' wird nicht mehr als Vertrags-Status geführt,
    sondern über den inaktiven Haushaltsposten. Bestehende pausierte Verträge
    normalisieren: Posten inaktiv, Vertrags-Status zurück auf 'aktiv'
    (pause_until bleibt als Auto-Reaktivierungs-Datum erhalten)."""
    rows = conn.execute("SELECT posten_id FROM contracts WHERE status='pausiert'").fetchall()
    for r in rows:
        conn.execute("UPDATE posten SET active=0 WHERE id=?", (r["posten_id"],))
    conn.execute("UPDATE contracts SET status='aktiv' WHERE status='pausiert'")


def migrate_v10(conn):
    """Dokumente überleben das Löschen ihres Vertrags/Postens als 'verwaist'.

    contract_docs.contract_id wird nullable und die Kaskade von ON DELETE CASCADE
    auf ON DELETE SET NULL umgestellt. Wird ein Vertrag (oder via Ledger-Kaskade
    der Posten) gelöscht, bleibt die Datei erhalten und ihr contract_id wird NULL
    (= verwaist, in der Dateiverwaltung wieder zuordenbar). SQLite kann Spalten
    nicht ändern -> Tabelle neu aufbauen und Daten übernehmen."""
    conn.execute("""
        CREATE TABLE contract_docs_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id  INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
            filename_enc TEXT NOT NULL,
            stored_name  TEXT NOT NULL,
            size         INTEGER NOT NULL DEFAULT 0,
            sort         INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT
        )""")
    conn.execute("""INSERT INTO contract_docs_new(id,contract_id,filename_enc,stored_name,size,sort,created_at)
                    SELECT id,contract_id,filename_enc,stored_name,size,sort,created_at FROM contract_docs""")
    conn.execute("DROP TABLE contract_docs")
    conn.execute("ALTER TABLE contract_docs_new RENAME TO contract_docs")


# Standard-Reihenfolge der festen Partner-Felder (core_key, Label, Typ).
# Werden vorab je Partner angelegt (leer) – konsistente Ansicht, alle verschiebbar.
PARTNER_CORE_FIELDS = [
    ("contact",      "Ansprechpartner",    "Text"),
    ("cancel_email", "Kündigungs-E-Mail",  "E-Mail"),
    ("hotline",      "Hotline",            "Telefon"),
    ("portal",       "Kundenportal",       "URL"),
    ("postal",       "Postanschrift",      "Adresse"),
    ("note",         "Notiz",              "Freitext"),
]

# Farbpalette für Partner-Avatare (wie Kategorien; für spätere Diagramme unterscheidbar)
PARTNER_COLORS = ["#8f9fd9", "#6fb98a", "#d9b877", "#c49ad0", "#8fb3c9",
                  "#d99a76", "#86bd8f", "#b39ddb", "#e0a13a", "#7fc4c0"]


def migrate_v11(conn):
    """Vertragspartner als eigene Entität (wie Vertragskategorien).

    Neu:
      - contract_partners: Stammdaten (Name verschlüsselt; Typ/Branche/Farbe klar).
      - partner_fields:    ALLE Angaben (feste + eigene), je Feld Label+Typ+Wert,
                           is_core/core_key für die feste, nicht löschbare Vorlage.
      - contracts.partner_id: nullable, ON DELETE SET NULL (Partner löschen ⇒
                           Vertrag verwaist, wird nicht gelöscht).

    Verlustfreie Übernahme: aus den bestehenden vendor_enc werden Partner erzeugt
    (Dubletten über normalisierten Namen zusammengefasst) und die Verträge
    zugeordnet; je Partner die festen Felder (leer) angelegt. vendor_enc bleibt
    vorerst als Sicherheitsnetz erhalten (Entfernen erst in einem späteren Schritt).
    """
    from datetime import datetime, timezone
    from core import crypto

    conn.execute("""
        CREATE TABLE IF NOT EXISTS contract_partners (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name_enc   TEXT NOT NULL,
            ptype      TEXT,
            branch     TEXT,
            color      TEXT,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS partner_fields (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            partner_id INTEGER NOT NULL
                       REFERENCES contract_partners(id) ON DELETE CASCADE,
            label_enc  TEXT NOT NULL,
            ftype      TEXT NOT NULL DEFAULT 'Text',
            value_enc  TEXT,
            is_core    INTEGER NOT NULL DEFAULT 0,
            core_key   TEXT,
            sort       INTEGER NOT NULL DEFAULT 0
        )""")

    cols = [r["name"] for r in conn.execute("PRAGMA table_info(contracts)").fetchall()]
    if "partner_id" not in cols:
        conn.execute("ALTER TABLE contracts ADD COLUMN partner_id INTEGER "
                     "REFERENCES contract_partners(id) ON DELETE SET NULL")

    now = datetime.now(timezone.utc).isoformat()

    def _seed_fields(pid):
        for i, (ck, label, ftype) in enumerate(PARTNER_CORE_FIELDS):
            conn.execute(
                "INSERT INTO partner_fields(partner_id,label_enc,ftype,value_enc,is_core,core_key,sort) "
                "VALUES(?,?,?,?,?,?,?)",
                (pid, crypto.encrypt(label), ftype, None, 1, ck, i))

    by_norm = {}  # normalisierter Name -> partner_id
    for r in conn.execute("SELECT id, vendor_enc FROM contracts").fetchall():
        try:
            vendor = crypto.decrypt(r["vendor_enc"]) if r["vendor_enc"] else ""
        except Exception:
            vendor = ""
        norm = vendor.strip().lower()
        if not norm:
            continue
        pid = by_norm.get(norm)
        if pid is None:
            color = PARTNER_COLORS[len(by_norm) % len(PARTNER_COLORS)]
            cur = conn.execute(
                "INSERT INTO contract_partners(name_enc,ptype,branch,color,sort,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (crypto.encrypt(vendor.strip()), None, None, color, len(by_norm), now, now))
            pid = cur.lastrowid
            by_norm[norm] = pid
            _seed_fields(pid)
        conn.execute("UPDATE contracts SET partner_id=? WHERE id=?", (pid, r["id"]))
    # vendor_enc bleibt erhalten (Sicherheitsnetz)
