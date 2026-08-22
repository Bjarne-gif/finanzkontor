"""DB-Schema des Ledger-Bausteins (Migration v2) + Seed der Standard-Kategorien."""
from datetime import datetime, timezone

from core import crypto

STANDARD = [
    ("income",  "Einnahmen"),
    ("expense", "Fixe Kosten"),
    ("expense", "Variable Kosten"),
]


def _now():
    return datetime.now(timezone.utc).isoformat()


def migrate_v2(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL CHECK(kind IN ('income','expense')),
            name_enc   TEXT NOT NULL,
            color      TEXT,
            sort       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS posten (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            name_enc     TEXT NOT NULL,
            amount_enc   TEXT NOT NULL,
            interval     TEXT NOT NULL DEFAULT 'monatlich',
            active       INTEGER NOT NULL DEFAULT 1,
            note_enc     TEXT,
            tags         TEXT,
            income_role  TEXT,
            sort         INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT,
            updated_at   TEXT
        )""")
    # Standard-Kategorien nur seeden, wenn noch keine da sind.
    n = conn.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"]
    if n == 0:
        for i, (kind, name) in enumerate(STANDARD):
            conn.execute(
                "INSERT INTO categories(kind, name_enc, sort, created_at) VALUES(?,?,?,?)",
                (kind, crypto.encrypt(name), i, _now()),
            )
