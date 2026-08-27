// api/enviar-recordatorios.js
// Ejecutar este endpoint cada minuto desde cron-job.org para que los avisos
// se envíen con una precisión aproximada de un minuto.

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "America/Santiago";

export default async function handler(req, res) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const secret = req.query.secret || bearer;

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" });
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  function normalizarTelefono(telefono) {
    const limpio = (telefono || "").replace(/[^\d]/g, "");
    if (limpio.startsWith("56")) return limpio;
    if (limpio.startsWith("9") && limpio.length === 9) return "56" + limpio;
    return limpio;
  }

  function normalizarTexto(valor) {
    return String(valor || "").split("\n").map((linea) => {
      const limpio = linea.trim().replace(/\s+/g, " ");
      if (!limpio) return "";
      return limpio.charAt(0).toLocaleUpperCase("es-CL") + limpio.slice(1).toLocaleLowerCase("es-CL");
    }).join("\n");
  }

  function contactosWhatsApp(perfil) {
    const bruto = perfil?.telefono_whatsapp;
    try {
      const contactos = JSON.parse(bruto || "[]");
      if (Array.isArray(contactos)) return contactos.filter((c) => c?.id && c?.telefono)
        .map((c) => ({ id: String(c.id), telefono: c.telefono, apikey: c.apikey || "", activo: c.activo !== false }));
    } catch (_) {}
    return bruto ? [{ id: "principal", telefono: bruto, apikey: perfil?.callmebot_apikey || "", activo: true }] : [];
  }

  function destinatariosDelRecordatorio(recordatorio, perfil) {
    const contactos = contactosWhatsApp(perfil);
    try {
      const ids = JSON.parse(recordatorio.telefono_whatsapp || "[]");
      if (Array.isArray(ids)) return contactos.filter((c) => c.activo && ids.includes(c.id));
    } catch (_) {}
    const telefono = normalizarTelefono(recordatorio.telefono_whatsapp || perfil.telefono_whatsapp);
    return contactos.filter((c) => c.activo && normalizarTelefono(c.telefono) === telefono);
  }

  // Convierte una fecha/hora ingresada en Chile a un instante UTC real.
  // Intl incorpora automáticamente los cambios de horario de verano/invierno.
  function fechaLocalAUTC(fecha, hora, timeZone = APP_TIME_ZONE) {
    const [year, month, day] = String(fecha).split("-").map(Number);
    const [hour, minute, second = 0] = String(hora).split(":").map(Number);

    if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
      throw new Error(`Fecha u hora inválida: ${fecha} ${hora}`);
    }

    const objetivoUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    let candidato = objetivoUTC;
    for (let intento = 0; intento < 3; intento++) {
      const partes = Object.fromEntries(
        formatter.formatToParts(new Date(candidato))
          .filter((p) => p.type !== "literal")
          .map((p) => [p.type, Number(p.value)])
      );
      const representacionUTC = Date.UTC(
        partes.year,
        partes.month - 1,
        partes.day,
        partes.hour,
        partes.minute,
        partes.second
      );
      const siguiente = candidato + (objetivoUTC - representacionUTC);
      if (siguiente === candidato) break;
      candidato = siguiente;
    }

    return new Date(candidato);
  }

  async function actualizarEstadoAvisos(id, region, notificado) {
    const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ region, notificado }),
    });

    if (!respuesta.ok) {
      throw new Error(`No se pudo marcar el recordatorio ${id} como notificado`);
    }
  }

  try {
    const resReminders = await fetch(
      `${SUPABASE_URL}/rest/v1/reminders?avisar_whatsapp=eq.true&notificado=eq.false&select=*`,
      { headers }
    );
    if (!resReminders.ok) {
      const detalle = await resReminders.text();
      return res.status(500).json({ error: "Error consultando reminders", detalle });
    }

    const reminders = await resReminders.json();
    const ahora = Date.now();
    let enviados = 0;
    let pendientes = 0;
    const errores = [];

    for (const r of reminders) {
      try {
        const fechaHora = fechaLocalAUTC(r.fecha, r.hora);
        let estadoAvisos;
        if (String(r.region || "").startsWith("__avisos:")) {
          try { estadoAvisos = JSON.parse(String(r.region).slice(9)); } catch { estadoAvisos = null; }
        }
        const todosAvisos = (estadoAvisos?.todos?.length ? estadoAvisos.todos : [Number(r.anticipacion_horas ?? 24)]).map(Number);
        const yaEnviados = new Set((estadoAvisos?.enviados || []).map(Number));
        const avisosVencidos = todosAvisos.filter((horas) => !yaEnviados.has(horas) && ahora >= fechaHora.getTime() - horas * 3600 * 1000);

        if (!avisosVencidos.length) {
          pendientes++;
          continue;
        }

        const resPerfil = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${r.user_id}&select=telefono_whatsapp,callmebot_apikey`,
          { headers }
        );
        if (!resPerfil.ok) throw new Error("No se pudo consultar el perfil");

        const perfilArr = await resPerfil.json();
        const perfil = perfilArr[0] || {};
        const destinatarios = destinatariosDelRecordatorio(r, perfil);
        if (!destinatarios.length) {
          errores.push({ id: r.id, motivo: "No hay destinatarios activos para este recordatorio; se reintentará" });
          continue;
        }
        const fechaTexto = fechaHora.toLocaleDateString("es-CL", {
          timeZone: APP_TIME_ZONE,
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        const horaTexto = r.hora.slice(0, 5);
        // Las compras se guardan como "otro" para ser compatibles con bases
        // antiguas que restringen los valores permitidos en la columna tipo.
        const esCompra = r.tipo === "compra" || (r.tipo === "otro" && r.titulo === "🛒 Lista de compras");
        const tipoReal = esCompra ? "compra" : r.tipo;
        const tipoInfo = {
          cita_medica: { emoji: "🩺", titulo: "Cita médica", saludo: "¡Hola! 👋 Este es tu recordatorio de salud 🔔" },
          evento: { emoji: "🎉", titulo: "Evento", saludo: "¡Hola! 👋 Tienes un evento próximo 🎉" },
          tramite: { emoji: "📄", titulo: "Trámite", saludo: "¡Hola! 👋 Tienes un trámite pendiente 📄" },
          compra: { emoji: "🛒", titulo: "Lista de compras", saludo: "¡Hola! 👋 Esta es tu lista de compras 🛒" },
          otro: { emoji: "✨", titulo: "Recordatorio", saludo: "¡Hola! 👋 Tienes un recordatorio 🔔" },
        }[tipoReal] || { emoji: "🔔", titulo: "Recordatorio", saludo: "¡Hola! 👋 Tienes un recordatorio 🔔" };

        const lineas = [tipoInfo.saludo, "", `${tipoInfo.emoji} *${tipoInfo.titulo}*`];

        if (r.tipo !== "cita_medica" && !esCompra) {
          lineas.push(`📌 *${normalizarTexto(r.titulo)}*`);
        }

        lineas.push("", `📅 ${fechaTexto}`, `🕒 ${horaTexto} hrs`);

        if (r.tipo === "cita_medica") {
          if (r.centro_medico) lineas.push(`🏥 ${normalizarTexto(r.centro_medico)}`);
          if (r.especialidad) lineas.push(`🩺 ${normalizarTexto(r.especialidad)}`);
          if (r.medico) lineas.push(`👩‍⚕️ ${normalizarTexto(r.medico)}`);
          if (r.direccion) lineas.push(`📍 ${normalizarTexto(r.direccion)}`);
          if (r.notas) lineas.push("", `📝 *Notas:* ${normalizarTexto(r.notas)}`);
        } else if (esCompra) {
          const productos = (r.notas || "")
            .split("\n")
            .map((item) => item.trim().replace(/^[-•☐]\s*/, ""))
            .filter(Boolean);
          if (productos.length) {
            lineas.push("", "🧺 *Tu lista:*", ...productos.map((item) => `- ${normalizarTexto(item)}`));
          }
        } else {
          if (r.ubicacion) lineas.push(`📍 ${normalizarTexto(r.ubicacion)}`);
          if (r.tipo === "evento" && r.notas?.startsWith("Llevar:")) {
            const [llevar, ...notasExtra] = r.notas.split("\n\n");
            lineas.push("", `🎒 *Para llevar:* ${normalizarTexto(llevar.replace(/^Llevar:\s*/, ""))}`);
            if (notasExtra.join("\n\n").trim()) lineas.push(`📝 ${normalizarTexto(notasExtra.join("\n\n"))}`);
          } else if (r.notas) {
            lineas.push("", `📝 ${normalizarTexto(r.notas)}`);
          }
        }

        const mensaje = lineas.join("\n");
        const resultados = await Promise.all(destinatarios.map(async (destinatario) => {
          if (!destinatario.apikey) return { ok: false, detalle: `Falta API key para ${destinatario.telefono}` };
          const urlEnvio = `https://api.callmebot.com/whatsapp.php?phone=${normalizarTelefono(destinatario.telefono)}&text=${encodeURIComponent(mensaje)}&apikey=${destinatario.apikey}`;
          const respuesta = await fetch(urlEnvio);
          const detalle = await respuesta.text();
          return { ok: respuesta.ok && !/error/i.test(detalle), detalle };
        }));
        const fallidos = resultados.filter((resultado) => !resultado.ok);
        if (fallidos.length) {
          errores.push({
            id: r.id,
            motivo: "CallMeBot respondió con error para uno o más destinatarios; se reintentará",
            detalle: fallidos.map((resultado) => resultado.detalle).join(" | ").slice(0, 200),
          });
          continue;
        }

        avisosVencidos.forEach((horas) => yaEnviados.add(horas));
        const completo = todosAvisos.every((horas) => yaEnviados.has(horas));
        const regionActualizada = `__avisos:${JSON.stringify({ todos: todosAvisos, enviados: [...yaEnviados] })}`;
        await actualizarEstadoAvisos(r.id, regionActualizada, completo);
        enviados++;
      } catch (error) {
        errores.push({ id: r.id, motivo: String(error?.message || error) });
      }
    }

    return res.status(200).json({
      zona_horaria: APP_TIME_ZONE,
      revisados: reminders.length,
      pendientes,
      enviados,
      errores,
    });
  } catch (error) {
    return res.status(500).json({ error: "Error inesperado", detalle: String(error) });
  }
}
