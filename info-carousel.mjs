export function initializeInfoCarousel(doc) {
  const get = id => doc.getElementById(id), region = get('tech-carousel'), fixed = get('tech-intranet-slide'), dynamic = get('tech-carousel-slides');
  const previous = get('tech-prev'), next = get('tech-next'), position = get('tech-slide-position');
  if (!region || !fixed || !dynamic || !previous || !next || !position) return null;
  let selected = 'intranet', disposed = false;
  fixed.dataset.slideId = 'intranet';
  const slides = () => [fixed, ...dynamic.children];
  function render() {
    const items = slides();
    if (!items.some(item => item.dataset.slideId === selected)) selected = 'intranet';
    const index = items.findIndex(item => item.dataset.slideId === selected);
    items.forEach((item, at) => {
      item.hidden = at !== index; item.setAttribute('role', 'group'); item.setAttribute('aria-roledescription', 'diapositive');
      item.setAttribute('aria-label', `${at + 1} sur ${items.length}`);
    });
    position.textContent = `${index + 1} / ${items.length}`;
    previous.disabled = next.disabled = items.length < 2;
  }
  function move(direction) {
    if (disposed) return;
    const items = slides(), index = items.findIndex(item => item.dataset.slideId === selected);
    selected = items[(index + direction + items.length) % items.length].dataset.slideId; render();
  }
  const back = () => move(-1), forward = () => move(1);
  const keyboard = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
  };
  previous.addEventListener('click', back); next.addEventListener('click', forward); region.addEventListener('keydown', keyboard);
  render();
  return {
    setSlides(items) {
      if (disposed) return;
      const old = [...dynamic.children];
      old.forEach(item => { if (!items.includes(item)) dynamic.removeChild(item); });
      items.forEach((item, index) => { if (dynamic.children[index] !== item) dynamic.insertBefore(item, dynamic.children[index] || null); });
      render();
    },
    dispose() { disposed = true; previous.removeEventListener('click', back); next.removeEventListener('click', forward); region.removeEventListener('keydown', keyboard); }
  };
}
