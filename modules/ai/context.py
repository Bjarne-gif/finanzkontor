"""KI-Kontext-Layer — read-only.

Verdichtet die vorhandenen `calc`-Ausgaben der Module zu kompakten Datenpaketen,
wie sie ein lokales LLM als Kontext bekommen würde. Rechnet nichts neu (das macht
`calc`), holt nur Kennzahlen + saubere Rohdaten und lässt technischen Ballast
(IDs, sort, tags, Timestamps, Verschlüsselungsfelder) weg.

Jedes Paket hat eine stabile Form:
    key            – interner Strom-Schlüssel
    titel          – lesbarer Name
    sensibel       – ob es persönliche Finanzdaten enthält (steuert später die Freigabe)
    kompakt        – nur die Kennzahlen (schnelle Überblicksfragen)
    detail         – Kennzahlen + saubere Rohdaten (für konkrete Fragen; „voll"-Freigabe)
    klartext       – kurzer deutscher Abriss der Kennzahlen (leicht verdaulich fürs LLM)
"""

from modules.ledger import repo as ledger_repo
from modules.ledger import calc as ledger_calc
from modules.split import repo as split_repo
from modules.split import calc as split_calc
from modules.assets import repo as assets_repo
from modules.assets import calc as assets_calc
from modules.contracts import repo as contracts_repo
from modules.contracts import calc as contracts_calc


