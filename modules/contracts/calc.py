"""Berechnungen für Verträge – Kündigungsstichtag, Status, Kennzahlen.

Kernpunkt (bewusst so gewählt): die Leitzahl ist der KÜNDIGUNGSSTICHTAG, also
der letzte Tag, an dem die Kündigung raus sein muss = Vertragsende MINUS Frist.
Nicht das Vertragsende. Fristen in Monaten werden als VOLLE Kalendermonate
gerechnet (01.01. − 3 Monate = 01.10.), Wochen tagbasiert. Ist der Stichtag des
laufenden Zyklus schon vorbei, wird automatisch zum nächsten Termin
weitergerechnet (missed=True) – so zeigt das Tool immer einen einhaltbaren Tag.

Status-Logik:
  - aktiv                 : zählt, normal.
  - gekündigt, läuft noch : zählt bis Vertragsende weiter (man zahlt bis dahin),
                            danach beendet -> zählt nicht mehr.
  - gekündigt, jederzeit  : sofort beendet.
  - pausiert              : zählt nicht (durchgestrichen), reaktiviert am pause_until.

Ausgabe serientauglich (monatlich UND jährlich je Vertrag + in Summe), damit
Diagramme (Stufe 6) und die KI (Stufe 7) direkt darauf aufsetzen können.
"""
from datetime import date


def _viewable(filename):
    """Kann die Datei im eingebauten Viewer (iframe) inline angezeigt werden?"""
    try:
        from modules.contracts import storage
        return storage.content_info(filename)[1]
    except Exception:
        return False


# ---- Datums-Helfer (volle Kalendermonate, mit Monatsende-Clamp) -----------
def _parse(iso):
    if not iso:
        return None
    y, m, d = (int(x) for x in iso.split("-"))
    return date(y, m, d)


def _last_day(y, m):
    if m == 12:
        return 31
    from calendar import monthrange
    return monthrange(y, m)[1]


def add_months(d, n):
    total = (d.year * 12 + (d.month - 1)) + n
    y, m = divmod(total, 12)
    m += 1
    day = min(d.day, _last_day(y, m))
    return date(y, m, day)


def sub_days(d, n):
    from datetime import timedelta
    return d - timedelta(days=n)


def days_between(a, b):
    return (b - a).days


# ---- Fristen ---------------------------------------------------------------
def notice_stichtag(end, notice_n, notice_unit):
    """Kündigungsstichtag = Vertragsende − Kündigungsfrist."""
    if notice_unit == "Wochen":
        return sub_days(end, notice_n * 7)
    return add_months(end, -notice_n)


def compute_frist(ct, today):
    """Liefert stichtag/ende/tage/verpasst für einen Vertrag mit fixer Laufzeit."""
    if ct.get("anytime") or not ct.get("end_date"):
        return {"anytime": True, "end": None, "stichtag": None, "days": None, "missed": False}
    end = _parse(ct["end_date"])
    n, unit, renew = ct["notice_n"], ct["notice_unit"], ct.get("renew_n", 0)
    st = notice_stichtag(end, n, unit)
    missed = False
    while st < today and renew > 0:
        end = add_months(end, renew)
        st = notice_stichtag(end, n, unit)
        missed = True
    return {"anytime": False, "end": end, "stichtag": st,
            "days": days_between(today, st), "missed": missed}


def is_effective_active(ct, today, posten_active=True):
    """Zählt der Vertrag in Kosten/Bestand (und ist NICHT durchgestrichen)?

    Ist der zugehörige Ledger-Posten inaktiv (im Haushalt durchgestrichen), gilt
    der Vertrag ebenfalls als inaktiv – auch wenn er für einen bereits inaktiven
    Posten angelegt wurde (Reverse-Kopplung)."""
    status = ct.get("status", "aktiv")
    if status == "gekündigt":
        # gekündigt läuft bis Vertragsende weiter (unabhängig vom Posten-Flag)
        if ct.get("anytime") or not ct.get("end_date"):
            return False
        return today < _parse(ct["end_date"])
    # aktiv/inaktiv wird über den Haushaltsposten geführt (ein Master)
    return bool(posten_active)


# ---- Gesamtzustand + Kennzahlen -------------------------------------------
def auto_reactivate(conn, today=None):
    """Reaktiviert Posten, deren Pause (pause_until) abgelaufen ist.

    Setzt den Haushaltsposten wieder aktiv und löscht das Datum. Wird beim Laden
    des Zustands aufgerufen, sodass pausierte Verträge am Stichtag von selbst
    wieder anlaufen – in Verträgen UND im Haushalt."""
    today = today or date.today()
    rows = conn.execute(
        "SELECT c.id, c.posten_id, c.pause_until FROM contracts c "
        "JOIN posten p ON p.id=c.posten_id "
        "WHERE c.pause_until IS NOT NULL AND p.active=0").fetchall()
    for r in rows:
        try:
            if _parse(r["pause_until"]) <= today:
                conn.execute("UPDATE posten SET active=1 WHERE id=?", (r["posten_id"],))
                conn.execute("UPDATE contracts SET pause_until=NULL WHERE id=?", (r["id"],))
        except Exception:
            pass
    conn.commit()


