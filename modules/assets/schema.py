"""DB-Schema des Vermögens-Bausteins (Stufe 3, Migration v4).

Zwei Tabellen, analog zum Ledger:
  - asset_classes:    Klassen (Art 'asset'=Besitz / 'debt'=Schuld). Besitz-Klassen
                      tragen ein 3-Achsen-Profil (Liquidität/Risiko/Art) als KLARE
                      Struktur-Felder, damit ohne Entschlüsseln gruppiert werden kann.
  - asset_positions:  Positionen je Klasse (Name, Wert, Notiz, aktiv).

Sensible Werte (Name, Wert, Notiz) liegen wie im Ledger Fernet-verschlüsselt;
strukturelle Felder (Art, Profil, aktiv, Sortierung) klar zum Rechnen/Filtern.

Additiv: legt nur neue Tabellen an, bestehende Ledger-/Split-Daten bleiben
unberührt. Es werden bewusst KEINE Standard-Klassen geseedet.
"""


def migrate_v4(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS asset_classes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL DEFAULT 'asset'
                       CHECK(kind IN ('asset','debt')),
            name_enc   TEXT NOT NULL,
            liq        TEXT CHECK(liq  IS NULL OR liq  IN ('liquide','halb-liquide','illiquide')),
            risk       TEXT CHECK(risk IS NULL OR risk IN ('sicher','mittel','hoch')),
            art        TEXT CHECK(art  IS NULL OR art  IN ('Geldwert','Sachwert')),
            color      TEXT,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS asset_positions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id   INTEGER NOT NULL REFERENCES asset_classes(id) ON DELETE CASCADE,
            name_enc   TEXT NOT NULL,
            value_enc  TEXT NOT NULL,
            note_enc   TEXT,
            active     INTEGER NOT NULL DEFAULT 1,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )""")
