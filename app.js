// =====================================================================
// NEXO · Tu círculo, tu seguridad
// JavaScript puro (sin frameworks). Dos modos:
//   - NUBE:   base de datos Supabase (usuarios reales + tiempo real)
//   - LOCAL:  cuentas de prueba locales (localStorage)
// Mapa: Leaflet + tiles oscuros Esri · Navegación: Waze · Estilo Life360
// =====================================================================

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const INTERVALO_REPORTE_UBICACION = 5000;

const URL_MAPA = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";

// Canal de sincronización entre pestañas del MISMO navegador (modo LOCAL):
// cuando una pestaña actualiza su GPS o los datos, las demás se enteran al
// instante vía el evento "storage". Sin esto, dos pestañas con distintas
// cuentas no verían las posiciones reales en vivo.
const CANAL_SYNC = "nexo_sync_v1";

const MODO_NUBE = !!(window.NUBE && window.NUBE.activo);
// Silenciar notificación de contraseña (se usa en "¿Olvidaste tu contraseña?")

// Colores fijos por miembro (estilo Life360)
const COLORES_MIEMBRO = ["#F2A33C", "#2DD4BF", "#F472B6", "#60A5FA", "#FB7185", "#A3E635", "#38BDF8"];

let mapa = null;
let mapaPicker = null;
let pickerMarker = null;
let marcadores = {};
let vivo = {};
let miPos = null;
let usandoSimulacion = false;
let watchId = null;
let intervaloReporte = null;
let fichaAbiertaId = null;
let grupoDetalleId = null;
let toastTimer = null;
let vistaActual = null;
let entrandoNube = false;

// ============================ UTILIDADES ============================

function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function iniciales(nombre) {
  const partes = String(nombre || "?").trim().split(/\s+/);
  const letras = (partes[0] ? partes[0][0] : "") + (partes[1] ? partes[1][0] : "");
  return letras.toUpperCase() || "?";
}

function hashColor(cadena) {
  let h = 0;
  for (const ch of String(cadena)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORES_MIEMBRO[h % COLORES_MIEMBRO.length];
}

function colorDe(userId) {
  return hashColor(userId);
}

function nuevoId() {
  return window.NUBE ? window.NUBE.nuevoId() : uuid();
}

function fmtAgo(iso) {
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "ahora";
  if (s < 60) return "hace " + s + " s";
  const m = Math.round(s / 60);
  if (m < 60) return "hace " + m + " min";
  const h = Math.round(m / 60);
  if (h < 24) return "hace " + h + " h";
  return "hace " + Math.round(h / 24) + " d";
}

function fmtHora(iso) {
  try { return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return ""; }
}

function fmtFecha(iso) {
  try { return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }); }
  catch (e) { return ""; }
}

function mostrarToast(mensaje, tipo) {
  const t = $("#toast");
  t.textContent = mensaje;
  t.className = "toast " + (tipo || "");
  t.classList.remove("oculta");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("oculta"), 3000);
}

function setCargando(activo) {
  $("#cargando").classList.toggle("oculta", !activo);
}

function abrirModal(html) {
  $("#modal").innerHTML = html;
  $("#modal").classList.remove("oculta");
  $("#tapete").classList.remove("oculta");
}

function cerrarModal() {
  $("#modal").classList.add("oculta");
  $("#tapete").classList.add("oculta");
  if (mapaPicker) { mapaPicker.remove(); mapaPicker = null; pickerMarker = null; }
}

// ============================ DATOS ============================

function usuarioActual() {
  return datos.users.find((u) => u.id === datos.sessionUserId) || null;
}

function usuarioPorId(id) { return datos.users.find((u) => u.id === id); }
function grupoPorId(id) { return datos.groups.find((g) => g.id === id); }

function gruposDe(userId) { return datos.groups.filter((g) => g.members.some((m) => m.userId === userId)); }

function miembrosDe(userId) {
  const lista = [];
  gruposDe(userId).forEach((g) => g.members.forEach((m) => {
    if (!lista.find((x) => x.userId === m.userId)) lista.push(m);
  }));
  return lista;
}

function miembrosDelGrupo(gid) {
  const g = grupoPorId(gid);
  return g ? g.members : [];
}

function rolEnGrupo(gid, userId) {
  const g = grupoPorId(gid);
  const m = g && g.members.find((x) => x.userId === userId);
  return m ? m.role : null;
}

const ROL_LABEL = { OWNER: "Líder", ADMIN: "Co-líder", MEMBER: "Miembro" };

function esDeMiGrupo(alerta) {
  const yo = usuarioActual();
  return yo && gruposDe(yo.id).some((g) => g.id === alerta.groupId);
}

function agregarAlertaUnica(a) {
  if (!datos.alerts.some((x) => x.id === a.id)) datos.alerts.push(a);
}

function agregarNotifUnica(n) {
  if (!datos.notifications.some((x) => x.id === n.id)) datos.notifications.push(n);
}

function generarCodigo() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "NEXO";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ============================ ACCESO ============================

function entrarApp() {
  $("#vistaLogin").classList.add("oculta");
  $("#vistaRegistro").classList.add("oculta");
  $("#app").classList.remove("oculta");
  const u = usuarioActual();
  $("#textoEnVivo").textContent = u ? u.name : "en vivo";
  mostrarVista("mapa");
  iniciarMapa();
  actualizarBadge();
  setTimeout(procesarInvitacionEnlace, 300);
}

function limpiarSesionUI() {
  if ($("#app").classList.contains("oculta")) return;
  $("#app").classList.add("oculta");
  $("#vistaLogin").classList.remove("oculta");
  $("#loginError").textContent = "";
  $("#vistaRegistro").classList.add("oculta");
}

function salirApp() {
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (intervaloReporte) { clearInterval(intervaloReporte); intervaloReporte = null; }
  if (mapa) { mapa.remove(); mapa = null; }
  marcadores = {}; vivo = {}; miPos = null; usandoSimulacion = false; fichaAbiertaId = null; grupoDetalleId = null; circuloPrecision = null;
  datos.sessionUserId = null;
  salvarDatos();
  if (MODO_NUBE) {
    window.NUBE.desconectarEnVivo();
    window.NUBE.cerrarSesion().catch(() => {});
  }
  limpiarSesionUI();
}

function entrarComo(userId) {
  datos.sessionUserId = userId;
  salvarDatos();
  entrarApp();
}

async function entrarAppNube(user) {
  if (entrandoNube) return;
  entrandoNube = true;
  setCargando(true);
  try {
    const t = await window.NUBE.cargarTodo();
    const uid = user.id;

    datos.users = t.perfiles.map((p) => ({
      id: p.id,
      name: p.nombre || "Usuario",
      email: p.id === uid ? user.email : "",
      phone: p.telefono || "",
      shareLocation: !!p.share_ubicacion,
      createdAt: p.created_at,
      points: []
    }));

    Object.keys(vivo).forEach((k) => delete vivo[k]);
    t.ubicaciones.forEach((u) => {
      vivo[u.usuario_id] = { lat: u.lat, lng: u.lng, lastAt: u.updated_at || fechaISO() };
    });

    datos.groups = t.grupos.map((g) => ({
      id: g.id, name: g.nombre, description: g.descripcion, code: g.codigo,
      ownerId: g.propietario_id, createdAt: g.created_at,
      members: t.miembros.filter((m) => m.grupo_id === g.id).map((m) => ({ userId: m.usuario_id, role: m.rol }))
    }));

    datos.places = t.lugares.map((p) => ({
      id: p.id, userId: p.usuario_id, name: p.nombre, category: p.categoria,
      address: p.direccion, lat: p.lat, lng: p.lng, createdAt: p.created_at
    }));

    datos.alerts = t.alertas.map((a) => ({
      id: a.id, groupId: a.grupo_id, senderId: a.emisor_id, message: a.mensaje,
      lat: a.lat, lng: a.lng, status: a.estado, sentAt: a.creada_en, resolvedAt: a.resuelta_en
    }));

    datos.notifications = t.notificaciones
      .filter((n) => n.usuario_id === uid)
      .map((n) => ({
        id: n.id, userId: n.usuario_id, type: n.tipo, title: n.titulo,
        body: n.cuerpo, read: !!n.leida, createdAt: n.created_at
      }));

    datos.sessionUserId = uid;

    // Cada persona nueva arranca con su propio círculo (código único), salvo que
    // venga de una invitación: en ese caso se une al círculo de quien la invitó.
    if (!gruposDe(uid).length && !hayParametroInvitacion()) await crearGrupoInicial(uid);

    salvarDatos();
    entrarApp();
    window.NUBE.conectarEnVivo(manejarCambioEnVivo);
    iniciarReporteNube();
  } catch (e) {
    mostrarToast(e.message || "No se pudo conectar con la nube.", "error");
  } finally {
    setCargando(false);
    entrandoNube = false;
  }
}

async function crearGrupoInicial(uid) {
  const grupo = {
    id: nuevoId(), name: "Mi círculo", description: "Círculo de confianza",
    code: generarCodigo(), ownerId: uid, createdAt: fechaISO(),
    members: [{ userId: uid, role: "OWNER" }]
  };
  try {
    await window.NUBE.insert("grupos", { id: grupo.id, nombre: grupo.name, descripcion: grupo.description, codigo: grupo.code, propietario_id: uid });
    await window.NUBE.insert("miembros", { grupo_id: grupo.id, usuario_id: uid, rol: "OWNER" });
    datos.groups.push(grupo);
  } catch (e) { mostrarToast("No se pudo crear tu círculo: " + e.message, "error"); }
}

function iniciarSesion() {
  const errorEl = $("#loginError");
  errorEl.textContent = "";
  const correo = $("#loginCorreo").value.trim().toLowerCase();
  const clave = $("#loginContrasena").value;
  if (MODO_NUBE) {
    setCargando(true);
    window.NUBE.inicioSesion(correo, clave)
      .catch((e) => { errorEl.textContent = e.message; })
      .finally(() => setCargando(false));
    return;
  }
  const u = datos.users.find((x) => x.email === correo && x.password === clave);
  if (!u) { errorEl.textContent = "Correo o contraseña incorrectos."; return; }
  entrarComo(u.id);
}

