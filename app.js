// Santorini Club · Sistema de caja
// Datos en Firebase (Authentication + Cloud Firestore). Ver README.md.
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence, updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, writeBatch,
  runTransaction, increment, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => "$ " + Math.round(n || 0).toLocaleString("es-CO");
const nowIso = () => new Date().toISOString();
const dt = iso => iso ? new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const tm = iso => iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "—";
const parseMoney = v => { const n = parseInt(String(v).replace(/[^\d]/g, ""), 10); return isNaN(n) ? 0 : n; };
const moneyInput = el => el.addEventListener("input", () => { const n = parseMoney(el.value); el.value = el.value.trim() === "" ? "" : fmt(n); });
const METHODS = { efectivo: "Efectivo", transfer: "Transferencia" };
const DOMAIN = "@santoriniclub.local"; // los usuarios se guardan como correo interno: usuario@santoriniclub.local
const toEmail = u => u.trim().toLowerCase() + DOMAIN;

/* ---------- arranque de Firebase ---------- */
const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PEGA_");
let app, auth, db;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
}

/* ---------- estado en memoria (alimentado por Firestore en vivo) ---------- */
let me = null;                 // perfil del usuario conectado {id, user, name, role, active}
let users = [], products = [], current = null; // current = id del turno abierto
let session = null, sales = [], expenses = [], tabs = [];
let pendingTab = null; // cuenta recién creada que aún no llega del servidor
let receivables = []; // cuentas por cobrar de cierres anteriores
let tabLines = {}, lineUnsubs = {}; // líneas (productos anotados) de cada cuenta abierta
let tab = "caja", cat = "Todas", cart = [], selTab = null; // selTab = cuenta (mesa/cliente) seleccionada; null = venta rápida
let unsubs = [], sessUnsubs = [];
const isAdmin = () => me && me.role === "admin";

/* ---------- modal / toast ---------- */
function modal(html, onMount) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-bg"><div class="modal panel pad" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = root.firstChild;
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", kd); flushRender(); };
  const kd = e => { if (e.key === "Escape") close(); };
  bg.addEventListener("click", e => { if (e.target === bg) close(); });
  document.addEventListener("keydown", kd);
  onMount && onMount(bg.firstChild, close);
  const f = bg.querySelector("input,select,textarea"); f && f.focus();
  return close;
}
function confirmBox(title, msg, okLabel, danger, cb) {
  modal(`<h3>${esc(title)}</h3><div class="muted">${msg}</div><div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn ${danger ? "btn-danger" : "btn-gold"}" data-ok>${esc(okLabel)}</button></div>`,
    (m, close) => { m.querySelector("[data-x]").onclick = close; m.querySelector("[data-ok]").onclick = () => { close(); cb(); }; });
}
let tt;
function toast(t) { clearTimeout(tt); let el = $(".toast"); if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); } el.textContent = t; tt = setTimeout(() => el.remove(), 2600); }
function fail(e, fallback) { console.error(e); toast(e && e.code === "permission-denied" ? "No tienes permiso para esta acción." : (fallback || "No se pudo guardar. Revisa la conexión.")); }
async function busy(btn, fn) { if (btn) btn.disabled = true; try { await fn(); } finally { if (btn) btn.disabled = false; } }

/* ---------- pantallas ---------- */
function show(id) { ["boot", "login", "noconfig", "app"].forEach(x => $("#" + x).hidden = x !== id); }

let setupMode = false;
async function showLogin() {
  show("login");
  let setupDone = true;
  try { setupDone = (await getDoc(doc(db, "meta", "setup"))).exists(); } catch (e) { console.warn(e); }
  setupMode = !setupDone;
  $("#setupText").hidden = !setupMode;
  $("#nameField").hidden = !setupMode;
  $("#loginBtn").textContent = setupMode ? "Crear administrador" : "Entrar";
  $("#loginTitle").textContent = setupMode ? "CONFIGURACIÓN INICIAL" : "CONTROL DE CAJA";
  $("#lp").autocomplete = setupMode ? "new-password" : "current-password";
  (setupMode ? $("#ln") : $("#lu")).focus();
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const user = $("#lu").value.trim().toLowerCase(), pw = $("#lp").value, err = $("#lerr");
  err.textContent = "";
  if (!/^[a-z0-9._-]+$/.test(user)) { err.textContent = "El usuario solo puede tener letras, números, punto o guion, sin espacios."; return; }
  await busy($("#loginBtn"), async () => {
    if (setupMode) {
      const name = $("#ln").value.trim();
      if (!name) { err.textContent = "Escribe el nombre del administrador."; return; }
      if (pw.length < 6) { err.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }
      try {
        const cred = await createUserWithEmailAndPassword(auth, toEmail(user), pw);
        const b = writeBatch(db);
        b.set(doc(db, "users", cred.user.uid), { user, name, role: "admin", active: true, created: nowIso() });
        b.set(doc(db, "meta", "setup"), { at: nowIso(), by: cred.user.uid });
        b.set(doc(db, "meta", "state"), { current: null });
        await b.commit();
      } catch (ex) {
        console.error(ex);
        err.textContent = ex.code === "auth/email-already-in-use" ? "Ese usuario ya existe. Inicia sesión." : "No se pudo crear el administrador (" + (ex.code || ex.message) + ").";
      }
      return;
    }
    try { await signInWithEmailAndPassword(auth, toEmail(user), pw); $("#lp").value = ""; }
    catch (ex) {
      err.textContent = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(ex.code)
        ? "Usuario o contraseña incorrectos." : ex.code === "auth/too-many-requests" ? "Demasiados intentos. Espera unos minutos." : "No se pudo entrar (" + ex.code + ").";
    }
  });
}

function stopListeners() { unsubs.forEach(u => u()); unsubs = []; stopSession(); }
function stopSession() { sessUnsubs.forEach(u => u()); sessUnsubs = []; Object.values(lineUnsubs).forEach(u => u()); lineUnsubs = {}; tabLines = {}; session = null; sales = []; expenses = []; tabs = []; selTab = null; pendingTab = null; }

async function onUser(fbUser) {
  stopListeners(); me = null; cart = [];
  if (!fbUser) { showLogin(); return; }
  let snap;
  try { snap = await getDoc(doc(db, "users", fbUser.uid)); } catch (e) { console.error(e); }
  if (!snap || !snap.exists()) {
    // puede ocurrir un instante durante la configuración inicial
    setTimeout(async () => { if (auth.currentUser && auth.currentUser.uid === fbUser.uid && !me) { const s2 = await getDoc(doc(db, "users", fbUser.uid)).catch(() => null); if (s2 && s2.exists()) onUser(fbUser); else { await signOut(auth); $("#lerr").textContent = "Este usuario no tiene perfil en el sistema."; } } }, 1500);
    return;
  }
  const p = { id: fbUser.uid, ...snap.data() };
  if (!p.active) { await signOut(auth); $("#lerr").textContent = "Este usuario está desactivado. Habla con el administrador."; return; }
  me = p; tab = "caja";
  show("app");
  $("#whoName").textContent = me.name;
  const r = $("#whoRole"); r.textContent = isAdmin() ? "Admin" : "Cajero"; r.className = "role" + (isAdmin() ? " admin" : "");
  startListeners();
  render();
}

function startListeners() {
  unsubs.push(onSnapshot(doc(db, "users", me.id), s => {
    if (!s.exists() || !s.data().active) { toast("Tu usuario fue desactivado"); signOut(auth); return; }
    Object.assign(me, s.data());
  }));
  unsubs.push(onSnapshot(collection(db, "products"), s => {
    products = s.docs.map(d => ({ id: d.id, ...d.data() }));
    softRender();
  }, e => fail(e, "No se pudieron leer los productos.")));
  if (isAdmin()) unsubs.push(onSnapshot(collection(db, "users"), s => { users = s.docs.map(d => ({ id: d.id, ...d.data() })); softRender(); }));
  unsubs.push(onSnapshot(query(collection(db, "receivables"), where("status", "==", "pending")), s => {
    receivables = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    renderNav(); if (tab === "cobrar") softRender();
  }, e => console.error(e)));
  unsubs.push(onSnapshot(doc(db, "meta", "state"), { includeMetadataChanges: true }, s => {
    $("#sync").textContent = s.metadata.fromCache ? "Sin conexión" : "En línea";
    $("#sync").classList.toggle("off", s.metadata.fromCache);
    const c = s.exists() ? s.data().current : null;
    if (c !== current) { current = c; stopSession(); if (c) watchSession(c); else cart = []; softRender(); }
  }));
}
function watchSession(id) {
  sessUnsubs.push(onSnapshot(doc(db, "sessions", id), s => { session = s.exists() ? { id: s.id, ...s.data() } : null; softRender(); }));
  sessUnsubs.push(onSnapshot(query(collection(db, "sessions", id, "sales"), orderBy("at")), s => { sales = s.docs.map(d => ({ id: d.id, ...d.data() })); softRender(); }));
  sessUnsubs.push(onSnapshot(query(collection(db, "sessions", id, "expenses"), orderBy("at")), s => { expenses = s.docs.map(d => ({ id: d.id, ...d.data() })); softRender(); }));
  sessUnsubs.push(onSnapshot(query(collection(db, "sessions", id, "tabs"), where("status", "==", "open")), s => {
    const prev = tabs;
    tabs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    if (pendingTab && tabs.some(x => x.id === pendingTab.id)) pendingTab = null;
    if (selTab && !tabs.some(x => x.id === selTab) && prev.some(x => x.id === selTab)) selTab = null;
    syncLineListeners();
    onTabsChanged();
  }));
}

