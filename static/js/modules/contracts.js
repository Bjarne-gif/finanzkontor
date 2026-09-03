/* Verträge-Panel (Stufe 4) – Kennzahlen · Kategorien-Tabelle · Details/Dokumente.
   Fristen/Kennzahlen kommen vom Backend. Werte werden interaktiv gespeichert
   (kein Speichern-Button). Alle Klassen unter .cxwrap gescopt. Drag folgt separat. */

const eur = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEUR = (n) => eur.format(n || 0);
const eurSign = (n) => fmtEUR(n) + " €";
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Deutsche Konvention (Komma = Dezimal, Punkt = Tausender) – wie im Ledger.
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
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const debounceF = (fn, ms) => { let t, la; const w = (...a) => { la = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...la); }, ms); }; w.flush = () => { if (t) { clearTimeout(t); t = null; fn(...(la || [])); } }; return w; };
const UNITS = ["Monate", "Wochen"];
const ddmmyy = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const toISO = (raw) => { const s = (raw || "").trim(); const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };
const parseISO = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const DAYMS = 86400000;
function subMonthsJS(dt, n) { const d = new Date(dt); const c = d.getDate(); d.setMonth(d.getMonth() - n); if (d.getDate() !== c) d.setDate(0); return d; }
function addMonthsJS(dt, n) { const d = new Date(dt); const c = d.getDate(); d.setMonth(d.getMonth() + n); if (d.getDate() !== c) d.setDate(0); return d; }
// Fristenlogik lokal (spiegelt modules/contracts/calc.py) – für flüssige Live-Anzeige.
function computeFristJS(c, today) {
  if (c.anytime || !c.end_date) return { anytime: true };
  let end = parseISO(c.end_date);
  const stichOf = (e) => c.notice_unit === "Wochen" ? new Date(e.getTime() - c.notice_n * 7 * DAYMS) : subMonthsJS(e, c.notice_n);
  let st = stichOf(end), missed = false;
  while (st < today && c.renew_n > 0) { end = addMonthsJS(end, c.renew_n); st = stichOf(end); missed = true; }
  return { anytime: false, end, stichtag: st, days: Math.round((st - today) / DAYMS), missed };
}