function registrarUsuario() {
  const errorEl = $("#regError");
  errorEl.textContent = "";
  const nombre = $("#regNombre").value.trim();
  const correo = $("#regCorreo").value.trim().toLowerCase();
  const clave = $("#regContrasena").value;
  if (!nombre) { errorEl.textContent = "Escribe tu nombre."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { errorEl.textContent = "Correo no válido."; return; }
  if (clave.length < 6) { errorEl.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }
  if (MODO_NUBE) {
    setCargando(true);
    window.NUBE.registro(nombre, correo, clave)
      .then((sesionIniciada) => {
        if (!sesionIniciada) {
          mostrarToast("Revisa tu correo para confirmar la cuenta.", "aviso");
          $("#vistaRegistro").classList.add("oculta");
          $("#vistaLogin").classList.remove("oculta");
        }
      })
      .catch((e) => { errorEl.textContent = e.message; })
      .finally(() => setCargando(false));
    return;
  }
  if (datos.users.some((x) => x.email === correo)) { errorEl.textContent = "Ese correo ya está registrado."; return; }
  datos.users.push({
    id: uuid(), name: nombre, email: correo, password: clave,
    phone: "", shareLocation: false, createdAt: fechaISO(), points: []
  });
  salvarDatos();
  entrarComo(datos.users[datos.users.length - 1].id);
  mostrarToast("Cuenta creada. ¡Bienvenido a NEXO!", "exito");
}

// ============================ NAVEGACION ============================

const NOMBRES_VISTA = { mapa: "Mapa", grupo: "Mi grupo", lugares: "Lugares", alertas: "Alertas", perfil: "Perfil" };
const IDS_VISTA = { mapa: "vistaMapa", grupo: "vistaGrupo", lugares: "vistaLugares", alertas: "vistaAlertas", perfil: "vistaPerfil" };

function mostrarVista(vista) {
  vistaActual = vista;
  $$(".vista").forEach((v) => v.classList.add("oculta"));
  $("#" + IDS_VISTA[vista]).classList.remove("oculta");
  $$(".tab").forEach((t) => t.classList.toggle("activa", t.dataset.vista === vista));
  $("#textoCabecera").textContent = NOMBRES_VISTA[vista];
  if (vista === "mapa") {
    if (mapa) setTimeout(() => { mapa.invalidateSize(); actualizarMarcadores(); }, 80);
    actualizarBannerPrivacidad();
    renderFichaSiAbierta();
  }
  if (vista === "grupo") grupoDetalleId ? verDetalleGrupo(grupoDetalleId) : renderGrupos();
  if (vista === "lugares") renderLugares();
  if (vista === "alertas") renderAlertas();
  if (vista === "perfil") renderPerfil();
}

// ============================ MAPA ============================

function iniciarMapa() {
  if (typeof L === "undefined") { mostrarToast("Sin red: no se pudo cargar el mapa.", "error"); return; }
  mapa = L.map("mapa").setView([POSICION_BASE.lat, POSICION_BASE.lng], 13);
  L.tileLayer(URL_MAPA, {
    maxZoom: 18,
    attribution: 'Tiles &copy; Esri &mdash; Fuente: Esri. Pines NEXO'
  }).addTo(mapa);
  const yo = usuarioActual();
  comenzarMiUbicacion();
  actualizarMarcadores();
}

function comenzarMiUbicacion() {
  if (watchId) return;
  if (!navigator.geolocation) { errorGps({ code: 0 }); return; }
  watchId = navigator.geolocation.watchPosition(
    (pos) => fijarPosicionMia(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    errorGps,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// Errores reales del GPS. En modo NUBE jamás se inventa una posición:
// mostrarle a tu círculo un lugar falso es peor que no mostrar nada.
function errorGps(err) {
  const msgs = {
    0: "Tu navegador no soporta ubicación.",
    1: "Permiso de ubicación denegado. Actívalo en los ajustes del navegador.",
    2: "No se pudo determinar tu ubicación. Revisa el GPS.",
    3: "El GPS tardó demasiado. Reintentando…"
  };
  if (err && err.code === 3 && miPos) return;
  if (MODO_NUBE) { mostrarToast(msgs[err && err.code] || msgs[2], "aviso"); return; }
  usarPosicionPorDefecto();
}

function usarPosicionPorDefecto() {
  if (miPos) return;
  usandoSimulacion = true;
  fijarPosicionMia(
    POSICION_BASE.lat + (Math.random() - 0.5) * 0.02,
    POSICION_BASE.lng + (Math.random() - 0.5) * 0.02
  );
  mostrarToast("GPS no disponible: se usa una ubicación de prueba.", "aviso");
}

let circuloPrecision = null;
function fijarPosicionMia(lat, lng, precision) {
  const primera = !miPos;
  miPos = { lat, lng, lastAt: fechaISO() };
  if (!marcadores["yo"]) crearMarca("yo", usuarioActual().name, true);
  else marcadores["yo"].setLatLng([lat, lng]);
  if (mapa && precision && precision > 15 && precision < 500) {
    if (!circuloPrecision) circuloPrecision = L.circle([lat, lng], { radius: precision, color: "#E58AA9", weight: 1, fillColor: "#E58AA9", fillOpacity: 0.15, interactive: false }).addTo(mapa);
    else { circuloPrecision.setLatLng([lat, lng]); circuloPrecision.setRadius(precision); }
  } else if (circuloPrecision && mapa) { mapa.removeLayer(circuloPrecision); circuloPrecision = null; }
  if (primera && mapa && !usandoSimulacion) mapa.setView([lat, lng], 16);
  const yo = usuarioActual();
  yo.points = yo.points || [];
  yo.points.push({ lat, lng, t: fechaISO() });
  if (yo.points.length > 500) yo.points = yo.points.slice(-500);
  salvarDatos();
  publicarPosicion(yo.id, lat, lng);
}

// Publica la posición en el canal compartido para que otras pestañas
// del mismo navegador la vean al instante (modo LOCAL, sin servidor).
// Solo se comparte si el usuario decidió mostrar su ubicación.
function publicarPosicion(userId, lat, lng) {
  if (MODO_NUBE) return;
  const emisor = usuarioPorId(userId);
  if (!emisor || !emisor.shareLocation) return;
  if (!("localStorage" in window)) return;
  try {
    localStorage.setItem(CANAL_SYNC, JSON.stringify({ t: "pos", userId, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), ts: Date.now() }));
    localStorage.removeItem(CANAL_SYNC);
  } catch (e) { /* modo privado: sin sincronización */ }
}

// Publica un cambio de datos (grupos, miembros, etc.) entre pestañas.
function publicarCambioDatos() {
  if (MODO_NUBE) return;
  if (!("localStorage" in window)) return;
  try {
    localStorage.setItem(CANAL_SYNC, JSON.stringify({ t: "datos", ts: Date.now() }));
    localStorage.removeItem(CANAL_SYNC);
  } catch (e) { /* modo privado */ }
}

// Recibe los cambios de OTRAS pestañas del mismo navegador.
function escucharCambiosOtrasPestanas() {
  if (MODO_NUBE) return;
  if (!("localStorage" in window)) return;
  window.addEventListener("storage", (ev) => {
    if (ev.key !== CANAL_SYNC || !ev.newValue) return;
    let msg;
    try { msg = JSON.parse(ev.newValue); } catch (e) { return; }
    if (msg.t === "pos") {
      const yo = usuarioActual();
      if (!yo || msg.userId === yo.id) return;
      const emisor = usuarioPorId(msg.userId);
      if (!emisor || !emisor.shareLocation) return;
      if (miembrosDe(yo.id).some((m) => m.userId === msg.userId)) {
        vivo[msg.userId] = { lat: msg.lat, lng: msg.lng, lastAt: fechaISO() };
        if (marcadores[msg.userId]) marcadores[msg.userId].setLatLng([msg.lat, msg.lng]);
        else if (vistaActual === "mapa" && mapa) actualizarMarcadores();
        if (fichaAbiertaId === msg.userId) renderFicha();
      }
    } else if (msg.t === "datos") {
      const yo = usuarioActual();
      if (yo && vistaActual === "mapa" && mapa) actualizarMarcadores();
      if (vistaActual === "grupo") renderGrupos();
    }
  });
}

function detenerMiUbicacion() {
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  miPos = null; usandoSimulacion = false;
  if (marcadores["yo"]) { mapa.removeLayer(marcadores["yo"]); delete marcadores["yo"]; }
  if (circuloPrecision && mapa) { mapa.removeLayer(circuloPrecision); }
  circuloPrecision = null;
}

function crearMarca(userId, nombre, esYo) {
  const latlng = esYo
    ? [miPos.lat, miPos.lng]
    : [vivo[userId].lat, vivo[userId].lng];
  const icono = L.divIcon({
    className: "",
    html: `<div class="marca ${esYo ? "marca-mia" : "marca-miembro"}" style="background:${colorDe(userId)}">${iniciales(nombre)}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
  const m = L.marker(latlng, { icon: icono }).addTo(mapa);
  m.on("click", () => abrirFicha(userId));
  marcadores[userId] = m;
}

function posicionInicial() {
  return {
    lat: POSICION_BASE.lat + (Math.random() - 0.5) * 0.06,
    lng: POSICION_BASE.lng + (Math.random() - 0.5) * 0.06,
    lastAt: fechaISO()
  };
}

function actualizarMarcadores() {
  const yo = usuarioActual();
  if (!mapa || !yo) return;
  const idsValidos = miembrosDe(yo.id).map((m) => m.userId);
  idsValidos.push("yo");
  Object.keys(marcadores).forEach((k) => {
    if (!idsValidos.includes(k)) { mapa.removeLayer(marcadores[k]); delete marcadores[k]; }
  });
  miembrosDe(yo.id).forEach((mm) => {
    const u = usuarioPorId(mm.userId);
    if (!u || mm.userId === yo.id) return;
    if (!u.shareLocation) { if (marcadores[u.id]) { mapa.removeLayer(marcadores[u.id]); delete marcadores[u.id]; } return; }
    if (!vivo[u.id]) {
      if (MODO_NUBE) return;
      vivo[u.id] = posicionInicial();
    }
    if (!marcadores[u.id]) crearMarca(u.id, u.name, false);
    else marcadores[u.id].setLatLng([vivo[u.id].lat, vivo[u.id].lng]);
  });
  if (miPos) {
    if (!marcadores["yo"]) crearMarca("yo", yo.name, true);
    else marcadores["yo"].setLatLng([miPos.lat, miPos.lng]);
  }
  refrescarEstadoMarcadores();
}

const MS_SIN_SENAL = 10 * 60 * 1000;
function refrescarEstadoMarcadores() {
  Object.keys(marcadores).forEach((k) => {
    const el = marcadores[k].getElement && marcadores[k].getElement();
    const marca = el && el.querySelector(".marca");
    if (!marca || k === "yo") return;
    const p = vivo[k];
    const antigua = !p || (Date.now() - new Date(p.lastAt).getTime() > MS_SIN_SENAL);
    marca.classList.toggle("marca-antigua", antigua);
  });
}
setInterval(refrescarEstadoMarcadores, 30000);

function ajustarVista() {
  if (!mapa) return;
  const puntos = Object.values(marcadores).map((m) => m.getLatLng());
  if (!puntos.length) { mapa.setView([POSICION_BASE.lat, POSICION_BASE.lng], 13); return; }
  if (puntos.length === 1) { mapa.setView(puntos[0], 15); return; }
  mapa.fitBounds(L.latLngBounds(puntos), { padding: [50, 50] });
}

function centrarEn(lat, lng) {
  if (mapa) mapa.flyTo([lat, lng], 15);
}

function centrarEnMi() {
  if (!mapa) return;
  if (miPos) { centrarEn(miPos.lat, miPos.lng); return; }
  mapa.locate({ setView: true, maxZoom: 15 });
  mapa.once("locationerror", () => {
    mapa.setView([POSICION_BASE.lat, POSICION_BASE.lng], 13);
    mostrarToast("No se pudo obtener tu ubicación GPS.", "aviso");
  });
}

function iniciarReporteNube() {
  if (!MODO_NUBE) return;
  if (intervaloReporte) clearInterval(intervaloReporte);
  intervaloReporte = setInterval(() => {
    const yo = usuarioActual();
    if (yo && yo.shareLocation && miPos) {
      window.NUBE.reportarUbicacion(yo.id, miPos.lat, miPos.lng).catch(() => {});
    }
  }, INTERVALO_REPORTE_UBICACION);
}

// ============================ TIEMPO REAL (SUPABASE) ============================

function manejarCambioEnVivo(ev) {
  const yo = usuarioActual();
  if (!yo) return;
  if (ev.tipo === "ubicacion") {
    const d = ev.dato;
    if (!d || d.usuario_id === yo.id) return;
    if (miembrosDe(yo.id).some((m) => m.userId === d.usuario_id)) {
      vivo[d.usuario_id] = { lat: d.lat, lng: d.lng, lastAt: d.updated_at || fechaISO() };
      if (vistaActual === "mapa" && mapa) actualizarMarcadores();
      if (fichaAbiertaId === d.usuario_id) renderFicha();
    }
  } else if (ev.tipo === "sos") {
    const a = ev.dato;
    if (!a) return;
    if (esDeMiGrupo({ groupId: a.grupo_id })) {
      agregarAlertaUnica({
        id: a.id, groupId: a.grupo_id, senderId: a.emisor_id, message: a.mensaje,
        lat: a.lat, lng: a.lng, status: a.estado, sentAt: a.creada_en, resolvedAt: a.resuelta_en
      });
      salvarDatos();
      const emisor = usuarioPorId(a.emisor_id);
      mostrarToast("SOS de " + (emisor ? emisor.name : "un miembro"), "error");
      if (vistaActual === "alertas") renderAlertas();
      actualizarBadge();
    }
  } else if (ev.tipo === "notificacion") {
    const n = ev.dato;
    if (n && n.usuario_id === yo.id) {
      agregarNotifUnica({
        id: n.id, userId: n.usuario_id, type: n.tipo, title: n.titulo,
        body: n.cuerpo, read: !!n.leida, createdAt: n.created_at
      });
      salvarDatos();
      if (vistaActual === "alertas") renderAlertas();
      actualizarBadge();
    }
  } else if (ev.tipo === "miembro") {
    sincronizarNube();
  }
}

async function sincronizarNube() {
  if (!MODO_NUBE) return;
  try {
    const t = await window.NUBE.cargarTodo();
    const yo = usuarioActual();
    if (!yo) return;
    const previos = datos.users;
    datos.users = t.perfiles.map((p) => {
      const antes = previos.find((x) => x.id === p.id);
      return {
        id: p.id, name: p.nombre || "Usuario", email: p.id === yo.id ? yo.email : "",
        phone: p.telefono || "", shareLocation: p.id === yo.id ? yo.shareLocation : !!p.share_ubicacion,
        createdAt: p.created_at, points: antes ? antes.points : []
      };
    });
    t.ubicaciones.forEach((u) => {
      if (u.usuario_id === yo.id) return;
      vivo[u.usuario_id] = { lat: u.lat, lng: u.lng, lastAt: u.updated_at || fechaISO() };
    });
    datos.groups = t.grupos.map((g) => ({
      id: g.id, name: g.nombre, description: g.descripcion, code: g.codigo,
      ownerId: g.propietario_id, createdAt: g.created_at,
      members: t.miembros.filter((m) => m.grupo_id === g.id).map((m) => ({ userId: m.usuario_id, role: m.rol }))
    }));
    datos.places = t.lugares.map((p) => ({
      id: p.id, userId: p.usuario_id, name: p.nombre, category: p.categoria,
      address: p.direccion, lat: p.lat, lng: p.lng, createdAt: p.created_at
    }));
    datos.alerts = t.alertas.map((a) => ({
      id: a.id, groupId: a.grupo_id, senderId: a.emisor_id, message: a.mensaje,
      lat: a.lat, lng: a.lng, status: a.estado, sentAt: a.creada_en, resolvedAt: a.resuelta_en
    }));
    datos.notifications = t.notificaciones
      .filter((n) => n.usuario_id === yo.id)
      .map((n) => ({
        id: n.id, userId: n.usuario_id, type: n.tipo, title: n.titulo,
        body: n.cuerpo, read: !!n.leida, createdAt: n.created_at
      }));
    salvarDatos();
    if (vistaActual === "mapa") actualizarMarcadores();
    if (vistaActual === "grupo") grupoDetalleId ? verDetalleGrupo(grupoDetalleId) : renderGrupos();
    if (vistaActual === "lugares") renderLugares();
    if (vistaActual === "alertas") renderAlertas();
    if (vistaActual === "perfil") renderPerfil();
    actualizarBadge();
  } catch (e) { /* silencioso */ }
}

// ============================ FICHA DE MIEMBRO ============================

function abrirFicha(userId) {
  fichaAbiertaId = userId;
  renderFicha();
}

function renderFicha() {
  const el = $("#fichaMiembro");
  const yo = usuarioActual();
  const esYo = fichaAbiertaId === "yo" || fichaAbiertaId === yo.id;
  const u = esYo ? yo : usuarioPorId(fichaAbiertaId);
  if (!u) { el.classList.add("oculta"); return; }
  const pos = esYo ? (miPos || vivo[yo.id]) : vivo[u.id];
  const lat = pos ? pos.lat : POSICION_BASE.lat;
  const lng = pos ? pos.lng : POSICION_BASE.lng;
  const estado = pos ? ("Visto " + fmtAgo(pos.lastAt || u.createdAt) + " · " + lat.toFixed(5) + ", " + lng.toFixed(5)) : "No comparte ubicación";
  el.innerHTML = `
    <div class="tarjeta-fila">
      <div class="avatar-miembro" style="background:${colorDe(u.id)}">${iniciales(u.name)}</div>
      <div style="flex:1">
        <strong>${esc(u.name)}</strong>
        <div class="texto-suave">${estado}</div>
      </div>
      <button class="btn-conexo" onclick="cerrarFicha()">✕</button>
    </div>
    <div class="fila-acciones">
      <button class="btn btn-primario" onclick="centrarEn(${lat}, ${lng})">Centrar</button>
      <button class="btn btn-waze" onclick="abrirWaze(${lat}, ${lng})">Navegar con Waze</button>
    </div>`;
  el.classList.remove("oculta");
}

function renderFichaSiAbierta() {
  if (fichaAbiertaId && !$("#fichaMiembro").classList.contains("oculta")) renderFicha();
}

function cerrarFicha() {
  $("#fichaMiembro").classList.add("oculta");
  fichaAbiertaId = null;
}

function abrirWaze(lat, lng, direccion) {
  const params = new URLSearchParams({ ll: `${lat},${lng}`, navigate: "yes", utm_source: "nexo" });
  if (direccion) params.set("q", direccion);
  const url = `https://www.waze.com/ul?${params}`;
  window.open(url, "_blank");
}

function mostrarWazeEmbed(lat, lng, nombre) {
  const embedUrl = `https://embed.waze.com/iframe?zoom=15&lat=${lat}&lon=${lng}&pin=1`;
  const wazeUrl = `https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes&utm_source=nexo`;
  abrirModal(`
    <h2>${esc(nombre)}</h2>
    <div class="waze-embed">
      <iframe src="${embedUrl}" title="Ubicación en Waze" loading="lazy"></iframe>
    </div>
    <div class="fila-acciones">
      <a class="btn btn-waze btn-block" href="${wazeUrl}" target="_blank" rel="noopener">Abrir en Waze</a>
    </div>
  `);
}

// ============================ ALERTA SOS ============================

function abrirModalSos() {
  const yo = usuarioActual();
  const grupos = gruposDe(yo.id);
  const opciones = grupos.length
    ? grupos.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")
    : `<option value="">(sin grupos)</option>`;
  abrirModal(`
    <h2>Enviar alerta SOS</h2>
    <label>Grupo</label>
    <select id="sosGrupo">${opciones}</select>
    <label>Mensaje (opcional)</label>
    <input id="sosMensaje" placeholder="Necesito ayuda">
    <div class="texto-suave" style="margin-top:10px">Tu círculo recibirá tu posición actual y podrá llegar a ti.</div>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cancelar</button>
      <button class="btn btn-peligro" onclick="enviarSos()">Enviar SOS</button>
    </div>`);
}

function enviarSos() {
  const gid = $("#sosGrupo").value;
  if (!gid || !grupoPorId(gid)) { mostrarToast("Primero crea o únete a un grupo.", "aviso"); return; }
  const yo = usuarioActual();
  const pos = miPos || vivo[yo.id] || null;
  const lat = pos ? pos.lat : POSICION_BASE.lat;
  const lng = pos ? pos.lng : POSICION_BASE.lng;
  const alerta = {
    id: nuevoId(), groupId: gid, senderId: yo.id,
    message: $("#sosMensaje").value.trim() || "Necesito ayuda",
    lat, lng, status: "ACTIVE", sentAt: fechaISO()
  };
  agregarAlertaUnica(alerta);
  const otros = miembrosDelGrupo(gid).filter((m) => m.userId !== yo.id);
  if (MODO_NUBE) {
    window.NUBE.insert("alertas", {
      id: alerta.id, grupo_id: gid, emisor_id: yo.id, mensaje: alerta.message,
      lat, lng, estado: "ACTIVE"
    }).catch((e) => mostrarToast(e.message, "error"));
    otros.forEach((mm) => {
      window.NUBE.insert("notificaciones", {
        usuario_id: mm.userId, tipo: "SOS", titulo: "SOS de " + yo.name, cuerpo: alerta.message
      }).catch(() => {});
    });
  } else {
    otros.forEach((mm) => {
      datos.notifications.push({
        id: nuevoId(), userId: mm.userId, type: "SOS", title: "SOS de " + yo.name,
        body: alerta.message, read: false, createdAt: fechaISO()
      });
    });
  }
  salvarDatos();
  cerrarModal();
  actualizarBadge();
  mostrarToast("SOS enviado a tu círculo.", "exito");
}

function resolverSos(id) {
  const a = datos.alerts.find((x) => x.id === id);
  if (!a) return;
  a.status = "RESOLVED";
  a.resolvedAt = fechaISO();
  if (MODO_NUBE) {
    window.NUBE.actualizar("alertas", { estado: "RESOLVED", resuelta_en: a.resolvedAt }, "id", id).catch((e) => mostrarToast(e.message, "error"));
  }
  salvarDatos();
  renderAlertas();
  actualizarBadge();
  mostrarToast("SOS marcado como resuelto.", "exito");
}

// ============================ GRUPOS ============================

function renderGrupos() {
  const yo = usuarioActual();
  const grupos = gruposDe(yo.id);
  let html = `
    <div class="titulo-panel">Mis grupos</div>
    <div class="subtitulo-panel">Crea un círculo o únete con un código.</div>
    <div class="fila-acciones">
      <button class="btn btn-primario" onclick="abrirModalCrearGrupo()">+ Crear grupo</button>
      <button class="btn btn-secundario" onclick="abrirModalUnirse()">Unirme con código</button>
    </div>`;
  if (!grupos.length) html += `<div class="contenedor-vacio"><span class="icono">👥</span>Aún no formas parte de ningún grupo.</div>`;
  grupos.forEach((g) => {
    html += `
      <div class="tarjeta">
        <div class="tarjeta-fila">
          <div class="avatar-miembro" style="background:${colorDe(g.ownerId)}">${iniciales(g.name)}</div>
          <div style="flex:1">
            <strong>${esc(g.name)}</strong>
            <div class="texto-suave">${g.members.length} miembros · código ${esc(g.code)}</div>
          </div>
          <span class="chip">${ROL_LABEL[rolEnGrupo(g.id, yo.id)]}</span>
        </div>
        <div class="fila-acciones">
          <button class="btn btn-conexo" onclick="verDetalleGrupo('${g.id}')">Ver círculo</button>
        </div>
      </div>`;
  });
  $("#contenidoGrupo").innerHTML = html;
}

function abrirModalCrearGrupo() {
  abrirModal(`
    <h2>Crear grupo</h2>
    <label>Nombre</label>
    <input id="nuevoGrupoNombre" placeholder="Familia">
    <label>Descripción</label>
    <input id="nuevoGrupoDesc" placeholder="Nuestro círculo seguro">
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cancelar</button>
      <button class="btn btn-primario" onclick="crearGrupo()">Crear</button>
    </div>`);
}

async function crearGrupo() {
  const nombre = $("#nuevoGrupoNombre").value.trim();
  if (!nombre) { mostrarToast("Escribe un nombre para el grupo.", "aviso"); return; }
  const yo = usuarioActual();
  const nuevo = {
    id: nuevoId(), name: nombre, description: $("#nuevoGrupoDesc").value.trim(),
    code: generarCodigo(), ownerId: yo.id, createdAt: fechaISO(),
    members: [{ userId: yo.id, role: "OWNER" }]
  };
  if (MODO_NUBE) {
    try {
      // Primero el grupo y DESPUÉS el miembro (el miembro depende del grupo).
      await window.NUBE.insert("grupos", {
        id: nuevo.id, nombre, descripcion: nuevo.description, codigo: nuevo.code, propietario_id: yo.id
      });
      await window.NUBE.insert("miembros", { grupo_id: nuevo.id, usuario_id: yo.id, rol: "OWNER" });
    } catch (e) {
      mostrarToast("No se pudo guardar el grupo en la nube: " + e.message, "error");
      return;
    }
  }
  datos.groups.push(nuevo);
  salvarDatos();
  cerrarModal();
  mostrarToast("Grupo creado. Código: " + nuevo.code, "exito");
  actualizarMarcadores();
  if (vistaActual === "grupo") renderGrupos();
}

function abrirModalUnirse(codigoPrefill) {
  abrirModal(`
    <h2>Unirme a un grupo</h2>
    <label>Código de invitación</label>
    <input id="codigoUnirse" value="${esc(codigoPrefill || "")}" placeholder="NEXO1234" style="text-transform:uppercase">
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cancelar</button>
      <button class="btn btn-primario" onclick="unirseGrupo()">Unirme</button>
    </div>`);
}

function leerCodigoInvitacion() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("unirse") || "").replace(/\s+/g, "").toUpperCase();
    return code || null;
  } catch (e) { return null; }
}

function leerGrupoInvitacion() {
  try {
    const params = new URLSearchParams(window.location.search);
    const payload = params.get("ingresar");
    if (!payload) return null;
    return decodificarGrupo(String(payload).trim());
  } catch (e) { return null; }
}

function hayParametroInvitacion() {
  try {
    const params = new URLSearchParams(window.location.search);
    return !!params.get("ingresar") || !!params.get("unirse");
  } catch (e) { return false; }
}

function limpiarParametroInvitacion() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("ingresar");
    url.searchParams.delete("unirse");
    window.history.replaceState({}, "", url.toString());
  } catch (e) { /* no crítico */ }
}

