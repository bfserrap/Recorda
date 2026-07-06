// api/enviar-recordatorios.js
// Esta función la llama un servicio externo (cron-job.org) cada 5-10 minutos.
// Revisa los recordatorios que ya deberían avisarse y envía el WhatsApp via CallMeBot.

export default async function handler(req, res) {
  if (req.query.secret !== process.env.CRON_SECRET) {
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
    let limpio = (telefono || "").replace(/[^\d]/g, "");
    if (limpio.startsWith("56")) return limpio;
    if (limpio.startsWith("9") && limpio.length === 9) return "56" + limpio;
    return limpio;
  }

  try {
    const resReminders = await fetch(
      `${SUPABASE_URL}/rest/v1/reminders?avisar_whatsapp=eq.true&notificado=eq.false&select=*`,
      { headers }
    );
    if (!resReminders.ok) {
      const t = await resReminders.text();
      return res.status(500).json({ error: "Error consultando reminders", detalle: t });
    }
    const reminders = await resReminders.json();

    let enviados = 0;
    const errores = [];

    for (const r of reminders) {
      const fechaHora = new Date(`${r.fecha}T${r.hora}`);
      const horasAntic = r.anticipacion_horas ?? 24;
      const fechaAviso = new Date(fechaHora.getTime() - horasAntic * 3600 * 1000);

      if (new Date() < fechaAviso) continue; // todavía no toca avisar

      let telefono = r.telefono_whatsapp;
      let apikey = null;

      // Si el recordatorio no trae teléfono/apikey propio, usa los del perfil
      if (!telefono || !apikey) {
        const resPerfil = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${r.user_id}&select=telefono_whatsapp,callmebot_apikey`,
          { headers }
        );
        const perfilArr = await resPerfil.json();
        const perfil = perfilArr[0] || {};
        telefono = telefono || perfil.telefono_whatsapp;
        apikey = perfil.callmebot_apikey;
      }

      if (!telefono || !apikey) {
        // No se puede avisar sin estos datos: se marca igual para no reintentar en loop infinito
        await fetch(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${r.id}`, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({ notificado: true }),
        });
        errores.push({ id: r.id, motivo: "faltan telefono o apikey" });
        continue;
      }

      const telefonoLimpio = normalizarTelefono(telefono);
      const fechaTexto = fechaHora.toLocaleDateString("es-CL", { day: "numeric", month: "long" });
      const horaTexto = r.hora.slice(0, 5);
      const mensaje = `🔔 Recordatorio: ${r.titulo} el ${fechaTexto} a las ${horaTexto}`;
      const urlEnvio = `https://api.callmebot.com/whatsapp.php?phone=${telefonoLimpio}&text=${encodeURIComponent(mensaje)}&apikey=${apikey}`;

      try {
        const resEnvio = await fetch(urlEnvio);
        const textoRespuesta = await resEnvio.text();
        enviados++;
        if (!resEnvio.ok || /error/i.test(textoRespuesta)) {
          errores.push({ id: r.id, motivo: "CallMeBot respondió con error", detalle: textoRespuesta.slice(0, 200) });
        }
      } catch (e) {
        errores.push({ id: r.id, motivo: "fallo de red a CallMeBot", detalle: String(e) });
      }

      await fetch(`${SUPABASE_URL}/rest/v1/reminders?id=eq.${r.id}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ notificado: true }),
      });
    }

    return res.status(200).json({ revisados: reminders.length, enviados, errores });
  } catch (e) {
    return res.status(500).json({ error: "Error inesperado", detalle: String(e) });
  }
}
