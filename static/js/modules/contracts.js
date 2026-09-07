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
  pdf.innerHTML = `<div class="cx-pdfbox"><div class="cx-pdfhead"><span class="pt" id="cxPdfTitle"></span><a id="cxPdfTab" target="_blank" href="#" style="display:none">↗ In neuem Tab</a><span class="px" id="cxPdfClose">✕</span></div><div class="cx-pdfcontent"><div class="cx-pdfmain" id="cxPdfMain"></div><div class="cx-pdfbar" id="cxPdfBar" title="Konfigspalte ein-/ausklappen"><span class="knob"><span class="chev">›</span></span></div><div class="cx-pdfside" id="cxPdfSide"><div class="cx-pdfside-in" id="cxPdfSideIn"></div></div></div></div>`;
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
  pdf.querySelector("#cxPdfBar").addEventListener("click", () => {
    const box = pdf.querySelector(".cx-pdfbox");
    ui.pdfCollapsed = box.classList.toggle("collapsed");
    saveUi();
  });
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
    // dynamische Wertspalten-Breite: wächst erst bei großen Beträgen (wie Vermögen).
    // Wird auf .cxwrap gesetzt (nicht led), damit der an .cxwrap gehängte Drag-Klon denselben Wert erbt.
    const maxLen = Math.max(9, ...items.map((it) => Math.max(fmtEUR(it.monthly).length, fmtEUR(it.yearly).length)));
    const _cw = root.querySelector(".cxwrap");
    if (_cw) _cw.style.setProperty("--cx-wertw", Math.max(106, Math.round(maxLen * 8.5 + 26)) + "px");
    led.innerHTML = `<div class="colhead"><span></span><span class="h">Vertragspartner / Posten</span><span class="h r">Kündigen bis</span><span class="h r">mtl.</span><span class="h r">jährl.</span><span></span></div>`;
    const byCat = new Map(); cats.forEach((c) => byCat.set(c.id, []));
    const orphan = [];
    items.forEach((it) => (byCat.has(it.category_id) ? byCat.get(it.category_id) : orphan).push(it));

    const block = (cat, rows) => {
      const g = el("div", "gclass"); if (cat) g.dataset.cid = cat.id;
      const gh = el("div", "ghead");
      gh.innerHTML = `${cat ? `<span class="grip" title="verschieben">⠿</span>` : `<span class="grip-void"></span>`}<span class="ch-id"><span class="cdot" style="background:${cat ? esc(cat.color || "var(--accent)") : "var(--text-faint)"}"></span>${cat ? `<input class="cname" value="${esc(cat.name)}" data-catname="${cat.id}">` : `<span class="cname" style="border:0">Ohne Kategorie</span>`}</span><span class="ch-act">${cat ? `<button class="del" title="Kategorie löschen" data-delcat="${cat.id}">✕</button>` : ""}</span>`;
      g.append(gh);
      rows.forEach((it) => {
        const r = el("div", "prow" + (it.posten_id === ui.selId ? " sel" : "") + (it.effective_active ? "" : " inactive"));
        r.dataset.vid = it.id;
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
    wireDrag();
  }

  /* ---------------- Drag & Drop (Verträge + Kategorien) ---------------- */
  const cxwrap = root.querySelector(".cxwrap");
  const dragCanvas = root.closest(".canvas");
  let posDrag = null, catDrag = null;

  const blockEl = (cid) => cid == null ? $table.querySelector(".gclass:not([data-cid])") : $table.querySelector(`.gclass[data-cid="${cid}"]`);
  function catBlocks() {
    const cats = data.categories || [], items = data.contracts || [];
    const byCat = new Map(); cats.forEach((c) => byCat.set(c.id, []));
    const orphan = [];
    items.forEach((it) => (byCat.has(it.category_id) ? byCat.get(it.category_id) : orphan).push(it));
    const blocks = cats.map((c) => ({ cid: c.id, rows: byCat.get(c.id) }));
    if (orphan.length) blocks.push({ cid: null, rows: orphan });
    return blocks;
  }
  function wireDrag() {
    $table.querySelectorAll(".gclass[data-cid] .ghead > .grip").forEach((g) => g.addEventListener("pointerdown", onCatGrip));
    $table.querySelectorAll(".prow > .grip").forEach((g) => g.addEventListener("pointerdown", onPosGrip));
  }

  // --- Verträge (Zeilen; frei zwischen Kategorien inkl. „Ohne Kategorie") ---
  function onPosGrip(e) {
    if (e.button != null && e.button !== 0) return;
    const row = e.target.closest(".prow"); if (!row) return;
    const g = e.target.closest(".gclass");
    startPosDrag(row.dataset.vid, g && g.dataset.cid ? +g.dataset.cid : null, e);
  }
  function posZone() {
    const gs = [...$table.querySelectorAll(".gclass")];
    if (!gs.length) { const r = $table.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }
    return { top: gs[0].getBoundingClientRect().top, bottom: gs[gs.length - 1].getBoundingClientRect().bottom };
  }
  function startPosDrag(vid, cid, e) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    e.preventDefault();
    const rowEl = $table.querySelector(`.prow[data-vid="${vid}"]`); if (!rowEl) return;
    const rect = rowEl.getBoundingClientRect();
    const orderedRows = [];
    catBlocks().forEach((b) => b.rows.forEach((it) => { const r = $table.querySelector(`.prow[data-vid="${it.id}"]`); if (r) { const bb = r.getBoundingClientRect(); orderedRows.push({ vid: it.id, cid: b.cid, mc0: (bb.top + bb.bottom) / 2 }); } }));
    const fromGlobalIdx = orderedRows.findIndex((o) => o.vid == vid);
    const draggedMc0 = orderedRows[fromGlobalIdx] ? orderedRows[fromGlobalIdx].mc0 : (rect.top + rect.bottom) / 2;
    const clone = rowEl.cloneNode(true); clone.classList.add("pclone");
    const dragged = (data.contracts || []).find((x) => x.id == vid);
    clone.style.background = `color-mix(in srgb, ${dragged ? catColor(dragged) : "var(--accent)"} 14%, var(--surface))`;
    clone.style.width = rect.width + "px"; clone.style.left = rect.left + "px"; clone.style.top = rect.top + "px";
    cxwrap.appendChild(clone); cxwrap.classList.add("dragging");
    const ph = document.createElement("div"); ph.className = "prow ph"; ph.style.height = rect.height + "px";
    rowEl.after(ph); rowEl.classList.add("dragsrc");
    const z = posZone();
    posDrag = { vid: +vid, cid, rowEl, clone, ph, rowH: rect.height, cloneOffY: rect.top - e.clientY, orderedRows, fromGlobalIdx, draggedMc0,
      listTop0: z.top, listBottom0: z.bottom, sc: dragCanvas, startScroll: dragCanvas ? dragCanvas.scrollTop : 0, lastY: e.clientY, dstCid: cid, dstIndex: -1, raf: 0 };
    window.addEventListener("pointermove", onPMove);
    window.addEventListener("pointerup", onPUp);
    window.addEventListener("pointercancel", cancelP);
    window.addEventListener("keydown", onPKey, true);
    updateP();
  }
  function onPMove(e) { if (!posDrag) return; posDrag.lastY = e.clientY; updateP(); autoScrollP(); }
  function flipP(mutator) {
    const nodes = [...$table.querySelectorAll(".prow:not(.dragsrc), .ghead, .catadd, .srow, .totalrow")];
    const first = new Map(); nodes.forEach((n) => first.set(n, n.getBoundingClientRect().top));
    mutator();
    nodes.forEach((n) => { n.style.transition = "none"; n.style.transform = ""; });
    void $table.offsetWidth;
    nodes.forEach((n) => { const dy = first.get(n) - n.getBoundingClientRect().top; if (Math.abs(dy) > 0.5) n.style.transform = `translateY(${dy}px)`; });
    requestAnimationFrame(() => { nodes.forEach((n) => { if (n.style.transform) { n.style.transition = "transform .16s ease"; n.style.transform = ""; } }); });
  }
  function placeP(cid, index) {
    const g = blockEl(cid); if (!g) return;
    const rows = [...g.querySelectorAll(".prow")].filter((x) => !x.classList.contains("dragsrc") && !x.classList.contains("ph"));
    if (index >= rows.length) { const anchor = g.querySelector(".catadd") || g.querySelector(".srow"); if (anchor) anchor.before(posDrag.ph); else g.appendChild(posDrag.ph); }
    else rows[index].before(posDrag.ph);
  }
  function mapIns(ins, cloneCenter) {
    const blocks = catBlocks(); let cum = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi], cnt = b.rows.reduce((a, it) => a + (it.id == posDrag.vid ? 0 : 1), 0);
      if (ins < cum + cnt) return { cid: b.cid, index: ins - cum };
      if (ins === cum + cnt) {
        const next = blocks[bi + 1];
        if (!next) return { cid: b.cid, index: cnt };
        const g = blockEl(b.cid), ng = blockEl(next.cid);
        const midGap = ((g ? g.getBoundingClientRect().bottom : 0) + (ng ? ng.getBoundingClientRect().top : 0)) / 2;
        return (cloneCenter < midGap) ? { cid: b.cid, index: cnt } : { cid: next.cid, index: 0 };
      }
      cum += cnt;
    }
    const last = blocks[blocks.length - 1]; return { cid: last.cid, index: last.rows.reduce((a, it) => a + (it.id == posDrag.vid ? 0 : 1), 0) };
  }
  const cidKey = (c) => (c == null ? "\u2205" : c);
  function updateP() {
    const D = posDrag; if (!D) return;
    const dScroll = D.sc ? (D.sc.scrollTop - D.startScroll) : 0;
    let top = D.lastY + D.cloneOffY;
    const lt = D.listTop0 - dScroll, lb = D.listBottom0 - dScroll;
    top = Math.max(lt, Math.min(Math.max(lt, lb - D.rowH), top));
    D.clone.style.top = top + "px";
    const cloneTop = top, cloneBottom = top + D.rowH;
    let below = 0, above = 0;
    D.orderedRows.forEach((o) => {
      if (o.vid == D.vid) return; const mcn = o.mc0 - dScroll;
      if (o.mc0 > D.draggedMc0) { if (cloneBottom > mcn) below++; }
      else { if (cloneTop < mcn) above++; }
    });
    const N = Math.max(0, D.orderedRows.length - 1);
    const ins = Math.max(0, Math.min(N, D.fromGlobalIdx + below - above));
    const t = mapIns(ins, cloneTop + D.rowH / 2);
    if (cidKey(t.cid) !== cidKey(D.dstCid) || t.index !== D.dstIndex) { D.dstCid = t.cid; D.dstIndex = t.index; flipP(() => placeP(t.cid, t.index)); }
  }
  function autoScrollP() {
    const D = posDrag; if (!D || D.raf || !dragCanvas) return;
    const EDGE = 56;
    const step = () => {
      if (!posDrag) return; const rr = dragCanvas.getBoundingClientRect(), yy = posDrag.lastY; let dd = 0;
      if (yy < rr.top + EDGE) dd = -1; else if (yy > rr.bottom - EDGE) dd = 1;
      if (dd === 0) { posDrag.raf = 0; return; }
      const di = dd < 0 ? (rr.top + EDGE - yy) : (yy - (rr.bottom - EDGE)); const sp = Math.min(20, 4 + di / 2.4);
      const before = dragCanvas.scrollTop; dragCanvas.scrollTop = Math.max(0, before + dd * sp);
      if (dragCanvas.scrollTop !== before) { updateP(); posDrag.raf = requestAnimationFrame(step); } else posDrag.raf = 0;
    };
    posDrag.raf = requestAnimationFrame(step);
  }
  function onPKey(e) { if (e.key === "Escape" && posDrag) { e.preventDefault(); cancelP(); } }
  function detachP() { window.removeEventListener("pointermove", onPMove); window.removeEventListener("pointerup", onPUp); window.removeEventListener("pointercancel", cancelP); window.removeEventListener("keydown", onPKey, true); }
  function cleanupP() {
    const D = posDrag; if (!D) return; if (D.raf) cancelAnimationFrame(D.raf);
    try { D.clone.remove(); } catch (_) {} try { D.ph.remove(); } catch (_) {}
    if (D.rowEl) D.rowEl.classList.remove("dragsrc");
    $table.querySelectorAll(".prow, .ghead, .catadd, .srow, .totalrow").forEach((n) => { n.style.transition = ""; n.style.transform = ""; });
    cxwrap.classList.remove("dragging");
    posDrag = null;
  }
  function cancelP() { detachP(); cleanupP(); render(); }
  async function onPUp() {
    const D = posDrag; if (!D) return; detachP();
    if (D.dstIndex < 0) { cleanupP(); render(); return; }   // reiner Klick ohne Ziehen
    const cid = D.dstCid, index = D.dstIndex;
    let items = data.contracts || [];
    const it = items.find((x) => x.id == D.vid);
    if (!it) { cleanupP(); render(); return; }
    const changed = (it.category_id ?? null) !== (cid ?? null);
    items = items.filter((x) => x.id != D.vid);
    it.category_id = cid;
    const cats = data.categories || [];
    const byCat = new Map(); cats.forEach((c) => byCat.set(c.id, []));
    const orphan = [];
    items.forEach((x) => (byCat.has(x.category_id) ? byCat.get(x.category_id) : orphan).push(x));
    const targetRows = cid == null ? orphan : (byCat.get(cid) || orphan);
    targetRows.splice(Math.max(0, Math.min(targetRows.length, index)), 0, it);
    const flat = []; cats.forEach((c) => (byCat.get(c.id) || []).forEach((x) => flat.push(x))); orphan.forEach((x) => flat.push(x));
    data.contracts = flat;
    cleanupP(); computeMetrics(); render();
    try {
      flushSoon.flush();
      if (changed) await api.updateContract(it.id, { category_id: cid });
      await api.reorderContracts(flat.map((x) => x.id));
    } catch (e) { toast(e.message, true); refresh(); }
  }

  // --- Kategorien (echte Kategorien untereinander; „Ohne Kategorie" bleibt fix) ---
  function onCatGrip(e) {
    if (e.button != null && e.button !== 0) return;
    const g = e.target.closest(".gclass"); if (!g || !g.dataset.cid) return;
    startCatDrag(+g.dataset.cid, e);
  }
  function catZone() {
    const gs = [...$table.querySelectorAll(".gclass[data-cid]")];
    if (!gs.length) { const r = $table.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }
    return { top: gs[0].getBoundingClientRect().top, bottom: gs[gs.length - 1].getBoundingClientRect().bottom };
  }
  function startCatDrag(cid, e) {
    const cats = data.categories || [];
    if (cats.length < 2) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    e.preventDefault();
    const gEl = blockEl(cid); if (!gEl) return; const rect = gEl.getBoundingClientRect();
    const clone = gEl.cloneNode(true); clone.classList.add("cclone");
    clone.style.width = rect.width + "px"; clone.style.left = rect.left + "px"; clone.style.top = rect.top + "px";
    cxwrap.appendChild(clone); cxwrap.classList.add("dragging");
    gEl.style.visibility = "hidden";
    const gels = {}, mc0 = {}; cats.forEach((cc) => { const g = blockEl(cc.id); gels[cc.id] = g; if (g) { const r = g.getBoundingClientRect(); mc0[cc.id] = (r.top + r.bottom) / 2; } });
    const z = catZone();
    catDrag = { cid, gEl, clone, gels, order0: cats.slice(), mc0, mcCid: mc0[cid], fromIndex: cats.findIndex((cc) => cc.id == cid),
      blockH: rect.height, footprint: rect.height + 9, cloneOffY: rect.top - e.clientY,
      listTop0: z.top, listBottom0: z.bottom, sc: dragCanvas, startScroll: dragCanvas ? dragCanvas.scrollTop : 0, lastY: e.clientY, toIndex: cats.findIndex((cc) => cc.id == cid), raf: 0 };
    window.addEventListener("pointermove", onCMove);
    window.addEventListener("pointerup", onCUp);
    window.addEventListener("pointercancel", cancelC);
    window.addEventListener("keydown", onCKey, true);
    updateC();
  }
  function onCMove(e) { if (!catDrag) return; catDrag.lastY = e.clientY; updateC(); autoScrollC(); }
  function updateC() {
    const D = catDrag; if (!D) return;
    const y = D.lastY, dScroll = D.sc ? (D.sc.scrollTop - D.startScroll) : 0;
    let cloneTop = y + D.cloneOffY;
    const lt = D.listTop0 - dScroll, lb = D.listBottom0 - dScroll;
    cloneTop = Math.max(lt, Math.min(Math.max(lt, lb - D.blockH), cloneTop));
    D.clone.style.top = cloneTop + "px";
    const cloneBot = cloneTop + D.blockH;
    let below = 0, above = 0;
    D.order0.forEach((oc) => {
      if (oc.id == D.cid) return; const mcn = D.mc0[oc.id] - dScroll;
      if (D.mc0[oc.id] > D.mcCid) { if (cloneBot > mcn) below++; }
      else { if (cloneTop < mcn) above++; }
    });
    const toIndex = D.fromIndex + below - above;
    if (toIndex !== D.toIndex) { D.toIndex = toIndex; applyCatShift(); }
  }
  function applyCatShift() {
    const D = catDrag; if (!D) return; const { order0, cid, fromIndex, toIndex, footprint } = D;
    order0.forEach((oc, i) => {
      if (oc.id == cid) return; let sh = 0;
      if (toIndex > fromIndex) { if (i > fromIndex && i <= toIndex) sh = -footprint; }
      else if (toIndex < fromIndex) { if (i >= toIndex && i < fromIndex) sh = footprint; }
      const g = D.gels[oc.id]; if (g) { g.style.transition = "transform .16s ease"; g.style.transform = sh ? `translateY(${sh}px)` : ""; }
    });
  }
  function autoScrollC() {
    const D = catDrag; if (!D || D.raf || !dragCanvas) return;
    const EDGE = 56;
    const step = () => {
      if (!catDrag) return; const rr = dragCanvas.getBoundingClientRect(), yy = catDrag.lastY; let dd = 0;
      if (yy < rr.top + EDGE) dd = -1; else if (yy > rr.bottom - EDGE) dd = 1;
      if (dd === 0) { catDrag.raf = 0; return; }
      const di = dd < 0 ? (rr.top + EDGE - yy) : (yy - (rr.bottom - EDGE)); const sp = Math.min(20, 4 + di / 2.4);
      const before = dragCanvas.scrollTop; dragCanvas.scrollTop = Math.max(0, before + dd * sp);
      if (dragCanvas.scrollTop !== before) { updateC(); catDrag.raf = requestAnimationFrame(step); } else catDrag.raf = 0;
    };
    catDrag.raf = requestAnimationFrame(step);
  }
  function onCKey(e) { if (e.key === "Escape" && catDrag) { e.preventDefault(); cancelC(); } }
  function detachC() { window.removeEventListener("pointermove", onCMove); window.removeEventListener("pointerup", onCUp); window.removeEventListener("pointercancel", cancelC); window.removeEventListener("keydown", onCKey, true); }
  function cleanupC() {
    const D = catDrag; if (!D) return; if (D.raf) cancelAnimationFrame(D.raf);
    try { D.clone.remove(); } catch (_) {}
    if (D.gEl) D.gEl.style.visibility = "";
    D.order0.forEach((oc) => { const g = D.gels[oc.id]; if (g) { g.style.transition = ""; g.style.transform = ""; } });
    cxwrap.classList.remove("dragging");
    catDrag = null;
  }
  function cancelC() { detachC(); cleanupC(); render(); }
  async function onCUp() {
    const D = catDrag; if (!D) return; detachC();
    const cats = data.categories || [];
    const to = Math.max(0, Math.min(cats.length - 1, D.toIndex));
    const cur = cats.findIndex((c) => c.id == D.cid);
    const moved = cur !== to && cur >= 0;
    if (moved) { const [m] = cats.splice(cur, 1); cats.splice(to, 0, m); }
    cleanupC(); render();
    if (!moved) return;
    try { flushSoon.flush(); await api.reorderContractCategories(cats.map((c) => c.id)); }
    catch (e) { toast(e.message, true); refresh(); }
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
  function applyViewerCat(it) { const box = pdf.querySelector(".cx-pdfbox"); if (box) box.style.setProperty("--cx-cat", catColor(it)); }
  function renderViewerSide(it) {
    const side = pdf.querySelector("#cxPdfSideIn");
    side.innerHTML = viewerSideHTML(it);
    wireForm(side, it);
    applyViewerCat(it);
  }
  function updateViewerHead(it) {
    const sh = pdf.querySelector("#cxPdfSh"), ss = pdf.querySelector("#cxPdfSs");
    if (sh) sh.innerHTML = `${esc(it.vendor)}${it.label ? " — " + esc(it.label) : ""}`;
    if (ss) ss.textContent = `Posten „${it.posten_name}" · ${fmtEUR(it.amount)} € ${it.interval === "monatlich" ? "mtl." : "jährl."} · kündigen bis ${it.anytime ? "jederzeit" : ddmmyy(it.stichtag)}`;
    applyViewerCat(it);
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
    const docsec = el("div", "docsec");
    docsec.innerHTML = `<div class="dt"><span>Dokumente</span><span class="cnt">${it.docs.length}</span><span class="sp"></span><button class="fmbtn" style="--cat:${col}" title="Dateiverwaltung öffnen"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5a1.8 1.8 0 0 1 1.8-1.8h3.2l1.8 1.8h6.4A1.8 1.8 0 0 1 20 9.3v7.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 16.7V7.5Z"/></svg></span>Verwaltung</button></div>`;
    docsec.querySelector(".fmbtn").addEventListener("click", (e) => { e.stopPropagation(); openFileManager(); });
    it.docs.forEach((d) => {
      const doc = el("div", "doc");
      doc.innerHTML = `<span class="fi">${(d.filename.split(".").pop() || "").slice(0, 4).toUpperCase() || "DOC"}</span><span class="fmeta"><div class="fn">${esc(d.filename)}</div><div class="fs">${fmtSize(d.size)}</div></span><span class="fx" data-del="${d.id}" title="Vom Vertrag lösen (→ Verwaist)">✕</span>`;
      doc.addEventListener("click", (e) => { if (e.target.dataset.del) delDoc(+e.target.dataset.del); else openPdf(d, it); });
      docsec.append(doc);
    });
    const drop = el("div", "drop"); drop.innerHTML = `+ Dokument hinzufügen<br><span style="font-size:10.5px">PDF, Bild, Office-Dokument · max. 15 MB</span>`;
    drop.addEventListener("click", () => triggerUpload(it, drop));
    docsec.append(drop); body.append(docsec);
    $detail.append(det);
    wireForm(body, it);
  }

  /* ---------------- Dateiverwaltung (Stufe 5) — Modal + Liste ---------------- */
  let fmScrim = null;
  const fm = { docs: [], contracts: [], categories: [], mode: "cat", expanded: new Set(), editing: null, rmenu: null, active: null, dirty: false };
  const fmCatColor = (catId) => { const c = (fm.categories || []).find((x) => x.id === catId); return c ? (c.color || "var(--accent)") : "var(--accent)"; };
  const fmLabel = (c) => esc(c.vendor || "") + (c.label ? " — " + esc(c.label) : "");
  const fmDownload = (url) => { const a = document.createElement("a"); a.href = url; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
  function fmConfirm(msg, okLabel = "Löschen") {
    return new Promise((resolve) => {
      const c = el("div", "cx-fmconfirm");
      c.innerHTML = `<div class="box"><div class="msg"></div><div class="btns"><button class="cancel">Abbrechen</button><button class="ok">${esc(okLabel)}</button></div></div>`;
      c.querySelector(".msg").textContent = msg;
      fmScrim.querySelector(".cx-fm").appendChild(c);
      const done = (v) => { c.remove(); resolve(v); };
      c.addEventListener("click", (e) => { if (e.target === c) done(false); });
      c.querySelector(".cancel").addEventListener("click", () => done(false));
      c.querySelector(".ok").addEventListener("click", () => done(true));
    });
  }

  function buildFmScrim() {
    fmScrim = el("div", "cx-fmscrim");
    fmScrim.innerHTML = `<div class="cx-fm"><div class="cx-fmhead"><h2>Dateiverwaltung</h2><span class="sp"></span><span class="db" id="cxFmDb"></span><span class="x" id="cxFmClose">✕</span></div>`
      + `<div class="cx-fmbody">`
      + `<div class="cx-fmview"><div class="cx-fmvhead" id="cxFmVHead"><span class="fn">Vorschau</span><span class="sp"></span></div><div class="cx-fmvbody empty" id="cxFmVBody"><div class="ph">Datei rechts anklicken,<br>um sie hier anzusehen.</div></div></div>`
      + `<div class="cx-fmbar" id="cxFmBar" title="Liste ein-/ausklappen"><span class="knob"><span class="chev">›</span></span></div>`
      + `<div class="cx-fmleft"><div class="cx-fmleft-in"><div class="cx-fmtools"><div class="seg"><button data-m="cat" class="on">Nach Kategorie</button><button data-m="all">Alle</button></div></div>`
      + `<div class="cx-fmlist" id="cxFmList"></div>`
      + `<div class="cx-fmfoot"><span class="sum" id="cxFmSum"></span><button class="btn" id="cxFmZip">⤓ Alle als ZIP</button><button class="btn danger" id="cxFmClean">Verwaiste löschen</button></div></div></div>`
      + `</div></div>`;
    document.body.appendChild(fmScrim);
    fmScrim.addEventListener("click", (e) => { if (e.target === fmScrim) closeFileManager(); });
    fmScrim.querySelector("#cxFmClose").addEventListener("click", closeFileManager);
    fmScrim.querySelector("#cxFmBar").addEventListener("click", () => fmScrim.querySelector(".cx-fm").classList.toggle("collapsed"));
    fmScrim.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => { fmScrim.querySelectorAll(".seg button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); fm.mode = b.dataset.m; fmRenderList(); }));
    fmScrim.querySelector("#cxFmZip").addEventListener("click", () => fmDownload(api.docsZipUrl()));
    fmScrim.querySelector("#cxFmClean").addEventListener("click", fmCleanOrphans);
    const list = fmScrim.querySelector("#cxFmList");
    list.addEventListener("click", fmListClick);
    list.addEventListener("keydown", fmListKey);
    list.addEventListener("pointerdown", fmDragStart);
  }
  async function openFileManager() {
    if (!fmScrim) buildFmScrim();
    fmScrim.classList.add("show");
    try {
      const r = await api.docsAll();
      fm.docs = r.docs || []; fm.contracts = r.contracts || []; fm.categories = r.categories || [];
      fm.editing = null; fm.rmenu = null; fm.active = null;
      fm.expanded = new Set([...fm.categories.map((c) => c.id), "orphan"]);
      fmScrim.querySelector("#cxFmDb").textContent = "Datenbank: " + (r.db || "");
      fmViewedId = undefined; fmRenderList();
    } catch (e) { toast(e.message || "Laden fehlgeschlagen", true); }
  }
  function closeFileManager() { if (fmScrim) { fmScrim.classList.remove("show"); fmCloseMenus(); } fm.editing = null; }

  function fmFrowHTML(d) {
    const editing = fm.editing === d.id;
    const meta = editing
      ? `<div class="edit"><input id="cxFmRen" value="${esc(d.filename)}"><button class="ib ok" data-rok="${d.id}" title="Speichern">✓</button><button class="ib" data-rcancel="1" title="Abbrechen">✕</button></div>`
      : `<div class="fn">${esc(d.filename)}</div><div class="lk">${d.vendor ? fmLabel(d) : "keine Verknüpfung"}</div>`;
    const act = editing ? ""
      : `<button class="ib" data-rn="${d.id}" title="Umbenennen">✎</button><button class="ib" data-menu="${d.id}" title="Mehr">⋯</button><div class="rmenu"><button data-dl="${d.id}"><span class="mi">⤓</span> Download</button><div class="sep"></div><button class="del" data-del="${d.id}"><span class="mi">🗑</span> Löschen</button></div>`;
    const ext = (d.filename.split(".").pop() || "").slice(0, 4).toUpperCase() || "DOC";
    return `<div class="frow${fm.active === d.id ? " active" : ""}" data-vid="${d.id}"><span class="grip" title="ziehen zum Umhängen / Sortieren">⠿</span><span class="fi"${editing ? "" : ` data-open="${d.id}"`}>${ext}</span><div class="meta"${editing ? "" : ` data-open="${d.id}"`}>${meta}</div>${editing ? "" : `<span class="sz">${fmtSize(d.size)}</span>`}<span class="act">${act}</span></div>`;
  }
  function fmCtrHTML(c) {
    const items = fm.docs.filter((d) => d.contract_id === c.id);
    return `<div class="ctr" data-ctr="${c.id}"><div class="ctrhead"><span class="cdot" style="background:${fmCatColor(c.category_id)}"></span>${fmLabel(c)}</div>${items.map(fmFrowHTML).join("")}<div class="ctr-empty">Noch keine Dokumente</div></div>`;
  }
  function fmGroupHTML(cat) {
    const ctrs = fm.contracts.filter((c) => c.category_id === cat.id);
    const total = fm.docs.filter((d) => ctrs.some((c) => c.id === d.contract_id)).length;
    const open = fm.mode === "all" || fm.expanded.has(cat.id);
    return `<div class="catgroup ${open ? "open" : ""}" style="--cat:${cat.color || "var(--accent)"}"><div class="cathead" data-grp="${cat.id}"><span class="dot"></span><span class="cn">${esc(cat.name)}</span><span class="cc">${total}</span><span class="chev">▸</span></div><div class="catfiles">${ctrs.map(fmCtrHTML).join("")}</div></div>`;
  }
  function fmOrphanHTML() {
    const orph = fm.docs.filter((d) => d.contract_id == null);
    const open = fm.mode === "all" || fm.expanded.has("orphan");
    return `<div class="catgroup grouporphan ${open ? "open" : ""}" style="--cat:var(--negative)"><div class="cathead" data-grp="orphan"><span class="dot"></span><span class="cn">Verwaist</span><span class="cc">${orph.length}</span><span class="chev">▸</span></div><div class="catfiles"><div class="ctr" data-ctr="">${orph.map(fmFrowHTML).join("")}<div class="ctr-empty">Keine verwaisten Dokumente</div></div></div></div>`;
  }
  function fmRenderList() {
    if (!fmScrim) return;
    fmScrim.querySelector("#cxFmList").innerHTML = fm.categories.map(fmGroupHTML).join("") + fmOrphanHTML();
    fmUpdateSummary();
    fmRenderView();
  }
  function fmUpdateSummary() {
    const orph = fm.docs.filter((d) => d.contract_id == null).length;
    const total = fm.docs.reduce((a, d) => a + (d.size || 0), 0);
    fmScrim.querySelector("#cxFmSum").innerHTML = `<b>${fm.docs.length}</b> Dateien · <b>${fmtSize(total)}</b> · <b>${orph}</b> verwaist`;
    const cl = fmScrim.querySelector("#cxFmClean"); cl.textContent = `Verwaiste löschen${orph ? " (" + orph + ")" : ""}`; cl.disabled = !orph;
  }
  let fmViewedId;
  function fmRenderView(force) {
    if (!fmScrim) return;
    if (!force && fmViewedId === fm.active) return;   // Guard: iframe nicht ohne Not neu laden (kein Flackern)
    fmViewedId = fm.active;
    const vh = fmScrim.querySelector("#cxFmVHead"), vb = fmScrim.querySelector("#cxFmVBody"), bar = fmScrim.querySelector(".cx-fmbar");
    const d = fm.docs.find((x) => x.id === fm.active);
    // Balken-Kachel in der Kategorie-Farbe der aktiven Datei
    bar.classList.toggle("colored", !!d);
    if (d) { const c = fm.contracts.find((x) => x.id === d.contract_id); bar.style.setProperty("--fm-cat", c ? fmCatColor(c.category_id) : "var(--accent)"); }
    else bar.style.removeProperty("--fm-cat");
    if (!d) { vh.innerHTML = `<span class="fn">Vorschau</span><span class="sp"></span>`; vb.className = "cx-fmvbody empty"; vb.innerHTML = `<div class="ph">Datei rechts anklicken,<br>um sie hier anzusehen.</div>`; return; }
    const url = api.contractDocUrl(d.id);
    vh.innerHTML = `<span class="fn">${esc(d.filename)}</span><span class="sp"></span><a href="${url}" target="_blank" rel="noopener">↗ In neuem Tab</a>`;
    const ext = (d.filename.split(".").pop() || "").toLowerCase();
    if (ext === "pdf") { vb.className = "cx-fmvbody"; vb.innerHTML = `<iframe src="${url}" title="${esc(d.filename)}"></iframe>`; }
    else if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) { vb.className = "cx-fmvbody img"; vb.innerHTML = `<img src="${url}" alt="${esc(d.filename)}">`; }
    else { vb.className = "cx-fmvbody empty"; vb.innerHTML = `<div class="ph">Für diesen Dateityp gibt es keine Vorschau.<br><a href="${url}" target="_blank" rel="noopener">↗ In neuem Tab öffnen</a></div>`; }
  }

  const fmRow = (id) => fmScrim.querySelector(`.frow[data-vid="${id}"]`);
  const fmCloseMenus = () => fmScrim.querySelectorAll(".cx-fmlist .rmenu.show").forEach((m) => m.classList.remove("show"));
  function fmToggleMenu(id) { const row = fmRow(id); if (!row) return; const m = row.querySelector(".rmenu"); const was = m.classList.contains("show"); fmCloseMenus(); if (!was) m.classList.add("show"); }
  function fmSetActive(id) {
    fmScrim.querySelectorAll(".frow.active").forEach((r) => r.classList.remove("active"));
    fm.active = fm.active === id ? null : id;
    if (fm.active) { const row = fmRow(fm.active); if (row) row.classList.add("active"); }
    fmRenderView();   // nur hier wird die Vorschau (neu) geladen
  }
  // Änderungen live ins Vertrags-Detail spiegeln (Name / Entfernen), ohne F5
  function fmSyncDetail(id, value) {
    (data.contracts || []).forEach((c) => { const arr = c.docs || []; const i = arr.findIndex((x) => x.id === id); if (i >= 0) { if (value === null) arr.splice(i, 1); else arr[i].filename = value; } });
    renderDetail();
  }
  function fmStartRename(id) {
    fmCloseMenus(); fm.editing = id;
    const row = fmRow(id), d = fm.docs.find((x) => x.id === id);
    if (!row || !d) return;
    row.outerHTML = fmFrowHTML(d);
    const inp = fmScrim.querySelector("#cxFmRen");
    if (inp) { inp.focus(); inp.select(); inp.addEventListener("input", () => fmRenameLive(id, inp.value)); }
  }
  function fmRenameLive(id, value) {
    const d = fm.docs.find((x) => x.id === id); if (d) d.filename = value;
    if (fm.active === id) { const fnEl = fmScrim.querySelector("#cxFmVHead .fn"); if (fnEl) fnEl.textContent = value; }
    fmSyncDetail(id, value);   // Detail-Panel live (auch während des Tippens)
  }
  async function fmEndRename(id, save) {
    const inp = fmScrim.querySelector("#cxFmRen"); const v = (inp && inp.value.trim()) || "";
    fm.editing = null;
    const d = fm.docs.find((x) => x.id === id);
    if (save && v && d) { d.filename = v; fmSyncDetail(id, v); }
    else if (d) { fmSyncDetail(id, d.filename); }   // Abbruch: alten Namen zurückspiegeln
    const row = fmRow(id); if (row && d) row.outerHTML = fmFrowHTML(d);
    try { const inp2 = fmScrim.querySelector("#cxFmRen"); if (inp2) inp2.blur(); } catch (_) {}
    if (save && v) { try { await api.patchDoc(id, { filename: v }); } catch (e) { toast(e.message, true); } }
  }
  function fmListClick(e) {
    const t = e.target, gh = t.closest(".cathead");
    if (gh) { if (fm.mode === "cat") { const k = gh.dataset.grp; const key = k === "orphan" ? "orphan" : +k; fm.expanded.has(key) ? fm.expanded.delete(key) : fm.expanded.add(key); fmRenderList(); } return; }
    if (t.dataset.rn) { fmStartRename(+t.dataset.rn); return; }
    if (t.dataset.rok) { fmEndRename(+t.dataset.rok, true); return; }
    if (t.dataset.rcancel) { if (fm.editing != null) fmEndRename(fm.editing, false); return; }
    if (t.dataset.menu) { e.stopPropagation(); fmToggleMenu(+t.dataset.menu); return; }
    if (t.dataset.dl) { fmCloseMenus(); fmDownload(api.docDownloadUrl(+t.dataset.dl)); return; }
    if (t.dataset.del) { fmDelDoc(+t.dataset.del); return; }
    const openEl = t.closest("[data-open]"); if (openEl && fm.editing == null) { fmSetActive(+openEl.dataset.open); return; }
    fmCloseMenus();
  }
  function fmListKey(e) { if (e.target.id === "cxFmRen") { if (e.key === "Enter") fmEndRename(fm.editing, true); if (e.key === "Escape") fmEndRename(fm.editing, false); } }
  async function fmDelDoc(id) {
    fmCloseMenus();
    if (!(await fmConfirm("Dieses Dokument endgültig löschen?"))) return;
    fm.docs = fm.docs.filter((d) => d.id !== id);
    const row = fmRow(id); if (row) row.remove();
    if (fm.active === id) { fm.active = null; fmRenderView(); }
    fmSyncDetail(id, null); fmUpdateSummary();
    try { await api.deleteContractDoc(id); } catch (e) { toast(e.message, true); openFileManager(); }
  }
  async function fmCleanOrphans() {
    const orph = fm.docs.filter((d) => d.contract_id == null);
    if (!orph.length) return;
    if (!(await fmConfirm(`Alle ${orph.length} verwaisten Dokumente endgültig löschen?`))) return;
    orph.forEach((d) => { const r = fmRow(d.id); if (r) r.remove(); if (fm.active === d.id) { fm.active = null; fmRenderView(); } fmSyncDetail(d.id, null); });
    fm.docs = fm.docs.filter((d) => d.contract_id != null); fmUpdateSummary();
    try { await api.deleteOrphanDocs(); } catch (e) { toast(e.message, true); openFileManager(); }
  }

  // --- Drag: umhängen + sortieren — Engine wie Vermögen (Kanten-/50%-Trigger, mc0, mapIns, Autoscroll) ---
  let fmDrag = null, fmRafScroll = 0;
  function fmFlip(mut) {
    const list = fmScrim.querySelector("#cxFmList");
    const nodes = [...list.querySelectorAll(".frow:not(.dragghost), .ph, .ctrhead")];
    const first = new Map(); nodes.forEach((n) => first.set(n, n.getBoundingClientRect().top));
    mut();
    nodes.forEach((n) => { n.style.transition = "none"; n.style.transform = ""; });
    void list.offsetWidth;
    nodes.forEach((n) => { const dy = first.get(n) - n.getBoundingClientRect().top; if (Math.abs(dy) > 0.5) n.style.transform = `translateY(${dy}px)`; });
    requestAnimationFrame(() => nodes.forEach((n) => { if (n.style.transform) { n.style.transition = "transform .16s ease"; n.style.transform = ""; } }));
  }
  function fmDragStart(e) {
    const g = e.target.closest(".grip"); if (!g || fm.editing != null) return;
    const row = g.closest(".frow"); if (!row) return; e.preventDefault();
    fmCloseMenus();
    const list = fmScrim.querySelector("#cxFmList");
    const id = +row.dataset.vid, rect = row.getBoundingClientRect(), h = rect.height;
    // flache, geordnete Zeilenliste + Start-Mittelpunkte (VOR dem Ausblenden), nur sichtbare Zeilen
    const orderedRows = [...list.querySelectorAll(".frow:not(.dragghost)")]
      .map((r) => ({ id: +r.dataset.vid, ctr: r.closest(".ctr").dataset.ctr, rc: r.getBoundingClientRect() }))
      .filter((o) => o.rc.height > 0)
      .map((o) => ({ id: o.id, ctrId: o.ctr ? +o.ctr : null, mc0: (o.rc.top + o.rc.bottom) / 2 }));
    const fromGlobalIdx = orderedRows.findIndex((o) => o.id === id);
    const draggedMc0 = orderedRows[fromGlobalIdx] ? orderedRows[fromGlobalIdx].mc0 : (rect.top + rect.bottom) / 2;
    const clone = row.cloneNode(true); clone.classList.add("fclone"); clone.classList.remove("active");
    clone.style.width = rect.width + "px"; clone.style.left = rect.left + "px"; clone.style.top = rect.top + "px";
    fmScrim.querySelector(".cx-fm").appendChild(clone);
    const ph = document.createElement("div"); ph.className = "ph"; ph.style.height = h + "px";
    row.after(ph); row.classList.add("dragghost");
    fmScrim.querySelector(".cx-fm").classList.add("dragging");
    // sichtbare Vertrags-Container in DOM-Reihenfolge (Kategorie -> Verträge, dann Verwaist) + Zeilenzahl ohne die gezogene
    const containers = [...list.querySelectorAll(".ctr")]
      .filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => ({ el: c, ctrId: c.dataset.ctr ? +c.dataset.ctr : null, count: [...c.querySelectorAll(".frow:not(.dragghost)")].length }));
    const slots = [...list.querySelectorAll(".frow:not(.dragghost), .ctr-empty, .ph")].map((s) => s.getBoundingClientRect()).filter((r) => r.height > 0);
    const topLimit = slots.length ? Math.min(...slots.map((r) => r.top)) : list.getBoundingClientRect().top;
    fmDrag = { id, clone, ph, h, offY: e.clientY - rect.top, cx: rect.left + rect.width / 2,
      topLimit, startScroll: list.scrollTop, orderedRows, fromGlobalIdx, draggedMc0, containers,
      lastY: e.clientY, dstKey: null, srcCtr: row.closest(".ctr").dataset.ctr, list };
    window.addEventListener("pointermove", fmDragMove);
    window.addEventListener("pointerup", fmDragUp);
    window.addEventListener("keydown", fmDragKeyH, true);
    fmDragMove(e);
  }
  // Untergrenze live = Unterkante der letzten sichtbaren Kategorie-Gruppe (transform-immun, führt nach)
  function fmBotLimit(list) {
    const groups = [...list.querySelectorAll(".catgroup")].map((g) => g.getBoundingClientRect()).filter((r) => r.height > 0);
    return groups.length ? groups[groups.length - 1].bottom : list.getBoundingClientRect().bottom;
  }
  function fmPlaceP(container, index) {
    const rows = [...container.querySelectorAll(".frow")].filter((r) => !r.classList.contains("dragghost") && r !== fmDrag.ph);
    if (index >= rows.length) { const empty = container.querySelector(".ctr-empty"); if (empty) container.insertBefore(fmDrag.ph, empty); else container.appendChild(fmDrag.ph); }
    else container.insertBefore(fmDrag.ph, rows[index]);
  }
  // globalen Einfüge-Index auf Vertrag+Position abbilden; leere Verträge per Geometrie am Ende auflösen
  function fmMapIns(ins, cloneCenter) {
    const cs = fmDrag.containers; let cum = 0;
    for (let ci = 0; ci < cs.length; ci++) {
      const cnt = cs[ci].count;
      if (ins < cum + cnt) return { ci, index: ins - cum };            // mitten in den Zeilen dieses Vertrags
      if (ins === cum + cnt) {                                          // Grenze am Ende von ci
        let jSel = ci;
        for (let j = ci; j < cs.length; j++) { if (cs[j].el.getBoundingClientRect().top <= cloneCenter) jSel = j; else break; }
        return (jSel === ci) ? { ci, index: cnt } : { ci: jSel, index: 0 };   // Ende ci ODER Anfang eines (leeren) späteren Vertrags
      }
      cum += cnt;
    }
    return { ci: cs.length - 1, index: cs[cs.length - 1] ? cs[cs.length - 1].count : 0 };
  }
  function fmDragMove(e) {
    if (!fmDrag) return;
    const D = fmDrag, list = D.list;
    if (e && e.clientY != null) D.lastY = e.clientY;
    const dScroll = list.scrollTop - D.startScroll;
    const listRect = list.getBoundingClientRect();
    const contentTop = D.topLimit - dScroll, contentBottom = fmBotLimit(list);
    const lt = Math.max(listRect.top, contentTop);        // nie über die sichtbare Listen-Oberkante
    const lb = Math.min(listRect.bottom, contentBottom);  // nie unter die sichtbare Listen-Unterkante
    let top = D.lastY - D.offY;
    top = Math.max(lt, Math.min(Math.max(lt, lb - D.h), top));
    D.clone.style.top = top + "px";                       // left fix = seitlich gesperrt
    const cloneTop = top, cloneBottom = top + D.h, cloneCenter = top + D.h / 2;
    let below = 0, above = 0;
    D.orderedRows.forEach((o) => {
      if (o.id === D.id) return; const mcn = o.mc0 - dScroll;
      if (o.mc0 > D.draggedMc0) { if (cloneBottom > mcn) below++; }   // Unterkante über 50% der Zeile darunter
      else { if (cloneTop < mcn) above++; }                          // Oberkante über 50% der Zeile darüber
    });
    const N = D.orderedRows.length - 1;
    const ins = Math.max(0, Math.min(N, D.fromGlobalIdx + below - above));
    const t = fmMapIns(ins, cloneCenter); const cont = D.containers[t.ci]; if (!cont) { fmAutoScroll(); return; }
    const key = t.ci + "|" + t.index;
    if (key !== D.dstKey) {
      D.dstKey = key;
      fmFlip(() => fmPlaceP(cont.el, t.index));
      fmScrim.querySelectorAll(".ctr.dropok").forEach((x) => x.classList.remove("dropok")); cont.el.classList.add("dropok");
    }
    fmAutoScroll();
  }
  // Auto-Scroll: ruhige Randzone ~18% oben/unten, Tempo nach Eindringtiefe (wie assets.js)
  function fmAutoScroll() {
    if (!fmDrag || fmRafScroll) return;
    const list = fmDrag.list;
    const step = () => {
      if (!fmDrag) { fmRafScroll = 0; return; }
      const rr = list.getBoundingClientRect();
      const EDGE = Math.min(Math.max(rr.height * 0.18, 72), 150);
      const yy = fmDrag.lastY; let dd = 0;
      if (yy < rr.top + EDGE) dd = -1; else if (yy > rr.bottom - EDGE) dd = 1;
      if (dd === 0) { fmRafScroll = 0; return; }
      const depth = dd < 0 ? (rr.top + EDGE - yy) : (yy - (rr.bottom - EDGE));
      const sp = Math.min(10, 2 + depth / 6);
      const max = list.scrollHeight - list.clientHeight, before = list.scrollTop;
      list.scrollTop = Math.max(0, Math.min(max, before + dd * sp));
      if (list.scrollTop !== before) { fmDragMove(); fmRafScroll = requestAnimationFrame(step); } else fmRafScroll = 0;
    };
    fmRafScroll = requestAnimationFrame(step);
  }
  function fmStopScroll() { if (fmRafScroll) { cancelAnimationFrame(fmRafScroll); fmRafScroll = 0; } }
  function fmDragDetach() {
    fmStopScroll();
    window.removeEventListener("pointermove", fmDragMove); window.removeEventListener("pointerup", fmDragUp); window.removeEventListener("keydown", fmDragKeyH, true);
  }
  function fmDragKeyH(e) { if (e.key === "Escape" && fmDrag) { e.preventDefault(); fmDragDetach(); const d = fmDrag; fmDrag = null; fmScrim.querySelector(".cx-fm").classList.remove("dragging"); try { d.clone.remove(); } catch (_) {} try { d.ph.remove(); } catch (_) {} fmScrim.querySelectorAll(".ctr.dropok").forEach((x) => x.classList.remove("dropok")); fmRenderList(); } }
  async function fmDragUp() {
    fmDragDetach();
    const d = fmDrag; fmDrag = null;
    fmScrim.querySelector(".cx-fm").classList.remove("dragging");
    const order = [];
    fmScrim.querySelectorAll(".cx-fmlist .ctr").forEach((ctr) => {
      const cid = ctr.dataset.ctr ? +ctr.dataset.ctr : null;
      [...ctr.children].forEach((ch) => {
        if (ch === d.ph) order.push({ id: d.id, cid });
        else if (ch.classList.contains("frow") && !ch.classList.contains("dragghost")) order.push({ id: +ch.dataset.vid, cid });
      });
    });
    d.clone.remove(); d.ph.remove();
    fmScrim.querySelectorAll(".ctr.dropok").forEach((x) => x.classList.remove("dropok"));
    const oldCid = d.srcCtr ? +d.srcCtr : null;
    const target = order.find((o) => o.id === d.id); const newCid = target ? target.cid : oldCid;
    const byId = new Map(fm.docs.map((x) => [x.id, x]));
    fm.docs = order.map((o, i) => { const dd = byId.get(o.id); if (dd) { dd.contract_id = o.cid; dd.sort = i; } return dd; }).filter(Boolean);
    const moved = fm.docs.find((x) => x.id === d.id);
    if (moved) { const c = fm.contracts.find((x) => x.id === moved.contract_id); moved.vendor = c ? c.vendor : null; moved.label = c ? c.label : null; moved.category_id = c ? c.category_id : null; }
    fmRenderList();
    const changed = (oldCid ?? null) !== (newCid ?? null);
    try {
      if (changed) await api.patchDoc(d.id, { contract_id: newCid });
      await api.reorderDocs(order.map((o) => o.id));
      if (changed) refresh();   // Dokument wechselt Vertrag -> Vertrags-Detail neu laden
    } catch (e) { toast(e.message, true); openFileManager(); }
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
  async function delDoc(id) { try { await api.patchDoc(id, { contract_id: null }); await refresh(); } catch (e) { toast(e.message, true); } }
  function openPdf(d, it) {
    pdf.querySelector("#cxPdfTitle").textContent = d.filename;
    const tab = pdf.querySelector("#cxPdfTab"); tab.href = d.url; tab.style.display = "";
    const main = pdf.querySelector("#cxPdfMain");
    main.innerHTML = d.viewable ? `<iframe src="${d.url}"></iframe>` : `<div class="cx-pdfph"><div class="big">${(d.filename.split(".").pop() || "").slice(0, 4).toUpperCase()}</div><div><b>${esc(d.filename)}</b><br>Nicht im Viewer anzeigbar – über „In neuem Tab" öffnen.</div></div>`;
    renderViewerSide(it);
    pdf.querySelector(".cx-pdfbox").classList.toggle("collapsed", !!ui.pdfCollapsed);
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
    if (posDrag) { detachP(); cleanupP(); }
    if (catDrag) { detachC(); cleanupC(); }
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onFocusModeKey, true);
    window.removeEventListener("beforeunload", flushBeacon);
    rmenu.remove(); overlay.remove(); pdf.remove(); fileInput.remove(); vendorList.remove();
    if (fmDrag) { fmDragDetach(); try { fmDrag.clone.remove(); fmDrag.ph.remove(); } catch (_) {} fmDrag = null; }
    if (fmScrim) fmScrim.remove();
    root.innerHTML = "";
  } };
}

export default { mount };
