"""Berechnungen: Normalisierung auf Monat/Jahr + Gesamtübersicht.

Eine Quelle der Wahrheit. Nur AKTIVE Posten zählen in die Summen.
"""

# Wie oft pro Jahr fällt ein Intervall an -> daraus Monat & Jahr.
PER_YEAR = {
    "taeglich":     365.0,
    "woechentlich": 365.0 / 7.0,
    "monatlich":    12.0,
    "quartal":      4.0,
    "jaehrlich":    1.0,
}
INTERVALS = list(PER_YEAR.keys())


def monthly_of(amount, interval):
    return amount * PER_YEAR.get(interval, 12.0) / 12.0


def yearly_of(amount, interval):
    return amount * PER_YEAR.get(interval, 12.0)


def _mv(amount, interval):
    return {"monthly": round(monthly_of(amount, interval), 2),
            "yearly":  round(yearly_of(amount, interval), 2)}


def _tags(p):
    return [t for t in (p.get("tags") or "").split(",") if t]


def build_summary(categories, posten, exclude_tag="sprit"):
    by_cat = {}
    for p in posten:
        by_cat.setdefault(p["category_id"], []).append(p)

    cats_out = []
    einn_m = einn_y = spar_m = spar_y = kost_m = kost_y = kox_m = kox_y = 0.0
    breakdown = []

    for c in categories:
        items = sorted(by_cat.get(c["id"], []), key=lambda x: (x["sort"], x["id"]))
        cm = cy = 0.0
        pout = []
        for p in items:
            mv = _mv(p["amount"], p["interval"])
            if p["active"]:
                cm += mv["monthly"]; cy += mv["yearly"]
                if c["kind"] == "income":
                    if (p.get("income_role") or "einnahme") == "sparen":
                        spar_m += mv["monthly"]; spar_y += mv["yearly"]
                    else:
                        einn_m += mv["monthly"]; einn_y += mv["yearly"]
                else:
                    kost_m += mv["monthly"]; kost_y += mv["yearly"]
                    if exclude_tag not in _tags(p):
                        kox_m += mv["monthly"]; kox_y += mv["yearly"]
            pout.append({**p, "monthly": mv["monthly"], "yearly": mv["yearly"]})
        cats_out.append({**c, "monthly": round(cm, 2), "yearly": round(cy, 2), "posten": pout})
        breakdown.append({"category_id": c["id"], "name": c["name"], "kind": c["kind"],
                          "monthly": round(cm, 2), "yearly": round(cy, 2)})

    def pct(surplus, base):
        return round(surplus / base * 100, 1) if base else None

    us_m, us_y = einn_m - kost_m, einn_y - kost_y
    ux_m, ux_y = einn_m - kox_m, einn_y - kox_y

    totals = {
        "einnahmen":              {"monthly": round(einn_m, 2), "yearly": round(einn_y, 2)},
        "sparen":                 {"monthly": round(spar_m, 2), "yearly": round(spar_y, 2)},
        "kosten":                 {"monthly": round(kost_m, 2), "yearly": round(kost_y, 2)},
        "kosten_ohne_sprit":      {"monthly": round(kox_m, 2),  "yearly": round(kox_y, 2)},
        "ueberschuss":            {"monthly": round(us_m, 2),   "yearly": round(us_y, 2)},
        "ueberschuss_ohne_sprit": {"monthly": round(ux_m, 2),   "yearly": round(ux_y, 2)},
        "ueberschuss_prozent":              pct(us_m, einn_m),
        "ueberschuss_ohne_sprit_prozent":   pct(ux_m, einn_m),
    }
    return {"categories": cats_out, "totals": totals, "breakdown": breakdown,
            "exclude_tag": exclude_tag}
