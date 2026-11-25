(() => {
  const api = window.climaGemini;
  const byId = (id) => document.getElementById(id);
  const controls = {
    summary: byId("geminiSummary"),
    status: byId("geminiStatus"),
    retry: byId("geminiRetry"),
    discrepancies: byId("geminiDiscrepancies"),
    lifestyle: byId("geminiLifestyle"),
    alertsStatus: byId("smnAlertsStatus"),
    alertsList: byId("smnAlertsList"),
    alertsSummary: byId("smnGeminiSummary"),
    openChat: byId("geminiOpenChat"),
    chatDialog: byId("geminiChatDialog"),
    chatLocation: byId("geminiChatLocation"),
    chatForm: byId("geminiChatForm"),
    chatStatus: byId("geminiChatStatus"),
    messages: byId("geminiMessages"),
    question: byId("geminiQuestion"),
    dictate: byId("geminiDictate"),
  };
  const chatSubmit = controls.chatForm.querySelector('[type="submit"]');
  const alertTime = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short",
  });
  const recognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

  try {
    sessionStorage.removeItem("clima-consenso:gemini-access");
  } catch {}
  let overviewVersion = 0;
  let alertSignature = null;
  let locationKey = null;
  let chatVersion = 0;
  let chatBusy = false;
  let chatHistory = [];
  let recognition = null;

  function setText(element, text) {
    element.textContent = typeof text === "string" ? text : "";
    element.hidden = !element.textContent;
  }

  function setCardText(card, text) {
    const paragraph = card.querySelector("p");
    setText(paragraph, text);
    card.hidden = paragraph.hidden;
  }

  function renderOverview(data) {
    setText(controls.summary, data?.summary);
    setCardText(controls.discrepancies, data?.discrepancies);
    setCardText(controls.alertsSummary, data?.alertsSummary);
    const tips = [
      ["geminiOutfit", data?.lifestyle?.outfit],
      ["geminiOutdoor", data?.lifestyle?.outdoor],
      ["geminiLaundry", data?.lifestyle?.laundry],
    ];
    for (const [id, text] of tips) byId(id).textContent = text || "";
    controls.lifestyle.hidden = !tips.every(([, text]) => text);
  }

  function textNode(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function officialLink(source) {
    try {
      const url = new URL(source);
      const hosts = ["ssl.smn.gob.ar", "forms.smn.gob.ar", "www.smn.gob.ar"];
      if (url.protocol === "https:" && hosts.includes(url.hostname) && !url.username && !url.password) {
        const link = textNode("a", "Abrir boletín oficial ↗");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener";
        return link;
      }
    } catch {}
    return null;
  }

  function renderAlert(alert) {
    const card = document.createElement("article");
    card.classList.add("gemini-alert");
    const { severity, areas, event } = alert;
    if (["roja", "naranja", "amarilla"].includes(severity)) card.classList.add(severity);
    card.append(textNode("h3", `Alerta ${severity} · ${event}`));
    if (areas?.length) card.append(textNode("p", areas.join(" · ")));
    const start = Date.parse(alert.onset);
    const end = Date.parse(alert.expires);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const period = start > Date.now()
        ? `Desde ${alertTime.format(start)} hasta ${alertTime.format(end)} (hora argentina)`
        : `Vigente hasta ${alertTime.format(end)} (hora argentina)`;
      card.append(textNode("p", period));
    }
    const details = document.createElement("details");
    details.append(textNode("summary", "Leer el aviso"));
    if (alert.description) details.append(textNode("p", alert.description));
    if (alert.instructions) details.append(textNode("p", alert.instructions));
    const link = officialLink(alert.sourceUrl);
    if (link) details.append(link);
    card.append(details);
    return card;
  }

  function renderAlerts(result) {
    const alerts = Array.isArray(result?.alerts) ? result.alerts : [];
    const status = result?.status ?? "unavailable";
    const signature = JSON.stringify([status, alerts]);
    const messages = {
      active: "",
      partial: "Consulta parcial. Estos son los avisos confirmados.",
      none: "Sin alertas del SMN para esta ubicación en el índice consultado.",
      unavailable: "No se pudo confirmar si hay alertas para esta ubicación.",
    };
    controls.alertsStatus.textContent = messages[status] ?? messages.unavailable;
    if (signature === alertSignature) return;

    alertSignature = signature;
    setCardText(controls.alertsSummary, null);
    controls.alertsList.replaceChildren(...alerts.map(renderAlert));
  }

  async function loadAlerts(weather) {
    const result = await api.alerts(weather.lat, weather.lon).catch(() => null);
    if (api.weather() === weather) renderAlerts(result);
  }

  function errorMessage(result) {
    switch (result?.error) {
      case "QUOTA_EXHAUSTED": return "Llegaste al límite diario del asistente.";
      case "WEATHER_UNAVAILABLE": return "Actualizá el clima para seguir consultando.";
      case "WEATHER_CHANGED": return "El pronóstico cambió. Volvé a consultar.";
      default:
        return navigator.onLine === false
          ? "Estás sin conexión."
          : result?.message || "Gemini no está disponible en este momento.";
    }
  }

  function syncChat() {
    const weather = api.weather();
    controls.chatLocation.textContent = weather.location || "";
    chatSubmit.disabled = chatBusy || weather.state !== "ready";
    controls.dictate.disabled = chatSubmit.disabled;
  }

  function openChat() {
    syncChat();
    if (!controls.chatDialog.open) controls.chatDialog.showModal();
  }

  async function loadOverview() {
    const weather = api.weather();
    if (weather.state !== "ready") return;
    const version = ++overviewVersion;
    controls.status.textContent = "Preparando el parte…";
    controls.retry.hidden = true;
    const result = await api.overview();
    if (version !== overviewVersion || api.weather() !== weather) return;

    if (result?.officialAlerts) renderAlerts(result.officialAlerts);
    const localSummary = result?.ok ? "" : api.localSummary();
    renderOverview(result?.ok ? result.data : localSummary ? { summary: localSummary } : null);
    controls.status.textContent = result?.ok ? ""
      : localSummary ? "Parte generado con el pronóstico de la app. " + errorMessage(result)
      : errorMessage(result);
    controls.retry.hidden = Boolean(result?.ok ||
      result?.error === "QUOTA_EXHAUSTED" || result?.error === "WEATHER_UNAVAILABLE");
    if (!result?.officialAlerts) await loadAlerts(weather);
  }

  function setWeather(weather) {
    overviewVersion++;
    chatVersion++;
    chatBusy = false;
    renderOverview(null);
    controls.retry.hidden = true;
    controls.status.textContent = weather.state === "saved" ? "Gemini requiere un pronóstico actualizado."
      : weather.state === "loading" ? "Cargando pronóstico…" : "";
    controls.chatStatus.textContent = ["unavailable", "saved"].includes(weather.state)
      ? "Actualizá el clima para preguntar."
      : weather.state === "loading" ? "Cargando pronóstico…" : "";
    syncChat();
    if (weather.state !== "ready") {
      renderAlerts(null);
      if (weather.state === "loading") controls.alertsStatus.textContent = "Consultando alertas para tu ubicación…";
      return;
    }

    const nextLocation = `${weather.location}|${weather.lat.toFixed(3)}|${weather.lon.toFixed(3)}`;
    if (locationKey !== nextLocation) {
      chatHistory = [];
      controls.messages.replaceChildren();
      controls.question.value = "";
      locationKey = nextLocation;
    }
    void loadOverview();
  }

  function addMessage(label, content, isUser) {
    const entry = document.createElement("li");
    entry.className = isUser ? "gemini-message user" : "gemini-message";
    entry.append(textNode("strong", label), textNode("p", content));
    controls.messages.append(entry);
    controls.messages.scrollTop = controls.messages.scrollHeight;
    return entry;
  }

  function finishDictation() {
    recognition = null;
    controls.dictate.setAttribute("aria-pressed", "false");
    controls.dictate.textContent = "Dictar";
  }

  function dictate() {
    if (recognition) {
      recognition.stop();
      return;
    }
    const session = new recognitionClass();
    session.lang = "es-AR";
    session.interimResults = false;
    session.continuous = false;
    session.onresult = (event) => {
      if (recognition !== session) return;
      const text = event.results[event.resultIndex]?.[0]?.transcript?.trim();
      if (!text) return;
      controls.question.value = [controls.question.value.trim(), text].filter(Boolean).join(" ").slice(0, 500);
      controls.chatStatus.textContent = "";
      controls.question.focus();
    };
    session.onerror = ({ error }) => {
      if (recognition === session) controls.chatStatus.textContent = error === "not-allowed"
        ? "Permití el micrófono para dictar o escribí tu pregunta."
        : "No se pudo reconocer la voz. Podés volver a dictar o escribir.";
    };
    session.onend = () => {
      if (recognition !== session) return;
      finishDictation();
      if (controls.chatStatus.textContent === "Escuchando…") controls.chatStatus.textContent = "";
    };
    recognition = session;
    try {
      session.start();
      controls.dictate.setAttribute("aria-pressed", "true");
      controls.dictate.textContent = "Detener dictado";
      controls.chatStatus.textContent = "Escuchando…";
    } catch {
      finishDictation();
      controls.chatStatus.textContent = "No se pudo abrir el micrófono. Podés escribir tu pregunta.";
    }
  }

  controls.openChat.addEventListener("click", openChat);
  controls.retry.addEventListener("click", () => void loadOverview());
  document.querySelectorAll("[data-gemini-close]").forEach(button =>
    button.addEventListener("click", () => button.closest("dialog").close())
  );
  controls.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = controls.question.value.trim();
    if (!question || chatSubmit.disabled) return;
    if (recognition) {
      const session = recognition;
      finishDictation();
      session.abort();
    }

    const version = ++chatVersion;
    const sent = addMessage("Vos", question, true);
    controls.question.value = "";
    chatBusy = true;
    syncChat();
    controls.chatStatus.textContent = "Consultando el pronóstico…";
    const result = await api.chat(question, chatHistory);
    if (version !== chatVersion) {
      sent.remove();
      return;
    }
    chatBusy = false;
    if (result?.officialAlerts) renderAlerts(result.officialAlerts);
    if (result?.ok && typeof result.text === "string") {
      addMessage("Gemini", result.text, false);
      chatHistory = [...chatHistory, { question, text: result.text.slice(0, 1400) }].slice(-2);
      controls.chatStatus.textContent = "";
    } else {
      sent.remove();
      if (!controls.question.value) controls.question.value = question;
      controls.chatStatus.textContent = errorMessage(result);
    }
    syncChat();
  });

  if (recognitionClass) {
    controls.dictate.hidden = false;
    controls.dictate.addEventListener("click", dictate);
    controls.chatDialog.addEventListener("close", () => {
      const session = recognition;
      finishDictation();
      session?.abort();
      if (controls.chatStatus.textContent === "Escuchando…") controls.chatStatus.textContent = "";
    });
  }

  window.addEventListener("clima:weather", (event) => setWeather(event.detail));
  setWeather(api.weather());
})();