/* re-render sin borrar lo que alguien está escribiendo */
let pending = false;
function softRender() {
  if (!me) return;
  const a = document.activeElement;
  if ($("#modalRoot").firstChild || (a && $("#view").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { pending = true; return; }
  render();
}
function flushRender() { if (pending) { pending = false; softRender(); } }
document.addEventListener("focusout", () => setTimeout(flushRender, 50));

function totals() {
  const valid = sales.filter(x => !x.voided);
  const by = { efectivo: 0, transfer: 0 }; valid.forEach(x => by[x.method] = (by[x.method] || 0) + x.total);
  const total = valid.reduce((a, x) => a + x.total, 0);
  const exp = expenses.reduce((a, x) => a + x.amount, 0);
  const base = session ? session.base : 0;
  return { count: valid.length, sales: total, by, exp, expected: base + by.efectivo - exp };
}

/* ---------- navegación ---------- */
function renderNav() {
  const items = [["caja", "Caja"], ["cuentas", "Cuentas" + (tabs.length ? " (" + tabs.length + ")" : "")], ["cobrar", "Por cobrar" + (receivables.length ? " (" + receivables.length + ")" : "")], ["mov", "Movimientos"]];
  if (isAdmin()) items.push(["prod", "Productos"], ["users", "Usuarios"], ["hist", "Cierres"]);
  items.push(["cuenta", "Mi cuenta"]);
  $("#nav").innerHTML = items.map(([k, l]) => `<button class="${tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("");
}
function render() {
  renderNav();
  const v = $("#view");
  ({ caja: viewCaja, cuentas: viewCuentas, cobrar: viewCobrar, mov: viewMov, prod: viewProd, users: viewUsers, hist: viewHist, cuenta: viewCuenta }[tab] || viewCaja)(v);
}

/* ---------- CAJA ---------- */
function viewCaja(v) {
  if (current && !session) { v.innerHTML = `<div class="loading">Cargando turno…</div>`; return; }
  if (!current) {
    v.innerHTML = `<div class="open-box panel pad">
      <div class="crest"><div class="label">Caja cerrada</div><h2 style="margin-top:6px">Abrir turno</h2></div>
      <p class="muted" style="margin:0">Cuenta el efectivo que hay en la caja antes de empezar a vender. Ese valor queda como base del turno.</p>
      <div class="field"><label class="label" for="base">Efectivo inicial en caja</label><input class="input big num" id="base" inputmode="numeric" placeholder="$ 0"></div>
      <div class="denoms">${[100000, 200000, 300000, 500000].map(n => `<button class="chip" data-base="${n}">${fmt(n)}</button>`).join("")}</div>
      <div class="field"><label class="label" for="onote">Nota (opcional)</label><input class="input" id="onote" placeholder="Ej: viernes, evento DJ invitado"></div>
      <div class="err" id="oerr"></div>
      <button class="btn btn-gold btn-lg" id="openBtn">Abrir caja</button>
    </div>`;
    const bi = $("#base"); moneyInput(bi);
    v.querySelectorAll("[data-base]").forEach(b => b.onclick = () => { bi.value = fmt(+b.dataset.base); });
    $("#openBtn").onclick = e => {
      if (bi.value.trim() === "") { $("#oerr").textContent = "Escribe el efectivo inicial (puede ser $ 0)."; return; }
      busy(e.currentTarget, async () => {
        try {
          const ref = doc(collection(db, "sessions"));
          await runTransaction(db, async tx => {
            const st = await tx.get(doc(db, "meta", "state"));
            if (st.exists() && st.data().current) throw { code: "already-open" };
            tx.set(ref, { openedBy: me.id, openedByName: me.name, openedAt: nowIso(), base: parseMoney(bi.value), note: $("#onote").value.trim(), closedAt: null });
            tx.set(doc(db, "meta", "state"), { current: ref.id });
          });
          toast("Caja abierta");
        } catch (ex) { if (ex.code === "already-open") toast("Otra persona ya abrió la caja"); else fail(ex); }
      });
    };
    return;
  }
  const t = totals();
  const active = products.filter(p => p.active);
  const cats = ["Todas", ...new Set(active.map(p => p.category).sort())];
  if (!cats.includes(cat)) cat = "Todas";
  const list = active.filter(p => cat === "Todas" || p.category === cat).sort((a, b) => a.name.localeCompare(b.name));
  const withImg = active.some(p => p.img);
  v.innerHTML = `
  <div class="strip">
    <div class="panel status">
      <div class="stat"><span class="pill open">Caja abierta</span><span class="muted" style="font-size:.82rem">${esc(session.openedByName)} · ${tm(session.openedAt)}</span></div>
      <div class="stat"><span class="label">Base</span><span class="v num">${fmt(session.base)}</span></div>
      <div class="stat"><span class="label">Ventas (${t.count})</span><span class="v num">${fmt(t.sales)}</span></div>
      <div class="stat"><span class="label">Efectivo en caja</span><span class="v num gold">${fmt(t.expected)}</span></div>
    </div>
    <div class="strip-actions">
      <button class="btn" id="expBtn">Registrar salida</button>
      <button class="btn btn-danger" id="closeBtn">Cerrar caja</button>
    </div>
  </div>
  <div class="pos">
    <section>
      <div class="chips">${cats.map(c => `<button class="chip ${c === cat ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="prods">${list.map(p => {
        const out = p.stock !== null && p.stock <= 0;
        return `<button class="prod${withImg ? " has-img" : ""}" data-add="${p.id}" ${out ? "disabled" : ""}>${withImg ? (p.img ? `<img class="pimg" src="${p.img}" alt="" loading="lazy">` : `<span class="pimg ph" aria-hidden="true">${esc(p.name.trim().charAt(0).toUpperCase())}</span>`) : ""}<span class="pn">${esc(p.name)}</span>
          ${p.stock !== null ? `<span class="ps ${p.stock <= 5 ? "low" : ""}">${out ? "Agotado" : p.stock + " en stock"}</span>` : ""}
          <span class="pp num">${fmt(p.price)}</span></button>`;
      }).join("") || `<div class="muted">No hay productos activos. ${isAdmin() ? "Agrégalos en Productos." : "Pide al administrador que los agregue."}</div>`}</div>
    </section>
    <aside class="panel ticket" id="ticket"></aside>
  </div>`;
  v.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { cat = b.dataset.cat; render(); });
  v.querySelectorAll("[data-add]").forEach(b => b.onclick = () => addToCart(b.dataset.add));
  $("#expBtn").onclick = expenseModal;
  $("#closeBtn").onclick = closeModal;
  renderTicket();
}
/* ---------- cuentas por mesa / cliente ----------
   Cada producto anotado es un registro (línea) con hora y quién lo anotó:
   sessions/{turno}/tabs/{cuenta}/lines/{línea}. Así varios meseros pueden anotar
   a la vez sin chocar, y queda el desglose completo. */
const curTab = () => (selTab ? tabs.find(t => t.id === selTab) || (pendingTab && pendingTab.id === selTab ? pendingTab : null) : null);
function tabLinesOf(t) {
  const legacy = (t.items || []).map((l, i) => ({ id: "old" + i, ...l, at: t.openedAt, byName: t.openedByName }));
  return legacy.concat(tabLines[t.id] || []);
}
function aggregate(lines) {
  const map = new Map();
  for (const l of lines) {
    const k = l.pid || l.name;
    const cur = map.get(k) || { pid: l.pid, name: l.name, price: l.price, qty: 0 };
    cur.qty += l.qty; if (l.qty > 0) cur.price = l.price;
    map.set(k, cur);
  }
  return [...map.values()].filter(x => x.qty > 0);
}
const tabTotal = t => aggregate(tabLinesOf(t)).reduce((a, l) => a + l.price * l.qty, 0);

function syncLineListeners() {
  const ids = new Set(tabs.map(t => t.id)); if (pendingTab) ids.add(pendingTab.id);
  for (const id of Object.keys(lineUnsubs)) if (!ids.has(id)) { lineUnsubs[id](); delete lineUnsubs[id]; delete tabLines[id]; }
  for (const id of ids) if (!lineUnsubs[id]) {
    const sid = current;
    lineUnsubs[id] = onSnapshot(query(collection(db, "sessions", sid, "tabs", id, "lines"), orderBy("at")), s => {
      tabLines[id] = s.docs.map(d => ({ id: d.id, ...d.data() }));
      onTabsChanged();
    }, e => console.error(e));
  }
}
function onTabsChanged() {
  renderNav();
  const box = $("#modalRoot .modal[data-detail]");
  if (box) { renderDetail(box); return; }
  if (tab === "caja" && $("#ticket") && !$("#modalRoot").firstChild) renderTicket(); else softRender();
}

/* Pedido en curso de cada cuenta: se arma tocando productos y se guarda con el botón "Agregar pedido".
   Cada pedido queda con su hora; así se ve cuándo pidió cada mesa o cliente. */
const drafts = {}; // id de cuenta -> [{pid, name, price, qty}]
const draftOf = tid => (drafts[tid] = drafts[tid] || []);
const sumLines = ls => ls.reduce((a, l) => a + l.price * l.qty, 0);

// Agrupa las líneas de una cuenta por pedido (mismo orderId), en orden de hora.
function ordersOf(t) {
  const groups = new Map();
  if ((t.items || []).length) groups.set("legacy", { id: "legacy", at: t.openedAt, byName: t.openedByName, lines: t.items.map(l => ({ ...l, at: t.openedAt })) });
  for (const l of tabLines[t.id] || []) {
    const k = l.orderId || l.id;
    if (!groups.has(k)) groups.set(k, { id: k, at: l.at, byName: l.byName, lines: [] });
    groups.get(k).lines.push(l);
  }
  const list = [...groups.values()];
  // Las líneas retiradas (qty < 0) se muestran dentro del pedido al que pertenecen.
  return list.filter(g => g.lines.some(l => l.qty > 0)).concat(list.filter(g => !g.lines.some(l => l.qty > 0) && g.lines.length).map(g => ({ ...g, onlyRemovals: true })))
    .sort((a, b) => a.at.localeCompare(b.at));
}

function stockLeft(p, extra = 0) {
  if (p.stock === null) return Infinity;
  const inCart = cart.filter(l => l.pid === p.id).reduce((a, l) => a + l.qty, 0);
  const inDrafts = Object.values(drafts).flat().filter(l => l.pid === p.id).reduce((a, l) => a + l.qty, 0);
  return p.stock - inCart - inDrafts - extra;
}
function addToCart(pid) {
  const p = products.find(x => x.id === pid); if (!p) return;
  if (stockLeft(p) < 1) { toast("No hay más unidades de " + p.name); return; }
  const list = selTab ? draftOf(selTab) : cart;
  const l = list.find(x => x.pid === pid);
  if (l) l.qty++; else list.push({ pid, name: p.name, price: p.price, qty: 1 });
  renderTicket();
}
function changeList(list, pid, delta) {
  if (delta > 0) return addToCart(pid);
  const i = list.findIndex(l => l.pid === pid); if (i < 0) return;
  list[i].qty--; if (list[i].qty <= 0) list.splice(i, 1); renderTicket();
}

// Guarda el pedido en curso en la cuenta, todo con la misma hora.
function commitOrder(tid) {
  const d = draftOf(tid); if (!d.length) return;
  const orderId = doc(collection(db, "x")).id, at = nowIso();
  const b = writeBatch(db);
  for (const l of d) {
    b.set(doc(collection(db, "sessions", current, "tabs", tid, "lines")), { pid: l.pid, name: l.name, price: l.price, qty: l.qty, orderId, at, by: me.id, byName: me.name });
    const p = products.find(x => x.id === l.pid);
    if (p && p.stock !== null) b.update(doc(db, "products", l.pid), { stock: increment(-l.qty) });
  }
  const total = sumLines(d);
  drafts[tid] = [];
  b.commit().catch(e => fail(e, "No se pudo guardar el pedido. Revisa la conexión."));
  toast("Pedido agregado · " + fmt(total)); renderTicket();
}
// Quita una unidad de un pedido ya guardado (queda registrado como retiro).
function removeFromOrder(tid, orderId, pid) {
  const t = tabs.find(x => x.id === tid); if (!t) return;
  const g = ordersOf(t).find(o => o.id === orderId); if (!g) return;
  const left = g.lines.filter(l => l.pid === pid).reduce((a, l) => a + l.qty, 0);
  const src = g.lines.find(l => l.pid === pid && l.qty > 0);
  if (!src || left < 1) return;
  const b = writeBatch(db);
  b.set(doc(collection(db, "sessions", current, "tabs", tid, "lines")), { pid, name: src.name, price: src.price, qty: -1, orderId, at: nowIso(), by: me.id, byName: me.name, removal: true });
  const p = products.find(x => x.id === pid);
  if (p && p.stock !== null) b.update(doc(db, "products", pid), { stock: increment(1) });
  b.commit().catch(e => fail(e));
}

function orderRows(o) {
  const agg = aggregate(o.lines), rem = o.lines.filter(l => l.qty < 0);
  return { agg, rem, total: sumLines(agg) };
}

function renderTicket() {
  const el = $("#ticket"); if (!el) return;
  const t = curTab(); if (selTab && !t) selTab = null;
  const accbar = `<div class="accbar" role="tablist" aria-label="Cuentas">
    <button class="acc ${!selTab ? "on" : ""}" data-acc="">Venta rápida<small>${cart.length ? fmt(sumLines(cart)) : "Paga ya"}</small></button>
    ${tabs.map(x => `<button class="acc ${selTab === x.id ? "on" : ""}" data-acc="${x.id}">${esc(x.label)}${(drafts[x.id] || []).length ? " •" : ""}<small>${fmt(tabTotal(x))}</small></button>`).join("")}
    <button class="acc add" id="newTab">+ Cuenta</button>
  </div>`;
  const lineRow = l => `<div class="line"><div class="ln">${esc(l.name)}<div class="lu num">${fmt(l.price)} c/u</div></div>
    <div class="qty"><button data-dec="${l.pid}" aria-label="Quitar uno">−</button><span class="num">${l.qty}</span><button data-inc="${l.pid}" aria-label="Agregar uno">+</button></div>
    <div class="lt num">${fmt(l.price * l.qty)}</div></div>`;
  if (!t) {
    const total = sumLines(cart);
    el.innerHTML = accbar + `
    <div class="ticket-h"><div style="min-width:0"><h3>Venta rápida</h3><div class="meta">Se cobra en el momento</div></div>${cart.length ? `<button class="btn btn-ghost btn-sm" id="clr">Vaciar</button>` : ""}</div>
    <div class="lines">${cart.length ? cart.map(lineRow).join("") : `<div class="empty">Toca un producto para agregarlo.</div>`}</div>
    <div class="ticket-f">
      <div class="total"><span class="label">Total</span><span class="v num gold-text">${fmt(total)}</span></div>
      <button class="btn btn-gold btn-lg" id="pay" ${cart.length ? "" : "disabled"}>Cobrar ${cart.length ? fmt(total) : ""}</button>
    </div>`;
  } else {
    const d = draftOf(t.id), dTotal = sumLines(d), orders = ordersOf(t), total = tabTotal(t);
    el.innerHTML = accbar + `
    <div class="ticket-h"><div style="min-width:0"><h3>${esc(t.label)}</h3><div class="meta">Abierta ${tm(t.openedAt)} por ${esc(t.openedByName)}${t.note ? " · " + esc(t.note) : ""}</div></div>
      <button class="btn btn-sm" id="detBtn">Desglose</button></div>
    <div class="neworder">
      <div class="no-h"><span class="label">Pedido nuevo</span>${d.length ? `<button class="btn btn-ghost btn-sm" id="clrD">Descartar</button>` : ""}</div>
      <div class="lines">${d.length ? d.map(lineRow).join("") : `<div class="empty">Toca los productos que pide ${esc(t.label)} y luego pulsa <b>Agregar pedido</b>.</div>`}</div>
      <button class="btn btn-gold" id="addOrder" ${d.length ? "" : "disabled"}>Agregar pedido${d.length ? " · " + fmt(dTotal) : ""}</button>
    </div>
    <div class="orders">
      <div class="label">Pedidos de la cuenta (${orders.filter(o => !o.onlyRemovals).length})</div>
      ${orders.length ? orders.filter(o => !o.onlyRemovals).map((o, i) => { const r = orderRows(o); return `<div class="ord">
        <div class="ord-h"><span><b>Pedido ${i + 1}</b> · <span class="num">${tm(o.at)}</span></span><span class="num">${fmt(r.total)}</span></div>
        <div class="ord-i">${r.agg.map(l => `${l.qty}× ${esc(l.name)}`).join(", ") || "Retirado todo"}${r.rem.length ? ` <span class="muted">(${r.rem.length} retirado${r.rem.length > 1 ? "s" : ""})</span>` : ""}</div>
      </div>`; }).join("") : `<div class="muted small">Todavía no hay pedidos guardados.</div>`}
    </div>
    <div class="ticket-f">
      <div class="total"><span class="label">Total de la cuenta</span><span class="v num gold-text">${fmt(total)}</span></div>
      ${d.length ? `<div class="note warn">Hay un pedido nuevo sin agregar.</div>` : ""}
      <button class="btn btn-lg" id="pay" ${total && !d.length ? "" : "disabled"}>Cobrar cuenta ${total ? fmt(total) : ""}</button>
    </div>`;
    el.querySelector("#detBtn").onclick = () => detailModal(t.id);
    el.querySelector("#addOrder").onclick = () => commitOrder(t.id);
    el.querySelector("#clrD")?.addEventListener("click", () => { drafts[t.id] = []; renderTicket(); });
  }
  el.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => { selTab = b.dataset.acc || null; renderTicket(); });
  el.querySelector("#newTab").onclick = newTabModal;
  el.querySelector("#clr")?.addEventListener("click", () => { cart = []; renderTicket(); });
  const list = t ? draftOf(t.id) : cart;
  el.querySelectorAll("[data-inc]").forEach(b => b.onclick = () => changeList(list, b.dataset.inc, 1));
  el.querySelectorAll("[data-dec]").forEach(b => b.onclick = () => changeList(list, b.dataset.dec, -1));
  el.querySelector("#pay").onclick = () => payModal(t);
}

function newTabModal() {
  let kind = "Mesa";
  modal(`<h3>Nueva cuenta</h3><p class="muted" style="margin:0">Para mesas o clientes que van pidiendo y pagan al final.</p>
  <div class="seg" id="tk"><button class="on" data-k="Mesa">Mesa</button><button data-k="Cliente">Cliente</button></div>
  <div class="field"><label class="label" for="tl" id="tlL">Número o nombre de la mesa</label><input class="input" id="tl" placeholder="Ej: 5 o VIP 2"></div>
  <div class="field"><label class="label" for="tn">Nota (opcional)</label><input class="input" id="tn" placeholder="Ej: cumpleaños, 6 personas, manilla 120"></div>
  <div class="err" id="terr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Abrir cuenta</button></div>`, (m, close) => {
    const inp = m.querySelector("#tl");
    m.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      kind = b.dataset.k; m.querySelectorAll("[data-k]").forEach(x => x.classList.toggle("on", x === b));
      m.querySelector("#tlL").textContent = kind === "Mesa" ? "Número o nombre de la mesa" : "Nombre del cliente";
      inp.placeholder = kind === "Mesa" ? "Ej: 5 o VIP 2" : "Ej: Andrés (camisa negra)"; inp.focus();
    });
    m.querySelector("[data-x]").onclick = close;
    const go = () => {
      const v = inp.value.trim();
      if (!v) { m.querySelector("#terr").textContent = kind === "Mesa" ? "Escribe el número de la mesa." : "Escribe el nombre del cliente."; return; }
      const label = kind === "Mesa" && !/^mesa\b/i.test(v) ? "Mesa " + v : v;
      if (tabs.some(x => x.label.toLowerCase() === label.toLowerCase())) { m.querySelector("#terr").textContent = `Ya hay una cuenta abierta para ${label}.`; return; }
      const ref = doc(collection(db, "sessions", current, "tabs"));
      const data = { label, kind, note: m.querySelector("#tn").value.trim(), status: "open", openedAt: nowIso(), openedBy: me.id, openedByName: me.name };
      pendingTab = { id: ref.id, ...data };
      syncLineListeners();
      setDoc(ref, data).catch(e => { pendingTab = null; fail(e); });
      selTab = ref.id; tab = "caja"; close(); toast("Cuenta abierta: " + label); render();
    };
    m.querySelector("[data-ok]").onclick = go;
    inp.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
}

/* ---------- desglose de una cuenta ---------- */
function detailModal(tid) {
  modal(`<div data-body></div>`, (m, close) => { m.dataset.detail = tid; m._close = close; renderDetail(m); });
}
function renderDetail(m) {
  const tid = m.dataset.detail;
  const t = tabs.find(x => x.id === tid) || (pendingTab && pendingTab.id === tid ? pendingTab : null);
  const body = m.querySelector("[data-body]");
  if (!t) { body.innerHTML = `<h3>Cuenta cobrada</h3><p class="muted">Esta cuenta ya fue cobrada.</p><div class="modal-f"><button class="btn btn-gold" data-x>Cerrar</button></div>`; body.querySelector("[data-x]").onclick = m._close; return; }
  const orders = ordersOf(t).filter(o => !o.onlyRemovals), agg = aggregate(tabLinesOf(t)), total = sumLines(agg);
  body.innerHTML = `<div class="sec" style="gap:14px">
    <div><div class="label">Desglose · abierta ${tm(t.openedAt)} por ${esc(t.openedByName)}</div><h3 style="margin-top:4px;font-size:1.3rem">${esc(t.label)}</h3>${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ""}</div>
    ${orders.length ? orders.map((o, i) => { const r = orderRows(o); return `<div class="ord big">
      <div class="ord-h"><span><b>Pedido ${i + 1}</b> · <span class="num">${tm(o.at)}</span> <span class="muted small">· ${esc(o.byName || "")}</span></span><span class="num"><b>${fmt(r.total)}</b></span></div>
      <table><tbody>
        ${r.agg.map(l => `<tr><td class="r num" style="width:3em">${l.qty}×</td><td>${esc(l.name)}</td><td class="r num">${fmt(l.qty * l.price)}</td><td class="r" style="width:5.5em">${o.id !== "legacy" ? `<button class="btn btn-ghost btn-sm" data-rm="${o.id}|${l.pid}" aria-label="Quitar uno de ${esc(l.name)}">Quitar 1</button>` : ""}</td></tr>`).join("")}
        ${r.rem.map(l => `<tr class="minus"><td class="r num">−${-l.qty}</td><td>${esc(l.name)} <span class="pill bad">Retirado ${tm(l.at)}</span></td><td class="r num">−${fmt(-l.qty * l.price)}</td><td></td></tr>`).join("")}
      </tbody></table>
    </div>`; }).join("") : `<div class="panel pad empty">Todavía no hay pedidos guardados.</div>`}
    <div class="total"><span class="label">Total de la cuenta</span><span class="v num gold-text">${fmt(total)}</span></div>
    <div class="modal-f"><button class="btn btn-ghost" data-x>Cerrar</button><button class="btn" data-add>Nuevo pedido</button><button class="btn btn-gold" data-pay ${total && !draftOf(tid).length ? "" : "disabled"}>Cobrar ${fmt(total)}</button></div>
  </div>`;
  body.querySelector("[data-x]").onclick = m._close;
  body.querySelector("[data-add]").onclick = () => { m._close(); selTab = tid; tab = "caja"; render(); };
  body.querySelector("[data-pay]").onclick = () => { m._close(); payModal(t); };
  body.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const [oid, pid] = b.dataset.rm.split("|"); removeFromOrder(tid, oid, pid); });
}

/* ---------- imágenes (capture de transferencia y foto de producto) ---------- */
// Se reduce la imagen en el navegador y se guarda en Firestore (sin necesidad de Firebase Storage ni plan de pago).
async function compressImage(file, steps = [[1100, 0.7], [900, 0.6], [700, 0.5], [550, 0.45]], maxLen = 700000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    for (const [max, q] of steps) {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", q);
      if (data.length < maxLen) return data;
    }
    throw new Error("too-big");
  } finally { URL.revokeObjectURL(url); }
}
// Dos botones: tomar foto con la cámara (en celular) o elegir una imagen guardada.
function photoPicker(id) {
  return `<div class="pick">
    <label class="btn btn-sm" for="${id}Cam">Tomar foto</label><input type="file" id="${id}Cam" accept="image/*" capture="environment" hidden>
    <label class="btn btn-sm" for="${id}Gal">Elegir imagen</label><input type="file" id="${id}Gal" accept="image/*" hidden>
  </div>`;
}
function bindPicker(root, id, onFile) {
  for (const s of ["Cam", "Gal"]) root.querySelector("#" + id + s).addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) onFile(f); });
}

