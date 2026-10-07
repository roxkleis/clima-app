(() => {
  const button = document.getElementById('testNotification');
  const status = document.getElementById('testNotificationStatus');
  if (!button) return;

  const API = 'https://clima-consenso-smn.roxkleis.workers.dev';

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  async function getSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Este navegador no admite Web Push.');
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw new Error('Primero activá las alertas en este dispositivo.');
    return subscription;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Enviando notificación de prueba…');
    try {
      const subscription = await getSubscription();
      const json = subscription.toJSON();
      const response = await fetch(`${API}/push/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Error de envío HTTP ${response.status}`);
      }
      setStatus('✅ Enviada. Revisá las notificaciones de este dispositivo.');
    } catch (error) {
      setStatus(`❌ ${error?.message || 'No se pudo enviar la prueba.'}`);
    } finally {
      button.disabled = false;
    }
  });
})();
