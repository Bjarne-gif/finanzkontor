"""Berechnungen fürs Vermögen – serientauglich (Basis für Anzeige, Diagramme, KI).

Eine Quelle der Wahrheit. Nur AKTIVE Positionen zählen in die Summen.

Ausgabe:
  classes[]  – je Klasse Summe + Anteil am Gesamtbesitz, Positionen mit Anteil
  totals     – Gesamtbesitz, Gesamtschulden, Nettovermögen, griffbereit, Sachwerte
  allocation – Aufteilung nach Liquidität / Risiko / Art (Wert + %)
  kpis       – Eigenkapitalquote, Verschuldungsgrad, Sachwertquote, Cash-Quote,
               Anlagequote, Risikoquote (mittel+hoch), Sicher-Quote,
               Notgroschen-Reichweite (Monate), Klumpenrisiko (größte Position)
"""


def _pct(part, base):
    return round(part / base * 100, 1) if base else None


def compute_assets(classes, positions, monthly_expenses=0.0):
    by_class = {}
    for p in positions:
        by_class.setdefault(p["class_id"], []).append(p)

    gesamtbesitz = 0.0
    gesamtschulden = 0.0
    # Aggregatoren für Profile (nur Besitz)
    liq_sum  = {"liquide": 0.0, "halb-liquide": 0.0, "illiquide": 0.0}
    risk_sum = {"sicher": 0.0, "mittel": 0.0, "hoch": 0.0}
    art_sum  = {"Geldwert": 0.0, "Sachwert": 0.0}
    biggest = None  # Klumpenrisiko: größte aktive Besitz-Position

    # Erst die Summen bilden (für Anteile brauchen wir Gesamtbesitz)
    class_sums = {}
    for c in classes:
        items = sorted(by_class.get(c["id"], []), key=lambda x: (x["sort"], x["id"]))
        s = sum(p["value"] for p in items if p["active"])
        class_sums[c["id"]] = round(s, 2)
        if c["kind"] == "asset":
            gesamtbesitz += s
            prof = c.get("profile") or {}
            if prof.get("liq")  in liq_sum:  liq_sum[prof["liq"]]   += s
            if prof.get("risk") in risk_sum: risk_sum[prof["risk"]] += s
            if prof.get("art")  in art_sum:  art_sum[prof["art"]]   += s
            for p in items:
                if p["active"] and (biggest is None or p["value"] > biggest["value"]):
                    biggest = {"name": p["name"], "value": round(p["value"], 2)}
        else:
            gesamtschulden += s

    gesamtbesitz = round(gesamtbesitz, 2)
    gesamtschulden = round(gesamtschulden, 2)
    netto = round(gesamtbesitz - gesamtschulden, 2)

    # Klassen + Positionen mit Anteil am Gesamtbesitz ausgeben
    classes_out = []
    for c in classes:
        items = sorted(by_class.get(c["id"], []), key=lambda x: (x["sort"], x["id"]))
        pout = []
        for p in items:
            share = _pct(p["value"], gesamtbesitz) if (p["active"] and gesamtbesitz) else 0.0
            pout.append({**p, "anteil": share})
        cs = class_sums[c["id"]]
        classes_out.append({
            **c, "sum": cs,
            "anteil": _pct(cs, gesamtbesitz) if gesamtbesitz else 0.0,
            "positions": pout,
        })

    griffbereit = round(liq_sum["liquide"], 2)
    sachwerte = round(art_sum["Sachwert"], 2)
    risiko_mittel_hoch = round(risk_sum["mittel"] + risk_sum["hoch"], 2)

    def alloc(d):
        return {k: {"wert": round(v, 2), "prozent": _pct(v, gesamtbesitz)} for k, v in d.items()}

    reichweite = round(griffbereit / monthly_expenses, 1) if monthly_expenses else None

    kpis = {
        "eigenkapitalquote":  _pct(netto, gesamtbesitz),
        "verschuldungsgrad":  _pct(gesamtschulden, gesamtbesitz),
        "sachwertquote":      _pct(sachwerte, gesamtbesitz),
        "liquide_quote":      _pct(griffbereit, gesamtbesitz),
        "illiquide_quote":    _pct(liq_sum["illiquide"], gesamtbesitz),
        "risikoquote":        _pct(risiko_mittel_hoch, gesamtbesitz),
        "sicher_quote":       _pct(risk_sum["sicher"], gesamtbesitz),
        "notgroschen_reichweite_monate": reichweite,
        "klumpenrisiko": {
            "name":  biggest["name"] if biggest else None,
            "value": biggest["value"] if biggest else 0.0,
            "prozent": _pct(biggest["value"], gesamtbesitz) if (biggest and gesamtbesitz) else None,
        },
    }

    return {
        "classes": classes_out,
        "totals": {
            "gesamtbesitz": gesamtbesitz,
            "gesamtschulden": gesamtschulden,
            "nettovermoegen": netto,
            "griffbereit": griffbereit,
            "sachwerte": sachwerte,
        },
        "allocation": {
            "liquiditaet": alloc(liq_sum),
            "risiko": alloc(risk_sum),
            "art": alloc(art_sum),
        },
        "kpis": kpis,
        "monthly_expenses": round(monthly_expenses, 2),
    }