function payModal(t, rec) {
  if (t && draftOf(t.id).length) { toast("Primero agrega o descarta el pedido nuevo de " + t.label); return; }
  if (rec && !current) { toast("Abre la caja para cobrar cuentas pendientes"); return; }
  const lines = rec ? rec.items.map(l => ({ ...l })) : t ? aggregate(tabLinesOf(t)) : cart.map(l => ({ ...l }));
  const total = lines.reduce((a, l) => a + l.price * l.qty, 0);
  let m = "efectivo", img = null;
  modal(`<h3>${rec ? "Cobrar " + esc(rec.label) + " (por cobrar)" : t ? "Cobrar " + esc(t.label) : "Cobrar venta"}</h3>
  ${rec ? `<div class="muted small">Cuenta del turno del ${dt(rec.sessionOpenedAt)}. El pago entra en la caja de hoy.</div>` : ""}
  <div class="sum num">${lines.map(l => `<div><span>${l.qty}× ${esc(l.name)}</span><span>${fmt(l.price * l.qty)}</span></div>`).join("")}</div>
  <div class="total"><span class="label">Total a pagar</span><span class="v num gold-text">${fmt(total)}</span></div>
  <div class="seg" id="pm">${Object.entries(METHODS).map(([k, l]) => `<button class="${k === m ? "on" : ""}" data-m="${k}">${l}</button>`).join("")}</div>
  <div id="cashBox" class="sec" style="gap:10px">
    <div class="field"><label class="label" for="recv">Recibido</label><input class="input num" id="recv" inputmode="numeric" placeholder="${fmt(total)}"></div>
    <div class="change"><span class="muted">Cambio</span><b class="num" id="chg">—</b></div>
  </div>
  <div id="trBox" class="sec" style="gap:10px" hidden>
    <div class="drop" id="capBox"><span id="capTxt">Adjunta el capture de la transferencia</span><img id="capPrev" alt="Capture de la transferencia" hidden>${photoPicker("cap")}</div>
    <div class="muted small" style="text-align:center">En el computador también puedes pegar la imagen con Ctrl+V.</div>
    <div class="field"><label class="label" for="ref">Referencia o comprobante (opcional)</label><input class="input" id="ref" placeholder="Ej: M123456"></div>
  </div>
  <div class="err" id="perr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Confirmar pago</button></div>`, (box, close) => {
    const r = box.querySelector("#recv"), err = box.querySelector("#perr");
    r.addEventListener("input", () => { const n = parseMoney(r.value); r.value = n ? fmt(n) : ""; const c = n - total; box.querySelector("#chg").textContent = n ? (c >= 0 ? fmt(c) : "Faltan " + fmt(-c)) : "—"; });
    box.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
      m = b.dataset.m; box.querySelectorAll("[data-m]").forEach(x => x.classList.toggle("on", x === b));
      box.querySelector("#cashBox").hidden = m !== "efectivo"; box.querySelector("#trBox").hidden = m !== "transfer"; err.textContent = "";
    });
    const setFile = async f => {
      if (!f || !f.type.startsWith("image/")) { err.textContent = "El archivo debe ser una imagen (foto o captura de pantalla)."; return; }
      box.querySelector("#capTxt").textContent = "Procesando imagen…";
      try {
        img = await compressImage(f);
        const p = box.querySelector("#capPrev"); p.src = img; p.hidden = false;
        box.querySelector("#capTxt").textContent = "Capture adjunto. Puedes cambiarlo:"; err.textContent = "";
      } catch (e) { img = null; box.querySelector("#capTxt").textContent = "Adjunta el capture de la transferencia"; err.textContent = "No se pudo leer la imagen. Prueba con otra foto."; }
    };
    bindPicker(box, "cap", setFile);
    const onPaste = e => {
      if (!box.isConnected) { window.removeEventListener("paste", onPaste); return; }
      const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
      if (it) { e.preventDefault(); if (m !== "transfer") box.querySelector('[data-m="transfer"]').click(); setFile(it.getAsFile()); }
    };
    window.addEventListener("paste", onPaste);
    box.querySelector("[data-x]").onclick = close;
    box.querySelector("[data-ok]").onclick = e => {
      if (m === "efectivo" && r.value && parseMoney(r.value) < total) { err.textContent = "El dinero recibido no alcanza para el total."; return; }
      const reference = m === "transfer" ? box.querySelector("#ref").value.trim() : "";
      const sid = current;
      busy(e.currentTarget, async () => {
        try {
          const saleRef = doc(collection(db, "sessions", sid, "sales"));
          const rcptRef = m === "transfer" && img ? doc(collection(db, "receipts")) : null;
          const base = { at: nowIso(), by: me.id, byName: me.name, method: m, voided: false, receiptId: rcptRef ? rcptRef.id : null, reference };
          if (rec) {
            await runTransaction(db, async tx => {
              const rref = doc(db, "receivables", rec.id);
              const s = await tx.get(rref);
              if (!s.exists() || s.data().status !== "pending") throw { code: "tab-closed" };
              if (rcptRef) tx.set(rcptRef, { img, at: nowIso(), by: me.id, session: sid, total });
              tx.set(saleRef, { ...base, items: rec.items, total, account: rec.label + " (por cobrar)", receivableId: rec.id, fromSession: rec.sessionId, tabOpenedAt: rec.openedAt, lines: rec.lines || [] });
              tx.update(rref, { status: "paid", paidAt: nowIso(), paidBy: me.id, paidByName: me.name, paidSession: sid, saleId: saleRef.id, method: m });
            });
          } else if (t) {
            const fresh = tabs.find(x => x.id === t.id);
            if (!fresh) throw { code: "tab-closed" };
            const allLines = tabLinesOf(fresh), items = aggregate(allLines);
            const tot = items.reduce((a, l) => a + l.price * l.qty, 0);
            if (tot !== total) throw { code: "tab-changed" };
            await runTransaction(db, async tx => {
              const tref = doc(db, "sessions", sid, "tabs", t.id);
              const s = await tx.get(tref);
              if (!s.exists() || s.data().status !== "open") throw { code: "tab-closed" };
              if (rcptRef) tx.set(rcptRef, { img, at: nowIso(), by: me.id, session: sid, total: tot });
              tx.set(saleRef, { ...base, items, total: tot, account: fresh.label, tabId: t.id, tabOpenedAt: fresh.openedAt,
                lines: allLines.map(l => ({ name: l.name, qty: l.qty, price: l.price, at: l.at, byName: l.byName || "", orderId: l.orderId || null })) });
              tx.update(tref, { status: "paid", paidAt: nowIso(), paidBy: me.name, saleId: saleRef.id, total: tot });
            });
            selTab = null;
          } else {
            const b = writeBatch(db);
            if (rcptRef) b.set(rcptRef, { img, at: nowIso(), by: me.id, session: sid, total });
            b.set(saleRef, { ...base, items: lines, total, account: null });
            lines.forEach(l => { const p = products.find(x => x.id === l.pid); if (p && p.stock !== null) b.update(doc(db, "products", l.pid), { stock: increment(-l.qty) }); });
            const pr = b.commit();
            cart = []; close(); toast("Venta registrada · " + fmt(total)); render();
            await pr; return;
          }
          close(); toast("Cuenta cobrada · " + fmt(total)); render();
        } catch (ex) {
          if (ex.code === "tab-changed") { err.textContent = "Alguien agregó o quitó productos de esta cuenta. Cierra y revisa el nuevo total."; }
          else if (ex.code === "tab-closed") { close(); toast("Esa cuenta ya fue cobrada"); }
          else if (ex.code === "unavailable" || ex.code === "failed-precondition") err.textContent = "No se pudo confirmar con el servidor. Revisa la conexión e intenta de nuevo.";
          else { console.error(ex); err.textContent = "No se pudo registrar el pago (" + (ex.code || ex.message) + ")."; }
        }
      });
    };
  });
}

