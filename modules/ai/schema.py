"""KI-Baustein — Schema/Migrationen.

Migration v12: kleine Einstellungs-Tabelle `ai_settings` (Schlüssel/Wert).
Legt nur eine neue Tabelle an, rührt keine bestehenden Daten an — verlustfrei.
Speichert: ob die KI aktiviert ist und welche Bereiche freigegeben sind.
Gehört bewusst in die DB, damit die Freigabe mit der Datenbank mitwandert.
"""


def migrate_v12(conn):
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_settings ("
        "  key   TEXT PRIMARY KEY,"
        "  value TEXT"
        ")"
    )


def migrate_v13(conn):
    """Chatverlauf der KI (pro DB). Nachrichtentext verschlüsselt (Fernet),
    nur Rolle/Zeit im Klartext. Neue Tabelle, rührt nichts an — verlustfrei."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat ("
        "  id         INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  role       TEXT NOT NULL,"          # 'user' | 'assistant'
        "  text_enc   TEXT NOT NULL,"
        "  created_at TEXT NOT NULL"
        ")"
    )
