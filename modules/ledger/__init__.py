"""Ledger-Baustein: registriert Blueprint, Frontend-Panel und Migration."""
from core import registry
from modules.ledger.api import bp
from modules.ledger.schema import migrate_v2

registry.register("ledger", "Ledger", order=10, blueprint=bp, panel="js/modules/ledger.js")
registry.register_migration(2, migrate_v2)