async function receiptModal(id) {
  const close = modal(`<h3>Capture de transferencia</h3><div class="loading" style="min-height:120px">Cargando…</div><div class="modal-f"><button class="btn btn-gold" data-x>Cerrar</button></div>`, (m, c) => { m.querySelector("[data-x]").onclick = c; });
  try {
    const s = await getDoc(doc(db, "receipts", id));
    const box = $("#modalRoot .modal"); if (!box) return;
    box.querySelector(".loading").outerHTML = s.exists() ? `<img class="receipt-img" src="${s.data().img}" alt="Capture de la transferencia"><div class="muted small" style="text-align:center">${fmt(s.data().total)} · ${dt(s.data().at)}</div>` : `<p class="muted">No se encontró la imagen.</p>`;
  } catch (e) { fail(e, "No se pudo cargar el capture."); close(); }
}

// Desglose de una venta ya cobrada (desde Movimientos).
function saleDetailModal(x) {
  const lines = x.lines || [];
  const fake = { id: "_s", items: [], openedAt: x.at };
  tabLines._s = lines.map((l, i) => ({ id: "l" + i, ...l }));
  const orders = lines.length ? ordersOf(fake).filter(o => !o.onlyRemovals) : [];
  delete tabLines._s;
  modal(`<div class="label">${esc(METHODS[x.method] || x.method)} · cobrada ${tm(x.at)} por ${esc(x.byName)}</div><h3 style="font-size:1.3rem">${esc(x.account || "Venta rápida")}</h3>
  ${orders.map((o, i) => { const r = orderRows(o); return `<div class="ord big"><div class="ord-h"><span><b>Pedido ${i + 1}</b> · <span class="num">${tm(o.at)}</span> <span class="muted small">· ${esc(o.byName || "")}</span></span><span class="num"><b>${fmt(r.total)}</b></span></div>
    <div class="ord-i">${r.agg.map(l => `${l.qty}× ${esc(l.name)}`).join(", ")}${r.rem.length ? ` <span class="muted">(${r.rem.length} retirado${r.rem.length > 1 ? "s" : ""})</span>` : ""}</div></div>`; }).join("")}
  <div class="sum num">${x.items.map(i => `<div><span>${i.qty}× ${esc(i.name)}</span><span>${fmt(i.qty * i.price)}</span></div>`).join("")}</div>
  <div class="total"><span class="label">Total</span><span class="v num gold-text">${fmt(x.total)}</span></div>
  <div class="modal-f"><button class="btn btn-gold" data-x>Cerrar</button></div>`, (m, c) => { m.querySelector("[data-x]").onclick = c; });
}

