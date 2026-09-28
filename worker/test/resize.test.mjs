/**
 * Integration test for the Topping height reporter (toppings-resize.js).
 *
 * The extension cannot measure a cross-origin iframe, so the page has to report
 * its own height over postMessage. Every rule in that protocol is a way the
 * frame could get stuck or be fed a bogus number, so each one is pinned here:
 * the early returns for a direct visit and an unframed load, the full set of
 * message checks, the measurement formula, and -- the case a naive
 * document.scrollHeight gets wrong -- that the reported height shrinks again
 * when the content does.
 *
 * jsdom has no ResizeObserver, no layout, and a `parent` that is always itself,
 * so all three are stubbed. That is the point: the geometry is fed in, so the
 * arithmetic and the guards are what is under test, not the browser's layout.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const CHANNEL = 'hilltoppers-topping-v1';
const HOST = 'https://extension.test';
const SESSION = 'sess-9f2c';

const resizeScript = readFileSync(new URL('../../toppings-resize.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/**
 * Mount the reporter in a page with one content wrapper.
 *
 * `framed: false` leaves jsdom's own `parent === window`, which is the
 * "opened directly" case the script must bail out of. `bottom` is the wrapper's
 * measured bottom edge; a test changes it and fires the observer to simulate
 * content growing or shrinking.
 */
