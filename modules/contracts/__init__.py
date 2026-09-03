"""Verträge-Baustein (Stufe 4 – Verträge & Abos).

Registriert Blueprint und Migration v5. Ein Vertrag ist das Vertragsprofil eines
Ledger-Postens (1:1). Frontend-Panel folgt; das Backend steht eigenständig und
ist über /api/contracts abfragbar.
"""
from core import registry
from modules.contracts.api import bp
from modules.contracts.schema import migrate_v5, migrate_v6, migrate_v7, migrate_v8, migrate_v9

registry.register("contracts", "Verträge", order=40, blueprint=bp,
                  panel="js/modules/contracts.js")
registry.register_migration(5, migrate_v5)
registry.register_migration(6, migrate_v6)
registry.register_migration(7, migrate_v7)
registry.register_migration(8, migrate_v8)
registry.register_migration(9, migrate_v9)
