/* Ledger-Panel – Excel-Layout (Stufe 1 komplett).
   Anzeige · Editieren (Beträge kreuzweise, Kommentar/Name, Kategorie) ·
   Anlegen über fließende Geister-Zeilen · Organisieren (Drag/⋯/Inaktiv/Löschen).
   Voll per Tab bedienbar (Kommentar→Name→Monatlich→Jährlich→…→nächster Bereich→Umlauf).
   Speichern läuft über die API; fürs flüssige Tippen wird lokal nachgeführt und
   im Hintergrund persistiert. Backend unverändert. */

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const dec = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEUR = (n) => eur.format(n || 0);
const amtStr = (n) => dec.format(n || 0);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Deutsche Konvention (Komma = Dezimal, Punkt = Tausender).
function parse(raw) {
  if (typeof raw === "number") return r2(raw);
  let s = String(raw).trim().replace("€", "").replace(/\s/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(".")) {
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
    else { const [h, t] = s.split("."); if (t.length === 3) s = h + t; }
  }
  const v = parseFloat(s);
  if (isNaN(v) || v < 0) throw new Error("Betrag ungültig.");
  if (v > 999999999999.99) throw new Error("Betrag zu groß (max. 999.999.999.999,99).");
  return r2(v);
}

function mount(root, ctx) {
  const { api, store, toast } = ctx;
  const dbName = (store.get("state") && store.get("state").active_db) || "db";
  const UIKEY = "fk_ledger_ui_" + dbName;

  let data = null, menuEl = null, pDrag = null, confirmEl = null, catDrag = null, catSettling = null;
  let draftKey = 1, pendingFocus = null;

  // ---- Stufe 2: Überschussverwendung (Töpfe) ----
  const split = { pots: [] };            // aus /api/split geladen; Verteilung wird lokal gerechnet
  const COLORS = ["#8fb3c9", "#6fb98a", "#c9a86f", "#b98fb3", "#6f9bc9", "#c96f8f"];
  const cur = (n) => { const s = fmtEUR(n); const m = s.match(/^(.+?)(\s*€)$/); return m ? `${m[1]}<span class="cur">${m[2]}</span>` : s; };
  const parseNum = (s) => { try { return parse(s); } catch (e) { return 0; } };
  let tDrag = null;                      // Zustand beim Topf-Ziehen

  let ui = loadUi();
  function loadUi() {
    try { return { drafts: {}, scroll: 0, ...JSON.parse(localStorage.getItem(UIKEY) || "{}") }; }
    catch (_) { return { drafts: {}, scroll: 0 }; }
  }
  const saveUi = debounce(() => { try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (_) {} }, 250);

  /* Fokusverhalten für Euro-/Wert-Felder:
     - per Tab hinein  -> Inhalt wird markiert (direktes Überschreiben)
     - per Maus-Klick   -> Cursor bleibt an der Klickstelle (das €-Zeichen wird schon
                           im mousedown entfernt, damit der Cursor nicht springt).
     Textfelder (Name/Kommentar) bleiben unverändert: Tab -> ans Ende (ledgerTab),
     Maus -> Klickstelle (Browser). */
  let mouseFocus = false;
  const onFocusModeKey = (e) => { if (e.key === "Tab") mouseFocus = false; };
  document.addEventListener("keydown", onFocusModeKey, true);
  const stripCur = (v) => v.replace(/\s*€\s*$/, "");
  function wireAmt(inp, hasEuro) {
    inp.addEventListener("mousedown", () => { mouseFocus = true; });   // € bleibt -> Cursor springt nicht
    inp.addEventListener("focus", () => {
      if (mouseFocus) { mouseFocus = false; return; }        // Maus: € bleibt, Cursor an Klickstelle
      if (hasEuro) inp.value = stripCur(inp.value).trim();    // Tab: € weg ...
      try { inp.select(); } catch (_) {}                      // ... und markieren
    });
  }

  root.innerHTML = `<div class="ledger2"><div class="lg-load">Lade …</div></div>`;
  const canvas = root.closest(".canvas");
  const onScroll = debounce(() => { if (canvas) { ui.scroll = canvas.scrollTop; saveUi(); } }, 150);
  if (canvas) canvas.addEventListener("scroll", onScroll, { passive: true });

  async function refresh() { data = await api.ledgerState(); await loadSplit(); render(); }

  // Töpfe aus dem Backend laden (Verteilung rechnen wir lokal für die Live-Anzeige)
  async function loadSplit() {
    try {
      const s = await api.splitState();
      split.pots = (s.pots || []).map((p) => ({ id: p.id, name: p.name, color: p.color, mode: p.mode, value: p.value }));
    } catch (e) { split.pots = []; }
  }

  // Verteilung lokal berechnen – spiegelt modules/split/calc.py (eine Wahrheit, nur clientseitig gespiegelt)
  function computeSplit() {
    const uM = (data.totals && data.totals.ueberschuss.monthly) || 0;
    const base = Math.max(0, uM);
    const wanted = split.pots.map((t) => t.mode === "percent" ? base * (t.value || 0) / 100 : (t.value || 0));
    const sumW = wanted.reduce((a, b) => a + b, 0);
    let scale = 1;
    if (base <= 0) scale = 0;
    else if (sumW > base && sumW > 0) scale = base / sumW;
    const scaled = base > 0 && scale < 0.9995;
    const rows = split.pots.map((t, i) => ({
      ...t,
      color: t.color || COLORS[i % COLORS.length],
      assign: r2(wanted[i] * scale),
      capped: scaled && wanted[i] > 0,
    }));
    const verteilt = r2(rows.reduce((a, r) => a + r.assign, 0));
    return { uM, base, rows, verteilt, uebrig: r2(uM - verteilt), scaled };
  }

  // Lokale Neuberechnung (nach optimistischen Änderungen) – spiegelt das Backend.
  function recompute() {
    let eM = 0, eY = 0, kM = 0, kY = 0;
    for (const c of data.categories) {
      let sm = 0, sy = 0;
      for (const p of c.posten) {
        p.monthly = r2(p.interval === "jaehrlich" ? p.amount / 12 : p.amount);
        p.yearly = r2(p.interval === "jaehrlich" ? p.amount : p.amount * 12);
        if (p.active) { sm += p.monthly; sy += p.yearly; }
      }
      c.monthly = r2(sm); c.yearly = r2(sy);
      if (c.kind === "income") { eM += c.monthly; eY += c.yearly; } else { kM += c.monthly; kY += c.yearly; }
    }
    data.totals = {
      einnahmen: { monthly: r2(eM), yearly: r2(eY) },
      kosten: { monthly: r2(kM), yearly: r2(kY) },
      ueberschuss: { monthly: r2(eM - kM), yearly: r2(eY - kY) },
    };
  }

  const findPosten = (id) => { for (const c of data.categories) for (const p of c.posten) if (p.id === id) return p; return null; };
  const catObj = (cid) => data.categories.find((c) => c.id === cid);
  const catOf = (id) => data.categories.find((c) => c.posten.some((p) => p.id === id));

  // ---- Fokus-Descriptoren (überstehen Neuaufbau) ----
  function descOf(el) {
    if (!el || !el.dataset) return null;
    const d = el.dataset;
    if (d.gk != null) { const f = (String(el.className).match(/g-(?:note|name|m|y)/) || ["g-name"])[0]; return { t: "g", k: +d.gk, f }; }
    if (d.note != null) return { t: "p", id: +d.note, f: "note" };
    if (d.name != null) return { t: "p", id: +d.name, f: "name" };
    if (d.m != null) return { t: "p", id: +d.m, f: "m" };
    if (d.y != null) return { t: "p", id: +d.y, f: "y" };
    if (d.catname != null) return { t: "c", id: +d.catname };
    return null;
  }
  function selByDesc(desc) {
    if (!desc) return null;
    const q = (x) => root.querySelector(x);
    if (desc.t === "g") return q("." + (desc.f || "g-name") + `[data-gk="${desc.k}"]`);
    if (desc.t === "p") return q(`[data-${desc.f}="${desc.id}"]`);
    if (desc.t === "c") return q(`[data-catname="${desc.id}"]`);
    return null;
  }
  const isAmt = (el) => /(?:^|\s)(rval|g-m|g-y)(?:\s|$)/.test(el.className || "");
  function applyFocus() {
    if (!pendingFocus) return;
    const pf = pendingFocus; pendingFocus = null;
    const el = selByDesc(pf.desc); if (!el) return;
    el.focus();
    if (pf.caret != null && el.setSelectionRange) { try { el.setSelectionRange(pf.caret, pf.caret); } catch (e) {} }
    else if (isAmt(el) && el.select) el.select();
    else if (el.setSelectionRange) { try { const L = el.value.length; el.setSelectionRange(L, L); } catch (e) {} }
    ensureVisible(el, 0.34, 28);
  }

  // ---- Geister-Zeilen (Multi-Draft) ----
  const blank = () => ({ k: draftKey++, note: "", name: "", m: "", y: "", src: "monatlich" });
  const hasContent = (d) => !!((d.name || "").trim() || (d.note || "").trim() || (d.m || "").trim() || (d.y || "").trim());
  function normDrafts(cid) {
    let a = (ui.drafts[cid] || []).filter((d, i, arr) => i === arr.length - 1 || hasContent(d));
    if (a.length === 0 || hasContent(a[a.length - 1])) a = a.concat([blank()]);
    ui.drafts[cid] = a;
  }
  const getDraft = (cid, k) => (ui.drafts[cid] || []).find((x) => x.k === k);
  function ghostRowHTML(cid, gd) {
    return rp("ghost",
      `<button class="mGrip gplus" data-gadd="${cid}" data-gk="${gd.k}" title="Posten anlegen" tabindex="-1">+</button>`
      + `<span class="mInfo cInfo"><input class="g-note" data-gc="${cid}" data-gk="${gd.k}" placeholder="Kommentar…" value="${esc(gd.note || "")}" /></span>`
      + `<span class="mName cName"><input class="g-name" data-gc="${cid}" data-gk="${gd.k}" placeholder="Neuer Posten…" value="${esc(gd.name || "")}" /></span>`
      + `<span class="mAmt"><input class="g-m" data-gc="${cid}" data-gk="${gd.k}" inputmode="decimal" placeholder="0,00" value="${esc(gd.m || "")}" /></span>`
      + `<span class="mMenu"></span>`,
      `<span class="yw"><input class="g-y" data-gc="${cid}" data-gk="${gd.k}" inputmode="decimal" placeholder="0,00" value="${esc(gd.y || "")}" /></span>`, `data-block="${cid}"`);
  }

  // Neue leere Zeile chirurgisch anhängen – ohne das aktuell getippte Feld
  // neu aufzubauen (verhindert Cursor-/Zeichen-Verlust beim Tippen).
  function maybeSpawn(cid, k, rowEl) {
    const arr = ui.drafts[cid] || [];
    const isLast = arr.length && arr[arr.length - 1].k === k;
    const d = getDraft(cid, k);
    if (isLast && d && hasContent(d)) {
      const nb = blank(); arr.push(nb); ui.drafts[cid] = arr; saveUi();
      const tmp = document.createElement("div"); tmp.innerHTML = ghostRowHTML(cid, nb);
      const newRow = tmp.firstElementChild;
      if (rowEl && rowEl.after) { rowEl.after(newRow); wireGhostRow(newRow, cid); }
    }
  }

  function colWidths() {
    // Große feste MINDEST-Breiten (bis Millionen bleibt alles fest stehen);
    // erst wenn eine Zahl noch breiter wird (ab Milliarden), wächst die Spalte mit.
    const CH = 0.63; let mpx = 0, ypx = 0, empx = 0, eypx = 0;
    for (const c of data.categories) {
      for (const p of c.posten) { mpx = Math.max(mpx, fmtEUR(p.monthly).length * 13.5 * CH); ypx = Math.max(ypx, fmtEUR(p.yearly).length * 13.5 * CH); }
      mpx = Math.max(mpx, fmtEUR(c.monthly).length * 14 * CH); ypx = Math.max(ypx, fmtEUR(c.yearly).length * 14 * CH);
    }
    const t = data.totals;
    empx = Math.max(fmtEUR(t.einnahmen.monthly).length, fmtEUR(t.kosten.monthly).length) * 13 * CH;
    eypx = Math.max(fmtEUR(t.einnahmen.yearly).length, fmtEUR(t.kosten.yearly).length) * 13 * CH;
    empx = Math.max(empx, fmtEUR(t.ueberschuss.monthly).length * 20 * CH);
    eypx = Math.max(eypx, fmtEUR(t.ueberschuss.yearly).length * 13.5 * CH);
    return {
      mw:  Math.max(165, Math.round(mpx) + 20),
      yw:  Math.max(190, Math.round(ypx) + 22),
      emw: Math.max(200, Math.round(empx) + 22),
      eyw: Math.max(180, Math.round(eypx) + 24),
    };
  }

  const rp = (cls, mb, yb, attrs = "") => `<div class="rp ${cls}" ${attrs}><div class="mbox">${mb}</div><div class="ybox">${yb}</div></div>`;
  const valCell = (kind, p) => {
    const isSrc = kind === "m" ? p.interval !== "jaehrlich" : p.interval === "jaehrlich";
    const num = kind === "m" ? p.monthly : p.yearly;
    return `<input class="rval${isSrc ? "" : " drv"}" data-${kind}="${p.id}" inputmode="decimal" value="${fmtEUR(num)}" />`;
  };

  function renderPlan(empty) {
    if (empty) return `<div class="plancard plan-empty"></div>`;
    const t = data.totals, uM = t.ueberschuss.monthly, uY = t.ueberschuss.yearly;
    const c = computeSplit();
    const uCls = uM > 0 ? "pos" : uM < 0 ? "neg" : "";
    const lbl = uM < 0 ? "Verlust" : "Überschuss";
    const head = `<div class="psr head"><span class="pk"></span><span class="pm">Monatlich</span><span class="py">Jährlich</span></div>`;
    const psblock = `<div class="psblock">`
      + `<div class="psr val"><span class="pk">Einnahmen</span><span class="pm pos">${cur(t.einnahmen.monthly)}</span><span class="py pos">${cur(t.einnahmen.yearly)}</span></div>`
      + `<div class="psr val"><span class="pk">Kosten</span><span class="pm neg">${cur(t.kosten.monthly)}</span><span class="py neg">${cur(t.kosten.yearly)}</span></div>`
      + `<div class="psr sum"><span class="pk">${lbl}</span><span class="pm big ${uCls}">${cur(uM)}</span><span class="py ${uCls}">${cur(uY)}</span></div>`
      + `</div>`;
    const toepfe = c.rows.map((r) =>
      `<div class="trow${r.capped ? " capped" : ""}" data-id="${r.id}">`
      + `<span class="tgrip" data-tgrip="${r.id}" title="verschieben">⠿</span>`
      + `<span class="tdot" style="background:${r.color}"></span>`
      + `<input class="tname" data-tname="${r.id}" value="${esc(r.name)}" />`
      + `<div class="tmode"><button data-tmode="${r.id}" data-m="fixed" class="${r.mode === "fixed" ? "on" : ""}" tabindex="-1">€</button><button data-tmode="${r.id}" data-m="percent" class="${r.mode === "percent" ? "on" : ""}" tabindex="-1">%</button></div>`
      + `<input class="tval" data-tval="${r.id}" inputmode="decimal" value="${r.mode === "percent" ? (r.value || 0) : amtStr(r.value || 0)}" />`
      + `<div class="trright"><span class="tassign">${fmtEUR(r.assign)}</span>${r.capped ? `<span class="tcap">anteilig</span>` : ""}</div>`
      + `<button class="tdel" data-tdel="${r.id}" title="entfernen" tabindex="-1">×</button></div>`).join("");
    const split_ = `<div class="splitblock"><div class="pcsp-head"><span class="stitle">Überschussverwendung</span>`
      + `<span class="pcsp-basis">monatlich zu verteilen: <b>${fmtEUR(c.base)}</b></span></div>`
      + `<div class="tframe"><div class="tlist">${toepfe}</div><button class="taddbtn" data-taddpot>+ Topf hinzufügen</button></div></div>`;
    const uebrigBlock = `<div class="uebrig ${c.uebrig > 0 ? "ok" : "zero"}"><span class="pk">Übrig</span><span class="pm big">${cur(c.uebrig)}</span><span class="py">${cur(c.uebrig * 12)}</span></div>`;
    return `<div class="plancard">${head}${psblock}${split_}${uebrigBlock}</div>`;
  }

  function render() {
    const cats = data.categories, empty = cats.length === 0, w = colWidths();
    let html = "";
    if (empty) {
      html = `<div class="emptyrow"><div class="ebox ebox-main"><span>Noch keine Bereiche. Lege unten einen an.</span></div><div class="ebox ebox-year"></div></div>`;
    } else {
      html = rp("first hd", `<span class="mGrip"></span><span class="mInfo">Information</span><span class="mName">Posten</span><span class="mAmt">Monatlich</span><span class="mMenu"></span>`, `<span class="yhd">Jährlich</span>`);
      html += rp("spacer", "", "");
      cats.forEach((c, ci) => {
        html += rp("ghead grp-" + c.kind, `<span class="mGrip catgrip" data-catgrip="${c.id}" title="Bereich verschieben">⠿</span><span class="ghfull"><span class="dot"></span><input data-catname="${c.id}" value="${esc(c.name)}" /></span><span class="mMenu"><button class="catdel" data-catdel="${c.id}" title="Bereich löschen" tabindex="-1">×</button></span>`, "", `data-block="${c.id}"`);
        c.posten.forEach((p) => {
          html += rp("row " + (p.active ? "" : "inactive"),
            `<span class="mGrip" data-grip="${p.id}" title="Posten verschieben">⠿</span>`
            + `<span class="mInfo cInfo"><input data-note="${p.id}" value="${esc(p.note || "")}" placeholder="Kommentar…" /></span>`
            + `<span class="mName cName"><input data-name="${p.id}" value="${esc(p.name)}" /></span>`
            + `<span class="mAmt">${valCell("m", p)}</span>`
            + `<span class="mMenu"><button class="dots" data-menu="${p.id}" tabindex="-1">⋯</button></span>`,
            `<span class="yw">${valCell("y", p)}</span>`,
            `data-cat="${c.id}" data-id="${p.id}" data-block="${c.id}"`);
        });
        normDrafts(c.id);
        (ui.drafts[c.id] || []).forEach((gd) => { html += ghostRowHTML(c.id, gd); });
        const isLast = ci === cats.length - 1, scls = c.kind === "income" ? "pos" : "neg";
        html += rp("sum" + (isLast ? " last" : ""), `<span class="mGrip"></span><span class="mInfo sumlbl">Summe</span><span class="mName"></span><span class="mAmt"><span class="sumv ${scls}">${fmtEUR(c.monthly)}</span></span><span class="mMenu"></span>`, `<span class="yw"><span class="sumv ${scls}">${fmtEUR(c.yearly)}</span></span>`, `data-block="${c.id}"`);
        if (!isLast) html += rp("spacer", "", "", `data-block="${c.id}"`);
      });
    }
    html += `<div class="xaddcat"><button data-addcat="income">+ Einnahme-Kategorie</button><button data-addcat="expense">+ Kosten-Kategorie</button></div>`;

    root.innerHTML = `<div class="ledger2" style="--mw:${w.mw}px;--yw:${w.yw}px;--emw:${w.emw}px;--eyw:${w.eyw}px"><div class="leftcol"><div class="areatitle">Einzelpositionen</div><div class="tablearea">${html}</div></div><div class="plancol"><div class="areatitle">Zusammenfassung &amp; Aufteilung</div>${renderPlan(empty)}</div></div>`;
    if (canvas && ui.scroll) canvas.scrollTop = ui.scroll;
    if (catDrag) blockRows(catDrag.cid).forEach((r) => { r.style.visibility = "hidden"; });
    if (catSettling != null) blockRows(catSettling).forEach((r) => { r.style.visibility = "hidden"; });
    wire();
    applyFocus();
    syncWidth();
  }

  // Rechte Spalte auf die Breite der linken koppeln (beide gleich breit)
  function syncWidth() {
    const l = root.querySelector(".leftcol"), p = root.querySelector(".plancol");
    if (!l || !p) return;
    p.style.width = l.getBoundingClientRect().width + "px";
  }

  // ---- Anlegen (Geister-Zeile) ----
  async function commitDraft(cid, k, opts) {
    const arr = ui.drafts[cid] || [];
    const d = getDraft(cid, k); if (!d) return;
    const n = (d.name || "").trim(); if (!n) return;
    const src = d.src || "monatlich";
    let amount; try { amount = parse((src === "jaehrlich" ? d.y : d.m) || "0"); } catch (e) { toast(e.message, true); return; }
    let id;
    try { const res = await api.addPosten({ category_id: cid, name: n, amount, interval: src, note: d.note || "" }); id = res && res.id; }
    catch (e) { toast(e.message, true); return; }
    const idx = arr.findIndex((x) => x.k === k); if (idx >= 0) arr.splice(idx, 1);
    const c = catObj(cid);
    if (c) {
      const maxSort = c.posten.reduce((m, p) => Math.max(m, p.sort || 0), -1);
      c.posten.push({ id, category_id: cid, name: n, amount, interval: src, active: true, note: d.note || "", tags: "", income_role: c.kind === "income" ? "einnahme" : null, sort: maxSort + 1, monthly: 0, yearly: 0 });
    }
    if (opts && opts.desc) pendingFocus = { desc: opts.desc };
    else if (opts && opts.focusTrailing) { normDrafts(cid); const t = ui.drafts[cid][ui.drafts[cid].length - 1]; pendingFocus = { desc: { t: "g", k: t.k, f: "g-name" } }; }
    saveUi(); recompute(); render();
  }

  // ---- Sortieren ----
  async function move(id, dir) {
    const c = catOf(id); if (!c) return;
    const ids = c.posten.map((p) => p.id); const i = ids.indexOf(id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.reorderPosten(ids); await refresh(); } catch (e) { toast(e.message, true); }
  }

  // ---- ⋯-Menü ----
  function closeMenu() { if (menuEl) { const m = menuEl; m.classList.remove("open"); setTimeout(() => m.remove(), 150); menuEl = null; } }
  function openMenu(id, btn) {
    closeMenu(); const p = findPosten(id); if (!p) return;
    const items = [["up", "↑ Nach oben"], ["down", "↓ Nach unten"], ["sep"], ["active", p.active ? "Inaktiv setzen" : "Aktiv setzen"], ["sep"], ["del", "Löschen", "danger"]];
    const m = document.createElement("div"); m.className = "ctx";
    m.innerHTML = items.map((it) => it[0] === "sep" ? '<div class="sep"></div>' : `<button data-a="${it[0]}" class="${it[2] || ""}">${it[1]}</button>`).join("");
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect(); m.style.top = r.bottom + 6 + "px"; m.style.left = Math.max(8, Math.min(r.left - 148, window.innerWidth - 186)) + "px";
    requestAnimationFrame(() => m.classList.add("open")); menuEl = m;
    m.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeMenu();
      try {
        if (a === "up") await move(id, -1);
        else if (a === "down") await move(id, 1);
        else if (a === "active") { await api.updatePosten(id, { active: !p.active }); await refresh(); }
        else if (a === "del") { await api.deletePosten(id); await refresh(); }
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---- In-App-Bestätigung (kein Browser-Dialog; übersteht F5) ----
  function removeConfirm() { if (confirmEl) { if (confirmEl._esc) document.removeEventListener("keydown", confirmEl._esc); confirmEl.remove(); confirmEl = null; } }
  function renderConfirm() {
    removeConfirm(); const p = ui.pendingConfirm; if (!p) return;
    const ov = document.createElement("div"); ov.className = "fk-modal-ov";
    ov.innerHTML = `<div class="fk-modal" role="dialog" aria-modal="true"><div class="fk-modal-msg">${esc(p.message)}</div><div class="fk-modal-act"><button class="fk-mbtn" data-mc="cancel">Abbrechen</button><button class="fk-mbtn danger" data-mc="ok">Löschen</button></div></div>`;
    document.body.appendChild(ov); confirmEl = ov;
    const close = (ok) => { const pend = ui.pendingConfirm; delete ui.pendingConfirm; saveUi(); removeConfirm(); if (ok && pend) dispatchConfirm(pend); };
    ov.addEventListener("click", (e) => { if (e.target === ov) return close(false); const b = e.target.closest("[data-mc]"); if (!b) return; close(b.dataset.mc === "ok"); });
    ov._esc = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", ov._esc);
    const db = ov.querySelector(".danger"); if (db) db.focus();
  }
  function dispatchConfirm(p) { if (p.kind === "deleteCategory") doDeleteCategory(p.cid); }
  function requestDeleteCategory(cid) {
    const c = catObj(cid); if (!c) return; const n = c.posten.length;
    if (n === 0) { doDeleteCategory(cid); return; }
    ui.pendingConfirm = { kind: "deleteCategory", cid, message: `Bereich „${c.name}“ inklusive ${n} Posten löschen?` };
    saveUi(); renderConfirm();
  }
  async function doDeleteCategory(cid) {
    const c = catObj(cid);
    try { if (c) for (const p of c.posten) await api.deletePosten(p.id); await api.deleteCategory(cid); delete ui.drafts[cid]; saveUi(); await refresh(); }
    catch (e) { toast(e.message, true); await refresh(); }
  }

  // ---- Kategorie-Bereiche verschieben (schwebende Kopie, immer obenauf) ----
  function catOrder(){return data.categories.map((c)=>c.id);}
  function blockRows(cid){return [...root.querySelectorAll(`.rp[data-block="${cid}"]`)];}
  function gheadTop(cid){const g=root.querySelector(`.rp.ghead[data-block="${cid}"]`);return g?g.getBoundingClientRect().top:0;}
  function blockGeom(cid){const rows=blockRows(cid);if(!rows.length)return null;const a=rows[0].getBoundingClientRect(),b=rows[rows.length-1].getBoundingClientRect();return{top:a.top,bottom:b.bottom,mid:(a.top+b.bottom)/2,h:b.bottom-a.top};}
  function getScroller(el){let n=el;while(n&&n!==document.body){const st=getComputedStyle(n);if(/(auto|scroll)/.test(st.overflowY)&&n.scrollHeight>n.clientHeight+2)return n;n=n.parentElement;}return document.scrollingElement||document.documentElement;}
  function ensureVisible(el,mb,mt){if(!el)return;const sc=getScroller(root);const isDoc=(sc===document.scrollingElement||sc===document.documentElement||sc===document.body);const scr=isDoc?{top:0,bottom:(window.innerHeight||document.documentElement.clientHeight)}:sc.getBoundingClientRect();const r=el.getBoundingClientRect();const H=scr.bottom-scr.top;let bm=(mb!=null?mb:24);if(bm>0&&bm<1)bm=Math.min(Math.max(H*bm,150),300);const tm=(mt!=null?mt:24);let delta=0;if(r.bottom>scr.bottom-bm)delta=r.bottom-(scr.bottom-bm);else if(r.top<scr.top+tm)delta=r.top-(scr.top+tm);if(Math.abs(delta)>1){const target=Math.max(0,sc.scrollTop+delta);try{sc.scrollTo({top:target,behavior:"smooth"});}catch(e){sc.scrollTop=target;}if(sc===canvas){ui.scroll=target;saveUi();}}}
  function wireCatDrag(){root.querySelectorAll("[data-catgrip]").forEach((g)=>{g.addEventListener("pointerdown",(e)=>{if(e.button!=null&&e.button!==0)return;startCatDrag(+g.dataset.catgrip,e);});});}
  function startCatDrag(cid,e){if(document.activeElement&&document.activeElement!==document.body&&document.activeElement.blur)document.activeElement.blur();const order0=catOrder();if(order0.length<2)return;e.preventDefault();
    const fromIndex=order0.indexOf(cid);const mc0={};
    order0.forEach((oc)=>{const g=blockGeom(oc);if(g)mc0[oc]=g.mid;});
    const dr=blockRows(cid);if(!dr.length)return;
    const first=dr[0].getBoundingClientRect(),last=dr[dr.length-1].getBoundingClientRect();
    const fRows=blockRows(order0[0]),lRows=blockRows(order0[order0.length-1]);
    const listTop0=(fRows.length?fRows[0].getBoundingClientRect().top:first.top),listBottom0=(lRows.length?lRows[lRows.length-1].getBoundingClientRect().bottom:last.bottom);
    const sc=getScroller(root);const led=root.querySelector(".ledger2");
    const clone=document.createElement("div");clone.className="catclone";
    clone.setAttribute("style",((led&&led.getAttribute("style"))||"")+";position:fixed;left:"+first.left+"px;top:"+first.top+"px;width:"+first.width+"px;z-index:9999;pointer-events:none;margin:0;");
    dr.forEach((r)=>{const cr=r.cloneNode(true);const si=r.querySelectorAll("input"),di=cr.querySelectorAll("input");si.forEach((el,idx)=>{if(di[idx])di[idx].value=el.value;});clone.appendChild(cr);});
    document.body.appendChild(clone);
    dr.forEach((r)=>{r.style.visibility="hidden";});
    catDrag={cid,order0,fromIndex,mc0,mcCid:mc0[cid],clone,cloneOffY:first.top-e.clientY,blockH:last.bottom-first.top,listTop0,listBottom0,footprint:(last.bottom-first.top)+9,startClientY:e.clientY,startScroll:sc.scrollTop,sc,maxScroll:Math.max(0,sc.scrollHeight-sc.clientHeight),lastClientY:e.clientY,toIndex:fromIndex,rows:dr,autoRAF:0};
    root.classList.add("catdrag-on");
    window.addEventListener("pointermove",onCatMove);window.addEventListener("pointerup",onCatUp);window.addEventListener("pointercancel",cancelCatDrag);window.addEventListener("keydown",onCatKey,true);}
  function onCatMove(e){if(!catDrag)return;catDrag.lastClientY=e.clientY;updateCatDrag();maybeAutoScroll();}
  function updateCatDrag(){const D=catDrag;if(!D)return;const y=D.lastClientY;const dScroll=D.sc.scrollTop-D.startScroll;
    let cloneTop=y+D.cloneOffY;const lt=D.listTop0-dScroll,lb=D.listBottom0-dScroll;cloneTop=Math.max(lt,Math.min(lb-D.blockH,cloneTop));
    D.clone.style.top=cloneTop+"px";
    const cloneBot=cloneTop+D.blockH;let below=0,above=0;
    D.order0.forEach((oc)=>{if(oc===D.cid)return;const mcn=D.mc0[oc]-dScroll;if(D.mc0[oc]>D.mcCid){if(cloneBot>mcn)below++;}else{if(cloneTop<mcn)above++;}});
    const toIndex=D.fromIndex+below-above;
    if(toIndex!==D.toIndex){D.toIndex=toIndex;applyCatShift();}}
  function applyCatShift(){const{order0,cid,fromIndex,toIndex,footprint}=catDrag;
    order0.forEach((oc,i)=>{if(oc===cid)return;let sh=0;
      if(toIndex>fromIndex){if(i>fromIndex&&i<=toIndex)sh=-footprint;}
      else if(toIndex<fromIndex){if(i>=toIndex&&i<fromIndex)sh=footprint;}
      blockRows(oc).forEach((r)=>{r.style.transition="transform .16s var(--ease)";r.style.transform=sh?("translateY("+sh+"px)"):"";});});}
  function maybeAutoScroll(){const D=catDrag;if(!D||D.autoRAF)return;const EDGE=56;const r=D.sc.getBoundingClientRect();const y=D.lastClientY;
    if(y>=r.top+EDGE&&y<=r.bottom-EDGE)return;
    const step=()=>{if(!catDrag){return;}const rr=catDrag.sc.getBoundingClientRect();const yy=catDrag.lastClientY;let dd=0;
      if(yy<rr.top+EDGE)dd=-1;else if(yy>rr.bottom-EDGE)dd=1;
      if(dd===0){catDrag.autoRAF=0;return;}
      const di=dd<0?(rr.top+EDGE-yy):(yy-(rr.bottom-EDGE));const sp=Math.min(20,4+di/2.4);
      const before=catDrag.sc.scrollTop;const target=Math.max(0,Math.min(catDrag.maxScroll,before+dd*sp));catDrag.sc.scrollTop=target;
      if(catDrag.sc.scrollTop!==before){updateCatDrag();catDrag.autoRAF=requestAnimationFrame(step);}else{catDrag.autoRAF=0;}};
    D.autoRAF=requestAnimationFrame(step);}
  function stopAuto(){if(catDrag&&catDrag.autoRAF){cancelAnimationFrame(catDrag.autoRAF);catDrag.autoRAF=0;}}
  function endCatDrag(){stopAuto();window.removeEventListener("pointermove",onCatMove);window.removeEventListener("pointerup",onCatUp);window.removeEventListener("pointercancel",cancelCatDrag);window.removeEventListener("keydown",onCatKey,true);root.classList.remove("catdrag-on");catDrag=null;}
  function onCatKey(e){if(e.key==="Escape"&&catDrag){e.preventDefault();cancelCatDrag();}}
  function cancelCatDrag(){if(!catDrag)return;const D=catDrag;stopAuto();
    D.rows.forEach((r)=>{r.style.visibility="";});
    root.querySelectorAll(".rp[data-block]").forEach((r)=>{r.style.transition="transform .16s var(--ease)";r.style.transform="";});
    if(D.clone)D.clone.remove();
    setTimeout(()=>{root.querySelectorAll(".rp[data-block]").forEach((r)=>{r.style.transition="";});},180);
    endCatDrag();}
  function onCatUp(){if(!catDrag)return;const{cid,order0,toIndex,clone}=catDrag;stopAuto();
    const no=order0.filter((x)=>x!==cid);const ti=Math.max(0,Math.min(no.length,toIndex));no.splice(ti,0,cid);
    data.categories.sort((a,b)=>no.indexOf(a.id)-no.indexOf(b.id));
    if(canvas)ui.scroll=canvas.scrollTop;
    endCatDrag();render();
    api.reorderCategories(no).catch((err)=>{toast(err.message,true);refresh();});
    if(clone){catSettling=cid;blockRows(cid).forEach((r)=>r.style.visibility="hidden");const targetTop=gheadTop(cid);clone.style.transition="top .18s var(--ease)";requestAnimationFrame(()=>{clone.style.top=targetTop+"px";});setTimeout(()=>{catSettling=null;blockRows(cid).forEach((r)=>{r.style.visibility="";});try{clone.remove();}catch(e){}},210);}else{catSettling=null;}}

  // ---- Posten verschieben (weicher Klon, blockübergreifend, gleiche Art) ----
  function wirePostenDrag(){root.querySelectorAll(".rp.row [data-grip]").forEach((g)=>{g.addEventListener("pointerdown",(e)=>{if(e.button!=null&&e.button!==0)return;startPostenDrag(+g.dataset.grip,e);});});}
  function resolvePTarget(y){
    const geoms=data.categories.map((c)=>({c,g:blockGeom(c.id)})).filter((x)=>x.g);
    if(!geoms.length)return{cid:null,index:0,valid:false,rows:[]};
    const first=geoms[0],last=geoms[geoms.length-1];let hit;
    if(y<=first.g.top)hit=first;else if(y>=last.g.bottom)hit=last;
    else{hit=geoms.find((x)=>y>=x.g.top&&y<=x.g.bottom);if(!hit){let bd=Infinity;for(const x of geoms){const d=y<x.g.top?x.g.top-y:y-x.g.bottom;if(d<bd){bd=d;hit=x;}}}}
    const cid=hit.c.id,valid=hit.c.kind===pDrag.kind;
    const rows=[...root.querySelectorAll(`.rp.row[data-cat="${cid}"]:not(.dragsrc)`)];
    let index=rows.length;
    for(let i=0;i<rows.length;i++){const b=rows[i].getBoundingClientRect();if(y<b.top+b.height/2){index=i;break;}}
    return{cid,index,valid,rows};
  }
  function startPostenDrag(pid,e){
    if(document.activeElement&&document.activeElement!==document.body&&document.activeElement.blur)document.activeElement.blur();
    const srcBlock=catOf(pid);if(!srcBlock)return;
    const rowEl=root.querySelector(`.rp.row[data-id="${pid}"]`);if(!rowEl)return;
    e.preventDefault();
    const rect=rowEl.getBoundingClientRect();
    const allRows=[...root.querySelectorAll(".rp.row, .rp.ghead, .rp.sum")];
    const listTop0=allRows.length?allRows[0].getBoundingClientRect().top:rect.top;
    const listBottom0=allRows.length?allRows[allRows.length-1].getBoundingClientRect().bottom:rect.bottom;
    const sc=getScroller(root),led=root.querySelector(".ledger2");
    // schwebende Kopie – erbt die Spaltenbreiten der .ledger2 (rechte Spalte bündig)
    const clone=rowEl.cloneNode(true);clone.classList.remove("dragsrc");clone.classList.add("pclone");
    const si=rowEl.querySelectorAll("input"),di=clone.querySelectorAll("input");si.forEach((el,i)=>{if(di[i])di[i].value=el.value;});
    clone.setAttribute("style",((led&&led.getAttribute("style"))||"")+";position:fixed;left:"+rect.left+"px;top:"+rect.top+"px;width:"+rect.width+"px;z-index:9999;pointer-events:none;margin:0;");
    document.body.appendChild(clone);
    // unsichtbarer Platzhalter (gestrichelte Einfügemarke), Ursprungszeile raus
    const ph=document.createElement("div");ph.className="ph";ph.style.height=rect.height+"px";ph.innerHTML='<div class="pm"></div><div class="py"></div>';
    rowEl.after(ph);rowEl.classList.add("dragsrc");
    const srcIndex=srcBlock.posten.findIndex((p)=>p.id===pid);
    data.categories.forEach((c)=>{if(c.kind!==srcBlock.kind)root.querySelectorAll(`[data-block="${c.id}"]`).forEach((r)=>r.classList.add("locked"));});
    root.classList.add("catdrag-on");
    pDrag={pid,srcCid:srcBlock.id,srcIndex,kind:srcBlock.kind,rowEl,clone,ph,rowH:rect.height,cloneOffY:rect.top-e.clientY,listTop0,listBottom0,sc,startScroll:sc.scrollTop,maxScroll:Math.max(0,sc.scrollHeight-sc.clientHeight),lastClientY:e.clientY,dstCid:srcBlock.id,dstIndex:-1,valid:true,autoRAF:0};
    window.addEventListener("pointermove",onPMove);window.addEventListener("pointerup",onPUp);window.addEventListener("pointercancel",cancelP);window.addEventListener("keydown",onPKey,true);
  }
  function onPMove(e){if(!pDrag)return;pDrag.lastClientY=e.clientY;updateP();autoScrollP();}
  function updateP(){
    const D=pDrag;if(!D)return;const y=D.lastClientY;const dScroll=D.sc.scrollTop-D.startScroll;
    let top=y+D.cloneOffY;const lt=D.listTop0-dScroll,lb=D.listBottom0-dScroll;top=Math.max(lt,Math.min(lb-D.rowH,top));
    D.clone.style.top=top+"px";
    const t=resolvePTarget(y);D.valid=t.valid;
    root.classList.toggle("over-locked",!t.valid);D.ph.classList.toggle("blocked",!t.valid);
    if(t.cid!==D.dstCid||t.index!==D.dstIndex){D.dstCid=t.cid;D.dstIndex=t.index;flipP(()=>placeP(t.cid,t.index));}
  }
  function placeP(cid,index){
    const D=pDrag;if(cid==null)return;
    const rows=[...root.querySelectorAll(`.rp.row[data-cat="${cid}"]:not(.dragsrc)`)];
    if(index>=rows.length){if(rows.length)rows[rows.length-1].after(D.ph);else{const gh=root.querySelector(`.rp.ghead[data-block="${cid}"]`);if(gh)gh.after(D.ph);}}
    else rows[index].before(D.ph);
  }
  // kontinuierlicher FLIP: Nachbarzeilen gleiten smooth (auch mitten in laufender Animation)
  function flipP(mutator){
    const area=root.querySelector(".tablearea");if(!area){mutator();return;}
    const nodes=[...area.querySelectorAll(".rp.row:not(.dragsrc), .rp.ghead, .rp.sum, .rp.ghost, .rp.spacer")];
    const firstPos=new Map();nodes.forEach((n)=>firstPos.set(n,n.getBoundingClientRect().top));
    mutator();
    nodes.forEach((n)=>{n.style.transition="none";n.style.transform="";});
    void area.offsetWidth;
    nodes.forEach((n)=>{const dy=firstPos.get(n)-n.getBoundingClientRect().top;if(Math.abs(dy)>0.5)n.style.transform="translateY("+dy+"px)";});
    requestAnimationFrame(()=>{nodes.forEach((n)=>{if(n.style.transform){n.style.transition="transform .16s var(--ease)";n.style.transform="";}});});
  }
  function clearPTransforms(){const area=root.querySelector(".tablearea");if(!area)return;area.querySelectorAll(".rp").forEach((r)=>{r.style.transition="";r.style.transform="";});}
  function autoScrollP(){
    const D=pDrag;if(!D||D.autoRAF)return;const EDGE=56,r=D.sc.getBoundingClientRect(),y=D.lastClientY;
    if(y>=r.top+EDGE&&y<=r.bottom-EDGE)return;
    const step=()=>{if(!pDrag){return;}const rr=pDrag.sc.getBoundingClientRect(),yy=pDrag.lastClientY;let dd=0;
      if(yy<rr.top+EDGE)dd=-1;else if(yy>rr.bottom-EDGE)dd=1;
      if(dd===0){pDrag.autoRAF=0;return;}
      const di=dd<0?(rr.top+EDGE-yy):(yy-(rr.bottom-EDGE)),sp=Math.min(20,4+di/2.4);
      const before=pDrag.sc.scrollTop,target=Math.max(0,Math.min(pDrag.maxScroll,before+dd*sp));pDrag.sc.scrollTop=target;
      if(pDrag.sc.scrollTop!==before){updateP();pDrag.autoRAF=requestAnimationFrame(step);}else{pDrag.autoRAF=0;}};
    D.autoRAF=requestAnimationFrame(step);
  }
  function onPKey(e){if(e.key==="Escape"&&pDrag){e.preventDefault();cancelP();}}
  function detachP(){window.removeEventListener("pointermove",onPMove);window.removeEventListener("pointerup",onPUp);window.removeEventListener("pointercancel",cancelP);window.removeEventListener("keydown",onPKey,true);}
  function endPDrag(){root.classList.remove("catdrag-on","over-locked");root.querySelectorAll(".locked").forEach((r)=>r.classList.remove("locked"));pDrag=null;}
  function cancelP(){
    if(!pDrag)return;const D=pDrag;detachP();if(D.autoRAF)cancelAnimationFrame(D.autoRAF);
    flipP(()=>placeP(D.srcCid,D.srcIndex));
    const target=D.ph.getBoundingClientRect();
    D.clone.style.transition="top .18s var(--ease), left .18s var(--ease)";
    D.clone.style.top=target.top+"px";D.clone.style.left=target.left+"px";
    if(canvas)ui.scroll=canvas.scrollTop;
    setTimeout(()=>{try{D.clone.remove();}catch(e){}try{D.ph.remove();}catch(e){}clearPTransforms();if(D.rowEl)D.rowEl.classList.remove("dragsrc");endPDrag();render();},190);
  }
  function onPUp(){
    if(!pDrag)return;const D=pDrag;
    const t=resolvePTarget(D.lastClientY);
    if(!t.valid||t.cid==null){cancelP();return;}
    detachP();if(D.autoRAF)cancelAnimationFrame(D.autoRAF);
    const cid=(D.dstCid!=null?D.dstCid:t.cid),index=(D.dstIndex>=0?D.dstIndex:t.index);
    const targetTop=D.ph.getBoundingClientRect().top;
    const unchanged=(cid===D.srcCid&&index===D.srcIndex);
    if(!unchanged){
      const src=catObj(D.srcCid),dst=catObj(cid);
      const from=src.posten.findIndex((p)=>p.id===D.pid);
      const [moved]=src.posten.splice(from,1);
      let idx=index;if(idx>dst.posten.length)idx=dst.posten.length;if(idx<0)idx=0;
      moved.category_id=cid;
      dst.posten.splice(idx,0,moved);
      const dstIds=dst.posten.map((p)=>p.id);
      if(D.srcCid===cid)api.reorderPosten(dstIds).catch((e)=>{toast(e.message,true);refresh();});
      else api.updatePosten(D.pid,{category_id:cid}).then(()=>api.reorderPosten(dstIds)).catch((e)=>{toast(e.message,true);refresh();});
    }
    D.clone.style.transition="top .16s var(--ease), left .16s var(--ease)";
    D.clone.style.top=targetTop+"px";
    if(canvas)ui.scroll=canvas.scrollTop;
    setTimeout(()=>{try{D.clone.remove();}catch(e){}try{D.ph.remove();}catch(e){}clearPTransforms();endPDrag();recompute();render();},165);
  }

  function wire() {
    // Kategorie
    root.querySelectorAll("[data-addcat]").forEach((b) => b.addEventListener("click", async () => {
      try { await api.addCategory({ kind: b.dataset.addcat, name: b.dataset.addcat === "income" ? "Neue Einnahmen" : "Neue Kosten" }); await refresh(); ensureVisible(root.querySelector(".xaddcat"), 16); } catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll("[data-catname]").forEach((inp) => inp.addEventListener("change", () => {
      const c = catObj(+inp.dataset.catname); if (c) c.name = inp.value;
      api.updateCategory(+inp.dataset.catname, { name: inp.value }).catch((e) => { toast(e.message, true); refresh(); });
    }));
    root.querySelectorAll("[data-catdel]").forEach((b) => b.addEventListener("click", () => requestDeleteCategory(+b.dataset.catdel)));

    // Kommentar / Name (lokal + Hintergrund-Speichern, kein Neuaufbau)
    root.querySelectorAll("[data-note]").forEach((inp) => inp.addEventListener("input", () => { const p = findPosten(+inp.dataset.note); if (p) p.note = inp.value; saveNote(+inp.dataset.note, inp.value); }));
    root.querySelectorAll("[data-name]").forEach((inp) => inp.addEventListener("input", () => { const p = findPosten(+inp.dataset.name); if (p) p.name = inp.value; saveName(+inp.dataset.name, inp.value); }));

    // Beträge (direkt editierbar)
    root.querySelectorAll(".rval").forEach((inp) => {
      const kind = inp.dataset.m != null ? "m" : "y";
      const id = +(kind === "m" ? inp.dataset.m : inp.dataset.y);
      const row = inp.closest(".rp");
      const other = kind === "m" ? row.querySelector(".rval[data-y]") : row.querySelector(".rval[data-m]");
      wireAmt(inp, true);
      inp.addEventListener("input", () => { try { const v = parse(inp.value); if (other) other.value = kind === "m" ? amtStr(v * 12) : amtStr(v / 12); } catch (e) {} });
      inp.addEventListener("keydown", (e) => { const p = findPosten(id); if (e.key === "Enter") { e.preventDefault(); inp.blur(); } else if (e.key === "Escape") { if (p) inp.value = fmtEUR(kind === "m" ? p.monthly : p.yearly); inp.blur(); } });
      inp.addEventListener("blur", () => {
        const p = findPosten(id); if (!p) return;
        const cur = kind === "m" ? p.monthly : p.yearly;
        let v; try { v = parse(inp.value); } catch (e) { toast(e.message, true); inp.value = fmtEUR(cur); return; }
        if (Math.abs(v - cur) < 0.005) { inp.value = fmtEUR(cur); return; }
        p.amount = v; p.interval = kind === "m" ? "monatlich" : "jaehrlich";
        pendingFocus = { desc: descOf(document.activeElement) };
        recompute(); render();
        api.updatePosten(id, { amount: v, interval: p.interval }).catch((e) => { toast(e.message, true); refresh(); });
      });
    });

    // ⋯-Menü
    root.querySelectorAll("[data-menu]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openMenu(+btn.dataset.menu, btn); }));
    // Posten verschieben (weicher Klon, blockübergreifend gleiche Art)
    wirePostenDrag();

    // Geister-Zeilen
    root.querySelectorAll(".rp.ghost").forEach((row) => wireGhostRow(row, +row.querySelector("[data-gc]").dataset.gc));
    wireCatDrag();
    wireSplit();
  }

  function wireGhostRow(row, cid) {
    const k = +row.querySelector("[data-gk]").dataset.gk;
    const note = row.querySelector(".g-note"), name = row.querySelector(".g-name"), gm = row.querySelector(".g-m"), gy = row.querySelector(".g-y");
    const gadd = row.querySelector("[data-gadd]");
    const upd = (f, v) => { const d = getDraft(cid, k); if (d) d[f] = v; saveUi(); };
    gm.addEventListener("input", () => { const d = getDraft(cid, k); if (d) d.src = "monatlich"; upd("m", gm.value); try { gy.value = gm.value.trim() ? amtStr(parse(gm.value) * 12) : ""; } catch (e) {} upd("y", gy.value); maybeSpawn(cid, k, row); });
    gy.addEventListener("input", () => { const d = getDraft(cid, k); if (d) d.src = "jaehrlich"; upd("y", gy.value); try { gm.value = gy.value.trim() ? amtStr(parse(gy.value) / 12) : ""; } catch (e) {} upd("m", gm.value); maybeSpawn(cid, k, row); });
    note.addEventListener("input", () => { upd("note", note.value); maybeSpawn(cid, k, row); });
    name.addEventListener("input", () => { upd("name", name.value); maybeSpawn(cid, k, row); });
    [note, name, gm, gy].forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(cid, k, { focusTrailing: true }); } }));
    row.addEventListener("focusout", (e) => {
      if (row.contains(e.relatedTarget)) return;
      const d = getDraft(cid, k);
      if (d && (d.name || "").trim()) { commitDraft(cid, k, { desc: descOf(e.relatedTarget) }); return; }
      // Namenlos verlassen: überzählige leere Geister-Zeilen aufräumen (max. 1 bleibt).
      const before = (ui.drafts[cid] || []).length;
      normDrafts(cid);
      if ((ui.drafts[cid] || []).length !== before) { pendingFocus = { desc: descOf(e.relatedTarget) }; saveUi(); render(); }
    });
    if (gadd) { gadd.addEventListener("mousedown", (e) => e.preventDefault()); gadd.addEventListener("click", () => commitDraft(cid, k, { focusTrailing: true })); }
  }

  const saveNote = debounce((id, v) => api.updatePosten(id, { note: v }).catch((e) => toast(e.message, true)), 500);
  const saveName = debounce((id, v) => api.updatePosten(id, { name: v }).catch((e) => toast(e.message, true)), 500);

  function ledgerTab(e) {
    if (e.key !== "Tab") return;
    const box = root.querySelector(".leftcol"); if (!box) return;
    const fields = [...box.querySelectorAll("input")].filter((el) => el.offsetParent !== null);
    const i = fields.indexOf(document.activeElement); if (i === -1) return;
    e.preventDefault();
    let j = e.shiftKey ? i - 1 : i + 1; if (j < 0) j = fields.length - 1; if (j >= fields.length) j = 0;
    const t = fields[j]; if (!t) return;
    const desc = descOf(t); t.focus();
    let cur = document.activeElement;
    if ((!cur || cur === document.body) && desc) { pendingFocus = { desc }; applyFocus(); cur = document.activeElement; }
    if (cur && cur !== document.body) {
      if (isAmt(cur) && cur.select) cur.select();
      else if (cur.setSelectionRange) { try { const L = cur.value.length; cur.setSelectionRange(L, L); } catch (e2) {} }
      ensureVisible(cur, 0.34, 28);
    }
  }

  const onDocClick = () => closeMenu();
  const onResize = () => { closeMenu(); syncWidth(); };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", ledgerTab);
  window.addEventListener("resize", onResize);

  refresh().then(() => renderConfirm()).catch((e) => { root.innerHTML = `<div class="ledger2"><p class="lg-load">Ledger konnte nicht geladen werden: ${esc(e.message)}</p></div>`; });

  // ---- Töpfe: Verdrahtung ----
  function wireSplit() {
    // Name: lokal beim Tippen, speichern beim Verlassen
    root.querySelectorAll("[data-tname]").forEach((el) => {
      el.addEventListener("input", () => { const t = split.pots.find((x) => x.id == el.dataset.tname); if (t) t.name = el.value; });
      el.addEventListener("change", () => { const id = +el.dataset.tname; const t = split.pots.find((x) => x.id == id); if (t) api.updatePot(id, { name: t.name }).catch((e) => { toast(e.message, true); refresh(); }); });
    });
    // €/% umschalten
    root.querySelectorAll("[data-tmode]").forEach((b) => b.addEventListener("click", () => {
      const id = +b.dataset.tmode, t = split.pots.find((x) => x.id == id); if (!t || t.mode === b.dataset.m) return;
      t.mode = b.dataset.m; render();
      api.updatePot(id, { mode: t.mode }).catch((e) => { toast(e.message, true); refresh(); });
    }));
    // Wert: live beim Tippen, speichern beim Verlassen
    root.querySelectorAll("[data-tval]").forEach((el) => {
      wireAmt(el, false);
      el.addEventListener("input", () => { const t = split.pots.find((x) => x.id == el.dataset.tval); if (!t) return; try { t.value = parse(el.value); } catch (_) {} /* zu groß/ungültig: alten Wert halten, Meldung erst beim Verlassen */ liveSplit(); });
      el.addEventListener("change", () => {
        const id = +el.dataset.tval, t = split.pots.find((x) => x.id == id); if (!t) return;
        let v; try { v = parse(el.value); } catch (e) { toast(e.message, true); el.value = t.mode === "percent" ? (t.value || 0) : amtStr(t.value || 0); liveSplit(); return; }
        t.value = v; el.value = t.mode === "percent" ? v : amtStr(v);
        api.updatePot(id, { value: v }).catch((e) => { toast(e.message, true); refresh(); });
        liveSplit();
      });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    });
    // Löschen
    root.querySelectorAll("[data-tdel]").forEach((b) => b.addEventListener("click", () => {
      const id = +b.dataset.tdel;
      split.pots = split.pots.filter((x) => x.id != id); render();
      api.deletePot(id).catch((e) => { toast(e.message, true); refresh(); });
    }));
    // Hinzufügen
    const add = root.querySelector("[data-taddpot]");
    if (add) add.addEventListener("click", async () => {
      const color = COLORS[split.pots.length % COLORS.length];
      try {
        const r = await api.addPot({ name: "Neuer Topf", mode: "fixed", value: 0, color });
        split.pots.push({ id: r.id, name: "Neuer Topf", color, mode: "fixed", value: 0 });
        render();
        const inp = root.querySelector(`[data-tname="${r.id}"]`); if (inp) { inp.focus(); inp.select(); }
      } catch (e) { toast(e.message, true); }
    });
    // Ziehen (Reihenfolge)
    root.querySelectorAll(".tgrip[data-tgrip]").forEach((g) => g.addEventListener("pointerdown", (e) => { if (e.button != null && e.button !== 0) return; startTopfDrag(+g.dataset.tgrip, e); }));
  }

  // Nur Beträge/Übrig aktualisieren, ohne Neuaufbau (Fokus im tval-Feld bleibt erhalten)
  function liveSplit() {
    const c = computeSplit();
    const rows = [...root.querySelectorAll(".trow")];
    c.rows.forEach((r, i) => {
      const el = rows[i]; if (!el) return;
      el.classList.toggle("capped", r.capped);
      const a = el.querySelector(".tassign"); if (a) a.textContent = fmtEUR(r.assign);
      const rr = el.querySelector(".trright"), cap = el.querySelector(".tcap");
      if (r.capped && !cap && rr) { const s = document.createElement("span"); s.className = "tcap"; s.textContent = "anteilig"; rr.appendChild(s); }
      else if (!r.capped && cap) cap.remove();
    });
    const upm = root.querySelector(".uebrig .pm"); if (upm) upm.innerHTML = cur(c.uebrig);
    const upy = root.querySelector(".uebrig .py"); if (upy) upy.innerHTML = cur(c.uebrig * 12);
    const ue = root.querySelector(".uebrig"); if (ue) { ue.classList.toggle("ok", c.uebrig > 0); ue.classList.toggle("zero", c.uebrig <= 0); }
  }

  // ---- Töpfe verschieben (weicher Klon, wie bei Kategorien/Posten) ----
  function startTopfDrag(id, e) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const list = root.querySelector(".tlist"), rowEl = root.querySelector(`.trow[data-id="${id}"]`);
    if (!list || !rowEl) return; e.preventDefault();
    const rect = rowEl.getBoundingClientRect();
    const rows0 = [...root.querySelectorAll(".trow")];
    const listTop0 = rows0.length ? rows0[0].getBoundingClientRect().top : rect.top;
    const listBottom0 = rows0.length ? rows0[rows0.length - 1].getBoundingClientRect().bottom : rect.bottom;
    const sc = canvas;
    const clone = rowEl.cloneNode(true); clone.classList.add("tclone");
    const si = rowEl.querySelectorAll("input"), di = clone.querySelectorAll("input");
    si.forEach((el, i) => { if (di[i]) di[i].value = el.value; });
    clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;`;
    document.body.appendChild(clone);
    const ph = document.createElement("div"); ph.className = "tph"; ph.style.height = rect.height + "px"; rowEl.after(ph); rowEl.classList.add("tdragsrc");
    document.documentElement.classList.add("tdrag-on");
    tDrag = { id, rowEl, clone, ph, offY: rect.top - e.clientY, rowH: rect.height, listTop0, listBottom0, sc, startScroll: sc ? sc.scrollTop : 0, srcIndex: split.pots.findIndex((t) => t.id == id), index: -1 };
    window.addEventListener("pointermove", onTMove); window.addEventListener("pointerup", onTUp); window.addEventListener("keydown", onTKey, true);
  }
  function onTKey(e) { if (e.key === "Escape" && tDrag) cancelT(); }
  function onTMove(e) {
    if (!tDrag) return;
    const dScroll = (tDrag.sc ? tDrag.sc.scrollTop : 0) - tDrag.startScroll;
    let top = e.clientY + tDrag.offY;
    top = Math.max(tDrag.listTop0 - dScroll, Math.min(tDrag.listBottom0 - dScroll - tDrag.rowH, top));
    tDrag.clone.style.top = top + "px";
    const rows = [...root.querySelectorAll(".trow:not(.tdragsrc)")];
    let idx = rows.length;
    for (let i = 0; i < rows.length; i++) { const b = rows[i].getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { idx = i; break; } }
    if (idx !== tDrag.index) { tDrag.index = idx; flipT(() => { if (idx >= rows.length) { rows.length ? rows[rows.length - 1].after(tDrag.ph) : root.querySelector(".tlist").appendChild(tDrag.ph); } else rows[idx].before(tDrag.ph); }); }
  }
  function flipT(mut) {
    const list = root.querySelector(".tlist"); const nodes = [...list.querySelectorAll(".trow:not(.tdragsrc)")];
    const first = new Map(); nodes.forEach((n) => first.set(n, n.getBoundingClientRect().top));
    mut(); nodes.forEach((n) => { n.style.transition = "none"; n.style.transform = ""; }); void list.offsetWidth;
    nodes.forEach((n) => { const dy = first.get(n) - n.getBoundingClientRect().top; if (Math.abs(dy) > 0.5) n.style.transform = `translateY(${dy}px)`; });
    requestAnimationFrame(() => nodes.forEach((n) => { if (n.style.transform) { n.style.transition = "transform .16s var(--ease)"; n.style.transform = ""; } }));
  }
  function cleanupT() { document.documentElement.classList.remove("tdrag-on"); try { tDrag.clone.remove(); } catch (e) {} try { tDrag.ph.remove(); } catch (e) {} tDrag = null; }
  function cancelT() { if (!tDrag) return; window.removeEventListener("pointermove", onTMove); window.removeEventListener("pointerup", onTUp); window.removeEventListener("keydown", onTKey, true); render(); cleanupT(); }
  function onTUp() {
    if (!tDrag) return; const d = tDrag;
    window.removeEventListener("pointermove", onTMove); window.removeEventListener("pointerup", onTUp); window.removeEventListener("keydown", onTKey, true);
    let idx = d.index < 0 ? d.srcIndex : d.index;
    const from = split.pots.findIndex((t) => t.id == d.id); const [m] = split.pots.splice(from, 1);
    if (idx > split.pots.length) idx = split.pots.length; if (idx < 0) idx = 0; split.pots.splice(idx, 0, m);
    render(); cleanupT();
    api.reorderPots(split.pots.map((t) => t.id)).catch((e) => { toast(e.message, true); refresh(); });
  }

  return {
    unmount() {
      if (catDrag) cancelCatDrag();
      if (pDrag) cancelP();
      if (tDrag) cancelT();
      catSettling = null;
      closeMenu(); removeConfirm();
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", ledgerTab);
      document.removeEventListener("keydown", onFocusModeKey, true);
      window.removeEventListener("resize", onResize);
      if (canvas) canvas.removeEventListener("scroll", onScroll);
    },
  };
}

export default { mount };