/* ---------- cuentas por cobrar de cierres anteriores ---------- */
function viewCobrar(v) {
  const sum = receivables.reduce((a, r) => a + r.total, 0);
  v.innerHTML = `<div class="sec"><div class="sec-h"><div><div class="label">${receivables.length} cuenta${receivables.length === 1 ? "" : "s"} · ${fmt(sum)} por cobrar</div><h2>Cuentas por cobrar</h2></div></div>
  <p class="muted" style="margin:0;max-width:65ch">Cuentas que quedaron abiertas al cerrar la caja. Al cobrarlas, el pago entra en la caja del turno abierto${current ? "" : " (abre la caja para poder cobrar)"}.</p>
  ${receivables.length ? `<div class="cards">${receivables.map(r => `<div class="panel card">
    <button class="card-hit" data-rdet="${r.id}" aria-label="Ver desglose de ${esc(r.label)}">
      <div class="ct"><h3>${esc(r.label)}</h3><span class="pill warn">Pendiente</span></div>
      <div class="muted small">Turno del ${dt(r.sessionOpenedAt)} · cerrado ${dt(r.closedAt)}</div>
      ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ""}
      <div class="items">${r.items.map(l => `${l.qty}× ${esc(l.name)}`).join(", ")}</div>
      <div class="amt num">${fmt(r.total)}</div>
      <div class="muted small">Toca para ver el desglose</div>
    </button>
    <div class="row"><button class="btn btn-gold btn-sm" data-rpay="${r.id}" ${current ? "" : "disabled"}>Cobrar</button>${isAdmin() ? `<button class="btn btn-danger btn-sm" data-rvoid="${r.id}">Anular deuda</button>` : ""}</div>
  </div>`).join("")}</div>` : `<div class="panel pad empty">No hay cuentas pendientes de cierres anteriores.</div>`}</div>`;
  v.querySelectorAll("[data-rdet]").forEach(b => b.onclick = () => recDetailModal(receivables.find(r => r.id === b.dataset.rdet)));
  v.querySelectorAll("[data-rpay]").forEach(b => b.onclick = () => payModal(null, receivables.find(r => r.id === b.dataset.rpay)));
  v.querySelectorAll("[data-rvoid]").forEach(b => b.onclick = () => {
    const r = receivables.find(x => x.id === b.dataset.rvoid);
    confirmBox("Anular deuda", `La cuenta ${esc(r.label)} por ${fmt(r.total)} dejará de aparecer en Por cobrar y no se cobrará. Úsalo solo si la deuda no se va a pagar.`, "Anular deuda", true,
      () => updateDoc(doc(db, "receivables", r.id), { status: "void", voidedAt: nowIso(), voidedBy: me.name }).then(() => toast("Deuda anulada"), e => fail(e)));
  });
}
function recDetailModal(r) {
  const fake = { id: "_r", items: [], openedAt: r.openedAt };
  tabLines._r = (r.lines || []).map((l, i) => ({ id: "l" + i, ...l }));
  const orders = ordersOf(fake).filter(o => !o.onlyRemovals);
  delete tabLines._r;
  modal(`<div class="label">Por cobrar · turno del ${dt(r.sessionOpenedAt)}</div><h3 style="font-size:1.3rem">${esc(r.label)}</h3>${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ""}
  ${orders.map((o, i) => { const x = orderRows(o); return `<div class="ord big"><div class="ord-h"><span><b>Pedido ${i + 1}</b> · <span class="num">${dt(o.at)}</span> <span class="muted small">· ${esc(o.byName || "")}</span></span><span class="num"><b>${fmt(x.total)}</b></span></div>
    <div class="ord-i">${x.agg.map(l => `${l.qty}× ${esc(l.name)}`).join(", ")}${x.rem.length ? ` <span class="muted">(${x.rem.length} retirado${x.rem.length > 1 ? "s" : ""})</span>` : ""}</div></div>`; }).join("")}
  <div class="total"><span class="label">Total por cobrar</span><span class="v num gold-text">${fmt(r.total)}</span></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cerrar</button><button class="btn btn-gold" data-p ${current ? "" : "disabled"}>Cobrar ${fmt(r.total)}</button></div>`, (m, c) => {
    m.querySelector("[data-x]").onclick = c; m.querySelector("[data-p]").onclick = () => { c(); payModal(null, r); };
  });
}

/* ---------- vista de cuentas abiertas ---------- */
function viewCuentas(v) {
  if (!current || !session) { v.innerHTML = `<div class="panel pad empty">La caja está cerrada. Abre la caja para llevar cuentas por mesa o cliente.</div>`; return; }
  const sum = tabs.reduce((a, x) => a + tabTotal(x), 0);
  v.innerHTML = `<div class="sec"><div class="sec-h"><div><div class="label">${tabs.length} cuentas abiertas · ${fmt(sum)} por cobrar</div><h2>Cuentas por mesa y cliente</h2></div><button class="btn btn-gold" id="newTab2">Nueva cuenta</button></div>
  ${tabs.length ? `<div class="cards">${tabs.map(x => {
    const agg = aggregate(tabLinesOf(x)), ords = ordersOf(x).filter(o => !o.onlyRemovals), last = ords.slice(-1)[0];
    return `<div class="panel card">
    <button class="card-hit" data-det="${x.id}" aria-label="Ver desglose de ${esc(x.label)}">
      <div class="ct"><h3>${esc(x.label)}</h3><span class="muted small">${tm(x.openedAt)}</span></div>
      ${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ""}
      <div class="items">${agg.length ? agg.map(l => `${l.qty}× ${esc(l.name)}`).join(", ") : "Sin consumo todavía"}</div>
      <div class="amt num">${fmt(agg.reduce((a, l) => a + l.price * l.qty, 0))}</div>
      <div class="muted small">${ords.length} pedido${ords.length === 1 ? "" : "s"}${last ? " · último " + tm(last.at) : ""} · Toca para ver el desglose</div>
    </button>
    <div class="row"><button class="btn btn-sm" data-open="${x.id}">Nuevo pedido</button><button class="btn btn-gold btn-sm" data-pay="${x.id}" ${agg.length ? "" : "disabled"}>Cobrar</button></div>
  </div>`; }).join("")}</div>` : `<div class="panel pad empty">No hay cuentas abiertas. Crea una cuando llegue una mesa o un cliente que paga al final.</div>`}</div>`;
  $("#newTab2").onclick = newTabModal;
  v.querySelectorAll("[data-det]").forEach(b => b.onclick = () => detailModal(b.dataset.det));
  v.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { selTab = b.dataset.open; tab = "caja"; render(); });
  v.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => payModal(tabs.find(x => x.id === b.dataset.pay)));
}