function mount(root, ctx) {
  const { api, store, toast } = ctx;
  const dbName = (store.get("state") && store.get("state").active_db) || "db";
  const UIKEY = "fk_contracts_ui_" + dbName;
  let data = { contracts: [], categories: [], metrics: null };
  let linkable = [];
  let ui;
  try { ui = { marked: ["next"], selId: null, ...JSON.parse(localStorage.getItem(UIKEY) || "{}") }; }
  catch (_) { ui = { marked: ["next"], selId: null }; }
  if (!Array.isArray(ui.marked)) ui.marked = ["next"];
  const saveUi = debounce(() => { try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (_) {} }, 200);

  /* Fokusverhalten Euro-Feld: Tab -> markieren (direkt überschreiben),
     Maus -> Cursor an Klickstelle (€ schon im mousedown weg -> kein Springen). */
  let mouseFocus = false;
  const onFocusModeKey = (e) => { if (e.key === "Tab") mouseFocus = false; };
  document.addEventListener("keydown", onFocusModeKey, true);
  function wireAmt(inp) {
    if (!inp) return;
    inp.addEventListener("mousedown", () => { mouseFocus = true; });   // € bleibt -> Cursor springt nicht
    inp.addEventListener("focus", () => {
      if (mouseFocus) { mouseFocus = false; return; }
      inp.value = inp.value.replace(/\s*€\s*$/, "").trim();
      try { inp.select(); } catch (_) {}
    });
    inp.addEventListener("blur", () => {
      const raw = inp.value.trim(); if (!raw) return;
      let v; try { v = parse(raw); } catch (e) { toast(e.message, true); return; }
      inp.value = eurSign(v);
    });
  }

  // Zentrale Speicher-Warteschlange: sammelt Änderungen und schickt sie kurz danach ab.
  // Beim Verlassen der Seite (F5) wird alles Ausstehende sofort per keepalive gesendet,
  // damit nach dem Reload IMMER der zuletzt eingetippte Stand da ist.
  const pending = { contracts: {}, posten: {}, categories: {} };
  const flushSoon = debounceF(async () => {
    const cs = pending.contracts, ps = pending.posten, cats = pending.categories;
    pending.contracts = {}; pending.posten = {}; pending.categories = {};
    try {
      for (const [id, patch] of Object.entries(cs)) await api.updateContract(+id, patch);
      for (const [id, active] of Object.entries(ps)) await api.updatePosten(+id, { active: +active });
      for (const [id, patch] of Object.entries(cats)) await api.updateContractCategory(+id, patch);
    } catch (e) { toast(e.message, true); }
  }, 300);
  function flushBeacon() {
    const o = { method: "PATCH", headers: { "Content-Type": "application/json" }, keepalive: true, credentials: "same-origin" };
    try {
      for (const [id, patch] of Object.entries(pending.contracts)) fetch(`/api/contracts/contract/${id}`, { ...o, body: JSON.stringify(patch) });
      for (const [id, active] of Object.entries(pending.posten)) fetch(`/api/ledger/posten/${id}`, { ...o, body: JSON.stringify({ active: +active }) });
      for (const [id, patch] of Object.entries(pending.categories)) fetch(`/api/contracts/category/${id}`, { ...o, body: JSON.stringify(patch) });
    } catch (_) {}
  }
  window.addEventListener("beforeunload", flushBeacon);

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  const rmenu = el("div", "cx-rmenu");
  const overlay = el("div", "cx-overlay"); overlay.innerHTML = `<div class="cx-modal" id="cxModal"></div>`;
  const pdf = el("div", "cx-pdfscrim");
  pdf.innerHTML = `<div class="cx-pdfbox"><div class="cx-pdfhead"><span class="pt" id="cxPdfTitle"></span><a id="cxPdfTab" target="_blank" href="#" style="display:none">↗ In neuem Tab</a><span class="px" id="cxPdfClose">✕</span></div><div class="cx-pdfcontent"><div class="cx-pdfmain" id="cxPdfMain"></div><div class="cx-pdfside" id="cxPdfSide"></div></div></div>`;
  const vendorList = el("datalist"); vendorList.id = "cxVendors";
  const fileInput = el("input"); fileInput.type = "file"; fileInput.accept = ".pdf,image/*,.doc,.docx,.txt,.odt,.xls,.xlsx"; fileInput.style.display = "none";
  document.body.append(rmenu, overlay, pdf, fileInput, vendorList);
  const modal = overlay.querySelector("#cxModal");
  const closeMenu = () => rmenu.classList.remove("show");
  const closeOverlay = () => overlay.classList.remove("show");
  const closePdf = () => { pdf.classList.remove("show"); pdf.querySelector("#cxPdfMain").innerHTML = ""; ui.openDoc = null; saveUi(); };
  const onDocClick = (e) => { if (!rmenu.contains(e.target)) closeMenu(); };
  document.addEventListener("click", onDocClick);
  pdf.querySelector("#cxPdfClose").addEventListener("click", closePdf);
  pdf.addEventListener("click", (e) => { if (e.target === pdf) closePdf(); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });

  root.innerHTML = `<div class="cxwrap" id="cx">
    <section class="cx-left"><div class="areatitle">Überblick</div><div id="cxKpi"></div></section>
    <section class="cx-mid"><div class="areatitle">Verträge &amp; Abos</div><div id="cxTable"></div></section>
    <aside class="cx-right"><div class="areatitle">Details &amp; Dokumente</div><div id="cxDetail"></div></aside>
  </div>`;
  const $kpi = root.querySelector("#cxKpi"), $table = root.querySelector("#cxTable"), $detail = root.querySelector("#cxDetail");

  async function refresh() { data = await api.contractsState(); (data.contracts || []).forEach((c) => { if (c.raw_status === undefined) c.raw_status = c.status === "gekündigt" ? "gekündigt" : "aktiv"; }); render(); }
  const today = () => (data.today ? parseISO(data.today) : new Date());
  // lokale Neuberechnung eines Vertrags (Stichtag/Status/effektiv aktiv) – wie das Backend
  function recompute(c) {
    const t = today();
    const f = computeFristJS(c, t);
    c.anytime = !!f.anytime;
    if (f.anytime) { c.stichtag = null; c.days_to_stichtag = null; c.missed = false; c.end = null; }
    else { c.stichtag = isoOf(f.stichtag); c.days_to_stichtag = f.days; c.missed = f.missed; c.end = isoOf(f.end); }
    if (c.raw_status === "gekündigt") c.effective_active = !c.anytime && c.end_date && t < parseISO(c.end_date);
    else c.effective_active = !!c.posten_active;
    c.status = c.raw_status === "gekündigt" ? "gekündigt" : (!c.posten_active ? "pausiert" : "aktiv");
  }
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  // Kennzahlen lokal neu rechnen (spiegelt calc.py) – für live-Kacheln links
  function computeMetrics() {
    const all = data.contracts || [];
    const counting = all.filter((c) => c.effective_active);
    const sumM = counting.reduce((a, c) => a + (c.monthly || 0), 0), sumY = counting.reduce((a, c) => a + (c.yearly || 0), 0);
    const upcoming = all.filter((c) => c.status === "aktiv" && c.effective_active && !c.anytime && !c.missed && c.days_to_stichtag != null).sort((a, b) => a.days_to_stichtag - b.days_to_stichtag);
    const next = upcoming[0], missed = all.filter((c) => c.status === "aktiv" && c.effective_active && c.missed), endingSoon = upcoming.filter((c) => c.days_to_stichtag <= 30);
    const candidates = counting.filter((c) => c.candidate), potM = candidates.reduce((a, c) => a + (c.monthly || 0), 0);
    data.metrics = {
      count_active: counting.length,
      cost: { monthly: round2(sumM), yearly: round2(sumY) },
      next_deadline: next ? { vendor: next.vendor, posten_id: next.posten_id, stichtag: next.stichtag, days: next.days_to_stichtag } : null,
      action_needed: { total: missed.length + endingSoon.length, missed: missed.length, ending_soon: endingSoon.length },
      savings_potential: { count: candidates.length, monthly: round2(potM), yearly: round2(potM * 12) },
      upcoming: upcoming.slice(0, 8).map((c) => ({ vendor: c.vendor, posten_id: c.posten_id, stichtag: c.stichtag, days: c.days_to_stichtag })),
    };
  }
  // Cursor beim Tab-Fokus ans Ende (nichts markiert -> nichts wird versehentlich überschrieben)
  function cursorEnd(inp) { inp.addEventListener("focus", () => setTimeout(() => { try { const l = inp.value.length; inp.setSelectionRange(l, l); } catch (_) {} }, 0)); }
  const catColor = (it) => { const c = (data.categories || []).find((x) => x.id === it.category_id); return c && c.color ? c.color : "var(--accent)"; };

  /* ---------------- Kennzahlen ---------------- */
  function markTile(id) { const i = ui.marked.indexOf(id); if (i >= 0) ui.marked.splice(i, 1); else ui.marked.push(id); saveUi(); render(); }
  function renderKpi() {
    $kpi.innerHTML = "";
    if (!(data.contracts || []).length && !(data.categories || []).length) {
      const ph = el("div", "cx-ph"); ph.textContent = "Kennzahlen erscheinen, sobald du Verträge angelegt hast.";
      $kpi.append(ph); return;
    }
    const m = data.metrics || {};
    const next = m.next_deadline, cost = m.cost || { monthly: 0, yearly: 0 }, act = m.action_needed || {}, save = m.savings_potential || {};
    const handeln = act.total || 0;
    const grid = el("div", "kgrid");
    const tile = (id, cls, lbl, big, sub) => {
      const t = el("div", "tile " + cls + (ui.marked.includes(id) ? " marked" : ""));
      t.innerHTML = `<span class="tlbl">${lbl}</span><div class="tbig">${big}</div><span class="tsub">${sub}</span>`;
      t.addEventListener("click", () => markTile(id));
      return t;
    };
    grid.append(
      tile("count", "", "Bestand", `${m.count_active ?? 0}`, "aktive Verträge"),
      tile("warn", handeln ? "alert" : "ok", "Handlungsbedarf", `${handeln}`, handeln ? `${act.missed || 0} verpasst · ${act.ending_soon || 0} bald` : "alles im Blick"),
      tile("next", "wide hero", "Nächste Kündigungsfrist", next ? `${next.days}<span class="u">Tage</span>` : "—", next ? `${esc(next.vendor)} · kündigen bis ${ddmmyy(next.stichtag)}` : "keine anstehende Frist"),
      tile("cost", "wide", "Kosten", `${fmtEUR(cost.monthly)}<span class="cur">€/Mon.</span>`, `${fmtEUR(cost.yearly)} € pro Jahr`),
      tile("save", "wide", "Sparpotenzial", `${fmtEUR(save.monthly)}<span class="cur">€/Mon.</span>`, `${save.count || 0} Kündigungskandidaten`),
    );
    const lt = el("div", "tile wide listtile" + (ui.marked.includes("list") ? " marked" : ""));
    lt.innerHTML = `<div class="tlbl">Kündigen bis (spätestens)</div>`;
    const up = m.upcoming || [];
    if (!up.length) lt.insertAdjacentHTML("beforeend", `<div class="nr"><span class="nn" style="color:var(--text-faint)">keine anstehenden Fristen</span></div>`);
    const labelOf = (posten_id) => { const c = (data.contracts || []).find((x) => x.posten_id === posten_id); return c && c.label ? " — " + c.label : ""; };
    up.slice(0, 5).forEach((o) => {
      const col = o.days <= 21 ? "var(--negative)" : o.days <= 45 ? "var(--accent)" : "var(--text-faint)";
      const cd = o.days <= 45 ? `in ${o.days} T.` : `in ${Math.round(o.days / 30)} Mon.`;
      const nr = el("div", "nr");
      nr.innerHTML = `<span class="nd" style="color:${col}">${ddmmyy(o.stichtag).slice(0, 6)}</span><span class="nn">${esc(o.vendor)}${esc(labelOf(o.posten_id))}</span><span class="nc" style="color:${col}">${cd}</span>`;
      nr.addEventListener("click", (e) => { e.stopPropagation(); ui.selId = o.posten_id; saveUi(); render(); });
      lt.append(nr);
    });
    lt.addEventListener("click", () => markTile("list"));
    grid.append(lt);
    $kpi.append(grid);
  }

  /* ---------------- Tabelle ---------------- */
  const statusChip = (it) => {
    if (it.status === "pausiert") return `<span class="chip status">pausiert</span>`;
    if (it.status === "gekündigt") return `<span class="chip cancel">gekündigt</span>`;
    if (it.anytime) return `<span class="kd">—</span><span class="chip free">jederzeit</span>`;
    if (it.missed) return `<span class="kd">${ddmmyy(it.stichtag)}</span><span class="chip missed">Frist verpasst</span>`;
    const d = it.days_to_stichtag, u = d <= 21 ? "due" : d <= 45 ? "soon" : "calm";
    return `<span class="kd">${ddmmyy(it.stichtag)}</span><span class="chip ${u}">${d <= 45 ? "in " + d + " T." : "in " + Math.round(d / 30) + " Mon."}</span>`;
  };
  const nameLine = (it) => `${esc(it.vendor)}${it.label ? " — " + esc(it.label) : ""} <span class="pn">· ${esc(it.posten_name)}</span>`;
  const subLine = (it) => {
    if (it.status === "pausiert") return it.pause_until ? `pausiert bis ${ddmmyy(it.pause_until)}` : "inaktiv (pausiert)";
    if (it.status === "gekündigt") return it.effective_active ? `gekündigt · läuft bis ${it.anytime ? "Monatsende" : ddmmyy(it.end)}` : "gekündigt · beendet";
    if (it.anytime) return "jederzeit kündbar";
    return `läuft bis ${ddmmyy(it.end)} · Frist ${it.notice_n} ${it.notice_unit}`;
  };
  const amtCells = (it) => { const isM = it.interval === "monatlich";
    return `<span class="cnum m ${isM ? "prim" : "sec"}">${fmtEUR(it.monthly)}<span class="cur">€</span></span><span class="cnum y ${isM ? "sec" : "prim"}">${fmtEUR(it.yearly)}<span class="cur">€</span></span>`; };

  function renderTable() {
    $table.innerHTML = "";
    const cats = data.categories || [], items = data.contracts || [];
    // Zustand leer: nur "+ Vertrag hinzufügen" (Erstanlage legt Kategorie mit an)
    if (!cats.length && !items.length) {
      const box = el("div", "ledger cx-empty");
      box.innerHTML = `<span class="emptytxt">Noch keine Verträge.<br>Leg über „+ Vertrag hinzufügen" den ersten an – dabei wird gleich eine Kategorie erstellt.</span>`;
      $table.append(box);
      const add = el("button", "addbottom"); add.textContent = "+ Vertrag hinzufügen";
      add.addEventListener("click", () => openContractDialog(null, true)); $table.append(add);
      return;
    }
    const led = el("div", "ledger");
    // dynamische Wertspalten-Breite: wächst erst bei großen Beträgen (wie Vermögen)
    const maxLen = Math.max(9, ...items.map((it) => Math.max(fmtEUR(it.monthly).length, fmtEUR(it.yearly).length)));
    led.style.setProperty("--cx-wertw", Math.max(106, Math.round(maxLen * 8.5 + 26)) + "px");
    led.innerHTML = `<div class="colhead"><span></span><span class="h">Vertragspartner / Posten</span><span class="h r">Kündigen bis</span><span class="h r">mtl.</span><span class="h r">jährl.</span><span></span></div>`;
    const byCat = new Map(); cats.forEach((c) => byCat.set(c.id, []));
    const orphan = [];
    items.forEach((it) => (byCat.has(it.category_id) ? byCat.get(it.category_id) : orphan).push(it));

    const block = (cat, rows) => {
      const g = el("div", "gclass");
      const gh = el("div", "ghead");
      gh.innerHTML = `<span class="grip" title="verschieben">⠿</span><span class="ch-id"><span class="cdot" style="background:${cat ? esc(cat.color || "var(--accent)") : "var(--text-faint)"}"></span>${cat ? `<input class="cname" value="${esc(cat.name)}" data-catname="${cat.id}">` : `<span class="cname" style="border:0">Ohne Kategorie</span>`}</span><span class="ch-act">${cat ? `<button class="del" title="Kategorie löschen" data-delcat="${cat.id}">✕</button>` : ""}</span>`;
      g.append(gh);
      rows.forEach((it) => {
        const r = el("div", "prow" + (it.posten_id === ui.selId ? " sel" : "") + (it.effective_active ? "" : " inactive"));
        if (it.posten_id === ui.selId) { const col = catColor(it); r.style.boxShadow = `inset 3px 0 0 ${col}`; r.style.background = `color-mix(in srgb, ${col} 10%, transparent)`; }
        r.innerHTML = `<span class="grip">⠿</span><span class="vname"><span class="nm">${nameLine(it)}</span><span class="sub">${esc(subLine(it))}</span></span><span class="vkuend">${statusChip(it)}</span>${amtCells(it)}<button class="rmenu-btn" data-menu="${it.id}">⋯</button>`;
        r.addEventListener("click", (e) => { if (e.target.closest(".rmenu-btn")) return; ui.selId = (ui.selId === it.posten_id) ? null : it.posten_id; saveUi(); render(); });
        r.querySelector("[data-menu]").addEventListener("click", (e) => { e.stopPropagation(); if (rmenu.classList.contains("show") && rmenu._ownerId === it.id) { closeMenu(); return; } openRowMenu(it, e.currentTarget); });
        g.append(r);
      });
      // "+ Vertrag hinzufügen" in dieser Kategorie (nur echte Kategorien)
      if (cat) {
        const ca = el("div", "catadd"); ca.innerHTML = `<span class="lab">＋ Vertrag hinzufügen</span>`;
        ca.addEventListener("click", () => openContractDialog(cat.id, false)); g.append(ca);
      }
      // Summenzeile nur wenn Verträge drin
      if (rows.length) {
        const cRows = rows.filter((it) => it.effective_active);
        const sM = cRows.reduce((a, it) => a + it.monthly, 0), sY = cRows.reduce((a, it) => a + it.yearly, 0);
        const srow = el("div", "srow");
        srow.innerHTML = `<span></span><span class="sl">Summe ${cat ? esc(cat.name) : "ohne Kategorie"}</span><span></span><span class="cnum">${fmtEUR(sM)}<span class="cur">€</span></span><span class="cnum">${fmtEUR(sY)}<span class="cur">€</span></span><span></span>`;
        g.append(srow);
      }
      led.append(g);
    };
    cats.forEach((c) => block(c, byCat.get(c.id) || []));
    if (orphan.length) block(null, orphan);

    const act = items.filter((it) => it.effective_active);
    const gM = act.reduce((a, it) => a + it.monthly, 0), gY = act.reduce((a, it) => a + it.yearly, 0);
    const tot = el("div", "totalrow");
    tot.innerHTML = `<span></span><span class="sl">Gesamt (aktiv)</span><span></span><span class="cnum m">${fmtEUR(gM)}<span class="cur">€</span></span><span class="cnum y">${fmtEUR(gY)}<span class="cur">€</span></span><span></span>`;
    led.append(tot);
    $table.append(led);

    // global: nur "+ Kategorie hinzufügen" (Verträge legt man in den Kategorien an)
    const addcat = el("button", "addbottom"); addcat.textContent = "+ Kategorie hinzufügen";
    addcat.addEventListener("click", addCategory); $table.append(addcat);

    led.querySelectorAll("[data-catname]").forEach((inp) => {
      inp.addEventListener("input", () => liveCatName(inp, +inp.dataset.catname, inp.value));
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
      cursorEnd(inp);
    });
    led.querySelectorAll("[data-delcat]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); delCategory(+b.dataset.delcat); }));
  }

  function liveCatName(inp, id, v) {
    const cat = (data.categories || []).find((c) => c.id === id);
    if (cat) cat.name = v;
    const g = inp.closest(".gclass");
    const sl = g && g.querySelector(".srow .sl"); if (sl) sl.textContent = `Summe ${v}`;
    [$detail, pdf].forEach((scope) => { const o = scope.querySelector(`#e_cat option[value="${id}"]`); if (o) o.textContent = v; });
    saveCatName(id, v);
  }
  const saveCatName = (id, v) => { pending.categories[id] = { name: v }; flushSoon(); };
  async function addCategory() { try { await api.addContractCategory({ name: "Neue Kategorie" }); await refresh(); } catch (e) { toast(e.message, true); } }
  async function delCategory(id) {
    const n = (data.contracts || []).filter((it) => it.category_id === id).length;
    if (n) { toast("Kategorie enthält noch Verträge – erst leeren oder umhängen.", true); return; }
    try { await api.deleteContractCategory(id); await refresh(); } catch (e) { toast(e.message, true); } // leer -> direkt, ohne Rückfrage
  }

  /* ---------------- Zeilen-Menü ---------------- */
  function openRowMenu(it, btn) {
    const pInact = it.posten_active === false;
    rmenu.innerHTML = `<button data-a="up">↑ Nach oben</button><button data-a="down">↓ Nach unten</button><div class="sep"></div><button data-a="strike">${pInact ? "Wieder aktivieren" : "Inaktiv setzen"}</button><div class="sep"></div><button class="danger" data-a="rm">Aus Verträgen entfernen</button>`;
    rmenu.querySelectorAll("button").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation(); closeMenu();
      try {
        if (b.dataset.a === "up") await moveContract(it, -1);
        else if (b.dataset.a === "down") await moveContract(it, 1);
        else if (b.dataset.a === "strike") { await api.updatePosten(it.posten_id, { active: pInact ? 1 : 0 }); if (pInact) await api.updateContract(it.id, { pause_until: null }); await refresh(); }  // Master = Haushaltsposten
        else if (b.dataset.a === "rm") { if (ui.selId === it.posten_id) ui.selId = null; await api.deleteContract(it.id); await refresh(); }
      } catch (err) { toast(err.message, true); }
    }));
    const r = btn.getBoundingClientRect();
    rmenu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
    rmenu.style.top = (r.bottom + 4) + "px";
    rmenu._ownerId = it.id;
    rmenu.classList.add("show");
  }
  async function moveContract(it, dir) {
    const all = data.contracts || [];
    const sib = all.filter((x) => x.category_id === it.category_id);
    const i = sib.indexOf(it), j = i + dir; if (j < 0 || j >= sib.length) return;
    const ids = all.map((x) => x.id);
    const gi = all.indexOf(it), gj = all.indexOf(sib[j]);
    [ids[gi], ids[gj]] = [ids[gj], ids[gi]];
    await api.reorderContracts(ids); await refresh();
  }

  /* ---------------- Detail + Dokumente ---------------- */
  function formFields(it) {
    const catOpts = (data.categories || []).map((c) => `<option value="${c.id}" ${c.id === it.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    return `<div class="frow"><div class="fld"><label>Vertragspartner</label><input id="e_vendor" list="cxVendors" value="${esc(it.vendor)}"></div>
      <div class="fld"><label>Vertragsbezeichnung</label><input id="e_label" value="${esc(it.label || "")}" placeholder="z. B. Prime"></div></div>
      <div class="fld"><label>Kategorie</label><select id="e_cat"><option value="">— ohne —</option>${catOpts}</select></div>
      <div class="fld"><label>Vertragsende (leer = jederzeit kündbar)</label><input class="mono" id="e_ende" value="${it.anytime ? "" : ddmmyy(it.end_date)}" placeholder="TT.MM.JJJJ"></div>
      <div class="frow"><div class="fld"><label>Kündigungsfrist</label><div class="unitrow"><input type="number" min="0" id="e_fn" value="${it.anytime ? "" : it.notice_n}"><select id="e_fu">${UNITS.map((u) => `<option ${it.notice_unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></div></div>
      <div class="fld"><label>Verlängert um</label><div class="unitrow"><input type="number" min="0" id="e_vn" value="${it.renew_n || ""}"><select><option>Monate</option></select></div></div></div>
      <div class="frow"><div class="fld"><label>Status</label><select id="e_status"><option ${it.status === "aktiv" ? "selected" : ""}>aktiv</option><option ${it.status === "pausiert" ? "selected" : ""}>pausiert</option><option ${it.status === "gekündigt" ? "selected" : ""}>gekündigt</option></select></div>
      <div class="fld"><label>Kündigungskandidat</label><select id="e_flag"><option ${it.candidate ? "selected" : ""}>ja</option><option ${!it.candidate ? "selected" : ""}>nein</option></select></div></div>
      <div class="fld" id="e_pausewrap" style="${it.status === "pausiert" ? "" : "display:none"}"><label>Pausiert bis (leer = unbegrenzt)</label><input class="mono" id="e_pause" value="${ddmmyy(it.pause_until)}" placeholder="TT.MM.JJJJ"></div>
      <div class="savehint">Änderungen werden automatisch gespeichert.</div>`;
  }
  // Live-Bearbeitung: sofort lokal neu rechnen + Tabelle/Kopf aktualisieren (kein Flackern),
  // Backend-Speichern läuft optimistisch im Hintergrund (debounced).
  function wireForm(scope, it) {
    const g = (id) => scope.querySelector("#" + id);
    const readInto = () => {
      it.vendor = g("e_vendor").value.trim();
      it.label = g("e_label").value.trim();
      it.category_id = g("e_cat").value ? +g("e_cat").value : null;
      const endRaw = g("e_ende").value.trim();
      it.anytime = !endRaw;
      it.end_date = endRaw ? (toISO(endRaw) || it.end_date) : null;
      it.notice_n = parseInt(g("e_fn").value) || 0;
      it.notice_unit = g("e_fu").value;
      it.renew_n = parseInt(g("e_vn").value) || 0;
      it.candidate = g("e_flag").value === "ja";
      const st = g("e_status").value;
      it.raw_status = st === "gekündigt" ? "gekündigt" : "aktiv";
      it.posten_active = st !== "pausiert";
      it.pause_until = st === "pausiert" ? toISO(g("e_pause").value.trim()) : null;
    };
    const saveBackend = () => {
      pending.contracts[it.id] = {
        vendor: it.vendor, label: it.label, category_id: it.category_id,
        end_date: it.end_date ? ddmmyy(it.end_date) : "", anytime: it.anytime,
        notice_n: it.notice_n, notice_unit: it.notice_unit, renew_n: it.renew_n,
        candidate: it.candidate, status: it.raw_status,
        pause_until: it.pause_until ? ddmmyy(it.pause_until) : null,
      };
      pending.posten[it.posten_id] = it.posten_active ? 1 : 0;
      flushSoon();
    };
    const live = () => {
      readInto();
      recompute(it);
      g("e_pausewrap").style.display = g("e_status").value === "pausiert" ? "block" : "none";
      computeMetrics();
      renderTable();
      renderKpi();
      // Aktives Formular (wo der Cursor ist) nur im Kopf aktualisieren, das andere komplett neu –
      // so bleiben Tabelle, Detail-Panel und Viewer immer synchron, ohne den Fokus zu stören.
      const viewerOpen = pdf.classList.contains("show");
      const inViewer = viewerOpen && pdf.contains(document.activeElement);
      if (inViewer) { updateViewerHead(it); if (ui.selId === it.posten_id) renderDetail(); }
      else { updateDetailHead(it); if (viewerOpen) renderViewerSide(it); }
      saveBackend();
    };
    // Text/Zahl live beim Tippen; Datum + Selects beim Ändern/Verlassen
    const flush = () => flushSoon.flush();
    ["e_vendor", "e_label", "e_fn", "e_vn"].forEach((id) => { const e = g(id); if (e) { e.addEventListener("input", live); e.addEventListener("blur", flush); cursorEnd(e); } });
    ["e_ende", "e_pause"].forEach((id) => { const e = g(id); if (e) { cursorEnd(e); e.addEventListener("blur", flush); } });
    ["e_ende", "e_pause", "e_cat", "e_fu", "e_status", "e_flag"].forEach((id) => { const e = g(id); if (e) e.addEventListener("change", () => { live(); flush(); }); });
  }
  // nur den Detail-Kopf aktualisieren (Body/Felder bleiben -> Fokus & Eingabe unberührt)
  function viewerSideHTML(it) {
    return `<div class="sh" id="cxPdfSh">${esc(it.vendor)}${it.label ? " — " + esc(it.label) : ""}</div><div class="ss" id="cxPdfSs">Posten „${esc(it.posten_name)}" · ${fmtEUR(it.amount)} € ${it.interval === "monatlich" ? "mtl." : "jährl."} · kündigen bis ${it.anytime ? "jederzeit" : ddmmyy(it.stichtag)}</div>` + formFields(it);
  }
  function renderViewerSide(it) {
    const side = pdf.querySelector("#cxPdfSide");
    side.innerHTML = viewerSideHTML(it);
    wireForm(side, it);
  }
  function updateViewerHead(it) {
    const sh = pdf.querySelector("#cxPdfSh"), ss = pdf.querySelector("#cxPdfSs");
    if (sh) sh.innerHTML = `${esc(it.vendor)}${it.label ? " — " + esc(it.label) : ""}`;
    if (ss) ss.textContent = `Posten „${it.posten_name}" · ${fmtEUR(it.amount)} € ${it.interval === "monatlich" ? "mtl." : "jährl."} · kündigen bis ${it.anytime ? "jederzeit" : ddmmyy(it.stichtag)}`;
  }
  function detailHeadHTML(it) {
    const col = catColor(it);
    return `<div class="dhead" id="e_dhead" style="background:color-mix(in srgb, ${col} 16%, var(--surface-2))"><div class="dvendor">${esc(it.vendor)}${it.label ? " — " + esc(it.label) : ""}</div><div class="dposten">Posten „${esc(it.posten_name)}" · ${fmtEUR(it.amount)} € ${it.interval === "monatlich" ? "mtl." : "jährl."}</div><div class="dkuend">Kündigen bis <b style="color:var(--text)">${it.anytime ? "jederzeit" : ddmmyy(it.stichtag)}</b> ${statusChipInline(it)}</div></div>`;
  }
  function updateDetailHead(it) {
    const det = $detail.querySelector(".detail"); if (!det) return;
    det.style.borderColor = catColor(it);
    const head = det.querySelector("#e_dhead");
    if (head) head.outerHTML = detailHeadHTML(it);
  }
  const statusChipInline = (it) => it.status === "aktiv"
    ? (it.anytime ? `<span class="chip free">jederzeit</span>` : it.missed ? `<span class="chip missed">verpasst</span>` : (() => { const d = it.days_to_stichtag, u = d <= 21 ? "due" : d <= 45 ? "soon" : "calm"; return `<span class="chip ${u}">${d <= 45 ? "in " + d + " T." : "in " + Math.round(d / 30) + " Mon."}</span>`; })())
    : `<span class="chip ${it.status === "gekündigt" ? "cancel" : "status"}">${it.status}</span>`;

  function renderDetail() {
    $detail.innerHTML = "";
    const it = (data.contracts || []).find((x) => x.posten_id === ui.selId);
    if (!it) { const det = el("div", "detail cx-ph"); det.innerHTML = `<div class="empty">Wähle links einen Vertrag, um Werte zu bearbeiten und Dokumente zu hinterlegen.</div>`; $detail.append(det); return; }
    const col = catColor(it);
    const det = el("div", "detail"); det.style.borderColor = col;
    det.innerHTML = detailHeadHTML(it) + `<div class="dbody" id="e_body"></div>`;
    const body = det.querySelector("#e_body");
    body.innerHTML = formFields(it);
    const docsec = el("div", "docsec"); docsec.innerHTML = `<div class="dt"><span>Dokumente</span><span>${it.docs.length}</span></div>`;
    it.docs.forEach((d) => {
      const doc = el("div", "doc");
      doc.innerHTML = `<span class="fi">${(d.filename.split(".").pop() || "").slice(0, 4).toUpperCase() || "DOC"}</span><span class="fmeta"><div class="fn">${esc(d.filename)}</div><div class="fs">${fmtSize(d.size)}</div></span><span class="fx" data-del="${d.id}">✕</span>`;
      doc.addEventListener("click", (e) => { if (e.target.dataset.del) delDoc(+e.target.dataset.del); else openPdf(d, it); });
      docsec.append(doc);
    });
    const drop = el("div", "drop"); drop.innerHTML = `+ Dokument hinzufügen<br><span style="font-size:10.5px">PDF, Bild, Office-Dokument · max. 15 MB</span>`;
    drop.addEventListener("click", () => triggerUpload(it, drop));
    docsec.append(drop); body.append(docsec);
    $detail.append(det);
    wireForm(body, it);
  }

  /* ---------------- Dokumente ---------------- */
  function triggerUpload(it, dropEl) {
    fileInput.value = "";
    fileInput.onchange = async () => {
      const files = [...fileInput.files]; if (!files.length) return;
      dropEl.classList.add("busy");
      try { for (const f of files) await api.uploadContractDoc(it.id, f); await refresh(); }
      catch (e) { toast(e.message, true); } finally { dropEl.classList.remove("busy"); }
    };
    fileInput.click();
  }
  async function delDoc(id) { try { await api.deleteContractDoc(id); await refresh(); } catch (e) { toast(e.message, true); } }
  function openPdf(d, it) {
    pdf.querySelector("#cxPdfTitle").textContent = d.filename;
    const tab = pdf.querySelector("#cxPdfTab"); tab.href = d.url; tab.style.display = "";
    const main = pdf.querySelector("#cxPdfMain");
    main.innerHTML = d.viewable ? `<iframe src="${d.url}"></iframe>` : `<div class="cx-pdfph"><div class="big">${(d.filename.split(".").pop() || "").slice(0, 4).toUpperCase()}</div><div><b>${esc(d.filename)}</b><br>Nicht im Viewer anzeigbar – über „In neuem Tab" öffnen.</div></div>`;
    renderViewerSide(it);
    ui.openDoc = { docId: d.id, posten_id: it.posten_id }; saveUi();
    pdf.classList.add("show");
  }

  /* ---------------- Neuanlage ---------------- */
  async function openContractDialog(categoryId, askCategory) {
    try { const r = await api.contractsLinkable(); linkable = r.posten || []; } catch (e) { linkable = []; }
    let ledgerCats = [];
    try { const st = await api.ledgerState(); ledgerCats = (st.categories || []).filter((c) => c.kind === "expense"); } catch (e) {}
    const opts = linkable.map((p) => `<option value="${p.id}">${esc(p.name)} · ${fmtEUR(p.amount)} € ${p.interval === "monatlich" ? "mtl." : "jährl."}</option>`).join("");
    const catField = askCategory ? `<div class="fld"><label>Neue Vertrags-Kategorie (Name)</label><input id="n_catname" placeholder="z. B. Streaming"></div>` : "";
    modal.innerHTML = `<h3>Vertrag anlegen</h3><div class="msub">Ein Vertrag hängt immer an einem Kosten-Posten. Wähle einen bestehenden oder lege einen neuen an.</div>
      ${catField}
      <div class="fld"><label>Gehört zu Haushaltsposten</label><select id="n_posten">${opts}<option value="__new">➕ Neuen Kosten-Posten anlegen …</option></select></div>
      <div id="n_new" class="hbox" style="display:${linkable.length ? "none" : "block"}"><div class="hbox-title">Neuer Haushaltsposten</div><div class="fld"><label>Bezeichnung Haushaltsposten</label><input id="n_name" placeholder="z. B. Zeitung"></div><div class="frow"><div class="fld"><label>Betrag</label><input class="mono" id="n_amount" placeholder="0,00"></div><div class="fld" style="max-width:120px"><label>Intervall</label><select id="n_iv"><option value="monatlich">monatlich</option><option value="jaehrlich">jährlich</option></select></div></div>
        <div class="fld"><label>Haushalts-Kategorie (Kosten)</label><select id="n_hcat">${ledgerCats.map((c)=>`<option value="${c.id}">${esc(c.name)}</option>`).join("")}<option value="__newh">➕ Neue Haushalts-Kategorie …</option></select></div>
        <div class="fld" id="n_hcatwrap" style="display:${ledgerCats.length ? "none" : "block"}"><label>Name der Haushalts-Kategorie</label><input id="n_hcatname" value="Fixe Kosten"></div></div>
      <div class="fld"><label>Vertragspartner</label><input id="n_vendor" list="cxVendors" placeholder="z. B. Telekom"></div>
      <div class="fld"><label>Vertragsende (leer = jederzeit)</label><input class="mono" id="n_ende" placeholder="TT.MM.JJJJ"></div>
      <div class="frow"><div class="fld"><label>Kündigungsfrist</label><div class="unitrow"><input type="number" min="0" id="n_fn" placeholder="3"><select id="n_fu"><option>Monate</option><option>Wochen</option></select></div></div><div class="fld"><label>Verlängert um</label><div class="unitrow"><input type="number" min="0" id="n_vn" value="12"><select><option>Monate</option></select></div></div></div>
      <div class="mbtns"><button class="cancel">Abbrechen</button><button class="save">Vertrag anlegen</button></div>`;
    const sel = modal.querySelector("#n_posten");
    const toggleNew = () => { modal.querySelector("#n_new").style.display = (sel.value === "__new" || !linkable.length) ? "block" : "none"; };
    sel.addEventListener("change", toggleNew); toggleNew();
    wireAmt(modal.querySelector("#n_amount"));
    const hsel = modal.querySelector("#n_hcat");
    if (hsel) { const th = () => { modal.querySelector("#n_hcatwrap").style.display = (hsel.value === "__newh" || !ledgerCats.length) ? "block" : "none"; }; hsel.addEventListener("change", th); th(); }
    modal.querySelector(".cancel").addEventListener("click", closeOverlay);
    modal.querySelector(".save").addEventListener("click", async () => {
      try {
        let catId = categoryId;
        if (askCategory) {
          const cn = (modal.querySelector("#n_catname").value || "").trim() || "Neue Kategorie";
          const rc = await api.addContractCategory({ name: cn }); catId = rc.id;
        }
        let posten_id;
        if (sel.value === "__new" || !linkable.length) {
          const name = (modal.querySelector("#n_name").value || "").trim();
          if (!name) { toast("Name des Postens fehlt.", true); return; }
          let hcatId;
          if (hsel.value === "__newh" || !ledgerCats.length) {
            const hn = (modal.querySelector("#n_hcatname").value || "Fixe Kosten").trim();
            const rh = await api.addCategory({ kind: "expense", name: hn }); hcatId = rh.id;
          } else hcatId = +hsel.value;
          let amount; try { amount = parse(modal.querySelector("#n_amount").value); } catch (err) { toast(err.message, true); return; }
          const res = await api.addPosten({ category_id: hcatId, name, amount, interval: modal.querySelector("#n_iv").value });
          posten_id = res && res.id;
        } else posten_id = +sel.value;
        await api.addContract({ posten_id, category_id: catId || null, vendor: (modal.querySelector("#n_vendor").value || "").trim(), end_date: modal.querySelector("#n_ende").value.trim(), anytime: !modal.querySelector("#n_ende").value.trim(), notice_n: parseInt(modal.querySelector("#n_fn").value) || 0, notice_unit: modal.querySelector("#n_fu").value, renew_n: parseInt(modal.querySelector("#n_vn").value) || 0 });
        ui.selId = posten_id; saveUi(); closeOverlay(); await refresh();
      } catch (e) { toast(e.message, true); }
    });
    overlay.classList.add("show");
  }
  async function firstExpenseCat() {
    const st = await api.ledgerState();
    const c = (st.categories || []).find((x) => x.kind === "expense");
    if (!c) throw new Error("Keine Kosten-Kategorie im Haushalt vorhanden.");
    return c.id;
  }

  function fmtSize(bytes) { if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB"; return Math.max(1, Math.round(bytes / 1024)) + " KB"; }
  function restorePdf() {
    if (!ui.openDoc) return;
    const it = (data.contracts || []).find((x) => x.posten_id === ui.openDoc.posten_id);
    const d = it && (it.docs || []).find((x) => x.id === ui.openDoc.docId);
    if (it && d) openPdf(d, it); else { ui.openDoc = null; saveUi(); }
  }
  function updateVendorList() {
    const names = [...new Set((data.contracts || []).map((c) => c.vendor).filter(Boolean))].sort();
    vendorList.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
  }
  function render() { updateVendorList(); renderKpi(); renderTable(); renderDetail(); restorePdf(); }
  refresh().catch((e) => { toast(e.message, true); render(); });

  return { unmount() {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onFocusModeKey, true);
    window.removeEventListener("beforeunload", flushBeacon);
    rmenu.remove(); overlay.remove(); pdf.remove(); fileInput.remove(); vendorList.remove(); root.innerHTML = "";
  } };
}

export default { mount };
