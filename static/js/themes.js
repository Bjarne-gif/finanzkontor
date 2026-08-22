/* Themes: anwenden, merken (localStorage), Menü rendern.
   Neues Theme: hier eintragen + Block in themes.css ergänzen. */

export const THEMES = [
  { id: "graphit",   name: "Graphit",   base: "#121315", accent: "#8fb3c9" },
  { id: "kobalt",    name: "Kobalt",    base: "#0d1120", accent: "#7c8cff" },
  { id: "petrol",    name: "Petrol",    base: "#071a1c", accent: "#4fd6c0" },
  { id: "kontor",    name: "Kontor",    base: "#0e151d", accent: "#c9a227" },
  { id: "tresor",    name: "Tresor",    base: "#14110c", accent: "#d9b877" },
  { id: "konsole",   name: "Konsole",   base: "#0b0f0c", accent: "#83bd8e" },
  { id: "malve",     name: "Malve",     base: "#16111a", accent: "#c49ad0" },
  { id: "papier",    name: "Papier",    base: "#efe9dd", accent: "#9a6b1f" },
  { id: "alabaster", name: "Alabaster", base: "#eceef1", accent: "#4f6f8f" },
];

const DEFAULT_THEME = "graphit";

const KEY = "fk_theme";

export function currentTheme() {
  const saved = localStorage.getItem(KEY);
  return THEMES.some((t) => t.id === saved) ? saved : DEFAULT_THEME;
}

export function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id);
  localStorage.setItem(KEY, id);
  renderThemeMenu();
}

export function renderThemeMenu() {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  const active = currentTheme();
  grid.innerHTML = "";
  THEMES.forEach((t) => {
    const el = document.createElement("div");
    el.className = "theme-opt" + (t.id === active ? " active" : "");
    el.innerHTML = `
      <span class="swatch" style="background:${t.base}"><i style="background:${t.accent}"></i></span>
      <span class="tn">${t.name}</span>`;
    el.onclick = () => applyTheme(t.id);
    grid.appendChild(el);
  });
}

export function initTheme() {
  applyTheme(currentTheme());
}