function expenseModal() {
  modal(`<h3>Registrar salida de efectivo</h3><p class="muted" style="margin:0">Dinero que sale de la caja durante el turno: pago a proveedor, compra de hielo, propinas, etc.</p>
  <div class="field"><label class="label" for="ec">Concepto</label><input class="input" id="ec" placeholder="Ej: Compra de hielo"></div>
  <div class="field"><label class="label" for="ea">Valor</label><input class="input num" id="ea" inputmode="numeric" placeholder="$ 0"></div>
  <div class="err" id="eerr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Registrar</button></div>`, (m, close) => {
    const a = m.querySelector("#ea"); moneyInput(a);
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-ok]").onclick = () => {
      const c = m.querySelector("#ec").value.trim(), n = parseMoney(a.value);
      if (!c || !n) { m.querySelector("#eerr").textContent = "Escribe el concepto y un valor mayor a cero."; return; }
      addDoc(collection(db, "sessions", current, "expenses"), { at: nowIso(), by: me.id, byName: me.name, concept: c, amount: n }).catch(e => fail(e));
      close(); toast("Salida registrada");
    };
  });
}
function productSummary() {
  const map = {};
  sales.filter(x => !x.voided).forEach(x => x.items.forEach(i => { map[i.name] = map[i.name] || { name: i.name, q: 0, v: 0 }; map[i.name].q += i.qty; map[i.name].v += i.qty * i.price; }));
  return Object.values(map).sort((a, b) => b.v - a.v);
}
function closeModal() {
  const t = totals();
  const open = tabs.map(x => ({ t: x, total: tabTotal(x) }));
  const withDebt = open.filter(o => o.total > 0), pendTotal = withDebt.reduce((a, o) => a + o.total, 0);
  const unsent = tabs.filter(x => draftOf(x.id).length);
  modal(`<h3>Cierre de caja</h3>
  ${open.length ? `<div class="warnbox"><b>Quedan ${open.length} cuenta${open.length > 1 ? "s" : ""} sin cobrar${pendTotal ? " por " + fmt(pendTotal) : ""}.</b>
    ${withDebt.length ? `<div class="small">Al cerrar pasarán a <b>Por cobrar</b> y se podrán cobrar en otro turno. No cuentan como venta de hoy.</div>
    <div class="sum num">${withDebt.map(o => `<div><span>${esc(o.t.label)}</span><span>${fmt(o.total)}</span></div>`).join("")}</div>` : ""}
    ${open.length > withDebt.length ? `<div class="small muted">Las cuentas sin consumo se cierran sin deuda.</div>` : ""}
    ${unsent.length ? `<div class="small" style="color:var(--bad)">Pedidos armados sin agregar en ${unsent.map(x => esc(x.label)).join(", ")} se descartarán.</div>` : ""}
  </div>` : ""}
  <div class="sum num">
    <div><span>Base inicial</span><span>${fmt(session.base)}</span></div>
    <div><span>Ventas en efectivo</span><span>+ ${fmt(t.by.efectivo)}</span></div>
    <div><span>Salidas de efectivo</span><span>− ${fmt(t.exp)}</span></div>
    <div class="strong"><span>Efectivo esperado</span><span>${fmt(t.expected)}</span></div>
    <div><span class="muted">Transferencias</span><span class="muted">${fmt(t.by.transfer)}</span></div>
    <div><span class="muted">Total vendido (${t.count} ventas)</span><span class="muted">${fmt(t.sales)}</span></div>
  </div>
  <div class="field"><label class="label" for="cnt">Efectivo contado en caja</label><input class="input big num" id="cnt" inputmode="numeric" placeholder="$ 0"></div>
  <div class="change"><span class="muted">Diferencia</span><b class="num" id="dif">—</b></div>
  <div class="field"><label class="label" for="cnote">Observaciones</label><textarea class="input" id="cnote" rows="2" placeholder="Opcional"></textarea></div>
  <div class="err" id="cerr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Cerrar caja</button></div>`, (m, close) => {
    const c = m.querySelector("#cnt"), d = m.querySelector("#dif");
    moneyInput(c);
    c.addEventListener("input", () => {
      if (c.value === "") { d.textContent = "—"; d.style.color = ""; return; }
      const df = parseMoney(c.value) - t.expected;
      d.textContent = df === 0 ? "Cuadra exacto" : (df > 0 ? "Sobran " + fmt(df) : "Faltan " + fmt(-df));
      d.style.color = df === 0 ? "var(--ok)" : df > 0 ? "var(--warn)" : "var(--bad)";
    });
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-ok]").onclick = e => {
      if (c.value.trim() === "") { m.querySelector("#cerr").textContent = "Cuenta el efectivo y escribe el valor (puede ser $ 0)."; return; }
      busy(e.currentTarget, async () => {
        const t2 = totals(); const n = parseMoney(c.value);
        const pend = tabs.map(x => ({ x, lines: tabLinesOf(x), items: aggregate(tabLinesOf(x)) })).map(o => ({ ...o, total: sumLines(o.items) }));
        const debts = pend.filter(o => o.total > 0);
        const data = { closedAt: nowIso(), closedBy: me.id, closedByName: me.name, counted: n, expected: t2.expected, diff: n - t2.expected,
          closeNote: m.querySelector("#cnote").value.trim(),
          summary: { ...t2, products: productSummary(), pendingCount: debts.length, pendingTotal: debts.reduce((a, o) => a + o.total, 0), pendingList: debts.map(o => ({ label: o.x.label, total: o.total })) } };
        const report = { ...session, ...data };
        try {
          const b = writeBatch(db);
          for (const o of pend) {
            const tref = doc(db, "sessions", session.id, "tabs", o.x.id);
            if (o.total > 0) {
              b.set(doc(db, "receivables", o.x.id), { label: o.x.label, kind: o.x.kind || "", note: o.x.note || "", openedAt: o.x.openedAt, openedByName: o.x.openedByName || "",
                sessionId: session.id, sessionOpenedAt: session.openedAt, closedAt: data.closedAt, closedByName: me.name,
                items: o.items, total: o.total, lines: o.lines.map(l => ({ name: l.name, qty: l.qty, price: l.price, at: l.at, byName: l.byName || "", orderId: l.orderId || null })), status: "pending" });
              b.update(tref, { status: "pending", movedAt: data.closedAt, total: o.total });
            } else b.update(tref, { status: "empty", movedAt: data.closedAt });
          }
          for (const k of Object.keys(drafts)) delete drafts[k];
          b.update(doc(db, "sessions", session.id), data);
          b.set(doc(db, "meta", "state"), { current: null });
          await b.commit();
          close(); reportModal(report);
        } catch (ex) { fail(ex, "No se pudo cerrar la caja. Revisa la conexión e inténtalo de nuevo."); }
      });
    };
  });
}
function diffPill(d) { return d === 0 ? `<span class="pill ok">Cuadra</span>` : d > 0 ? `<span class="pill warn">Sobran ${fmt(d)}</span>` : `<span class="pill bad">Faltan ${fmt(-d)}</span>`; }
function reportHTML(s) {
  const t = s.summary, rows = t.products || [];
  return `<div class="report"><div class="rh"><h3>Santorini Club · Cierre de caja</h3><div class="muted">${dt(s.openedAt)} → ${dt(s.closedAt)}</div></div>
  <div class="sum num">
    <div><span>Abrió</span><span>${esc(s.openedByName)}</span></div>
    <div><span>Cerró</span><span>${esc(s.closedByName)}</span></div>
    <div><span>Base inicial</span><span>${fmt(s.base)}</span></div>
    <div><span>Ventas efectivo</span><span>${fmt(t.by.efectivo)}</span></div>
    <div><span>Transferencias</span><span>${fmt(t.by.transfer)}</span></div>
    <div><span>Salidas</span><span>${fmt(t.exp)}</span></div>
    <div class="strong"><span>Total vendido</span><span>${fmt(t.sales)}</span></div>
    <div><span>Efectivo esperado</span><span>${fmt(s.expected)}</span></div>
    <div><span>Efectivo contado</span><span>${fmt(s.counted)}</span></div>
    <div><span>Resultado</span><span>${diffPill(s.diff)}</span></div>
    ${t.pendingCount ? `<div><span>Quedaron por cobrar (${t.pendingCount})</span><span>${fmt(t.pendingTotal)}</span></div>` : ""}
  </div>
  ${(t.pendingList || []).length ? `<div class="label" style="margin-top:14px">Cuentas por cobrar</div><div class="sum num">${t.pendingList.map(p => `<div><span>${esc(p.label)}</span><span>${fmt(p.total)}</span></div>`).join("")}</div>` : ""}
  ${rows.length ? `<div class="label" style="margin-top:14px">Productos vendidos</div><div class="tbl-wrap"><table><thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Valor</th></tr></thead><tbody>${rows.map(x => `<tr><td>${esc(x.name)}</td><td class="r num">${x.q}</td><td class="r num">${fmt(x.v)}</td></tr>`).join("")}</tbody></table></div>` : ""}
  ${s.closeNote ? `<p class="muted">Obs.: ${esc(s.closeNote)}</p>` : ""}</div>`;
}
function reportText(s) {
  const t = s.summary;
  return `SANTORINI CLUB - CIERRE DE CAJA\n${dt(s.openedAt)} a ${dt(s.closedAt)}\nAbrió: ${s.openedByName} | Cerró: ${s.closedByName}\nBase: ${fmt(s.base)}\nEfectivo: ${fmt(t.by.efectivo)}\nTransferencias: ${fmt(t.by.transfer)}\nSalidas: ${fmt(t.exp)}\nTOTAL VENDIDO: ${fmt(t.sales)}\nEsperado en caja: ${fmt(s.expected)}\nContado: ${fmt(s.counted)}\nDiferencia: ${s.diff >= 0 ? "+" : "-"}${fmt(Math.abs(s.diff))}${t.pendingCount ? "\nQuedaron por cobrar: " + t.pendingCount + " cuentas, " + fmt(t.pendingTotal) + "\n" + t.pendingList.map(p => "- " + p.label + ": " + fmt(p.total)).join("\n") : ""}${s.closeNote ? "\nObs: " + s.closeNote : ""}`;
}
function reportModal(s) {
  modal(reportHTML(s) + `<div class="modal-f"><button class="btn" data-copy>Copiar resumen</button><button class="btn btn-gold" data-x>Listo</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-copy]").onclick = () => { navigator.clipboard.writeText(reportText(s)).then(() => toast("Resumen copiado, pégalo en WhatsApp"), () => toast("No se pudo copiar")); };
  });
}

/* ---------- MOVIMIENTOS ---------- */
const removedOf = x => (x.removed && x.removed.length) ? x.removed : (x.lines || []).filter(l => l.qty < 0).map(l => ({ qty: -l.qty, name: l.name, by: l.byName }));
function viewMov(v) {
  if (!current || !session) { v.innerHTML = `<div class="panel pad empty">No hay un turno abierto. Abre la caja para ver los movimientos del turno.</div>`; return; }
  const list = [...sales].reverse();
  v.innerHTML = `<div class="sec">
    <div class="sec-h"><div><div class="label">Turno abierto ${dt(session.openedAt)}</div><h2>Movimientos del turno</h2></div></div>
    <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Hora</th><th>Cuenta</th><th>Productos</th><th>Pago</th><th>Cobró</th><th class="r">Total</th>${isAdmin() ? "<th></th>" : ""}</tr></thead><tbody>
    ${list.map(x => `<tr class="${x.voided ? "voided" : ""}"><td class="num">${tm(x.at)}</td><td>${x.account ? `<button class="link" data-sale="${x.id}">${esc(x.account)}</button>` : '<span class="muted">Venta rápida</span>'}</td><td class="items">${x.items.map(i => `${i.qty}× ${esc(i.name)}`).join(", ")}${removedOf(x).length ? `<div class="muted small" title="${esc(removedOf(x).map(r => r.qty + "× " + r.name + " (" + r.by + ")").join(", "))}">${removedOf(x).length} retiro(s) de productos</div>` : ""}</td><td>${METHODS[x.method] || x.method}${x.voided ? ` <span class="pill void">Anulada</span>` : ""}${x.method === "transfer" ? (x.receiptId ? `<div><button class="link small" data-rcpt="${x.receiptId}">Ver capture</button></div>` : `<div class="muted small">Sin capture</div>`) : ""}${x.reference ? `<div class="muted small">Ref. ${esc(x.reference)}</div>` : ""}</td><td>${esc(x.byName)}</td><td class="r num">${fmt(x.total)}</td>${isAdmin() ? `<td class="r">${x.voided ? "" : `<button class="btn btn-danger btn-sm" data-void="${x.id}">Anular</button>`}</td>` : ""}</tr>`).join("") || `<tr><td colspan="7" class="empty">Aún no hay ventas en este turno.</td></tr>`}
    </tbody></table></div></div>
    <h3>Salidas de efectivo</h3>
    <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Hora</th><th>Concepto</th><th>Registró</th><th class="r">Valor</th></tr></thead><tbody>
    ${expenses.slice().reverse().map(x => `<tr><td class="num">${tm(x.at)}</td><td>${esc(x.concept)}</td><td>${esc(x.byName)}</td><td class="r num">${fmt(x.amount)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">Sin salidas registradas.</td></tr>`}
    </tbody></table></div></div></div>`;
  v.querySelectorAll("[data-rcpt]").forEach(b => b.onclick = () => receiptModal(b.dataset.rcpt));
  v.querySelectorAll("[data-sale]").forEach(b => b.onclick = () => saleDetailModal(sales.find(y => y.id === b.dataset.sale)));
  v.querySelectorAll("[data-void]").forEach(b => b.onclick = () => {
    const x = sales.find(y => y.id === b.dataset.void);
    confirmBox("Anular venta", `La venta de ${fmt(x.total)} (${tm(x.at)}) dejará de contar en el cierre y las unidades vuelven al inventario.`, "Anular venta", true, async () => {
      try {
        const bt = writeBatch(db);
        bt.update(doc(db, "sessions", current, "sales", x.id), { voided: true, voidedBy: me.name, voidedAt: nowIso() });
        x.items.forEach(i => { const p = products.find(q => q.id === i.pid); if (p && p.stock !== null) bt.update(doc(db, "products", i.pid), { stock: increment(i.qty) }); });
        await bt.commit(); toast("Venta anulada");
      } catch (e) { fail(e); }
    });
  });
}

/* ---------- PRODUCTOS ---------- */
const EXAMPLES = [
  ["Cover general", "Entradas", 20000, null], ["Cover VIP", "Entradas", 50000, null],
  ["Cerveza Águila", "Cerveza", 8000, 120], ["Cerveza Club Colombia", "Cerveza", 9000, 96], ["Corona", "Cerveza", 14000, 48],
  ["Aguardiente Antioqueño 750 ml", "Licores", 95000, 24], ["Aguardiente media", "Licores", 55000, 30], ["Ron Medellín 8 años 750 ml", "Licores", 130000, 12],
  ["Old Parr 750 ml", "Licores", 280000, 8], ["Buchanan's 12 750 ml", "Licores", 300000, 6],
  ["Agua", "Bebidas", 5000, 60], ["Gaseosa", "Bebidas", 6000, 60], ["Red Bull", "Bebidas", 14000, 48], ["Hielo (bolsa)", "Bebidas", 8000, null],
  ["Coctel de la casa", "Cocteles", 28000, null], ["Mojito", "Cocteles", 30000, null]
];
function viewProd(v) {
  if (!isAdmin()) return viewCaja(v);
  const ps = [...products].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  v.innerHTML = `<div class="sec"><div class="sec-h"><div><div class="label">${ps.length} productos</div><h2>Productos</h2></div><button class="btn btn-gold" id="newP">Agregar producto</button></div>
  ${ps.length ? `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Producto</th><th>Categoría</th><th class="r">Precio</th><th class="r">Stock</th><th>Estado</th><th></th></tr></thead><tbody>
  ${ps.map(p => `<tr><td><div class="pcell">${p.img ? `<img class="thumb" src="${p.img}" alt="">` : `<span class="thumb ph">${esc(p.name.trim().charAt(0).toUpperCase())}</span>`}<b>${esc(p.name)}</b></div></td><td>${esc(p.category)}</td><td class="r num">${fmt(p.price)}</td><td class="r num">${p.stock === null ? '<span class="muted">Sin control</span>' : (p.stock <= 5 ? `<span style="color:var(--warn)">${p.stock}</span>` : p.stock)}</td>
  <td>${p.active ? '<span class="pill ok">Activo</span>' : '<span class="pill void">Oculto</span>'}</td><td><div class="actions"><button class="btn btn-sm" data-edit="${p.id}">Editar</button></div></td></tr>`).join("")}
  </tbody></table></div></div>` : `<div class="panel pad sec"><h3>Aún no hay productos</h3><p class="muted" style="margin:0">Agrega tus productos uno por uno, o carga una lista de ejemplo de discoteca (cervezas, licores, cover) y luego ajusta precios y stock.</p><div><button class="btn" id="seedP">Cargar lista de ejemplo</button></div></div>`}</div>`;
  $("#newP").onclick = () => prodModal(null);
  $("#seedP")?.addEventListener("click", e => busy(e.currentTarget, async () => {
    try { const b = writeBatch(db); EXAMPLES.forEach(([name, category, price, stock]) => b.set(doc(collection(db, "products")), { name, category, price, stock, active: true })); await b.commit(); toast("Lista de ejemplo cargada"); }
    catch (ex) { fail(ex); }
  }));
  v.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => prodModal(products.find(p => p.id === b.dataset.edit)));
}
function prodModal(p) {
  const cats = [...new Set(products.map(x => x.category))];
  modal(`<h3>${p ? "Editar producto" : "Nuevo producto"}</h3>
  <div class="pimg-edit"><div class="pimg-prev" id="pimgPrev">${p && p.img ? `<img src="${p.img}" alt="">` : `<span>Sin imagen</span>`}</div>
    <div class="sec" style="gap:8px"><span class="label">Imagen del producto</span>${photoPicker("pimg")}<button class="link small" id="pimgDel" ${p && p.img ? "" : "hidden"} style="align-self:flex-start">Quitar imagen</button></div></div>
  <div class="field"><label class="label" for="pn">Nombre</label><input class="input" id="pn" value="${esc(p?.name)}"></div>
  <div class="row"><div class="field"><label class="label" for="pc">Categoría</label><input class="input" id="pc" list="catlist" value="${esc(p?.category)}"><datalist id="catlist">${cats.map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>
  <div class="field"><label class="label" for="pp">Precio</label><input class="input num" id="pp" inputmode="numeric" value="${p ? fmt(p.price) : ""}"></div></div>
  <div class="row"><div class="field"><label class="label" for="ps">Stock (vacío = sin control)</label><input class="input num" id="ps" inputmode="numeric" value="${p && p.stock !== null ? p.stock : ""}"></div>
  <div class="field"><label class="label" for="pa">Estado</label><select class="input" id="pa"><option value="1">Activo (se vende)</option><option value="0" ${p && !p.active ? "selected" : ""}>Oculto</option></select></div></div>
  <div class="err" id="perr"></div>
  <div class="modal-f">${p ? `<button class="btn btn-danger" data-del style="margin-right:auto">Eliminar</button>` : ""}<button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Guardar</button></div>`, (m, close) => {
    const pr = m.querySelector("#pp"); moneyInput(pr);
    let pimg = p ? (p.img || null) : null;
    const prev = m.querySelector("#pimgPrev"), del = m.querySelector("#pimgDel");
    bindPicker(m, "pimg", async f => {
      if (!f.type.startsWith("image/")) { m.querySelector("#perr").textContent = "El archivo debe ser una imagen."; return; }
      prev.innerHTML = "<span>Procesando…</span>";
      try { pimg = await compressImage(f, [[360, 0.75], [300, 0.68], [240, 0.6]], 120000); prev.innerHTML = `<img src="${pimg}" alt="">`; del.hidden = false; m.querySelector("#perr").textContent = ""; }
      catch (e) { prev.innerHTML = pimg ? `<img src="${pimg}" alt="">` : "<span>Sin imagen</span>"; m.querySelector("#perr").textContent = "No se pudo leer la imagen. Prueba con otra foto."; }
    });
    del.onclick = () => { pimg = null; prev.innerHTML = "<span>Sin imagen</span>"; del.hidden = true; };
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-del]")?.addEventListener("click", () => { close(); confirmBox("Eliminar producto", `¿Eliminar “${esc(p.name)}”? Las ventas ya registradas no cambian. Si solo quieres dejar de venderlo, márcalo como oculto.`, "Eliminar", true, () => deleteDoc(doc(db, "products", p.id)).then(() => toast("Producto eliminado"), e => fail(e))); });
    m.querySelector("[data-ok]").onclick = () => {
      const name = m.querySelector("#pn").value.trim(), category = m.querySelector("#pc").value.trim() || "General", price = parseMoney(pr.value), sv = m.querySelector("#ps").value.trim();
      if (!name || !price) { m.querySelector("#perr").textContent = "El producto necesita nombre y precio."; return; }
      const data = { name, category, price, stock: sv === "" ? null : (parseInt(sv, 10) || 0), active: m.querySelector("#pa").value === "1", img: pimg };
      (p ? updateDoc(doc(db, "products", p.id), data) : addDoc(collection(db, "products"), data)).catch(e => fail(e));
      close(); toast(p ? "Producto actualizado" : "Producto agregado");
    };
  });
}

/* ---------- USUARIOS ---------- */
function viewUsers(v) {
  if (!isAdmin()) return viewCaja(v);
  const us = [...users].sort((a, b) => a.name.localeCompare(b.name));
  v.innerHTML = `<div class="sec"><div class="sec-h"><div><div class="label">Solo el administrador crea usuarios</div><h2>Usuarios</h2></div><button class="btn btn-gold" id="newU">Crear usuario</button></div>
  <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>
  ${us.map(u => `<tr><td><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="muted">(tú)</span>' : ""}</td><td class="num">${esc(u.user)}</td><td><span class="role ${u.role === "admin" ? "admin" : ""}">${u.role === "admin" ? "Admin" : "Cajero"}</span></td>
  <td>${u.active ? '<span class="pill ok">Activo</span>' : '<span class="pill void">Desactivado</span>'}</td>
  <td><div class="actions">${u.id !== me.id ? `<button class="btn btn-sm" data-role="${u.id}">${u.role === "admin" ? "Hacer cajero" : "Hacer admin"}</button><button class="btn btn-sm" data-tog="${u.id}">${u.active ? "Desactivar" : "Activar"}</button>` : ""}</div></td></tr>`).join("")}
  </tbody></table></div></div>
  <p class="muted" style="margin:0;font-size:.86rem">Si un cajero olvida su contraseña, desactívalo y créale un usuario nuevo. Cada persona cambia su propia contraseña en “Mi cuenta”.</p></div>`;
  $("#newU").onclick = userModal;
  v.querySelectorAll("[data-tog]").forEach(b => b.onclick = () => { const u = users.find(x => x.id === b.dataset.tog); updateDoc(doc(db, "users", u.id), { active: !u.active }).then(() => toast(u.active ? "Usuario desactivado" : "Usuario activado"), e => fail(e)); });
  v.querySelectorAll("[data-role]").forEach(b => b.onclick = () => { const u = users.find(x => x.id === b.dataset.role); const r = u.role === "admin" ? "cajero" : "admin"; updateDoc(doc(db, "users", u.id), { role: r }).then(() => toast("Rol actualizado"), e => fail(e)); });
}
function userModal() {
  modal(`<h3>Crear usuario</h3>
  <div class="field"><label class="label" for="un">Nombre completo</label><input class="input" id="un" placeholder="Ej: Laura Pérez"></div>
  <div class="row"><div class="field"><label class="label" for="uu">Usuario</label><input class="input" id="uu" placeholder="laura" autocapitalize="off"></div>
  <div class="field"><label class="label" for="ur">Rol</label><select class="input" id="ur"><option value="cajero">Cajero</option><option value="admin">Administrador</option></select></div></div>
  <div class="field"><label class="label" for="up">Contraseña (mínimo 6 caracteres)</label><input class="input" id="up" type="password" autocomplete="new-password"></div>
  <div class="err" id="uerr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Crear usuario</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-ok]").onclick = e => {
      const name = m.querySelector("#un").value.trim(), user = m.querySelector("#uu").value.trim().toLowerCase(), pw = m.querySelector("#up").value, role = m.querySelector("#ur").value, er = m.querySelector("#uerr");
      if (!name || !user) { er.textContent = "Escribe nombre y usuario."; return; }
      if (!/^[a-z0-9._-]+$/.test(user)) { er.textContent = "El usuario solo puede tener letras, números, punto o guion, sin espacios."; return; }
      if (users.some(u => u.user === user)) { er.textContent = "Ese usuario ya existe."; return; }
      if (pw.length < 6) { er.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }
      busy(e.currentTarget, async () => {
        // Se usa una segunda instancia de Firebase para crear la cuenta sin cerrar la sesión del administrador.
        const sec = initializeApp(firebaseConfig, "alta-" + Date.now());
        try {
          const cred = await createUserWithEmailAndPassword(getAuth(sec), toEmail(user), pw);
          await setDoc(doc(db, "users", cred.user.uid), { user, name, role, active: true, created: nowIso(), createdBy: me.id });
          await signOut(getAuth(sec));
          close(); toast("Usuario creado");
        } catch (ex) {
          console.error(ex);
          er.textContent = ex.code === "auth/email-already-in-use" ? "Ese usuario ya existe (puede estar desactivado)." : "No se pudo crear (" + (ex.code || ex.message) + ").";
        } finally { deleteApp(sec).catch(() => {}); }
      });
    };
  });
}

