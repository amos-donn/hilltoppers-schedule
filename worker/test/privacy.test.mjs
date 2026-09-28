/**
 * Test for privacy.html's contact-email widget.
 *
 * The address is deliberately not written into the page, so the thing worth
 * asserting is that it is in fact absent from the served source -- if someone
 * later "tidies" the button back into a plain mailto or a literal address, that
 * assertion is what fails. The rest checks the parts still join into a usable
 * address when a reader asks for it.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../../privacy.html', import.meta.url), 'utf8');

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.test/privacy.html' });
const { window } = dom;
const $ = (id) => window.document.getElementById(id);

await test('the full address never appears in the page source', () => {
  assert.ok(!html.includes('donn@student.stjacademy.org'),
    'the address must not be written into the markup');
  assert.ok(!/mailto:/i.test(html), 'and not as a mailto link');
});

await test('the address is split into the three expected parts', () => {
  const parts = [...window.document.querySelectorAll('#email-parts [data-part]')]
    .map((b) => b.textContent);
  assert.deepEqual(parts, ['Amos.', 'donn@', 'student.stjacademy.org']);
});

await test('the modal is closed until a reveal button is clicked', () => {
  assert.equal($('email-modal').hidden, true, 'starts closed');
  assert.equal(window.document.querySelectorAll('[data-reveal-email]').length, 3,
    'the address is replaced by three reveal buttons');
  window.document.querySelector('[data-reveal-email]').dispatchEvent(new window.Event('click'));
  assert.equal($('email-modal').hidden, false, 'clicking one opens the modal');
});

await test('selecting every part joins them into the address', () => {
  assert.equal($('email-result').textContent, 'Revealed parts appear here',
    'nothing is shown before the parts are picked');
  for (const part of window.document.querySelectorAll('#email-parts [data-part]')) {
    part.dispatchEvent(new window.Event('click'));
  }
  assert.equal($('email-result').textContent, 'Amos.donn@student.stjacademy.org');
});

await test('closing hides the modal again', () => {
  $('email-close').dispatchEvent(new window.Event('click'));
  assert.equal($('email-modal').hidden, true);
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
if (passed !== results.length) process.exit(1);
