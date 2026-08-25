"""DB-Schema des Aufteilungs-Bausteins (Stufe 2, Migration v3).

Speichert die "Töpfe" der Überschussverwendung: Name, Farbe, Modus (fester
Betrag € oder Prozent) und Wert. Sensible Werte (Name, Wert) liegen wie im
Ledger verschlüsselt in der DB; strukturelle Felder (Modus, Sortierung) klar,
damit ohne Entschlüsseln gerechnet/sortiert werden kann.

Es werden bewusst KEINE Standard-Töpfe geseedet – der Nutzer legt selbst an.
"""


def migrate_v3(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pots (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name_enc   TEXT NOT NULL,
            color      TEXT,
            mode       TEXT NOT NULL DEFAULT 'fixed'
                       CHECK(mode IN ('fixed','percent')),
            value_enc  TEXT NOT NULL,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )""")
