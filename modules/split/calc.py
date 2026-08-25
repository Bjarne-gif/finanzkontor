"""Aufteilungs-Rechnung: Überschuss auf Töpfe verteilen.

Eine Quelle der Wahrheit für die Verteilung. Regeln (aus der Konzeptphase):
  - Jeder Topf hat einen Zielbetrag: fester € -Betrag ODER Prozent des
    (positiven) Überschusses.
  - Wollen die Töpfe zusammen MEHR als der Überschuss, wird anteilig (proportional)
    gedeckelt – keine Reihenfolge-Priorität. "Übrig" wird dabei nie negativ.
  - Bei Überschuss <= 0 (Verlust/Null) wird nichts verteilt.

Ausgaben sind serientauglich (monatlich + jährlich je Topf und in Summe),
damit spätere Auswertungen / KI direkt darauf aufsetzen können.
"""


def _mv(monthly):
    return {"monthly": round(monthly, 2), "yearly": round(monthly * 12, 2)}


def compute_split(ueberschuss_monthly, pots):
    """pots: Liste aus repo.list_pots (id, name, color, mode, value, sort).

    Gibt die verteilten Beträge je Topf + Summen zurück (monatlich/jährlich).
    """
    us = round(float(ueberschuss_monthly or 0), 2)
    base = us if us > 0 else 0.0

    # 1) Zielbeträge je Topf (monatlich)
    targets = []
    for p in pots:
        val = float(p.get("value") or 0)
        if p.get("mode") == "percent":
            target = base * val / 100.0
        else:
            target = val
        targets.append(max(0.0, target))

    total_target = round(sum(targets), 2)

    # 2) Deckelung: passt nicht in den Überschuss -> proportional skalieren
    scaled = False
    if base <= 0:
        assigned = [0.0 for _ in targets]
    elif total_target > base and total_target > 0:
        scale = base / total_target
        assigned = [t * scale for t in targets]
        scaled = True
    else:
        assigned = list(targets)

    verteilt = round(sum(assigned), 2)
    uebrig = round(us - verteilt, 2)   # bei Verlust ehrlich negativ

    pots_out = []
    for p, a in zip(pots, assigned):
        pots_out.append({
            "id": p["id"], "name": p["name"], "color": p.get("color"),
            "mode": p.get("mode"), "value": float(p.get("value") or 0),
            "sort": p.get("sort", 0),
            "assign": _mv(round(a, 2)),
            "capped": scaled,
        })

    return {
        "ueberschuss": _mv(us),
        "pots": pots_out,
        "verteilt": _mv(verteilt),
        "uebrig": _mv(uebrig),
        "scaled": scaled,
    }
