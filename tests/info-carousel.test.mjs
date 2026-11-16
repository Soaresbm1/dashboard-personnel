import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeInfoCarousel } from '../info-carousel.mjs';

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.dataset = {}; this.hidden = false;
    this.disabled = false; this.textContent = ''; this.attributes = {}; this.listeners = new Map();
    this.parentNode = null; this.detached = [];
  }
  replaceChildren(...items) { this.children = items; }
  insertBefore(item, before) {
    if (item === before) return item;
    if (item.parentNode) item.parentNode.removeChild(item);
    const index = before === null ? this.children.length : this.children.indexOf(before);
    if (index < 0) throw new Error('Missing reference child');
    this.children.splice(index, 0, item); item.parentNode = this; return item;
  }
  removeChild(item) {
    const index = this.children.indexOf(item);
    if (index < 0) throw new Error('Missing child');
    this.children.splice(index, 1); item.parentNode = null; this.detached.push(item); return item;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  dispatch(name, event = {}) { this.listeners.get(name)?.(event); }
}
const slide = key => Object.assign(new Element(), { dataset: { slideId: key } });
function fakeClock() {
  let clock = 0, nextId = 1;
  const pending = new Map();
  return {
    now: () => clock,
    setTimeout(callback, delay) { const id = nextId++; pending.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get count() { return pending.size; },
    advance(milliseconds) {
      const until = clock + milliseconds;
      let runs = 0;
      while (true) {
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++runs > 1000) throw new Error('Runaway carousel clock');
        clock = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      clock = until;
    }
  };
}
function harness(options = {}) {
  const ids = ['tech-carousel', 'tech-intranet-slide', 'tech-carousel-slides', 'tech-prev', 'tech-next', 'tech-slide-position'];
  if (options.toggle !== false) ids.push('tech-rotation-toggle');
  const nodes = new Map(ids.map(id => [id, new Element(id)]));
  const get = id => nodes.get(id), fixed = get('tech-intranet-slide'), dynamic = get('tech-carousel-slides');
  const publication = new Element('existing-publication'); publication.textContent = 'Existing intranet publication';
  fixed.children = [publication]; get('tech-carousel').children = [fixed, dynamic];
  const clock = fakeClock(), docEvents = new Element(), windowEvents = new Element();
  const doc = { getElementById: get, hidden: !!options.hidden,
    addEventListener: (...args) => docEvents.addEventListener(...args), removeEventListener: (...args) => docEvents.removeEventListener(...args) };
  const win = { addEventListener: (...args) => windowEvents.addEventListener(...args), removeEventListener: (...args) => windowEvents.removeEventListener(...args) };
  doc.defaultView = win;
  const controller = initializeInfoCarousel(doc, { window: win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
  return { nodes, get, fixed, dynamic, publication, controller, clock, doc, docEvents, windowEvents,
    selected: () => [fixed, ...dynamic.children].find(item => !item.hidden)?.dataset.slideId,
    click: direction => get(direction === 'next' ? 'tech-next' : 'tech-prev').dispatch('click') };
}

test('The existing intranet publication is the first slide and survives every dynamic refresh', () => {
  const h = harness();
  assert.equal(h.selected(), 'intranet'); assert.equal(h.get('tech-slide-position').textContent, '1 / 1');
  assert.equal(h.get('tech-prev').disabled, true); assert.equal(h.get('tech-next').disabled, true);
  h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  assert.equal(h.selected(), 'intranet'); assert.equal(h.get('tech-slide-position').textContent, '1 / 3');
  assert.equal(h.get('tech-prev').disabled, false); assert.equal(h.get('tech-next').disabled, false);
  assert.deepEqual(h.fixed.children, [h.publication]);
  assert.equal(h.get('tech-carousel').children[0], h.fixed);
  h.controller.setSlides([]);
  assert.equal(h.selected(), 'intranet'); assert.deepEqual(h.fixed.children, [h.publication]);
  assert.equal(h.publication.textContent, 'Existing intranet publication');
  assert.equal(h.get('tech-prev').disabled, true);
  h.controller.dispose();
});

test('Previous and next buttons move manually through slides and wrap in both directions', () => {
  const h = harness(), status = slide('status:microsoft'), news = slide('article:a');
  h.controller.setSlides([status, news]);
  h.click('previous'); assert.equal(h.selected(), 'article:a'); assert.equal(h.get('tech-slide-position').textContent, '3 / 3');
  h.click('next'); assert.equal(h.selected(), 'intranet');
  h.click('next'); assert.equal(h.selected(), 'status:microsoft');
  assert.equal(h.fixed.hidden, true); assert.equal(status.hidden, false); assert.equal(news.hidden, true);
  h.click('next'); assert.equal(h.selected(), 'article:a');
  h.click('next'); assert.equal(h.selected(), 'intranet');
  for (const [index, item] of [h.fixed, status, news].entries()) {
    assert.equal(item.attributes.role, 'group');
    assert.equal(item.attributes['aria-roledescription'], 'diapositive');
    assert.equal(item.attributes['aria-label'], `${index + 1} sur 3`);
  }
  h.controller.dispose();
});

test('Arrow keys navigate accessibly while modified arrows and unrelated keys retain their default behavior', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai')]);
  let prevented = 0;
  const key = (name, overrides = {}) => h.get('tech-carousel').dispatch('keydown', { key: name, preventDefault() { prevented++; }, ...overrides });
  key('ArrowRight'); assert.equal(h.selected(), 'status:openai'); assert.equal(prevented, 1);
  key('ArrowLeft'); assert.equal(h.selected(), 'intranet'); assert.equal(prevented, 2);
  key('ArrowLeft'); assert.equal(h.selected(), 'status:openai');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) key('ArrowRight', { [modifier]: true });
  for (const name of ['Tab', 'Enter', 'Escape', 'ArrowDown']) key(name);
  assert.equal(h.selected(), 'status:openai'); assert.equal(prevented, 3);
  h.controller.dispose();
});

test('Refreshing or reordering slides preserves the selected article by key, not its former index or DOM node', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a'), slide('article:b')]);
  h.click('next'); h.click('next'); assert.equal(h.selected(), 'article:a');
  const replacement = slide('article:a');
  h.controller.setSlides([slide('article:c'), slide('article:b'), slide('status:openai'), replacement]);
  assert.equal(h.selected(), 'article:a'); assert.equal(replacement.hidden, false);
  assert.equal(h.get('tech-slide-position').textContent, '5 / 5');
  h.controller.dispose();
});

