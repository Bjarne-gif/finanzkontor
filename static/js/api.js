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

  // Vermögen / Net Worth (Stufe 3)
  assetsState:        ()          => req("GET",  "/api/assets/state"),
  addAssetClass:      (data)      => req("POST", "/api/assets/class", data),
  updateAssetClass:   (id, patch) => req("PATCH", `/api/assets/class/${id}`, patch),
  deleteAssetClass:   (id)        => req("DELETE", `/api/assets/class/${id}`),
  reorderAssetClasses:(ids)       => req("POST", "/api/assets/class/reorder", { ids }),
  addAssetPosition:      (data)      => req("POST", "/api/assets/position", data),
  updateAssetPosition:   (id, patch) => req("PATCH", `/api/assets/position/${id}`, patch),
  deleteAssetPosition:   (id)        => req("DELETE", `/api/assets/position/${id}`),
  reorderAssetPositions: (ids)       => req("POST", "/api/assets/position/reorder", { ids }),

  // Verträge & Abos (Stufe 4)
  contractsState:   ()          => req("GET",  "/api/contracts/state"),
  contractsLinkable:()          => req("GET",  "/api/contracts/linkable"),
  addContract:      (data)      => req("POST", "/api/contracts/contract", data),
  updateContract:   (id, patch) => req("PATCH", `/api/contracts/contract/${id}`, patch),
  deleteContract:   (id)        => req("DELETE", `/api/contracts/contract/${id}`),
  reorderContracts: (ids)       => req("POST", "/api/contracts/contract/reorder", { ids }),
  contractCategories:   ()          => req("GET",  "/api/contracts/state"),
  addContractCategory:  (data)      => req("POST", "/api/contracts/category", data),
  updateContractCategory:(id,patch) => req("PATCH", `/api/contracts/category/${id}`, patch),
  deleteContractCategory:(id)       => req("DELETE", `/api/contracts/category/${id}`),
  reorderContractCategories:(ids)   => req("POST", "/api/contracts/category/reorder", { ids }),
  deleteContractDoc:(docId)         => req("DELETE", `/api/contracts/doc/${docId}`),
  contractDocUrl:   (docId)         => `/api/contracts/doc/${docId}`,
  // Upload braucht FormData statt JSON:
  uploadContractDoc: async (cid, file) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/contracts/contract/${cid}/doc`, {
      method: "POST", body: fd, credentials: "same-origin",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Upload fehlgeschlagen");
    return data;
  },
};
