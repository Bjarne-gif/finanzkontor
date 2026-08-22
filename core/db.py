"""SQLite-Handling: mehrere DB-Dateien im DATA_DIR, Auswahl, Schema + Migrationen.

Jede DB ist eine eigenständige Datei. Das Tool findet alle *.db im DATA_DIR und
lässt eine davon aktiv setzen. Das Schema wächst über Migrationen, die die
Bausteine selbst mitbringen (core.registry.register_migration).
"""
import re
import sqlite3
from datetime import datetime, timezone

import config
from core import appstate, registry

BASELINE_VERSION = 1  # Stufe 0: nur meta-Tabelle


def _now():
    return datetime.now(timezone.utc).isoformat()


def safe_name(name: str) -> str:
    name = (name or "").strip()
    if not name.endswith(".db"):
        name += ".db"
    base = name[:-3]
    if not re.fullmatch(r"[A-Za-z0-9 _\-]{1,60}", base):
        raise ValueError("Ungültiger Name. Erlaubt: Buchstaben, Zahlen, Leer, _ und -")
    return base + ".db"


def db_path(name: str):
    return config.DATA_DIR / safe_name(name)


def list_databases():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(config.DATA_DIR.glob("*.db")):
        st = p.stat()
        out.append({
            "name": p.name,
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
        })
    return out


def _meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def _meta_set(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def _ensure_meta(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    if _meta_get(conn, "schema_version") is None:
        _meta_set(conn, "schema_version", BASELINE_VERSION)
        _meta_set(conn, "created_at", _now())
    conn.commit()


def _migrate(conn):
    current = int(_meta_get(conn, "schema_version", BASELINE_VERSION))
    target = registry.target_version()
    if current < target:
        applied = registry.run_migrations(conn, current)
        _meta_set(conn, "schema_version", applied)
        conn.commit()


def connect(name):
    conn = sqlite3.connect(str(db_path(name)))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_meta(conn)
    _migrate(conn)
    return conn


def create_database(name):
    name = safe_name(name)
    if db_path(name).exists():
        raise ValueError("Diese Datei existiert bereits.")
    connect(name).close()
    return name


def active_db():
    name = appstate.get("active_db")
    files = {f["name"] for f in list_databases()}
    if name in files:
        return name
    if files:
        name = sorted(files)[0]
        appstate.set("active_db", name)
        return name
    name = create_database(config.DEFAULT_DB_NAME)
    appstate.set("active_db", name)
    return name


def set_active_db(name):
    name = safe_name(name)
    if not db_path(name).exists():
        raise ValueError("Datei nicht gefunden.")
    appstate.set("active_db", name)
    return name
