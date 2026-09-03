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
