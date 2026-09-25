"""KI — vollständige Datenübergabe (read-only).

Baut aus den vorhandenen `repo`- und `calc`-Daten einen lesbaren deutschen Text,
der zu jeder Frage an die KI geht: je freigegebenem Bereich erst die Kennzahlen,
dann JEDER Eintrag einzeln – mit Kurz-IDs, über die alle Verknüpfungen sichtbar
sind (Haushaltsposten ↔ Vertrag ↔ Partner ↔ Dokument).

Kurz-IDs (intern eindeutige DB-Nummer mit Buchstaben davor):
    K = Haushalts-Kategorie   P = Haushaltsposten   V = Vertrag
    PA = Vertragspartner      D = Dokument          A = Vermögensklasse
    (Bereich „dokumente“: Inhalt der Dateien, siehe dokumente.py)
    VK = Vertragskategorie

Freigabe: Es erscheinen nur die Inhalte der freigegebenen Bereiche. Verweist ein
Eintrag auf einen nicht freigegebenen Bereich, steht dort nur die ID (bzw. beim
Vertrag der Partnername, der ohnehin Teil der Vertragsbezeichnung ist).
Bereiche: haushalt, vermoegen, vertraege, partner (Vertragspartner mit allen Feldern).

Rechnet nichts neu – alle Beträge, Summen, Fristen und Kennzahlen kommen aus `calc`,
also exakt wie in der App angezeigt.
"""
from datetime import date

from modules.ledger import repo as ledger_repo
from modules.ledger import calc as ledger_calc
from modules.split import repo as split_repo
from modules.split import calc as split_calc
from modules.assets import repo as assets_repo
from modules.assets import calc as assets_calc
from modules.contracts import repo as contracts_repo
from modules.contracts import calc as contracts_calc
from . import dokumente

INTERVALL = {"taeglich": "täglich", "woechentlich": "wöchentlich", "monatlich": "monatlich",
             "quartal": "vierteljährlich", "jaehrlich": "jährlich"}
LEGENDE = ("Kurz-IDs: K = Haushalts-Kategorie, P = Haushaltsposten, V = Vertrag, VK = Vertragskategorie, "
           "PA = Vertragspartner, D = Dokument, A = Vermögensklasse. Gleiche ID = derselbe Eintrag.")


