/* API-Schicht: dünne Wrapper um die Backend-Endpunkte. */

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  session:      ()             => req("GET",  "/api/session"),
  setup:        (password, remember) => req("POST", "/api/setup",  { password, remember }),
  login:        (password, remember) => req("POST", "/api/login",  { password, remember }),
  logout:       ()             => req("POST", "/api/logout"),
  state:        ()             => req("GET",  "/api/state"),
  selectDb:     (name)         => req("POST", "/api/databases/select", { name }),
  createDb:     (name)         => req("POST", "/api/databases/create", { name }),

  // Ledger (Stufe 1)
  ledgerState:      ()          => req("GET",  "/api/ledger/state"),
  addCategory:      (data)      => req("POST", "/api/ledger/category", data),
  updateCategory:   (id, patch) => req("PATCH", `/api/ledger/category/${id}`, patch),
  deleteCategory:   (id)        => req("DELETE", `/api/ledger/category/${id}`),
  reorderCategories:(ids)       => req("POST", "/api/ledger/category/reorder", { ids }),
  addPosten:        (data)      => req("POST", "/api/ledger/posten", data),
  updatePosten:     (id, patch) => req("PATCH", `/api/ledger/posten/${id}`, patch),
  deletePosten:     (id)        => req("DELETE", `/api/ledger/posten/${id}`),
  reorderPosten:    (ids)       => req("POST", "/api/ledger/posten/reorder", { ids }),

  // Überschussverwendung / Aufteilung (Stufe 2)
  splitState:       ()          => req("GET",  "/api/split/state"),
  addPot:           (data)      => req("POST", "/api/split/pot", data),
  updatePot:        (id, patch) => req("PATCH", `/api/split/pot/${id}`, patch),
  deletePot:        (id)        => req("DELETE", `/api/split/pot/${id}`),
  reorderPots:      (ids)       => req("POST", "/api/split/pot/reorder", { ids }),
};