def compute_contracts(posten_by_id, contract_categories, contracts, today=None):
    """Fügt Verträge mit ihren Ledger-Posten zusammen und rechnet Kennzahlen.

    posten_by_id:        {id: posten-dict aus ledger.repo.list_posten}
    contract_categories: Liste aus contracts.repo.list_categories (eigene Kategorien)
    contracts:           Liste aus contracts.repo.list_contracts
    """
    from modules.ledger import calc as ledger_calc
    today = today or date.today()
    cat_name = {c["id"]: c["name"] for c in contract_categories}

    items = []
    for ct in contracts:
        p = posten_by_id.get(ct["posten_id"])
        if not p:
            continue  # Posten wurde gelöscht -> Kaskade räumt normalerweise auf
        posten_active = bool(p.get("active", 1))
        raw_status = ct.get("status", "aktiv")
        f = compute_frist(ct, today)
        eff = is_effective_active(ct, today, posten_active)
        if raw_status == "gekündigt":
            display_status = "gekündigt"
        elif not posten_active:
            display_status = "pausiert"
        else:
            display_status = "aktiv"
        m = round(ledger_calc.monthly_of(p["amount"], p["interval"]), 2)
        y = round(ledger_calc.yearly_of(p["amount"], p["interval"]), 2)
        items.append({
            "id": ct["id"],
            "posten_id": ct["posten_id"],
            "posten_name": p["name"],
            "category_id": ct.get("category_id"),
            "category": cat_name.get(ct.get("category_id"), ""),
            "vendor": ct["vendor"],
            "label": ct.get("label", ""),
            "posten_active": posten_active,
            "amount": p["amount"], "interval": p["interval"],
            "monthly": m, "yearly": y,
            "anytime": bool(ct.get("anytime")),
            "end_date": ct.get("end_date"),
            "end": f["end"].isoformat() if f["end"] else None,
            "notice_n": ct["notice_n"], "notice_unit": ct["notice_unit"],
            "renew_n": ct.get("renew_n", 0),
            "stichtag": f["stichtag"].isoformat() if f["stichtag"] else None,
            "days_to_stichtag": f["days"],
            "missed": f["missed"],
            "status": display_status,
            "raw_status": raw_status,
            "pause_until": ct.get("pause_until"),
            "candidate": bool(ct.get("candidate")),
            "note": ct.get("note", ""),
            "effective_active": eff,
            "docs": [{"id": d["id"], "filename": d["filename"], "size": d["size"],
                      "url": f"/api/contracts/doc/{d['id']}",
                      "viewable": _viewable(d["filename"])}
                     for d in ct.get("docs", [])],
        })

    active = [it for it in items if it["effective_active"]]
    sum_m = round(sum(it["monthly"] for it in active), 2)
    sum_y = round(sum(it["yearly"] for it in active), 2)

    # nur "aktiv" (nicht gekündigt/pausiert) haben eine anstehende Kündigungsfrist
    upcoming = sorted(
        [it for it in items if it["status"] == "aktiv" and it["effective_active"]
         and not it["anytime"] and not it["missed"] and it["days_to_stichtag"] is not None],
        key=lambda it: it["days_to_stichtag"])
    nxt = upcoming[0] if upcoming else None
    missed = [it for it in items if it["status"] == "aktiv" and it["effective_active"] and it["missed"]]
    ending_soon = [it for it in upcoming if it["days_to_stichtag"] <= 30]
    candidates = [it for it in active if it["candidate"]]
    pot_m = round(sum(it["monthly"] for it in candidates), 2)

    metrics = {
        "count_active": len(active),
        "cost": {"monthly": sum_m, "yearly": sum_y},
        "next_deadline": None if not nxt else {
            "vendor": nxt["vendor"], "posten_id": nxt["posten_id"],
            "stichtag": nxt["stichtag"], "days": nxt["days_to_stichtag"]},
        "action_needed": {
            "total": len(missed) + len(ending_soon),
            "missed": len(missed), "ending_soon": len(ending_soon)},
        "savings_potential": {"count": len(candidates),
                              "monthly": pot_m, "yearly": round(pot_m * 12, 2)},
        "upcoming": [{"vendor": it["vendor"], "posten_id": it["posten_id"],
                      "stichtag": it["stichtag"], "days": it["days_to_stichtag"]}
                     for it in upcoming[:8]],
    }
    return {"contracts": items, "metrics": metrics,
            "categories": contract_categories, "today": today.isoformat()}