function mount({ search = '', framed = true, wrapper = true, bottom = 500, scrollY = 0,
                 paddingBottom = '0px', marginBottom = '0px' } = {}) {
  const errors = [];
  const posts = [];
  const observers = [];
  const parent = { postMessage: (message, targetOrigin) => posts.push({ message, targetOrigin }) };

  const body = wrapper ? '<div id="content" data-topping-content></div>' : '';
  // After the wrapper, the way a deferred script runs after parse -- the script
  // looks the wrapper up as soon as it runs.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}`
    + `<script>${resizeScript}</script></body></html>`;

  const d = new JSDOM(html, {
    url: `https://amos-donn.github.io/hilltoppers-schedule/index.html${search}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
      if (framed) Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
      window.requestAnimationFrame = (cb) => { cb(0); return 0; };
      window.ResizeObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); }
        observe(target) { this.target = target; }
        unobserve() {}
        disconnect() {}
      };
      window.Element.prototype.getBoundingClientRect = function () {
        return { top: 0, bottom, left: 0, right: 0, width: 100, height: bottom, x: 0, y: 0, toJSON() {} };
      };
      const realGet = window.getComputedStyle.bind(window);
      window.getComputedStyle = (el, ...rest) =>
        (el === window.document.body ? { paddingBottom, marginBottom } : realGet(el, ...rest));
    },
  });

  const w = d.window;
  return {
    window: w,
    errors,
    posts,
    observers,
    parent,
    content: w.document.getElementById('content'),
    /** Change the wrapper's measured bottom edge and notify the observer. */
    setBottom(next) { bottom = next; observers.forEach((o) => o.cb([])); },
    fireObserver() { observers.forEach((o) => o.cb([])); },
    fireWindowResize() { w.dispatchEvent(new w.Event('resize')); },
    /** A well-formed context message, with any field overridable. */
    context(overrides = {}) {
      const data = { channel: CHANNEL, session: SESSION, type: 'context', heightMode: 'content', ...overrides };
      const source = 'source' in overrides ? overrides.source : parent;
      const origin = 'origin' in overrides ? overrides.origin : HOST;
      const ev = new w.MessageEvent('message', { data, origin, source });
      w.dispatchEvent(ev);
    },
    heights: () => posts.map((p) => p.message.height),
    message: (i) => posts[i].message,
  };
}

const embedSearch = `?session=${SESSION}&host=${encodeURIComponent(HOST)}`;

const results = [];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

// ---------------------------------------------------------------------------
// Opened directly: nothing happens, whatever arrives.
// ---------------------------------------------------------------------------
await test('a direct visit with no query params never posts', async () => {
  const p = mount();
  p.context();
  p.setBottom(900);
  p.fireWindowResize();
  assert.equal(p.posts.length, 0, 'no height was reported');
  assert.equal(p.errors.length, 0, p.errors.join(' | '));
});

await test('the reporter stands down when it is not framed, even with params', async () => {
  const p = mount({ search: embedSearch, framed: false });
  p.context();
  p.setBottom(900);
  assert.equal(p.posts.length, 0, 'parent === window means nothing is posted');
});

await test('with no content wrapper there is nothing to measure and no post', async () => {
  const p = mount({ search: embedSearch, wrapper: false });
  p.context();
  assert.equal(p.posts.length, 0, 'the script bailed out');
});

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------
await test('in content mode it reports the measured height to the host', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  assert.equal(p.posts.length, 1, 'one report');
  // The message is built inside the jsdom realm, so it is copied into a plain
  // object before the strict deep comparison.
  assert.deepEqual({ ...p.message(0) }, { channel: CHANNEL, session: SESSION, type: 'resize', height: 500 });
  assert.equal(p.posts[0].targetOrigin, HOST, 'posted to the host origin, not "*"');
});

await test('the height is the wrapper plus body padding and margin', async () => {
  const p = mount({
    search: embedSearch, bottom: 420, scrollY: 13,
    paddingBottom: '12px', marginBottom: '7px',
  });
  p.context();
  assert.deepEqual(p.heights(), [452], 'bottom + scrollY + padding + margin');
});

await test('the height is rounded up, so a fractional layout is never under-reported', async () => {
  const p = mount({ search: embedSearch, bottom: 400.2 });
  p.context();
  assert.deepEqual(p.heights(), [401]);
});

await test('a height of zero or less is never reported', async () => {
  const p = mount({ search: embedSearch, bottom: -40 });
  p.context();
  assert.deepEqual(p.heights(), [], 'a non-positive height is rejected');
});

// ---------------------------------------------------------------------------
// Growing and shrinking.
// ---------------------------------------------------------------------------
await test('content growing reports a larger height', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  p.setBottom(880);
  assert.deepEqual(p.heights(), [500, 880]);
});

await test('content shrinking reports a SMALLER height', async () => {
  // The case document.scrollHeight gets wrong: the iframe viewport is included,
  // so the page grows and never comes back down. A natural-height wrapper has
  // to be able to report a height below the previous one.
  const p = mount({ search: embedSearch, bottom: 900 });
  p.context();
  p.setBottom(420);
  assert.deepEqual(p.heights(), [900, 420], 'the smaller height was reported');
  p.setBottom(300);
  assert.deepEqual(p.heights(), [900, 420, 300], 'and again on the next shrink');
});

await test('an unchanged height is not reported twice', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  p.setBottom(500);
  p.fireWindowResize();
  p.fireObserver();
  assert.deepEqual(p.heights(), [500], 'the duplicate was suppressed');
  p.setBottom(501);
  assert.deepEqual(p.heights(), [500, 501], 'but a real change still gets through');
});

await test('a window resize re-measures', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  p.setBottom(640);
  p.fireWindowResize();
  assert.deepEqual(p.heights(), [500, 640]);
});

// ---------------------------------------------------------------------------
// The ResizeObserver is what catches async layout changes.
// ---------------------------------------------------------------------------
await test('a ResizeObserver watches the content wrapper', async () => {
  const p = mount({ search: embedSearch });
  p.context();
  assert.equal(p.observers.length, 1, 'one observer');
  assert.equal(p.observers[0].target, p.content, 'observing the content wrapper, not the document');
});

await test('a later layout change (an image or web font) is picked up with no extra work', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  // Nothing else fires: only the observer callback, as a real async reflow would.
  p.setBottom(733);
  assert.deepEqual(p.heights(), [500, 733]);
});

// ---------------------------------------------------------------------------
// Height mode is re-checked on every context message.
// ---------------------------------------------------------------------------
await test('in fixed mode nothing is reported, even as content changes', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context({ heightMode: 'fixed' });
  p.setBottom(900);
  p.fireWindowResize();
  assert.deepEqual(p.heights(), [], 'fixed mode stays silent');
});

await test('a missing or unknown heightMode is not content mode', async () => {
  const p = mount({ search: embedSearch });
  p.context({ heightMode: undefined });
  p.setBottom(900);
  assert.deepEqual(p.heights(), [], 'no mode means no reporting');
});

await test('switching content -> fixed stops reporting', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  assert.deepEqual(p.heights(), [500]);
  p.context({ heightMode: 'fixed' });
  p.setBottom(900);
  p.fireWindowResize();
  assert.deepEqual(p.heights(), [500], 'nothing more after the switch');
});

await test('switching fixed -> content starts reporting', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context({ heightMode: 'fixed' });
  p.setBottom(600);
  assert.deepEqual(p.heights(), []);
  p.context();
  assert.deepEqual(p.heights(), [600], 'the current height is reported as soon as content mode is on');
});

await test('re-entering content mode re-reports even when the height is unchanged', async () => {
  // The host resets its frame to the fixed layout on every mode change and
  // waits for a fresh report, so "Fit content" must answer even if nothing
  // moved -- otherwise the frame stays stuck at the fixed height.
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  assert.deepEqual(p.heights(), [500]);
  p.context({ heightMode: 'fixed' });
  p.context();
  assert.deepEqual(p.heights(), [500, 500], 'the unchanged height was re-reported on re-entry');
});

await test('the repeating context message does not re-report in steady content mode', async () => {
  const p = mount({ search: embedSearch, bottom: 500 });
  p.context();
  p.context();
  p.context();
  assert.deepEqual(p.heights(), [500], 'only the first of the repeated messages reported');
});

// ---------------------------------------------------------------------------
// Every message field is checked.
// ---------------------------------------------------------------------------
await test('a message with the wrong session is ignored', async () => {
  const p = mount({ search: embedSearch });
  p.context({ session: 'someone-elses-session' });
  assert.deepEqual(p.heights(), []);
});

await test('a message from the wrong origin is ignored', async () => {
  const p = mount({ search: embedSearch });
  p.context({ origin: 'https://evil.test' });
  assert.deepEqual(p.heights(), []);
});

await test('a message from a window other than the parent is ignored', async () => {
  const p = mount({ search: embedSearch });
  p.context({ source: p.window });
  assert.deepEqual(p.heights(), []);
});

await test('a message on another channel is ignored', async () => {
  const p = mount({ search: embedSearch });
  p.context({ channel: 'something-else-v1' });
  assert.deepEqual(p.heights(), []);
});

await test('a message that is not a context message is ignored', async () => {
  const p = mount({ search: embedSearch });
  p.context({ type: 'resize' });
  p.context({ type: 'anything' });
  assert.deepEqual(p.heights(), []);
});

await test('a non-object message does not throw', async () => {
  const p = mount({ search: embedSearch });
  for (const data of [null, undefined, 'context', 42]) {
    const ev = new p.window.MessageEvent('message', { data, origin: HOST, source: p.parent });
    p.window.dispatchEvent(ev);
  }
  assert.deepEqual(p.heights(), [], 'still nothing reported');
  assert.equal(p.errors.length, 0, p.errors.join(' | '));
});

// ---------------------------------------------------------------------------
// The page is actually wired for this.
// ---------------------------------------------------------------------------
await test('index.html loads the reporter deferred, after the wrapper', async () => {
  assert.match(indexHtml, /<script src="toppings-resize\.js[^"]*" defer><\/script>/, 'deferred script tag');
  const wrapperAt = indexHtml.indexOf('data-topping-content');
  const scriptAt = indexHtml.indexOf('toppings-resize.js');
  assert.ok(wrapperAt !== -1, 'the content wrapper exists');
  assert.ok(scriptAt > wrapperAt, 'the wrapper is in the document before the script runs');
});

await test('index.html carries the CSS fit-content mode depends on', async () => {
  assert.match(indexHtml, /html, body \{ margin: 0; min-height: 0; \}/, 'html/body can shrink below their initial height');
  assert.match(indexHtml, /\[?#root[^\n]*display: flow-root/, 'the wrapper stops child margins collapsing through it');
});

await test('nothing reintroduces a viewport-height wrapper', async () => {
  // height:100vh / min-height:100% on html, body or the wrapper would pin the
  // frame at its tallest point -- the exact bug content mode exists to avoid.
  const styleBlock = indexHtml.split('<style>')[1].split('</style>')[0];
  assert.doesNotMatch(styleBlock, /100vh|100dvh/, 'no viewport units in the page styles');
  assert.doesNotMatch(styleBlock, /min-height:\s*100%/, 'no percentage min-height');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