test('An article removed by a newer feed returns to the intranet rather than selecting an unrelated replacement', () => {
  const h = harness(); h.controller.setSlides([slide('status:anthropic'), slide('article:expired')]);
  h.click('previous'); assert.equal(h.selected(), 'article:expired');
  h.controller.setSlides([slide('status:anthropic'), slide('article:new')]);
  assert.equal(h.selected(), 'intranet'); assert.equal(h.get('tech-slide-position').textContent, '1 / 3');
  assert.deepEqual(h.fixed.children, [h.publication]);
  h.controller.dispose();
});

test('Replacing status observations leaves an unchanged selected news node attached to preserve keyboard focus', () => {
  const h = harness(), oldStatus = slide('status:openai'), article = slide('article:a');
  h.controller.setSlides([oldStatus, article]); h.click('previous');
  assert.equal(h.selected(), 'article:a'); assert.equal(article.parentNode, h.dynamic);
  h.dynamic.detached.length = 0;
  const newStatus = slide('status:openai'); h.controller.setSlides([newStatus, article]);
  assert.equal(h.selected(), 'article:a'); assert.deepEqual(h.dynamic.children, [newStatus, article]);
  assert.equal(h.dynamic.detached.includes(article), false, 'Refreshing a different slide must not detach the current article link');
  assert.equal(article.parentNode, h.dynamic); h.controller.dispose();
});

test('Automatic rotation waits ten full seconds per slide and wraps to the intranet', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  assert.equal(h.selected(), 'intranet'); h.clock.advance(9_999); assert.equal(h.selected(), 'intranet');
  h.clock.advance(1); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(9_999); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(1); assert.equal(h.selected(), 'article:a');
  h.clock.advance(10_000); assert.equal(h.selected(), 'intranet');
  assert.equal(h.clock.count, 1); h.controller.dispose();
});

test('Manual arrows keep working during autoplay and restart a full ten-second reading period', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  h.clock.advance(9_000); h.click('next'); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(1_000); assert.equal(h.selected(), 'status:openai', 'The prior automatic deadline was cancelled');
  h.clock.advance(8_999); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(1); assert.equal(h.selected(), 'article:a');
  h.click('previous'); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(9_999); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(1); assert.equal(h.selected(), 'article:a'); h.controller.dispose();
});

test('Feed refresh preserves the selected key without pushing back an already scheduled rotation', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  h.clock.advance(6_000); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  assert.equal(h.selected(), 'intranet');
  h.clock.advance(3_999); assert.equal(h.selected(), 'intranet');
  h.clock.advance(1); assert.equal(h.selected(), 'status:openai');
  assert.equal(h.clock.count, 1); h.controller.dispose();
});