function busquedaLocalDeGrupo(codigo) {
  return datos.groups.find((g) => String(g.code).toUpperCase() === codigo) || null;
}

let errorBusquedaNube = "";

function mensajeCodigoInvalido() {
  if (!MODO_NUBE) return "Ese código no existe en este navegador. Estás en modo local: los círculos solo viven en el dispositivo donde se crearon. Configura Supabase para unirte desde otros dispositivos.";
  if (errorBusquedaNube) return "No se pudo consultar el código: " + errorBusquedaNube;
  return "El código no existe. Revisa que esté bien escrito (sin espacios) o pide uno nuevo.";
}

async function buscarGrupoEnNube(codigo) {
  errorBusquedaNube = "";
  if (!MODO_NUBE) return null;
  try {
    const g = await window.NUBE.buscarGrupoPorCodigo(codigo);
    if (!g) return null;
    const miembros = await window.NUBE.buscarMiembrosDe(g.id);
    const local = {
      id: g.id, name: g.nombre, description: g.descripcion, code: g.codigo,
      ownerId: g.propietario_id, createdAt: g.created_at,
      members: miembros.map((m) => ({ userId: m.usuario_id, role: m.rol }))
    };
    if (!datos.groups.some((x) => x.id === local.id)) datos.groups.push(local);
    return local;
  } catch (e) {
    errorBusquedaNube = e.message || "error de red";
    return null;
  }
}

