/**
 * Test for the contact-email widget on the legal pages.
 *
 * The address is deliberately not written into either page, so the thing worth
 * asserting is that it is in fact absent from the served source -- if someone
 * later "tidies" a button back into a plain mailto, a literal address, or the
 * old [[CONTACT EMAIL]] placeholder, that assertion is what fails. The rest
 * checks the parts still join into a usable address when a reader asks.
 *
 * Both pages carry the widget, so both are checked. They have different numbers
 * of reveal buttons: privacy.html links to the address three times, terms.html
 * once.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

const PAGES = [
  { file: 'privacy.html', revealButtons: 3 },
  { file: 'terms.html', revealButtons: 1 },
];

for (const page of PAGES) {
  const html = readFileSync(new URL(`../../${page.file}`, import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: `https://example.test/${page.file}` });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);

  await test(`${page.file}: the full address never appears in the page source`, () => {
    assert.ok(!html.includes('donn@student.stjacademy.org'),
      'the address must not be written into the markup');
    assert.ok(!/mailto:/i.test(html), 'and not as a mailto link');
    assert.ok(!html.includes('[['), 'and no placeholder is left unreplaced');
  });

  await test(`${page.file}: the address is split into the three expected parts`, () => {
    const parts = [...window.document.querySelectorAll('#email-parts [data-part]')]
      .map((b) => b.textContent);
    assert.deepEqual(parts, ['Amos.', 'donn@', 'student.stjacademy.org']);
  });

  await test(`${page.file}: the modal is closed until a reveal button is clicked`, () => {
    assert.equal($('email-modal').hidden, true, 'starts closed');
    assert.equal(window.document.querySelectorAll('[data-reveal-email]').length, page.revealButtons,
      'every link to the address is a reveal button');
    window.document.querySelector('[data-reveal-email]').dispatchEvent(new window.Event('click'));
    assert.equal($('email-modal').hidden, false, 'clicking one opens the modal');
  });

  await test(`${page.file}: selecting every part joins them into the address`, () => {
    assert.equal($('email-result').textContent, 'Revealed parts appear here',
      'nothing is shown before the parts are picked');
    for (const part of window.document.querySelectorAll('#email-parts [data-part]')) {
      part.dispatchEvent(new window.Event('click'));
    }
    assert.equal($('email-result').textContent, 'Amos.donn@student.stjacademy.org');
  });

  await test(`${page.file}: closing hides the modal again`, () => {
    $('email-close').dispatchEvent(new window.Event('click'));
    assert.equal($('email-modal').hidden, true);
  });
}

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
if (passed !== results.length) process.exit(1);