test('A hidden page pauses rotation and resumes with a fresh ten-second period without a catch-up storm', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  h.clock.advance(6_000); h.doc.hidden = true; h.docEvents.dispatch('visibilitychange');
  assert.equal(h.clock.count, 0); h.clock.advance(120_000); assert.equal(h.selected(), 'intranet');
  h.doc.hidden = false; h.docEvents.dispatch('visibilitychange');
  h.clock.advance(9_999); assert.equal(h.selected(), 'intranet');
  h.clock.advance(1); assert.equal(h.selected(), 'status:openai');
  assert.equal(h.clock.count, 1); h.controller.dispose();
});

test('The pause control stops autoplay while preserving manual arrows, and resume starts a new ten-second period', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  h.clock.advance(4_000); h.get('tech-rotation-toggle').dispatch('click');
  assert.equal(h.clock.count, 0); h.clock.advance(30_000); assert.equal(h.selected(), 'intranet');
  h.click('next'); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(30_000); assert.equal(h.selected(), 'status:openai');
  h.get('tech-rotation-toggle').dispatch('click');
  h.clock.advance(9_999); assert.equal(h.selected(), 'status:openai');
  h.clock.advance(1); assert.equal(h.selected(), 'article:a'); h.controller.dispose();
});

test('A single intranet slide does not run a timer, and removing all extra slides stops rotation', () => {
  const h = harness(); assert.equal(h.clock.count, 0);
  h.controller.setSlides([slide('article:a')]); assert.equal(h.clock.count, 1);
  h.controller.setSlides([]); assert.equal(h.clock.count, 0);
  h.clock.advance(60_000); assert.equal(h.selected(), 'intranet'); h.controller.dispose();
});

test('Hovering or reading with keyboard focus pauses autoplay until the pointer and focus leave the viewport', () => {
  const h = harness(); h.controller.setSlides([slide('status:openai'), slide('article:a')]);
  h.clock.advance(5_000); h.get('tech-carousel').dispatch('mouseenter');
  assert.equal(h.clock.count, 0); h.clock.advance(20_000); assert.equal(h.selected(), 'intranet');
  h.get('tech-carousel').dispatch('focusin'); h.get('tech-carousel').dispatch('mouseleave');
  assert.equal(h.clock.count, 0, 'Keyboard focus keeps the reading slide paused after the pointer leaves');
  h.get('tech-carousel').dispatch('focusout', { relatedTarget: h.publication });
  assert.equal(h.clock.count, 0, 'Moving focus between links in the slide does not resume autoplay');
  h.get('tech-carousel').dispatch('focusout', { relatedTarget: new Element('outside') });
  h.clock.advance(9_999); assert.equal(h.selected(), 'intranet');
  h.clock.advance(1); assert.equal(h.selected(), 'status:openai'); h.controller.dispose();
});

test('An explicit pause remains paused across page hiding and showing', () => {
  const h = harness(); h.controller.setSlides([slide('article:a')]);
  h.get('tech-rotation-toggle').dispatch('click');
  h.doc.hidden = true; h.docEvents.dispatch('visibilitychange'); h.clock.advance(20_000);
  h.doc.hidden = false; h.docEvents.dispatch('visibilitychange'); h.clock.advance(20_000);
  assert.equal(h.selected(), 'intranet'); assert.equal(h.clock.count, 0);
  h.controller.dispose();
});

test('Disposal removes all navigation listeners and ignores late feed updates', () => {
  const h = harness(), article = slide('article:a'); h.controller.setSlides([article]);
  h.click('next'); assert.equal(h.selected(), 'article:a');
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.clock.count, 0); h.clock.advance(60_000);
  h.click('previous'); h.click('next');
  h.get('tech-carousel').dispatch('keydown', { key: 'ArrowLeft', preventDefault() { assert.fail('disposed key listener'); } });
  h.controller.setSlides([slide('article:late')]);
  assert.equal(h.selected(), 'article:a'); assert.deepEqual(h.dynamic.children, [article]);
  assert.equal(h.get('tech-prev').listeners.size, 0); assert.equal(h.get('tech-next').listeners.size, 0);
  assert.equal(h.get('tech-carousel').listeners.size, 0);
  assert.equal(h.docEvents.listeners.size, 0);
});

test('Missing carousel markup is ignored without changing unrelated document content', () => {
  assert.equal(initializeInfoCarousel({ getElementById: () => null }), null);
});