async function resolverGrupoPorCodigo(codigo) {
  const local = busquedaLocalDeGrupo(codigo);
  if (local) return local;
  return await buscarGrupoEnNube(codigo);
}

async function procesarInvitacionEnlace() {
  const yo = usuarioActual();
  if (!yo) return;

  // 1) Invitación con grupo completo embebido (QR/WhatsApp local)
  // (Solo en modo local. En la nube el grupo real vive en Supabase y se une por código.)
  const gInv = leerGrupoInvitacion();
  if (gInv && !MODO_NUBE) {
    await entrarAGrupoEmbebido(gInv, yo);
    limpiarParametroInvitacion();
    return;
  }

  // 2) Invitación por código (también vale un enlace viejo con el grupo embebido)
  const code = leerCodigoInvitacion() || (gInv ? String(gInv.code).replace(/\s+/g, "").toUpperCase() : null);
  if (!code) { limpiarParametroInvitacion(); return; }
  const grupo = await resolverGrupoPorCodigo(code);
  if (!grupo) {
    mostrarToast(mensajeCodigoInvalido(), "error");
    limpiarParametroInvitacion();
    return;
  }
  if (grupo.members.some((m) => m.userId === yo.id)) {
    mostrarToast("Ya formás parte de " + grupo.name + ".", "exito");
    limpiarParametroInvitacion();
    return;
  }
  await unirseGrupoConCodigo(code);
  limpiarParametroInvitacion();
}

// Recrea (si falta) el grupo que viene embebido en el enlace y une al usuario.
// Registra en `datos.users` los perfiles que vienen embebidos en la
// invitación para que los miembros del grupo se muestren con su nombre.
function registrarPerfilesEmbebidos(gInv) {
  if (!gInv.perfiles) return;
  Object.keys(gInv.perfiles).forEach((pid) => {
    if (pid === (usuarioActual() || {}).id) return;
    if (datos.users.some((u) => u.id === pid)) return;
    const p = gInv.perfiles[pid];
    datos.users.push({
      id: pid, name: p.n || "Miembro", email: "", password: "",
      phone: p.t || "", shareLocation: !!p.c, createdAt: fechaISO(), points: []
    });
  });
}

async function entrarAGrupoEmbebido(gInv, yo) {
  // Ya existe un grupo local con ese mismo código → unirse a él
  const existente = datos.groups.find((x) => x.code.toUpperCase() === gInv.code.toUpperCase());
  if (existente) {
    registrarPerfilesEmbebidos(gInv);
    if (!existente.members.some((m) => m.userId === yo.id)) {
      existente.members.push({ userId: yo.id, role: "MEMBER" });
      salvarDatos();
      finalizarUnion(existente);
    } else {
      mostrarToast("Ya formás parte de " + existente.name + ".", "exito");
    }
    return;
  }

  // El grupo no existe en este dispositivo → recrearlo con todos sus miembros
  registrarPerfilesEmbebidos(gInv);
  gInv.id = nuevoId();
  gInv.createdAt = fechaISO();
  if (!gInv.members.some((m) => m.userId === yo.id)) {
    gInv.members.push({ userId: yo.id, role: "MEMBER" });
  }
  datos.groups.push(gInv);
  delete gInv.perfiles;
  salvarDatos();
  finalizarUnion(gInv);
}

