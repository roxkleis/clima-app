(() => {
  const observationEl = document.getElementById('observation');
  if (!observationEl) return;

  function renderObservationText(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('📍 Observación SMN · ')) return;

    const parts = raw.split(' · ');
    if (parts.length < 5) return;

    const station = parts[1];
    const clock = parts[2];
    const distance = parts[4];
    if (!station || !clock || !distance) return;

    observationEl.classList.add('station-observation');
    observationEl.classList.remove('fallback');
    observationEl.innerHTML = `
      <span class="observation-title">📍 Observación SMN</span>
      <span class="observation-detail">${escapeHtml(station)} · ${escapeHtml(distance)} · actualizado ${escapeHtml(clock)}</span>
    `;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>\"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;'
    }[char]));
  }

  const observer = new MutationObserver(() => {
    if (!observationEl.querySelector('.observation-title')) {
      renderObservationText(observationEl.textContent);
    }
  });

  observer.observe(observationEl, {childList:true, characterData:true, subtree:true});
  renderObservationText(observationEl.textContent);
})();