def _eur(v):
    """1060.0 -> '1.060 €' (deutsche Tausenderpunkte, ohne Nachkommastellen bei glatten Beträgen)."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    s = f"{n:,.0f}".replace(",", ".")
    return f"{s} €"


def _monthly_expenses(conn):
    """Monatliche Gesamtkosten aus dem Ledger — gleiche Quelle wie das Assets-Modul."""
    cats = ledger_repo.list_categories(conn)
    posten = ledger_repo.list_posten(conn)
    return ledger_calc.build_summary(cats, posten)["totals"]["kosten"]["monthly"]


def vermoegen_paket(conn):
    """Baut das Vermögens-Datenpaket aus dem vorhandenen Assets-`calc`."""
    classes = assets_repo.list_classes(conn)
    positions = assets_repo.list_positions(conn)
    expenses = _monthly_expenses(conn)
    a = assets_calc.compute_assets(classes, positions, expenses)   # exakt wie im App-State
    tot, kpis, alloc = a["totals"], a["kpis"], a["allocation"]

    def _alloc(d):   # {kategorie: {wert, prozent}} -> schlanke Liste
        return [{"gruppe": k, "wert": v["wert"], "prozent": v["prozent"]} for k, v in d.items()]

    # --- Kennzahlen (kompakt) ---
    kompakt = {
        "nettovermoegen":  tot["nettovermoegen"],
        "gesamtbesitz":    tot["gesamtbesitz"],
        "gesamtschulden":  tot["gesamtschulden"],
        "griffbereit":     tot["griffbereit"],
        "sachwerte":       tot["sachwerte"],
        "eigenkapitalquote":  kpis["eigenkapitalquote"],
        "verschuldungsgrad":  kpis["verschuldungsgrad"],
        "risikoquote":        kpis["risikoquote"],
        "notgroschen_reichweite_monate": kpis["notgroschen_reichweite_monate"],
        "klumpenrisiko":      kpis["klumpenrisiko"],   # {name, value, prozent}
        "aufteilung": {
            "liquiditaet": _alloc(alloc["liquiditaet"]),
            "risiko":      _alloc(alloc["risiko"]),
            "art":         _alloc(alloc["art"]),
        },
    }

    # --- Detail: Klassen + Positionen (schlank, ohne technischen Ballast) ---
    detail_klassen = []
    for c in a["classes"]:
        detail_klassen.append({
            "klasse": c["name"],
            "art": "schuld" if c["kind"] == "debt" else "besitz",
            "summe": c["sum"],
            "anteil": c["anteil"],
            "positionen": [
                {"name": p["name"], "wert": p["value"], "anteil": p["anteil"]}
                for p in c.get("positions", [])
            ],
        })

    # --- Klartext (fürs LLM) ---
    klump = kompakt["klumpenrisiko"]
    klump_txt = (f" Größte Position: {klump['name']} ({klump['prozent']:.0f} %)."
                 if klump.get("name") and klump.get("prozent") is not None else "")
    reich = kompakt["notgroschen_reichweite_monate"]
    reich_txt = (f" Notgroschen reicht {reich:.1f} Monate." if reich is not None else "")
    klartext = (
        f"Vermögen: Netto {_eur(kompakt['nettovermoegen'])}, "
        f"davon griffbereit {_eur(kompakt['griffbereit'])}. "
        f"Verschuldungsgrad {kompakt['verschuldungsgrad']:.0f} %."
        f"{reich_txt}{klump_txt}"
    )

    return {
        "key": "vermoegen",
        "titel": "Vermögen (Besitz, Schulden & Rücklagen)",
        "sensibel": True,
        "kompakt": kompakt,
        "detail": {"klassen": detail_klassen},
        "klartext": klartext,
    }


def vertraege_paket(conn):
    """Baut das Verträge-Datenpaket aus dem vorhandenen Contracts-`calc`.

    Die `posten_id` je Vertrag ist der Anker zum Haushalt: darüber verbindet die KI
    einen Vertrag mit seinem Kosten-Posten (z. B. Vodafone-Vertrag -> Posten -> €/Jahr).
    """
    posten = {p["id"]: p for p in ledger_repo.list_posten(conn)}
    categories = contracts_repo.list_categories(conn)
    contracts = contracts_repo.list_contracts(conn)
    r = contracts_calc.compute_contracts(posten, categories, contracts)
    items, met = r["contracts"], r["metrics"]

    nd = met.get("next_deadline")
    kompakt = {
        "anzahl_aktiv": met["count_active"],
        "kosten_monat": met["cost"]["monthly"],
        "kosten_jahr":  met["cost"]["yearly"],
        "naechste_frist": None if not nd else {
            "partner": nd.get("vendor") or "",
            "kuendbar_bis": nd.get("stichtag"),
            "tage": nd.get("days"),
        },
        "handlungsbedarf": {
            "gesamt":          met["action_needed"]["total"],
            "frist_verpasst":  met["action_needed"]["missed"],
            "laeuft_bald_aus": met["action_needed"]["ending_soon"],
        },
        "sparpotenzial": {
            "anzahl": met["savings_potential"]["count"],
            "monat":  met["savings_potential"]["monthly"],
            "jahr":   met["savings_potential"]["yearly"],
        },
        "anstehende_fristen": [
            {"partner": u.get("vendor") or "", "posten_id": u.get("posten_id"),
             "kuendbar_bis": u.get("stichtag"), "tage": u.get("days")}
            for u in met.get("upcoming", [])
        ],
    }

    detail = []
    for it in items:
        detail.append({
            "posten_id": it["posten_id"],          # Anker -> Haushalts-Posten
            "partner": it.get("partner_name") or "",
            "bezeichnung": it.get("label") or "",
            "kategorie": it.get("category") or "",
            "monat": it["monthly"],
            "jahr":  it["yearly"],
            "status": it["status"],
            "kuendbar_bis": it.get("stichtag"),
            "tage_bis_frist": it.get("days_to_stichtag"),
            "jederzeit_kuendbar": it.get("anytime", False),
            "frist_verpasst": it.get("missed", False),
        })

    frist_txt = ""
    if kompakt["naechste_frist"]:
        nf = kompakt["naechste_frist"]
        frist_txt = f" Nächste Frist: {nf['partner']}, kündbar bis {nf['kuendbar_bis']} ({nf['tage']} Tage)."
    spar = kompakt["sparpotenzial"]
    spar_txt = (f" Sparpotenzial: {spar['anzahl']} Verträge, {_eur(spar['monat'])}/Monat."
                if spar["anzahl"] else "")
    klartext = (
        f"Verträge: {kompakt['anzahl_aktiv']} aktiv, zusammen {_eur(kompakt['kosten_monat'])}/Monat "
        f"({_eur(kompakt['kosten_jahr'])}/Jahr).{frist_txt}{spar_txt}"
    )

    return {
        "key": "vertraege",
        "titel": "Verträge & Abos (Kosten & Fristen)",
        "sensibel": True,
        "kompakt": kompakt,
        "detail": {"vertraege": detail},
        "klartext": klartext,
    }


def haushalt_paket(conn):
    """Baut das Haushalts-Datenpaket aus dem vorhandenen Ledger-`calc`."""
    cats = ledger_repo.list_categories(conn)
    posten = ledger_repo.list_posten(conn)
    summary = ledger_calc.build_summary(cats, posten)          # exakt wie im App-State
    tot = summary["totals"]

    # --- Kennzahlen (kompakt) ---
    kompakt = {
        "einnahmen_monat":   tot["einnahmen"]["monthly"],
        "kosten_monat":      tot["kosten"]["monthly"],
        "ueberschuss_monat": tot["ueberschuss"]["monthly"],
        "ueberschuss_prozent": tot["ueberschuss_prozent"],
        "einnahmen_jahr":    tot["einnahmen"]["yearly"],
        "kosten_jahr":       tot["kosten"]["yearly"],
        "ueberschuss_jahr":  tot["ueberschuss"]["yearly"],
    }

    # --- Kategorien verdichtet (Top-Kosten zuerst) ---
    kosten_kats = sorted(
        [b for b in summary["breakdown"] if b["kind"] == "expense"],
        key=lambda b: b["monthly"], reverse=True,
    )
    einnahme_kats = sorted(
        [b for b in summary["breakdown"] if b["kind"] == "income"],
        key=lambda b: b["monthly"], reverse=True,
    )
    kompakt["top_kosten"] = [
        {"kategorie": b["name"], "monat": b["monthly"]} for b in kosten_kats[:5]
    ]

    # --- Detail: saubere Posten je Kategorie (kein technischer Ballast) ---
    detail_kats = []
    for c in summary["categories"]:
        posten_clean = [
            {
                "posten_id": p["id"],          # Verknüpfungspunkt: Verträge zeigen hierauf
                "name":     p["name"],
                "betrag":   p["amount"],
                "intervall": p["interval"],
                "monat":    p["monthly"],
                "jahr":     p["yearly"],
            }
            for p in c.get("posten", [])
        ]
        detail_kats.append({
            "kategorie": c["name"],
            "art": "einnahme" if c["kind"] == "income" else "kosten",
            "monat": c["monthly"],
            "posten": posten_clean,
        })

    # --- Töpfe (Überschussverwendung, split-Modul) ---
    # Der Ledger-Überschuss fließt in Töpfe; das gehört zum Haushaltsbild dazu.
    pots = split_repo.list_pots(conn)
    split = split_calc.compute_split(kompakt["ueberschuss_monat"], pots)
    toepfe = {
        "ueberschuss_monat": split["ueberschuss"]["monthly"],
        "verteilt_monat":    split["verteilt"]["monthly"],
        "uebrig_monat":      split["uebrig"]["monthly"],   # frei verfügbar nach Töpfen
        "liste": [
            {
                "name":  t["name"],
                "modus": "prozent" if t.get("mode") == "percent" else "euro",
                "wert":  t["value"],
                "zugewiesen_monat": t["assign"]["monthly"],
                "zugewiesen_jahr":  t["assign"]["yearly"],
            }
            for t in split["pots"]
        ],
    }
    kompakt["toepfe"] = toepfe

    # --- Klartext-Abriss (leicht fürs LLM) ---
    top_txt = ", ".join(f"{b['name']} {_eur(b['monthly'])}" for b in kosten_kats[:3]) or "—"
    topf_txt = ", ".join(f"{t['name']} {_eur(t['zugewiesen_monat'])}" for t in toepfe["liste"][:3])
    klartext = (
        f"Haushalt: Einnahmen {_eur(kompakt['einnahmen_monat'])}/Monat, "
        f"Kosten {_eur(kompakt['kosten_monat'])}/Monat, "
        f"Überschuss {_eur(kompakt['ueberschuss_monat'])}/Monat "
        f"({kompakt['ueberschuss_prozent']:.0f} %). "
        f"Größte Kostenblöcke: {top_txt}."
    )
    if toepfe["liste"]:
        klartext += (
            f" Überschussverwendung: {topf_txt}"
            + (f" — frei übrig {_eur(toepfe['uebrig_monat'])}/Monat." if toepfe["uebrig_monat"] else ".")
        )

    return {
        "key": "haushalt",
        "titel": "Haushalt (Einnahmen, Kosten & Töpfe)",
        "sensibel": True,
        "kompakt": kompakt,
        "detail": {"kategorien": detail_kats},
        "klartext": klartext,
    }


# ---------------------------------------------------------------------------
# Kontext für das LLM: Klartext-Abrisse der FREIGEGEBENEN Bereiche
# ---------------------------------------------------------------------------
_PAKETE = {
    "haushalt":  haushalt_paket,
    "vermoegen": vermoegen_paket,
    "vertraege": vertraege_paket,
}


def context_text(conn, allowed):
    """Fügt die Klartext-Zusammenfassungen der freigegebenen Bereiche zusammen.

    Seit v0.12.16 geht an die KI die vollständige Übergabe aus `uebergabe.py`;
    diese Kurzfassung bleibt nur für Vergleiche/Tests erhalten.
    """
    parts = []
    for key in allowed:
        fn = _PAKETE.get(key)
        if not fn:
            continue
        try:
            p = fn(conn)
            if p.get("klartext"):
                parts.append(p["klartext"])
        except Exception:  # noqa: BLE001 — ein defekter Bereich soll die Anfrage nicht sprengen
            continue
    return "\n".join(parts)