/* ---------- CIERRES ---------- */
async function viewHist(v) {
  if (!isAdmin()) return viewCaja(v);
  v.innerHTML = `<div class="loading">Cargando cierres…</div>`;
  let closed = [];
  try {
    const s = await getDocs(query(collection(db, "sessions"), where("closedAt", "!=", null), orderBy("closedAt", "desc"), limit(100)));
    closed = s.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { fail(e, "No se pudieron leer los cierres."); }
  if (tab !== "hist") return;
  const sum = closed.reduce((a, s) => a + (s.summary?.sales || 0), 0);
  v.innerHTML = `<div class="sec"><div class="sec-h"><div><div class="label">${closed.length} turnos cerrados · ${fmt(sum)} vendidos</div><h2>Cierres de caja</h2></div></div>
  <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Apertura</th><th>Cierre</th><th>Cajero</th><th class="r">Vendido</th><th class="r">Efectivo esperado</th><th class="r">Contado</th><th>Resultado</th><th></th></tr></thead><tbody>
  ${closed.map(s => `<tr><td class="num">${dt(s.openedAt)}</td><td class="num">${dt(s.closedAt)}</td><td>${esc(s.openedByName)}${s.closedByName !== s.openedByName ? " / " + esc(s.closedByName) : ""}</td>
  <td class="r num"><b>${fmt(s.summary.sales)}</b></td><td class="r num">${fmt(s.expected)}</td><td class="r num">${fmt(s.counted)}</td><td>${diffPill(s.diff)}</td><td><button class="btn btn-sm" data-rep="${s.id}">Ver</button></td></tr>`).join("") || `<tr><td colspan="8" class="empty">Todavía no hay cierres. Aparecerán aquí cada vez que se cierre la caja.</td></tr>`}
  </tbody></table></div></div></div>`;
  v.querySelectorAll("[data-rep]").forEach(b => b.onclick = () => reportModal(closed.find(s => s.id === b.dataset.rep)));
}

/* ---------- MI CUENTA ---------- */
function viewCuenta(v) {
  v.innerHTML = `<div class="sec" style="max-width:560px"><div><div class="label">Mi cuenta</div><h2>${esc(me.name)}</h2></div>
  <div class="panel pad sec"><div class="sum"><div><span class="muted">Usuario</span><span>${esc(me.user)}</span></div><div><span class="muted">Rol</span><span>${isAdmin() ? "Administrador" : "Cajero"}</span></div></div>
  <button class="btn btn-gold" id="chpw">Cambiar mi contraseña</button></div></div>`;
  $("#chpw").onclick = pwModal;
}
function pwModal() {
  modal(`<h3>Cambiar contraseña</h3>
  <div class="field"><label class="label" for="op">Contraseña actual</label><input class="input" id="op" type="password" autocomplete="current-password"></div>
  <div class="field"><label class="label" for="np">Nueva contraseña</label><input class="input" id="np" type="password" autocomplete="new-password"></div>
  <div class="field"><label class="label" for="np2">Repite la nueva contraseña</label><input class="input" id="np2" type="password" autocomplete="new-password"></div>
  <div class="err" id="pwerr"></div>
  <div class="modal-f"><button class="btn btn-ghost" data-x>Cancelar</button><button class="btn btn-gold" data-ok>Guardar</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-ok]").onclick = e => {
      const er = m.querySelector("#pwerr"), np = m.querySelector("#np").value;
      if (np.length < 6) { er.textContent = "La nueva contraseña debe tener al menos 6 caracteres."; return; }
      if (np !== m.querySelector("#np2").value) { er.textContent = "Las contraseñas no coinciden."; return; }
      busy(e.currentTarget, async () => {
        try {
          await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, m.querySelector("#op").value));
          await updatePassword(auth.currentUser, np);
          close(); toast("Contraseña actualizada");
        } catch (ex) { er.textContent = ex.code === "auth/invalid-credential" || ex.code === "auth/wrong-password" ? "La contraseña actual no es correcta." : "No se pudo cambiar (" + ex.code + ")."; }
      });
    };
  });
}

/* ---------- inicio ---------- */
if (!configured) {
  show("noconfig");
} else {
  $("#loginForm").addEventListener("submit", onLoginSubmit);
  $("#logout").onclick = () => { if (cart.length) confirmBox("Salir", "Hay productos en la cuenta sin cobrar. Si sales se pierden.", "Salir", true, () => signOut(auth)); else signOut(auth); };
  $("#nav").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); } });
  setPersistence(auth, browserSessionPersistence).catch(() => {}).finally(() => onAuthStateChanged(auth, onUser));
}