# ---------------------------------------------------------------------------
# Formatierung
# ---------------------------------------------------------------------------
def _eur(v):
    """1234.5 -> '1.234,50 €' (deutsch, immer zwei Nachkommastellen)."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    s = f"{n:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{s} €"


def _pct(v, nachkomma=1):
    try:
        return f"{float(v):.{nachkomma}f} %".replace(".", ",")
    except (TypeError, ValueError):
        return "—"


def _datum(iso):
    """'2027-03-31' -> '31.03.2027'."""
    try:
        y, m, d = str(iso)[:10].split("-")
        return f"{d}.{m}.{y}"
    except ValueError:
        return str(iso or "—")


def _anzahl(n, einheit):
    """1 Monate -> 1 Monat, 2 Wochen bleibt."""
    einz = {"Monate": "Monat", "Wochen": "Woche"}
    return f"{n} {einz.get(einheit, einheit) if n == 1 else einheit}"


def _txt(s):
    """Freitext einzeilig machen (Notizen können Zeilenumbrüche enthalten)."""
    return " ".join(str(s or "").split())


# ---------------------------------------------------------------------------
# Haushalt
# ---------------------------------------------------------------------------
def haushalt_text(conn):
    cats = ledger_repo.list_categories(conn)
    posten = ledger_repo.list_posten(conn)
    s = ledger_calc.build_summary(cats, posten)
    t = s["totals"]
    vertrag_zu_posten = {c["posten_id"]: c["id"] for c in contracts_repo.list_contracts(conn)}

    z = ["=== Haushalt (Einnahmen, Kosten, Überschuss, Töpfe) ==="]
    z.append("Summen (nur aktive Posten zählen): "
             f"Einnahmen {_eur(t['einnahmen']['monthly'])}/Monat ({_eur(t['einnahmen']['yearly'])}/Jahr) · "
             f"Kosten {_eur(t['kosten']['monthly'])}/Monat ({_eur(t['kosten']['yearly'])}/Jahr) · "
             f"Überschuss {_eur(t['ueberschuss']['monthly'])}/Monat ({_eur(t['ueberschuss']['yearly'])}/Jahr, "
             f"{_pct(t['ueberschuss_prozent'])} der Einnahmen).")
    if t.get("sparen") and t["sparen"].get("monthly"):
        z.append(f"Davon als Sparen markierte Einnahmen: {_eur(t['sparen']['monthly'])}/Monat.")

    z.append("Kategorien und Posten (Betrag wie eingegeben, umgerechnet auf Monat und Jahr):")
    for c in s["categories"]:
        art = "Einnahmen" if c["kind"] == "income" else "Kosten"
        ps = c.get("posten", [])
        z.append(f"K{c['id']} {c['name']} ({art}) – Summe {_eur(c['monthly'])}/Monat, {_eur(c['yearly'])}/Jahr"
                 + ("" if ps else " – keine Posten"))
        for p in ps:
            teile = [f"  - P{p['id']} {p['name']}: {_eur(p['amount'])} {INTERVALL.get(p['interval'], p['interval'])} "
                     f"= {_eur(p['monthly'])}/Monat, {_eur(p['yearly'])}/Jahr"]
            if not p["active"]:
                teile.append("inaktiv/pausiert (zählt nicht in die Summen)")
            if c["kind"] == "income" and p.get("income_role") == "sparen":
                teile.append("Rolle: Sparen")
            if p["id"] in vertrag_zu_posten:
                teile.append(f"Vertrag V{vertrag_zu_posten[p['id']]}")
            if p.get("tags"):
                teile.append(f"Tags: {_txt(p['tags'])}")
            if p.get("note"):
                teile.append(f"Notiz: {_txt(p['note'])}")
            z.append(" · ".join(teile))

    sp = split_calc.compute_split(t["ueberschuss"]["monthly"], split_repo.list_pots(conn))
    if sp["pots"]:
        z.append(f"Überschussverwendung (Töpfe): Überschuss {_eur(sp['ueberschuss']['monthly'])}/Monat, "
                 f"verteilt {_eur(sp['verteilt']['monthly'])}/Monat, frei übrig {_eur(sp['uebrig']['monthly'])}/Monat"
                 + (" (Töpfe wurden anteilig gekürzt, weil sie mehr wollten als der Überschuss)" if sp.get("scaled") else "")
                 + ".")
        for p in sp["pots"]:
            regel = (f"{_pct(p['value'], 0)} des Überschusses" if p["mode"] == "percent"
                     else f"fester Betrag {_eur(p['value'])}")
            z.append(f"  - Topf {p['name']}: {regel} = {_eur(p['assign']['monthly'])}/Monat, "
                     f"{_eur(p['assign']['yearly'])}/Jahr" + (" (gekürzt)" if p.get("capped") else ""))
    else:
        z.append("Überschussverwendung: keine Töpfe angelegt.")
    return "\n".join(z)


# ---------------------------------------------------------------------------
# Vermögen
# ---------------------------------------------------------------------------
def vermoegen_text(conn):
    ledger_cats = ledger_repo.list_categories(conn)
    ledger_posten = ledger_repo.list_posten(conn)
    kosten = ledger_calc.build_summary(ledger_cats, ledger_posten)["totals"]["kosten"]["monthly"]
    a = assets_calc.compute_assets(assets_repo.list_classes(conn), assets_repo.list_positions(conn), kosten)
    tot, k, alloc = a["totals"], a["kpis"], a["allocation"]

    z = ["=== Vermögen (Besitz, Schulden, Rücklagen) ==="]
    z.append(f"Summen: Nettovermögen {_eur(tot['nettovermoegen'])} · Gesamtbesitz {_eur(tot['gesamtbesitz'])} · "
             f"Gesamtschulden {_eur(tot['gesamtschulden'])} · griffbereit (liquide) {_eur(tot['griffbereit'])} · "
             f"Sachwerte {_eur(tot['sachwerte'])}.")
    kz = [f"Eigenkapitalquote {_pct(k['eigenkapitalquote'])}", f"Verschuldungsgrad {_pct(k['verschuldungsgrad'])}",
          f"Risikoquote {_pct(k['risikoquote'])}"]
    if k.get("notgroschen_reichweite_monate") is not None:
        kz.append(f"Notgroschen reicht {str(round(k['notgroschen_reichweite_monate'], 1)).replace('.', ',')} Monate "
                  f"(bei Kosten von {_eur(kosten)}/Monat aus dem Haushalt)")
    kl = k.get("klumpenrisiko") or {}
    if kl.get("name"):
        kz.append(f"größte Einzelposition {kl['name']} mit {_pct(kl.get('prozent'))} des Besitzes")
    z.append("Kennzahlen: " + " · ".join(kz) + ".")
    for titel, key in (("Liquidität", "liquiditaet"), ("Risiko", "risiko"), ("Art", "art")):
        teile = [f"{g} {_eur(v['wert'])} ({_pct(v['prozent'])})" for g, v in (alloc.get(key) or {}).items()]
        if teile:
            z.append(f"Aufteilung nach {titel}: " + ", ".join(teile) + ".")

    z.append("Klassen und Positionen:")
    if not a["classes"]:
        z.append("  (keine Klassen angelegt)")
    for c in a["classes"]:
        if c["kind"] == "debt":
            kopf = f"A{c['id']} {c['name']} (Schulden)"
        else:
            pr = c.get("profile") or {}
            kopf = f"A{c['id']} {c['name']} (Besitz · {pr.get('liq') or '?'} · Risiko {pr.get('risk') or '?'} · {pr.get('art') or '?'})"
        ps = c.get("positions", [])
        z.append(f"{kopf} – Summe {_eur(c['sum'])}" + (f" ({_pct(c['anteil'])})" if c.get("anteil") is not None else "")
                 + ("" if ps else " – keine Positionen"))
        for p in ps:
            teile = [f"  - {p['name']}: {_eur(p['value'])}" + (f" ({_pct(p['anteil'])})" if p.get("anteil") is not None else "")]
            if not p.get("active", True):
                teile.append("inaktiv (zählt nicht in die Summen)")
            if p.get("note"):
                teile.append(f"Notiz: {_txt(p['note'])}")
            z.append(" · ".join(teile))
    return "\n".join(z)


# ---------------------------------------------------------------------------
# Verträge
# ---------------------------------------------------------------------------
def vertraege_text(conn, allowed=()):
    posten = {p["id"]: p for p in ledger_repo.list_posten(conn)}
    r = contracts_calc.compute_contracts(posten, contracts_repo.list_categories(conn), contracts_repo.list_contracts(conn))
    items, m = r["contracts"], r["metrics"]

    z = ["=== Verträge & Abos (Kosten, Laufzeiten, Kündigungsfristen) ==="]
    z.append(f"Summen: {m['count_active']} aktive{'r' if m['count_active'] == 1 else ''} Vertr{'ag' if m['count_active'] == 1 else 'äge'} · Kosten {_eur(m['cost']['monthly'])}/Monat "
             f"({_eur(m['cost']['yearly'])}/Jahr).")
    nd = m.get("next_deadline")
    if nd:
        z.append(f"Nächste Kündigungsfrist: {nd.get('vendor') or '—'}, kündbar bis {_datum(nd.get('stichtag'))} "
                 f"(noch {nd.get('days')} Tage).")
    an, sp = m["action_needed"], m["savings_potential"]
    z.append(f"Handlungsbedarf: {an['total']} (Frist verpasst: {an['missed']}, Frist in ≤ 30 Tagen: {an['ending_soon']}) · "
             f"Kündigungskandidaten: {sp['count']} mit zusammen {_eur(sp['monthly'])}/Monat ({_eur(sp['yearly'])}/Jahr).")

    z.append("Verträge:")
    if not items:
        z.append("  (keine Verträge angelegt)")
    for it in items:
        name = it.get("label") or it.get("posten_name") or "Vertrag"
        kopf = [f"V{it['id']} {name}"]
        if it.get("partner_id"):
            kopf.append(f"Partner PA{it['partner_id']} {it.get('partner_name') or ''}".rstrip())
        elif it.get("vendor"):
            kopf.append(f"Anbieter {it['vendor']}")
        kopf.append(f"Haushaltsposten P{it['posten_id']}"
                    + (f" „{it['posten_name']}“" if "haushalt" in allowed and it.get("posten_name") else ""))
        if it.get("category"):
            kopf.append(f"Kategorie VK{it['category_id']} {it['category']}")
        z.append(" · ".join(kopf))
        z.append(f"  Kosten: {_eur(it['amount'])} {INTERVALL.get(it['interval'], it['interval'])} "
                 f"= {_eur(it['monthly'])}/Monat, {_eur(it['yearly'])}/Jahr")
        st = [f"Status: {it['status']}"]
        if it.get("status") == "pausiert":
            st.append(f"pausiert bis {_datum(it['pause_until'])}" if it.get("pause_until") else "pausiert ohne Enddatum")
        if not it.get("effective_active", True):
            st.append("zählt derzeit nicht in die Kosten")
        if it.get("anytime"):
            st.append("jederzeit kündbar")
        else:
            if it.get("end"):
                st.append(f"Laufzeit bis {_datum(it['end'])}")
            if it.get("notice_n"):
                st.append(f"Kündigungsfrist {_anzahl(it['notice_n'], it['notice_unit'])}")
            if it.get("renew_n"):
                st.append(f"verlängert sich danach um {_anzahl(it['renew_n'], 'Monate')}")
            if it.get("stichtag"):
                st.append(f"kündbar bis {_datum(it['stichtag'])} (noch {it.get('days_to_stichtag')} Tage)")
            if it.get("missed"):
                st.append("Kündigungsfrist verpasst")
        if it.get("candidate"):
            st.append("als Kündigungskandidat markiert")
        z.append("  " + " · ".join(st))
        if it.get("note"):
            z.append(f"  Notiz: {_txt(it['note'])}")
        docs = it.get("docs") or []
        if docs:
            z.append("  Dokumente: " + ", ".join(f"D{d['id']} „{d['filename']}“" for d in docs))
    return "\n".join(z)


# ---------------------------------------------------------------------------
# Vertragspartner
# ---------------------------------------------------------------------------
def partner_text(conn, allowed=()):
    partner = contracts_repo.list_partners(conn)
    vertraege_frei = "vertraege" in allowed

    z = ["=== Vertragspartner (Kontakt- und Kündigungsdaten, alle Felder) ==="]
    mit = sum(1 for p in partner if p.get("contract_count"))
    z.append(f"Summen: {len(partner)} Vertragspartner, davon {mit} mit zugeordneten Verträgen.")
    if not partner:
        z.append("  (keine Vertragspartner angelegt)")
    for p in partner:
        kopf = [f"PA{p['id']} {p['name']}"]
        if p.get("ptype"):
            kopf.append(f"Typ {_txt(p['ptype'])}")
        if p.get("branch"):
            kopf.append(f"Branche {_txt(p['branch'])}")
        z.append(" · ".join(kopf))
        felder = [f for f in (p.get("fields") or []) if _txt(f.get("value"))]
        for f in felder:
            z.append(f"  - {_txt(f['label'])} ({f.get('ftype') or 'Text'}): {_txt(f['value'])}")
        if not felder:
            z.append("  - (keine Felder ausgefüllt)")
        vs = p.get("contracts") or []
        if vs:
            if vertraege_frei:
                z.append("  Verträge: " + ", ".join(f"V{v['id']} {v['name']}" for v in vs))
            else:
                z.append("  Verträge: " + ", ".join(f"V{v['id']}" for v in vs))
        else:
            z.append("  Verträge: keine zugeordnet")
    return "\n".join(z)


# ---------------------------------------------------------------------------
# Dokumente
# ---------------------------------------------------------------------------
MAX_BILDER_GESAMT = 20       # Obergrenze Bilder je Frage (Scans + Fotos)


def dokumente_text(conn, allowed=(), vision=False, bilder_out=None):
    """Inhalt aller Vertragsdokumente. Scans/Fotos landen – nur bei Modellen mit
    Bildverständnis – als Bilder in `bilder_out` (Liste von Base64-JPEGs)."""
    docs = contracts_repo.list_all_docs(conn)
    vertraege = {c["id"]: c for c in contracts_repo.list_contracts(conn)}
    partner_namen = {p["id"]: p["name"] for p in contracts_repo.list_partners(conn)} if "partner" in allowed else {}
    v_frei = "vertraege" in allowed

    z = ["=== Dokumente (Inhalt der Vertragsdokumente) ==="]
    if not docs:
        z.append("Summen: keine Dokumente hinterlegt.")
        return "\n".join(z)
    inhalte = [(d, dokumente.inhalt(d)) for d in docs]
    n_text = sum(1 for _, i in inhalte if i["art"] == "text")
    n_bild = sum(1 for _, i in inhalte if i["art"] in ("scan", "bild"))
    z.append(f"Summen: {len(docs)} Dokumente, davon {n_text} mit auslesbarem Text und {n_bild} Scans/Bilder"
             + ("." if vision or not n_bild else " (Scans/Bilder kann das aktuelle Modell nicht lesen – es versteht keine Bilder)."))

    nr = len(bilder_out) if bilder_out is not None else 0
    for d, inh in inhalte:
        kopf = [f"D{d['id']} „{d['filename']}“"]
        v = vertraege.get(d.get("contract_id"))
        if v:
            vname = v.get("label") or v.get("posten_name") or ""
            kopf.append(f"zu Vertrag V{v['id']}" + (f" {vname}" if v_frei and vname else ""))
            if v.get("partner_id"):
                kopf.append(f"Partner PA{v['partner_id']}" + (f" {partner_namen[v['partner_id']]}" if v["partner_id"] in partner_namen else ""))
        else:
            kopf.append("ohne Vertrag (verwaist)")
        fmt = inh.get("format", "?")
        if inh.get("seiten"):
            fmt += f", {inh['seiten']} Seite{'n' if inh['seiten'] != 1 else ''}"
        kopf.append(fmt)
        z.append(" · ".join(kopf))

        art = inh["art"]
        if art == "text":
            z.append(f"--- Inhalt D{d['id']} ---")
            z.append(inh["text"] or "(Dokument ist leer)")
            z.append(f"--- Ende D{d['id']} ---")
        elif art in ("scan", "bild"):
            was = "Scan ohne Textebene" if art == "scan" else "Bild/Foto"
            if not vision:
                z.append(f"  {was} – Inhalt nur für Modelle mit Bildverständnis lesbar.")
            elif bilder_out is None:
                z.append(f"  {was} – wird bei einer Frage als Bild mitgeschickt.")
            else:
                frei = MAX_BILDER_GESAMT - nr
                bs = dokumente.bilder(d, art)[:max(0, frei)]
                if bs:
                    bilder_out.extend(bs)
                    von, bis = nr + 1, nr + len(bs)
                    nr = bis
                    z.append(f"  {was} – als Bild {von}{'' if von == bis else '–' + str(bis)} beigefügt"
                             + (f" (nur die ersten {dokumente.MAX_SCAN_SEITEN} Seiten)" if art == "scan" and inh.get("seiten", 0) > dokumente.MAX_SCAN_SEITEN else "")
                             + ".")
                else:
                    z.append(f"  {was} – nicht beigefügt (Bild-Obergrenze erreicht oder nicht lesbar).")
        else:
            z.append(f"  Inhalt nicht verfügbar: {inh.get('grund', 'unbekannt')}.")
    return "\n".join(z)


# ---------------------------------------------------------------------------
# Zusammenbau
# ---------------------------------------------------------------------------
_BEREICHE = (("haushalt", haushalt_text), ("vermoegen", vermoegen_text), ("vertraege", vertraege_text),
             ("partner", partner_text), ("dokumente", dokumente_text))
_MIT_FREIGABE = {"vertraege", "partner"}     # diese Texte berücksichtigen, was sonst freigegeben ist
_NAMEN = (("Haushalt", "haushalt"), ("Vermögen", "vermoegen"), ("Verträge", "vertraege"),
          ("Vertragspartner", "partner"), ("Dokumente", "dokumente"))


def datenuebergabe(conn, allowed, heute=None, vision=False, bilder_out=None):
    """Vollständiger Text aller FREIGEGEBENEN Bereiche (leer, wenn nichts freigegeben).

    vision: Modell versteht Bilder → Scans/Fotos der Dokumente gehen als Bilder mit;
    sie werden an `bilder_out` angehängt (Liste, Base64-JPEG), falls übergeben.
    Ein defekter Bereich sprengt die Übergabe nicht: er wird mit Hinweis ausgelassen.
    """
    allowed = [a for a in (allowed or [])]
    teile = []
    for key, fn in _BEREICHE:
        if key not in allowed:
            continue
        try:
            if key == "dokumente":
                teile.append(fn(conn, allowed, vision=vision, bilder_out=bilder_out))
            else:
                teile.append(fn(conn, allowed) if key in _MIT_FREIGABE else fn(conn))
        except Exception as e:  # noqa: BLE001
            teile.append(f"=== {key} ===\n(Bereich konnte nicht gelesen werden: {e})")
    if not teile:
        return ""
    heute = heute or date.today()
    kopf = [f"Stand der Daten: {heute.strftime('%d.%m.%Y')} (heute).", LEGENDE]
    nicht = [n for n, k in _NAMEN if k not in allowed]
    if nicht:
        kopf.append("Nicht freigegeben (Inhalte fehlen bewusst, IDs dorthin sind nur Verweise): " + ", ".join(nicht) + ".")
    return "\n".join(kopf) + "\n\n" + "\n\n".join(teile)
