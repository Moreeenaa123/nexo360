// ============================================================
// NEXO · Adaptador de base de datos en la nube (Supabase)
// Si no hay credenciales configuradas, la app usa cuentas locales
// de prueba (localStorage).
// ============================================================

window.NUBE = (function () {
  const cfg = window.NEXO_CONFIG || {};
  const cliente = (window.supabase && cfg.supabaseUrl && cfg.supabaseAnonKey)
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  const activo = !!cliente;

  async function inicioSesion(correo, clave) {
    const r = await cliente.auth.signInWithPassword({ email: correo, password: clave });
    if (r.error) throw new Error("Correo o contraseña incorrectos.");
  }

  async function registro(nombre, correo, clave) {
    const r = await cliente.auth.signUp({
      email: correo,
      password: clave,
      options: { data: { nombre } }
    });
    if (r.error) {
      if (r.error.message.toLowerCase().includes("already registered")) throw new Error("Ese correo ya está registrado.");
      throw new Error(r.error.message);
    }
    return !!r.data.session;
  }

  async function cerrarSesion() {
    await cliente.auth.signOut();
  }

  async function cargarTodo() {
    const tablas = ["perfiles", "ubicaciones", "grupos", "miembros", "lugares", "alertas", "notificaciones"];
    const resultado = await Promise.all(tablas.map((t) => cliente.from(t).select("*")));
    const error = resultado.map((x) => x.error).find(Boolean);
    if (error) throw new Error(error.message);
    return {
      perfiles: resultado[0].data,
      ubicaciones: resultado[1].data,
      grupos: resultado[2].data,
      miembros: resultado[3].data,
      lugares: resultado[4].data,
      alertas: resultado[5].data,
      notificaciones: resultado[6].data
    };
  }

  // Todas las escrituras lanzan el error de Supabase. Antes devolvían el
  // resultado sin revisar `error`, así un grupo que NO se guardaba en la nube
  // parecía creado y luego su código "no existía".
  async function comprobar(promesa) {
    const r = await promesa;
    if (r && r.error) throw new Error(r.error.message || "Error de base de datos.");
    return r;
  }

  function insert(tabla, fila) {
    return comprobar(cliente.from(tabla).insert(fila));
  }

  async function buscarGrupoPorCodigo(codigo) {
    const limpio = String(codigo || "").replace(/\s+/g, "").toUpperCase();
    // 1) Función segura del esquema nuevo (no expone la lista de grupos)
    const rpc = await cliente.rpc("buscar_grupo_por_codigo", { p_codigo: limpio });
    if (!rpc.error) return (rpc.data && rpc.data[0]) || null;
    const falta = /could not find|does not exist|PGRST202|42883/i.test((rpc.error.message || "") + (rpc.error.code || ""));
    if (!falta) throw new Error(rpc.error.message);
    // 2) Compatibilidad con el esquema viejo (consulta directa)
    const r = await cliente.from("grupos").select("*").eq("codigo", limpio).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data || null;
  }

  async function buscarMiembrosDe(grupoId) {
    const r = await cliente.from("miembros").select("usuario_id, rol").eq("grupo_id", grupoId);
    if (r.error) throw new Error(r.error.message);
    return r.data || [];
  }

  function actualizar(tabla, campos, columna, valor) {
    return comprobar(cliente.from(tabla).update(campos).eq(columna, valor));
  }

  function borrar(tabla, columna, valor) {
    return comprobar(cliente.from(tabla).delete().eq(columna, valor));
  }

  function remove(tabla, condiciones) {
    return comprobar(cliente.from(tabla).delete().match(condiciones));
  }

  async function reportarUbicacion(usuarioId, lat, lng) {
    const r = await cliente.from("ubicaciones").upsert({
      usuario_id: usuarioId,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      updated_at: new Date().toISOString()
    }, { onConflict: "usuario_id" });
    if (r.error) throw r.error;
  }

  async function guardarPerfil(usuarioId, campos) {
    const r = await actualizar("perfiles", campos, "id", usuarioId);
    if (r.error) throw r.error;
  }

  // ---------- Altas de cuentas hechas por un líder ----------
  // Usa un segundo cliente SIN persistencia: así signUp no reemplaza tu sesión.
  async function crearCuenta(nombre, correo, clave) {
    const temporal = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "nexo-alta-temporal" }
    });
    const r = await temporal.auth.signUp({ email: correo, password: clave, options: { data: { nombre } } });
    if (r.error) {
      if (/registered|already/i.test(r.error.message)) throw new Error("Ese correo ya está registrado.");
      throw new Error(r.error.message);
    }
    const user = r.data && r.data.user;
    // Con "Confirm email" activo, un correo repetido vuelve sin error pero sin identidades
    if (!user || (user.identities && user.identities.length === 0)) throw new Error("Ese correo ya está registrado.");
    return { id: user.id, sesion: !!r.data.session, cliente: temporal };
  }

  async function unirCuentaAGrupo(cuenta, grupoId, rol) {
    return comprobar(cuenta.cliente.from("miembros").insert({ grupo_id: grupoId, usuario_id: cuenta.id, rol: rol || "MEMBER" }));
  }

  async function cerrarCuentaTemporal(cuenta) {
    try { await cuenta.cliente.auth.signOut({ scope: "local" }); } catch (e) { /* no crítico */ }
  }

  async function recuperarClave(correo) {
    const r = await cliente.auth.resetPasswordForEmail(correo, { redirectTo: window.location.origin + window.location.pathname });
    if (r.error) throw new Error(r.error.message);
  }

  async function nuevaClave(clave) {
    const r = await cliente.auth.updateUser({ password: clave });
    if (r.error) throw new Error(r.error.message);
  }

  let canal = null;

  function conectarEnVivo(onCambio) {
    if (canal) return;
    canal = cliente.channel("nexo-en-vivo");
    canal
      .on("postgres_changes", { event: "*", schema: "public", table: "ubicaciones" }, (pc) => onCambio({ tipo: "ubicacion", dato: pc.new }))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas" }, (pc) => onCambio({ tipo: "sos", dato: pc.new }))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notificaciones" }, (pc) => onCambio({ tipo: "notificacion", dato: pc.new }))
      .on("postgres_changes", { event: "*", schema: "public", table: "miembros" }, (pc) => onCambio({ tipo: "miembro", dato: pc.new || pc.old }))
      .subscribe();
  }

  function desconectarEnVivo() {
    if (canal) { canal.unsubscribe(); canal = null; }
  }

  return {
    activo, cliente,
    inicioSesion, registro, cerrarSesion,
    cargarTodo, insert, buscarGrupoPorCodigo, buscarMiembrosDe, actualizar, borrar, remove,
    reportarUbicacion, guardarPerfil,
    crearCuenta, unirCuentaAGrupo, cerrarCuentaTemporal, recuperarClave, nuevaClave,
    conectarEnVivo, desconectarEnVivo,
    nuevoId: () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : uuid())
  };
})();