async function unirseGrupoConCodigo(codigo) {
  const grupo = await resolverGrupoPorCodigo(codigo);
  if (!grupo) {
    mostrarToast(mensajeCodigoInvalido(), "error");
    return;
  }
  const yo = usuarioActual();
  if (MODO_NUBE) {
    try {
      await window.NUBE.insert("miembros", { grupo_id: grupo.id, usuario_id: yo.id, rol: "MEMBER" });
    } catch (e) {
      mostrarToast("No se pudo unir al grupo: " + (e.message || "error"), "error");
      return;
    }
    if (!grupo.members.some((m) => m.userId === yo.id)) grupo.members.push({ userId: yo.id, role: "MEMBER" });
    await sincronizarNube();                       // trae miembros y perfiles reales del círculo
    finalizarUnion(grupoPorId(grupo.id) || grupo);
    window.NUBE.insert("notificaciones", {
      usuario_id: grupo.ownerId, tipo: "GRUPO", titulo: "Nuevo miembro", cuerpo: yo.name + " se unió a " + grupo.name
    }).catch(() => {});
  } else {
    if (!grupo.members.some((m) => m.userId === yo.id)) grupo.members.push({ userId: yo.id, role: "MEMBER" });
    datos.notifications.push({
      id: nuevoId(), userId: grupo.ownerId, type: "GRUPO", title: "Nuevo miembro",
      body: yo.name + " se unió a " + grupo.name, read: false, createdAt: fechaISO()
    });
    salvarDatos();
    finalizarUnion(grupo);
  }
}

function finalizarUnion(grupo) {
  actualizarMarcadores();
  if (vistaActual === "grupo") renderGrupos();
  mostrarToast("¡Bienvenido a " + grupo.name + "!", "exito");
  publicarCambioDatos();
}

function unirseGrupo() {
  const codigo = $("#codigoUnirse").value.replace(/\s+/g, "").toUpperCase();
  if (!codigo) { mostrarToast("Ingresá el código de invitación.", "aviso"); return; }
  const yo = usuarioActual();
  if (!yo) return;
  const yaPertenece = datos.groups.some((g) => g.code.toUpperCase() === codigo && g.members.some((m) => m.userId === yo.id));
  if (yaPertenece) { mostrarToast("Ya formas parte de un grupo con ese código.", "aviso"); cerrarModal(); return; }
  cerrarModal();
  unirseGrupoConCodigo(codigo);
}

function verDetalleGrupo(gid) {
  grupoDetalleId = gid;
  const g = grupoPorId(gid);
  if (!g) return;
  const yo = usuarioActual();
  const miRol = rolEnGrupo(gid, yo.id);
  let html = `
    <button class="btn btn-conexo" onclick="grupoDetalleId=null; mostrarVista('grupo')">← Volver</button>
    <div class="tarjeta" style="margin-top:12px">
      <div class="tarjeta-fila">
        <div class="avatar-miembro" style="background:${colorDe(g.ownerId)}">${iniciales(g.name)}</div>
        <div style="flex:1">
          <strong>${esc(g.name)}</strong>
          <div class="texto-suave">${esc(g.description || "Sin descripción")}</div>
        </div>
        <span class="chip">${ROL_LABEL[miRol]}</span>
      </div>
      <div style="margin-top:14px; text-align:center">
        <div class="tarjeta-invitacion">
          <div class="texto-suave">Código de invitación</div>
          <div class="codigo-grande">${esc(g.code)}</div>
          <div class="fila-acciones">
            <button class="btn btn-whatsapp" onclick="compartirWhatsApp(grupoPorId(grupoDetalleId))">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.5 7.5 0 0 1-1.4-1.7c-.1-.2 0-.4.1-.5l.4-.5a2 2 0 0 0 .3-.4c0-.2 0-.3 0-.4s-.6-1.5-.8-2-.4-.5-.6-.5h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4 5.1 5.1 0 0 0 3 .8 2 2 0 0 0 1.4-.7 1.4 1.4 0 0 0 .3-.9v-.5z"/></svg>
              Invitar por WhatsApp
            </button>
            <button class="btn btn-secundario" onclick="mostrarQrInvitacion(grupoPorId(grupoDetalleId))">Código QR</button>
            <button class="btn btn-secundario" onclick="copiarEnlaceInvitacion(grupoPorId(grupoDetalleId))">Copiar enlace</button>
          </div>
          <div class="texto-suave" style="font-size:12px;margin-top:8px">
            Compartí el enlace por WhatsApp. Quien lo abra entrará a tu grupo con este código.
          </div>
        </div>
        <div class="fila-acciones">
          ${miRol !== "MEMBER" ? `<button class="btn btn-primario" onclick="abrirModalAgregarIntegrante('${g.id}')">+ Agregar integrante</button>` : ""}
          ${miRol === "OWNER" ? `<button class="btn btn-conexo" onclick="regenerarCodigo()">Nuevo código</button>` : ""}
        </div>
      </div>
    </div>
    <div class="titulo-panel" style="font-size:17px">Miembros (${g.members.length})</div>`;
  g.members.forEach((mm) => {
    const u = usuarioPorId(mm.userId);
    const visible = u && u.shareLocation;
    html += `
      <div class="tarjeta tarjeta-fila">
        <div class="avatar-miembro" style="background:${colorDe(mm.userId)}">${iniciales(u ? u.name : "?")}</div>
        <div style="flex:1">
          <strong>${esc(u ? u.name : "Desconocido")}</strong>
          <div class="texto-suave ${visible ? "texto-exito" : ""}">${visible ? "Compartiendo ubicación" : "Ubicación oculta"}</div>
        </div>
        <span class="chip ${visible ? "chip-exito" : "chip-oscuro"}">${visible ? "EN LÍNEA" : "OCULTO"}</span>
        ${miRol !== "MEMBER" && mm.userId !== yo.id && mm.role !== "OWNER"
          ? `<button class="btn btn-peligro" onclick="quitarMiembro('${mm.userId}')">Quitar</button>` : ""}
      </div>`;
  });
  html += `
    <div class="fila-acciones">
      ${miRol === "OWNER"
        ? `<button class="btn btn-peligro" onclick="eliminarGrupoConfirm()">Eliminar grupo</button>`
        : `<button class="btn btn-peligro" onclick="salirGrupoConfirm()">Salir del grupo</button>`}
    </div>`;
  $("#contenidoGrupo").innerHTML = html;
}

function copiarCodigo(codigo) {
  if (navigator.clipboard) { navigator.clipboard.writeText(codigo); mostrarToast("Código copiado.", "exito"); }
  else mostrarToast(codigo, "aviso");
}

