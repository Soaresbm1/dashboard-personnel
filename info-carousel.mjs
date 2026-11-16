export const INFO_CAROUSEL_INTERVAL_MS = 10_000;

export function initializeInfoCarousel(doc, options = {}) {
  const get = id => doc.getElementById(id), region = get('tech-carousel'), fixed = get('tech-intranet-slide'), dynamic = get('tech-carousel-slides');
  const previous = get('tech-prev'), next = get('tech-next'), position = get('tech-slide-position');
  if (!region || !fixed || !dynamic || !previous || !next || !position) return null;
  const toggle = get('tech-rotation-toggle'), win = options.window || doc.defaultView || globalThis.window;
  const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis), cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  let selected = 'intranet', disposed = false, playing = true, hovered = false, focused = false, timer = null;
  fixed.dataset.slideId = 'intranet';
  const slides = () => [fixed, ...dynamic.children];
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function refreshSchedule(reset = false) {
    if (disposed || !win || !playing || doc.hidden || hovered || focused || slides().length < 2) { clearTimer(); return; }
    if (!reset && timer !== null) return;
    clearTimer();
    timer = schedule(() => { timer = null; move(1, false); }, INFO_CAROUSEL_INTERVAL_MS);
    timer?.unref?.();
  }
  function render(manual = false) {
    const items = slides();
    if (!items.some(item => item.dataset.slideId === selected)) selected = 'intranet';
    const index = items.findIndex(item => item.dataset.slideId === selected);
    items.forEach((item, at) => {
      item.hidden = at !== index; item.setAttribute('role', 'group'); item.setAttribute('aria-roledescription', 'diapositive');
      item.setAttribute('aria-label', `${at + 1} sur ${items.length}`);
    });
    position.setAttribute('aria-live', manual ? 'polite' : 'off');
    position.textContent = `${index + 1} / ${items.length}`;
    previous.disabled = next.disabled = items.length < 2;
    if (toggle) {
      toggle.textContent = playing ? 'Pause' : 'Lecture';
      toggle.setAttribute('aria-pressed', String(!playing));
      toggle.setAttribute('aria-label', playing ? 'Mettre en pause le défilement automatique' : 'Reprendre le défilement automatique');
    }
  }
  function move(direction, manual = true) {
    if (disposed) return;
    const items = slides(), index = items.findIndex(item => item.dataset.slideId === selected);
    selected = items[(index + direction + items.length) % items.length].dataset.slideId; render(manual); refreshSchedule(true);
  }
  const back = () => move(-1), forward = () => move(1);
  const keyboard = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
  };
  const visibility = () => refreshSchedule(true);
  const enter = () => { hovered = true; refreshSchedule(); }, leave = () => { hovered = false; refreshSchedule(true); };
  const focus = () => { focused = true; refreshSchedule(); };
  const blur = event => { if (!region.contains?.(event.relatedTarget)) { focused = false; refreshSchedule(true); } };
  const toggleRotation = () => { playing = !playing; render(true); refreshSchedule(true); };
  previous.addEventListener('click', back); next.addEventListener('click', forward); region.addEventListener('keydown', keyboard);
  region.addEventListener('mouseenter', enter); region.addEventListener('mouseleave', leave);
  region.addEventListener('focusin', focus); region.addEventListener('focusout', blur);
  doc.addEventListener?.('visibilitychange', visibility); toggle?.addEventListener('click', toggleRotation);
  render(); refreshSchedule();
  return {
    setSlides(items) {
      if (disposed) return;
      const old = [...dynamic.children];
      old.forEach(item => { if (!items.includes(item)) dynamic.removeChild(item); });
      items.forEach((item, index) => { if (dynamic.children[index] !== item) dynamic.insertBefore(item, dynamic.children[index] || null); });
      render(); refreshSchedule();
    },
    dispose() {
      disposed = true; clearTimer(); previous.removeEventListener('click', back); next.removeEventListener('click', forward); region.removeEventListener('keydown', keyboard);
      region.removeEventListener('mouseenter', enter); region.removeEventListener('mouseleave', leave); region.removeEventListener('focusin', focus); region.removeEventListener('focusout', blur);
      doc.removeEventListener?.('visibilitychange', visibility); toggle?.removeEventListener('click', toggleRotation);
    }
  };
}
