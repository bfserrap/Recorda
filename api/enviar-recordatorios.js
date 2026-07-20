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

  async function marcarNotificado(id) {
    const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${id}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ notificado: true }),
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
        const horasAntic = Number(r.anticipacion_horas ?? 24);
        const fechaAviso = new Date(fechaHora.getTime() - horasAntic * 3600 * 1000);

        if (ahora < fechaAviso.getTime()) {
          pendientes++;
          continue;
        }

        let telefono = r.telefono_whatsapp;
        let apikey = null;

        const resPerfil = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${r.user_id}&select=telefono_whatsapp,callmebot_apikey`,
          { headers }
        );
        if (!resPerfil.ok) throw new Error("No se pudo consultar el perfil");

        const perfilArr = await resPerfil.json();
        const perfil = perfilArr[0] || {};
        telefono = telefono || perfil.telefono_whatsapp;
        apikey = perfil.callmebot_apikey;

        if (!telefono || !apikey) {
          errores.push({ id: r.id, motivo: "Faltan teléfono o API key; se reintentará" });
          continue;
        }

        const telefonoLimpio = normalizarTelefono(telefono);
        const fechaTexto = fechaHora.toLocaleDateString("es-CL", {
          timeZone: APP_TIME_ZONE,
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        const horaTexto = r.hora.slice(0, 5);
        const emojiTipo = { cita_medica: "🩺", evento: "🎉", tramite: "📄", otro: "✨" }[r.tipo] || "🔔";
        const tituloTipo = { cita_medica: "Cita médica", evento: "Evento", tramite: "Trámite", otro: "Recordatorio" }[r.tipo] || "Recordatorio";

        const lineas = [
          `¡Hola! 👋 Este es tu recordatorio${r.tipo === "cita_medica" ? " de salud" : ""} 🔔`,
          "",
          `${emojiTipo} *${tituloTipo}*`,
          `📌 ${r.titulo}`,
          `📅 ${fechaTexto}, ${horaTexto} hrs`,
        ];
        if (r.centro_medico) lineas.push(`🏥 ${r.centro_medico}`);
        if (r.especialidad) lineas.push(`⚕️ ${r.especialidad}`);
        if (r.medico) lineas.push(`👨‍⚕️ ${r.medico}`);
        if (r.direccion) lineas.push(`📍 ${r.direccion}`);
        if (r.ubicacion) lineas.push(`📍 ${r.ubicacion}`);
        if (r.numero_ficha) lineas.push(`🎫 N° ficha: ${r.numero_ficha}`);
        if (r.notas) lineas.push(`📝 ${r.notas}`);

        const mensaje = lineas.join("\n");
        const urlEnvio = `https://api.callmebot.com/whatsapp.php?phone=${telefonoLimpio}&text=${encodeURIComponent(mensaje)}&apikey=${apikey}`;
        const resEnvio = await fetch(urlEnvio);
        const textoRespuesta = await resEnvio.text();

        if (!resEnvio.ok || /error/i.test(textoRespuesta)) {
          errores.push({
            id: r.id,
            motivo: "CallMeBot respondió con error; se reintentará",
            detalle: textoRespuesta.slice(0, 200),
          });
          continue;
        }

        await marcarNotificado(r.id);
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