function urlBaseApp() {
  const href = window.location.href;
  try {
    const u = new URL(href);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch (e) {
    return href.split("?")[0];
  }
}

function codificarGrupo(g) {
  const perfiles = {};
  g.members.forEach((m) => {
    const u = usuarioPorId(m.userId);
    if (u) perfiles[m.userId] = { n: u.name, t: u.phone || "", c: !!u.shareLocation };
  });
  const datosGrp = {
    v: 1,
    nombre: g.name,
    desc: g.description || "",
    code: g.code,
    owner: g.ownerId,
    members: g.members.map((m) => ({ id: m.userId, rol: m.role })),
    perfiles: perfiles
  };
  const texto = JSON.stringify(datosGrp);
  try {
    return btoa(unescape(encodeURIComponent(texto))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (e) {
    return encodeURIComponent(texto);
  }
}

function decodificarGrupo(payload) {
  try {
    let texto;
    if (payload.indexOf("%") !== -1) {
      texto = decodeURIComponent(payload);
    } else {
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      texto = decodeURIComponent(escape(atob(b64)));
    }
    const d = JSON.parse(texto);
    if (!d || !d.code || !d.nombre || !d.owner) return null;
    return {
      id: null, name: d.nombre, description: d.desc || "", code: d.code, ownerId: d.owner,
      createdAt: fechaISO(),
      members: (d.members || []).map((m) => ({ userId: m.id, role: m.rol })),
      perfiles: d.perfiles || null
    };
  } catch (e) {
    return null;
  }
}

function enlaceInvitacion(g) {
  const base = urlBaseApp();
  // Nube: solo el código (el círculo real está en Supabase).
  // Local: el grupo viaja dentro del enlace porque no hay servidor.
  if (MODO_NUBE) return base + "?unirse=" + encodeURIComponent(g.code);
  return base + "?ingresar=" + codificarGrupo(g);
}

function mensajeWhatsApp(g) {
  const url = enlaceInvitacion(g);
  return "Hola! Te invito a mi grupo " + g.name + " en NEXO para empezar a compartir la ubicación y estar más seguros. Abrí este enlace:\n" + url;
}

function compartirWhatsApp(g) {
  const texto = encodeURIComponent(mensajeWhatsApp(g));
  const esMovil = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const url = esMovil ? "https://wa.me/?text=" + texto : "https://api.whatsapp.com/send?text=" + texto;
  window.open(url, "_blank");
}

function copiarEnlaceInvitacion(g) {
  const enlace = enlaceInvitacion(g);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(enlace).then(() => mostrarToast("Enlace de invitación copiado.", "exito"));
  } else {
    window.prompt("Copiá este enlace de invitación:", enlace);
  }
}

function mostrarQrInvitacion(g) {
  const enlace = enlaceInvitacion(g);
  abrirModal(`
    <h2>Escaneá para unirte</h2>
    <div class="texto-suave" style="margin-bottom:12px">Apuntá la cámara al código QR para abrir la invitación a <strong>${esc(g.name)}</strong>.</div>
    <div class="qr-contenedor" id="qrHost" style="text-align:center;background:#fff;padding:14px;border-radius:var(--radio-m);display:inline-block"></div>
    <div class="qr-enlace">
      <span class="codigo-grande">${esc(g.code)}</span>
      <div class="texto-suave" style="font-size:12px;margin-bottom:10px">O ingresá este código manualmente.</div>
    </div>
    <div class="fila-acciones">
      <button class="btn btn-whatsapp" onclick="compartirWhatsApp(grupoPorId(grupoDetalleId))" style="flex:1">Enviar por WhatsApp</button>
      <button class="btn btn-conexo" onclick="cerrarModal()">Cerrar</button>
    </div>`);

  const host = $("#qrHost");
  function pintarLibreria() {
    if (typeof QRCode === "function") {
      new QRCode(host, { text: enlace, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.H });
      return true;
    }
    return false;
  }
  if (!pintarLibreria()) {
    // Respaldo: API pública de generación de QR (sin clave)
    const img = document.createElement("img");
    img.src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(enlace);
    img.alt = "QR de invitación";
    img.style.width = "220px";
    img.style.height = "220px";
    img.style.borderRadius = "8px";
    host.appendChild(img);
  }
}

function regenerarCodigo() {
  const g = grupoPorId(grupoDetalleId);
  if (!g) return;
  g.code = generarCodigo();
  if (MODO_NUBE) window.NUBE.actualizar("grupos", { codigo: g.code }, "id", g.id).catch((e) => mostrarToast(e.message, "error"));
  salvarDatos();
  verDetalleGrupo(g.id);
  mostrarToast("Nuevo código generado.", "exito");
}

function quitarMiembro(userId) {
  const g = grupoPorId(grupoDetalleId);
  if (!g) return;
  g.members = g.members.filter((m) => m.userId !== userId);
  if (MODO_NUBE) window.NUBE.remove("miembros", { grupo_id: g.id, usuario_id: userId }).catch((e) => mostrarToast(e.message, "error"));
  salvarDatos();
  verDetalleGrupo(g.id);
  mostrarToast("Miembro retirado del círculo.", "exito");
}

function salirGrupoConfirm() {
  if (!confirm("¿Salir de este grupo?")) return;
  const g = grupoPorId(grupoDetalleId);
  const yo = usuarioActual();
  if (g) {
    g.members = g.members.filter((m) => m.userId !== yo.id);
    if (MODO_NUBE) window.NUBE.remove("miembros", { grupo_id: g.id, usuario_id: yo.id }).catch((e) => mostrarToast(e.message, "error"));
  }
  salvarDatos();
  grupoDetalleId = null;
  renderGrupos();
  actualizarMarcadores();
  mostrarToast("Has salido del grupo.", "aviso");
}

function eliminarGrupoConfirm() {
  if (!confirm("¿Eliminar el grupo y su historial?")) return;
  datos.groups = datos.groups.filter((g) => g.id !== grupoDetalleId);
  datos.alerts = datos.alerts.filter((a) => a.groupId !== grupoDetalleId);
  if (MODO_NUBE) window.NUBE.borrar("grupos", "id", grupoDetalleId).catch((e) => mostrarToast(e.message, "error"));
  salvarDatos();
  grupoDetalleId = null;
  renderGrupos();
  actualizarMarcadores();
  mostrarToast("Grupo eliminado.", "aviso");
}

// ============================ LUGARES ============================

const CATEGORIAS = ["Casa", "Trabajo", "Escuela", "Gimnasio", "Otro"];

function renderLugares() {
  const yo = usuarioActual();
  const lugares = datos.places.filter((p) => p.userId === yo.id);
  let html = `
    <div class="titulo-panel">Mis lugares</div>
    <div class="subtitulo-panel">Lugares importantes para tu círculo.</div>
    <button class="btn btn-primario btn-block" onclick="abrirModalLugar()">+ Agregar lugar</button>`;
  if (!lugares.length) html += `<div class="contenedor-vacio"><span class="icono">📍</span>Aún no tienes lugares guardados.</div>`;
  lugares.forEach((p) => {
    html += `
      <div class="tarjeta">
        <div class="tarjeta-fila">
          <div class="avatar-miembro">${esc(p.category[0])}</div>
          <div style="flex:1">
            <strong>${esc(p.name)}</strong>
            <div class="texto-suave">${esc(p.address || p.category)}</div>
            <div class="texto-suave">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
          </div>
          <span class="chip">${esc(p.category)}</span>
        </div>
        <div class="fila-acciones">
          <button class="btn btn-waze" onclick="abrirWaze(${p.lat}, ${p.lng}, '${esc(p.address || "").replace(/'/g, "\\'")}')">Navegar con Waze</button>
          <button class="btn btn-peligro" onclick="eliminarLugar('${p.id}')">Eliminar</button>
        </div>
      </div>`;
  });
  $("#contenidoLugares").innerHTML = html;
}

function abrirModalLugar() {
  const base = miPos || { lat: POSICION_BASE.lat, lng: POSICION_BASE.lng };
  abrirModal(`
    <h2>Agregar lugar</h2>
    <label>Nombre</label>
    <input id="lugNombre" placeholder="Casa de la abuela">
    <label>Categoría</label>
    <select id="lugCategoria">${CATEGORIAS.map((c) => `<option>${c}</option>`).join("")}</select>
    <label>Dirección (opcional)</label>
    <input id="lugDireccion" placeholder="Calle y número">
    <label>Ubicación en el mapa</label>
    <div id="miniMapa" class="mini-mapa"></div>
    <div class="texto-suave" style="margin-top:6px" id="lugCoord"></div>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="usarMiUbicacionLugar()">Usar mi ubicación</button>
    </div>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cancelar</button>
      <button class="btn btn-primario" onclick="guardarLugar()">Guardar</button>
    </div>`);
  setTimeout(() => iniciarMapaPicker(base.lat, base.lng), 60);
}

function iniciarMapaPicker(lat, lng) {
  if (typeof L === "undefined") return;
  mapaPicker = L.map("miniMapa").setView([lat, lng], 15);
  L.tileLayer(URL_MAPA, { maxZoom: 18 }).addTo(mapaPicker);
  pickerMarker = L.marker([lat, lng]).addTo(mapaPicker);
  mapaPicker.on("click", (e) => {
    pickerMarker.setLatLng(e.latlng);
    actualizarCoordPicker(e.latlng.lat, e.latlng.lng);
  });
  actualizarCoordPicker(lat, lng);
}

function actualizarCoordPicker(lat, lng) {
  const el = $("#lugCoord");
  if (el) el.textContent = "Lat " + lat.toFixed(5) + " · Lng " + lng.toFixed(5);
}

function usarMiUbicacionLugar() {
  const base = miPos || { lat: POSICION_BASE.lat, lng: POSICION_BASE.lng };
  if (pickerMarker) pickerMarker.setLatLng([base.lat, base.lng]);
  actualizarCoordPicker(base.lat, base.lng);
}

function guardarLugar() {
  const nombre = $("#lugNombre").value.trim();
  if (!nombre) { mostrarToast("Escribe el nombre del lugar.", "aviso"); return; }
  let lat, lng;
  if (pickerMarker) { const ll = pickerMarker.getLatLng(); lat = ll.lat; lng = ll.lng; }
  else { const base = miPos || POSICION_BASE; lat = base.lat; lng = base.lng; }
  const yo = usuarioActual();
  const lugar = {
    id: nuevoId(), userId: yo.id, name: nombre, category: $("#lugCategoria").value,
    address: $("#lugDireccion").value.trim(), lat, lng, createdAt: fechaISO()
  };
  if (MODO_NUBE) {
    window.NUBE.insert("lugares", {
      id: lugar.id, usuario_id: yo.id, nombre, categoria: lugar.category,
      direccion: lugar.address, lat, lng
    }).catch((e) => mostrarToast(e.message, "error"));
  }
  datos.places.push(lugar);
  salvarDatos();
  cerrarModal();
  renderLugares();
  mostrarToast("Lugar guardado.", "exito");
}

function eliminarLugar(id) {
  if (!confirm("¿Eliminar este lugar?")) return;
  datos.places = datos.places.filter((p) => p.id !== id);
  if (MODO_NUBE) window.NUBE.borrar("lugares", "id", id).catch((e) => mostrarToast(e.message, "error"));
  salvarDatos();
  renderLugares();
  mostrarToast("Lugar eliminado.", "exito");
}

// ============================ ALERTAS ============================

function renderAlertas() {
  const yo = usuarioActual();
  const sos = datos.alerts.filter((a) => esDeMiGrupo(a));
  const pendientes = sos.filter((a) => a.status === "ACTIVE");
  const historial = sos.filter((a) => a.status !== "ACTIVE");
  const notifs = datos.notifications
    .filter((n) => n.userId === yo.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  let html = `
    <div class="titulo-panel">Alertas</div>
    <div class="subtitulo-panel">SOS activos y notificaciones de tu círculo.</div>
    <div class="seccion-alertas"><h3>🚨 SOS activos</h3>`;
  if (!pendientes.length) html += `<div class="tarjeta texto-suave">No hay alertas SOS activas. Todo en calma.</div>`;
  pendientes.forEach((a) => {
    const emisor = usuarioPorId(a.senderId);
    const grupo = grupoPorId(a.groupId);
    html += `
      <div class="tarjeta" style="border-color:var(--sos)">
        <div class="tarjeta-fila">
          <div class="avatar-miembro" style="background:linear-gradient(135deg,#FF8A8A,#FF4040)">SOS</div>
          <div style="flex:1">
            <strong>${esc(emisor ? emisor.name : "Miembro")}</strong>
            <div class="texto-suave">${esc(a.message)}</div>
            <div class="texto-suave">${grupo ? esc(grupo.name) : ""} · ${fmtAgo(a.sentAt)}</div>
          </div>
        </div>
        <div class="fila-acciones">
          <button class="btn btn-waze" onclick="abrirWaze(${a.lat}, ${a.lng})">Navegar con Waze</button>
          <button class="btn btn-primario" onclick="resolverSos('${a.id}')">Marcar resuelto</button>
        </div>
      </div>`;
  });
  html += `</div><div class="seccion-alertas"><h3>Historial SOS</h3>`;
  if (!historial.length) html += `<div class="tarjeta texto-suave">Sin historial aún.</div>`;
  historial.forEach((a) => {
    const emisor = usuarioPorId(a.senderId);
    html += `
      <div class="tarjeta">
        <div class="tarjeta-fila">
          <div class="avatar-miembro">SOS</div>
          <div style="flex:1">
            <strong>${esc(emisor ? emisor.name : "Miembro")}</strong>
            <div class="texto-suave">${esc(a.message)} · ${fmtAgo(a.sentAt)}</div>
          </div>
          <span class="chip chip-exito">RESUELTO</span>
        </div>
      </div>`;
  });
  html += `</div><div class="seccion-alertas"><h3>🔔 Notificaciones</h3>`;
  html += `<div class="fila-acciones"><button class="btn btn-conexo" onclick="marcarTodasLeidas()">Marcar todas como leídas</button></div>`;
  if (!notifs.length) html += `<div class="contenedor-vacio"><span class="icono">🔔</span>Sin notificaciones.</div>`;
  notifs.forEach((n) => {
    html += `
      <div class="tarjeta fila-notificacion ${n.read ? "" : "no-leida"}">
        <span class="icono-notificacion">${n.type === "SOS" ? "🚨" : "ℹ️"}</span>
        <div style="flex:1">
          <strong>${esc(n.title)}</strong>
          <div class="texto-suave">${esc(n.body)}</div>
          <div class="texto-suave">${fmtAgo(n.createdAt)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${n.read ? "" : `<button class="btn btn-conexo" onclick="marcarLeida('${n.id}')">Leída</button>`}
          <button class="btn btn-peligro" onclick="borrarNotificacion('${n.id}')">✕</button>
        </div>
      </div>`;
  });
  html += `</div>`;

  $("#contenidoAlertas").innerHTML = html;
}

function marcarLeida(id) {
  const n = datos.notifications.find((x) => x.id === id);
  if (!n) return;
  n.read = true;
  if (MODO_NUBE) window.NUBE.actualizar("notificaciones", { leida: true }, "id", id).catch(() => {});
  salvarDatos();
  renderAlertas();
  actualizarBadge();
}

function marcarTodasLeidas() {
  const yo = usuarioActual();
  datos.notifications.forEach((n) => { if (n.userId === yo.id) n.read = true; });
  if (MODO_NUBE) window.NUBE.actualizar("notificaciones", { leida: true }, "usuario_id", yo.id).catch(() => {});
  salvarDatos();
  renderAlertas();
  actualizarBadge();
  mostrarToast("Notificaciones marcadas como leídas.", "exito");
}

function borrarNotificacion(id) {
  datos.notifications = datos.notifications.filter((n) => n.id !== id);
  if (MODO_NUBE) window.NUBE.borrar("notificaciones", "id", id).catch(() => {});
  salvarDatos();
  renderAlertas();
  actualizarBadge();
}

function actualizarBadge() {
  const yo = usuarioActual();
  if (!yo) { $("#badgeAlertas").classList.add("oculta"); return; }
  const noLeidas = datos.notifications.filter((n) => n.userId === yo.id && !n.read).length;
  const activos = datos.alerts.filter((a) => a.status === "ACTIVE" && esDeMiGrupo(a)).length;
  const total = noLeidas + activos;
  const b = $("#badgeAlertas");
  if (total > 0) { b.textContent = total; b.classList.remove("oculta"); }
  else b.classList.add("oculta");
}

// ============================ PERFIL ============================

function renderPerfil() {
  const yo = usuarioActual();
  let html = `
    <div class="titulo-panel">Mi perfil</div>
    <div class="subtitulo-panel">${esc(yo.email)}</div>
    <div class="tarjeta">
      <div class="tarjeta-fila">
        <div class="avatar-miembro" style="background:${colorDe(yo.id)}">${iniciales(yo.name)}</div>
        <div style="flex:1">
          <strong>${esc(yo.name)}</strong>
          <div class="texto-suave">Miembro desde ${fmtFecha(yo.createdAt)}</div>
        </div>
      </div>
    </div>
    <div class="tarjeta">
      <label>Nombre</label>
      <input id="perfilNombre" value="${esc(yo.name)}">
      <label>Teléfono (opcional)</label>
      <input id="perfilTelefono" value="${esc(yo.phone || "")}" placeholder="Ej. 555 010 2828">
      <div class="fila-acciones">
        <button class="btn btn-primario" onclick="guardarPerfil()">Guardar cambios</button>
      </div>
    </div>
    ${gruposAdministrables().length ? `
    <div class="tarjeta">
      <div class="titulo-panel" style="font-size:17px">Agregar personas</div>
      <div class="texto-suave">Crea el correo y la contraseña de quien quieras sumar a tu círculo.</div>
      <div class="fila-acciones">
        <button class="btn btn-primario" onclick="abrirModalAgregarIntegrante()">+ Agregar integrante</button>
      </div>
    </div>` : ""}
    <div class="tarjeta interruptor">
      <div class="texto-interruptor">
        <strong>Compartir mi ubicación</strong>
        <div class="texto-suave">Si lo desactivas, tu círculo no podrá verte en el mapa.</div>
      </div>
      <button class="switch ${yo.shareLocation ? "encendido" : ""}" onclick="alternarCompartir()"></button>
    </div>
    <div class="tarjeta">
      <div class="titulo-panel" style="font-size:17px">Historial de ubicación</div>
      <div class="texto-suave">Registro de tus posiciones. Es solo tuyo y puedes borrarlo cuando quieras.</div>
      <div class="fila-acciones">
        <button class="btn btn-conexo" onclick="verHistorial()">Ver historial</button>
        <button class="btn btn-peligro" onclick="borrarHistorial()">Borrar</button>
      </div>
    </div>
    <div class="fila-acciones">
      <button class="btn btn-secundario" onclick="salirApp()">Cerrar sesión</button>
      <button class="btn btn-peligro" onclick="borrarCuentaConfirm()">Borrar mi cuenta</button>
    </div>
    <div class="contenedor-vacio">
      <div class="logo-nudo" style="margin:0 auto 8px">
        <svg viewBox="0 0 64 64" style="width:40px;height:40px">
          <circle cx="20" cy="20" r="12" fill="#B93A64"/>
          <circle cx="44" cy="20" r="12" fill="#8A2748"/>
          <circle cx="32" cy="40" r="12" fill="#D9779A"/>
        </svg>
      </div>
      <div class="texto-suave">NEXO v2.0 · HTML + CSS + JavaScript</div>
    </div>`;
  $("#contenidoPerfil").innerHTML = html;
}

function guardarPerfil() {
  const yo = usuarioActual();
  yo.name = $("#perfilNombre").value.trim() || yo.name;
  yo.phone = $("#perfilTelefono").value.trim();
  if (MODO_NUBE) window.NUBE.guardarPerfil(yo.id, { nombre: yo.name, telefono: yo.phone }).catch((e) => mostrarToast(e.message, "error"));
  salvarDatos();
  renderPerfil();
  $("#textoEnVivo").textContent = yo.name;
  if (marcadores["yo"] && mapa) {
    mapa.removeLayer(marcadores["yo"]);
    delete marcadores["yo"];
    if (yo.shareLocation && miPos) crearMarca("yo", yo.name, true);
  }
  mostrarToast("Perfil actualizado.", "exito");
}

function alternarCompartir() {
  const yo = usuarioActual();
  yo.shareLocation = !yo.shareLocation;
  if (yo.shareLocation) {
    comenzarMiUbicacion();
    if (!miPos && !MODO_NUBE) usarPosicionPorDefecto();
    if (miPos) publicarPosicion(yo.id, miPos.lat, miPos.lng);
    if (MODO_NUBE && miPos) window.NUBE.reportarUbicacion(yo.id, miPos.lat, miPos.lng).catch(() => {});
    mostrarToast("Ahora tu círculo puede verte.", "exito");
  } else {
    detenerMiUbicacion();
    mostrarToast("Tu ubicación está oculta.", "aviso");
  }
  if (MODO_NUBE) window.NUBE.guardarPerfil(yo.id, { share_ubicacion: yo.shareLocation }).catch((e) => mostrarToast(e.message, "error"));
  actualizarMarcadores();
  actualizarBannerPrivacidad();
  renderPerfil();
}

function actualizarBannerPrivacidad() {
  const yo = usuarioActual();
  $("#bannerPrivacidad").classList.toggle("oculta", !yo || yo.shareLocation);
}

function verHistorial() {
  const yo = usuarioActual();
  const puntos = yo.points || [];
  let filas;
  if (!puntos.length) {
    filas = `<div class="contenedor-vacio"><span class="icono">🗺️</span>Aún no hay registros.</div>`;
  } else {
    filas = puntos.slice().reverse().slice(0, 50).map((p) => `
      <div class="tarjeta fila-notificacion">
        <div style="flex:1">
          <strong>${fmtHora(p.t)}</strong>
          <div class="texto-suave">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
        </div>
        <button class="btn btn-waze" onclick="cerrarModal(); abrirWaze(${p.lat}, ${p.lng})">Waze</button>
      </div>`).join("");
  }
  abrirModal(`
    <h2>Historial de ubicación (${puntos.length})</h2>
    <div class="texto-suave">Se muestran los 50 registros más recientes.</div>
    <div style="margin-top:10px">${filas}</div>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cerrar</button>
    </div>`);
}

function borrarHistorial() {
  if (!confirm("¿Borrar todo tu historial de ubicación?")) return;
  usuarioActual().points = [];
  salvarDatos();
  mostrarToast("Historial borrado.", "exito");
}

function borrarCuentaConfirm() {
  if (!confirm("Se borrará tu cuenta, tus grupos y tus lugares. ¿Continuar?")) return;
  const yo = usuarioActual();
  datos.users = datos.users.filter((u) => u.id !== yo.id);
  datos.groups = datos.groups.filter((g) => g.ownerId !== yo.id);
  datos.places = datos.places.filter((p) => p.userId !== yo.id);
  if (MODO_NUBE) {
    window.NUBE.cliente.auth.admin.deleteUser(yo.id).catch(() => {});
  }
  salirApp();
  mostrarToast("Cuenta eliminada.", "aviso");
}

// ============================ EVENTOS E INICIO ============================

function bindEvents() {
  $("#formLogin").addEventListener("submit", (e) => { e.preventDefault(); iniciarSesion(); });
  $("#formRegistro").addEventListener("submit", (e) => { e.preventDefault(); registrarUsuario(); });
  $("#linkRegistro").addEventListener("click", (e) => {
    e.preventDefault();
    $("#vistaLogin").classList.add("oculta");
    $("#vistaRegistro").classList.remove("oculta");
    $("#regError").textContent = "";
  });
  $("#linkLogin").addEventListener("click", (e) => {
    e.preventDefault();
    $("#vistaRegistro").classList.add("oculta");
    $("#vistaLogin").classList.remove("oculta");
    $("#loginError").textContent = "";
  });
  $("#linkOlvide").addEventListener("click", (e) => {
    e.preventDefault();
    recuperarClaveUI();
  });
  const btnUbic = $("#btnActivarUbic");
  if (btnUbic) btnUbic.addEventListener("click", alternarCompartir);
  $$(".tab").forEach((t) => t.addEventListener("click", () => mostrarVista(t.dataset.vista)));
  $("#btnSos").addEventListener("click", abrirModalSos);
  $("#btnCentrar").addEventListener("click", centrarEnMi);
  $("#btnAjustar").addEventListener("click", ajustarVista);
  $("#tapete").addEventListener("click", cerrarModal);
}

async function recuperarClaveUI() {
  const correo = $("#loginCorreo").value.trim().toLowerCase();
  if (!MODO_NUBE) { mostrarToast("En modo local no hay correo: usa tu contraseña o crea otra cuenta.", "aviso"); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { $("#loginError").textContent = "Escribe tu correo arriba y vuelve a tocar el enlace."; return; }
  try {
    await window.NUBE.recuperarClave(correo);
    mostrarToast("Si el correo existe, te enviamos un enlace para cambiar la contraseña.", "exito");
  } catch (e) { $("#loginError").textContent = e.message; }
}

function abrirModalNuevaClave() {
  abrirModal(`
    <h2>Nueva contraseña</h2>
    <div class="texto-suave">Elige una contraseña nueva para tu cuenta.</div>
    <label>Contraseña</label>
    <input id="nuevaClave" type="password" placeholder="Mínimo 6 caracteres" autocomplete="new-password">
    <p id="nuevaClaveError" class="error-msg"></p>
    <div class="fila-acciones">
      <button class="btn btn-primario" onclick="guardarNuevaClave()">Guardar</button>
    </div>`);
}

async function guardarNuevaClave() {
  const clave = $("#nuevaClave").value;
  if (clave.length < 6) { $("#nuevaClaveError").textContent = "Mínimo 6 caracteres."; return; }
  try {
    await window.NUBE.nuevaClave(clave);
    cerrarModal();
    mostrarToast("Contraseña actualizada.", "exito");
  } catch (e) { $("#nuevaClaveError").textContent = e.message; }
}

// ============================ AGREGAR INTEGRANTES (correo + contraseña) ============================

let ultimasCredenciales = null;

function gruposAdministrables() {
  const yo = usuarioActual();
  return gruposDe(yo.id).filter((g) => rolEnGrupo(g.id, yo.id) !== "MEMBER");
}

function generarClave() {
  const letras = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(10);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  return Array.from(buf, (n) => letras[n % letras.length]).join("");
}

function abrirModalAgregarIntegrante(gidPreferido) {
  const lista = gruposAdministrables();
  if (!lista.length) { mostrarToast("Necesitas ser líder o co-líder de un círculo para agregar personas.", "aviso"); return; }
  const pre = gidPreferido || grupoDetalleId || lista[0].id;
  const opciones = lista.map((g) => `<option value="${esc(g.id)}" ${g.id === pre ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  abrirModal(`
    <h2>Agregar integrante</h2>
    <div class="texto-suave">Crea el acceso (correo y contraseña) de una persona y súmala a tu círculo.</div>
    <label>Círculo</label>
    <select id="intGrupo">${opciones}</select>
    <label>Nombre</label>
    <input id="intNombre" placeholder="Nombre y apellido" autocomplete="off">
    <label>Correo electrónico</label>
    <input id="intCorreo" type="email" inputmode="email" autocapitalize="off" autocorrect="off" placeholder="persona@correo.com" autocomplete="off">
    <label>Contraseña</label>
    <div class="campo-clave">
      <input id="intClave" type="text" placeholder="Mínimo 6 caracteres" autocomplete="off" autocapitalize="off">
      <button type="button" class="btn btn-conexo" onclick="document.getElementById('intClave').value = generarClave()">Generar</button>
    </div>
    <p id="intError" class="error-msg"></p>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal()">Cancelar</button>
      <button id="btnCrearInt" class="btn btn-primario" onclick="crearIntegrante()">Crear acceso</button>
    </div>`);
}

async function crearIntegrante() {
  const err = $("#intError");
  err.textContent = "";
  const g = grupoPorId($("#intGrupo").value);
  const nombre = $("#intNombre").value.trim();
  const correo = $("#intCorreo").value.trim().toLowerCase();
  const clave = $("#intClave").value;
  if (!g) { err.textContent = "Elige un círculo."; return; }
  if (!nombre) { err.textContent = "Escribe el nombre."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { err.textContent = "Correo no válido."; return; }
  if (clave.length < 6) { err.textContent = "La contraseña debe tener al menos 6 caracteres."; return; }

  const btn = $("#btnCrearInt");
  btn.disabled = true;
  try {
    let uid, pendienteConfirmar = false;
    if (MODO_NUBE) {
      const cuenta = await window.NUBE.crearCuenta(nombre, correo, clave);
      uid = cuenta.id;
      if (cuenta.sesion) await window.NUBE.unirCuentaAGrupo(cuenta, g.id, "MEMBER");
      else pendienteConfirmar = true;
      await window.NUBE.cerrarCuentaTemporal(cuenta);
      if (!datos.users.some((u) => u.id === uid)) {
        datos.users.push({ id: uid, name: nombre, email: "", phone: "", shareLocation: false, createdAt: fechaISO(), points: [] });
      }
      if (!pendienteConfirmar) g.members.push({ userId: uid, role: "MEMBER" });
    } else {
      if (datos.users.some((u) => u.email === correo)) throw new Error("Ese correo ya está registrado.");
      uid = uuid();
      datos.users.push({ id: uid, name: nombre, email: correo, password: clave, phone: "", shareLocation: false, createdAt: fechaISO(), points: [] });
      g.members.push({ userId: uid, role: "MEMBER" });
    }
    salvarDatos();
    publicarCambioDatos();
    actualizarMarcadores();
    if (vistaActual === "grupo") grupoDetalleId ? verDetalleGrupo(grupoDetalleId) : renderGrupos();
    mostrarCredenciales({ nombre, correo, clave, grupo: g, pendienteConfirmar });
  } catch (e) {
    err.textContent = e.message || "No se pudo crear la cuenta.";
    btn.disabled = false;
  }
}

function textoCredenciales(c) {
  return "Hola " + c.nombre + "! Ya tienes acceso a NEXO.\n" +
    "Entra aquí: " + urlBaseApp() + "\n" +
    "Correo: " + c.correo + "\n" +
    "Contraseña: " + c.clave + "\n" +
    "Código de tu círculo: " + c.grupo.code + "\n" +
    "Te recomendamos cambiar la contraseña después de entrar.";
}

function mostrarCredenciales(c) {
  ultimasCredenciales = c;
  abrirModal(`
    <h2>Acceso creado</h2>
    <div class="texto-suave">Compártele estos datos a ${esc(c.nombre)}. La contraseña no se vuelve a mostrar.</div>
    <div class="credenciales">
      <div><span>Correo</span><strong>${esc(c.correo)}</strong></div>
      <div><span>Contraseña</span><strong>${esc(c.clave)}</strong></div>
      <div><span>Círculo</span><strong>${esc(c.grupo.name)} · ${esc(c.grupo.code)}</strong></div>
    </div>
    ${c.pendienteConfirmar ? `<div class="aviso-modo">Supabase está pidiendo confirmar el correo: la cuenta se creó pero ${esc(c.nombre)} debe confirmarlo, y luego unirse con el código <strong>${esc(c.grupo.code)}</strong>. Para evitarlo, desactiva "Confirm email" en Authentication → Providers → Email.</div>` : ""}
    <div class="fila-acciones">
      <button class="btn btn-secundario" onclick="copiarCredenciales()">Copiar datos</button>
      <button class="btn btn-whatsapp" onclick="enviarCredencialesWhatsApp()">WhatsApp</button>
    </div>
    <div class="fila-acciones">
      <button class="btn btn-conexo" onclick="cerrarModal(); abrirModalAgregarIntegrante()">Agregar otra persona</button>
      <button class="btn btn-primario" onclick="cerrarModal()">Listo</button>
    </div>`);
}

function copiarCredenciales() {
  if (!ultimasCredenciales) return;
  const texto = textoCredenciales(ultimasCredenciales);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(() => mostrarToast("Datos copiados.", "exito"));
  } else window.prompt("Copia estos datos:", texto);
}

function enviarCredencialesWhatsApp() {
  if (!ultimasCredenciales) return;
  const t = encodeURIComponent(textoCredenciales(ultimasCredenciales));
  const movil = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  window.open((movil ? "https://wa.me/?text=" : "https://api.whatsapp.com/send?text=") + t, "_blank");
}

function iniciar() {
  if (!MODO_NUBE) {
    $$(".tarjeta-auth").forEach((t) => {
      const p = document.createElement("p");
      p.className = "aviso-modo";
      p.textContent = "Modo local: las cuentas y círculos solo existen en este navegador. Conecta Supabase para usarlo entre dispositivos.";
      t.appendChild(p);
    });
  }
  bindEvents();
  escucharCambiosOtrasPestanas();

  if (MODO_NUBE) {
    window.NUBE.cliente.auth.onAuthStateChange((evento, sesion) => {
      if ((evento === "INITIAL_SESSION" || evento === "SIGNED_IN" || evento === "SIGNED_UP") && sesion) {
        entrarAppNube(sesion.user).catch(() => {});
      } else if (evento === "PASSWORD_RECOVERY") {
        abrirModalNuevaClave();
      } else if (evento === "SIGNED_OUT") {
        limpiarSesionUI();
      }
    });
  } else if (usuarioActual()) {
    entrarApp();
  }
}

iniciar();

// En el celular el navegador pausa el GPS cuando la pestaña queda en segundo plano.
// Al volver, se reinicia el seguimiento y se envía la posición enseguida.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !usuarioActual() || !mapa) return;
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  comenzarMiUbicacion();
  const yo = usuarioActual();
  if (MODO_NUBE && yo && yo.shareLocation && miPos) window.NUBE.reportarUbicacion(yo.id, miPos.lat, miPos.lng).catch(() => {});
  if (MODO_NUBE) sincronizarNube();
});
