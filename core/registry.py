"""Modul-Registry für die Bausteine.

Jeder Baustein (modules/<name>/) registriert sich hier mit:
  - id, name, order (Reihenfolge in der Oberfläche)
  - optional einem Flask-Blueprint (Backend-API)
  - optional einem Frontend-Panel (statischer JS-Pfad)

Stufe 0 hat noch keine Module – das Gerüst steht aber bereit.
"""

_modules = []


def register(mod_id, name, order=100, blueprint=None, panel=None):
    _modules.append({
        "id": mod_id,
        "name": name,
        "order": order,
        "blueprint": blueprint,
        "panel": panel,
    })


def all_modules():
    return sorted(_modules, key=lambda m: (m["order"], m["name"]))


def public_list():
    """Was das Frontend braucht, um Panels zu rendern (ohne Backend-Objekte)."""
    return [
        {"id": m["id"], "name": m["name"], "order": m["order"], "panel": m["panel"]}
        for m in all_modules()
    ]


def register_blueprints(app):
    for m in all_modules():
        if m["blueprint"] is not None:
            app.register_blueprint(m["blueprint"])


# ---- Migrationen: jeder Baustein bringt sein DB-Schema selbst mit ----------
# version -> Funktion(conn). Wird beim Verbinden auf DBs angewandt, die noch
# nicht auf dem Stand sind. So bleibt das Schema modular statt zentral.
_migrations = {}


def register_migration(version, fn):
    _migrations[int(version)] = fn


def target_version():
    return max([1, *_migrations.keys()])


def run_migrations(conn, current):
    applied = current
    for v in sorted(_migrations):
        if v > current:
            _migrations[v](conn)
            applied = v
    return applied
