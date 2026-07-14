/**
 * Helper de auth compartilhado pelas telas.
 * Guarda token/usuario no localStorage, injeta Authorization e redireciona
 * para o login em 401. Tenant/papeis vem do TOKEN (nao mais de headers).
 */
const AUTH = {
  token: () => localStorage.getItem("token"),
  user: () => { try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; } },
  set: (t, u) => { localStorage.setItem("token", t); localStorage.setItem("user", JSON.stringify(u)); },
  clear: () => { localStorage.removeItem("token"); localStorage.removeItem("user"); },
  logout: () => { AUTH.clear(); location.href = "login.html"; },
  hasRole: (r) => (AUTH.user()?.roles || []).includes(r),
};

/** Redireciona para o login se nao houver token. Chame no topo de cada tela. */
function requireLogin() {
  if (!AUTH.token()) { location.href = "login.html"; return false; }
  return true;
}

/** fetch com Authorization; em 401 limpa sessao e vai para o login. */
async function authFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + AUTH.token() });
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401) { AUTH.clear(); location.href = "login.html"; throw new Error("nao autenticado"); }
  return res;
}

/** Barra de usuario (nome@tenant [papeis] + sair) no elemento informado. */
function renderUserBar(elId) {
  const u = AUTH.user(); const el = document.getElementById(elId);
  if (!u || !el) return;
  el.innerHTML = `<span class="muted">${u.username}@${u.tenant} · ${(u.roles || []).join(", ")}</span> · <a href="#" id="logoutLink">sair</a>`;
  const link = document.getElementById("logoutLink");
  if (link) link.onclick = (e) => { e.preventDefault(); AUTH.logout(); };
}
