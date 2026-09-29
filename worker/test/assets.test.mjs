/**
 * Test for the site's icon and brand-mark wiring.
 *
 * A favicon that 404s is invisible in every other kind of test: the page still
 * loads, the markup still parses. The failure only shows up as a blank tab.
 * This checks that each page declares one and that the file it points at is
 * really there and really an image.
 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

import { repoPath } from './harness.mjs';

const PAGES = ['index.html', 'settings.html', 'privacy.html', 'terms.html'];

let passed = 0; const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

const html = Object.fromEntries(
  PAGES.map((page) => [page, readFileSync(repoPath(page), 'utf8')])
);

/** Every href on a rel=icon / apple-touch-icon link, without the cache buster. */
function iconHrefs(page) {
  const markup = html[page];
  const links = [...markup.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
  return links
    .filter((tag) => /rel="(icon|apple-touch-icon)"/.test(tag))
    .map((tag) => tag.match(/href="([^"]+)"/)[1])
    .map((href) => href.split('?')[0]);
}

function isPng(path) {
  const head = readFileSync(path).subarray(0, 8);
  return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isIco(path) {
  const head = readFileSync(path).subarray(0, 4);
  return head.equals(Buffer.from([0x00, 0x00, 0x01, 0x00]));
}

await test('every page declares a favicon and an Apple touch icon', () => {
  for (const page of PAGES) {
    const hrefs = iconHrefs(page);
    assert.ok(hrefs.some((h) => h.endsWith('.ico')), `${page} declares an .ico`);
    assert.ok(hrefs.some((h) => h.endsWith('.png')), `${page} declares a PNG favicon`);
    assert.ok(
      hrefs.some((h) => h.endsWith('apple-touch-icon.png')),
      `${page} declares an Apple touch icon`
    );
  }
});

await test('every declared icon file exists and is a real image', () => {
  for (const page of PAGES) {
    for (const href of iconHrefs(page)) {
      const path = repoPath(href);
      assert.ok(existsSync(path), `${page} -> ${href} exists`);
      const ok = href.endsWith('.ico') ? isIco(path) : isPng(path);
      assert.ok(ok, `${page} -> ${href} is the image format its name claims`);
    }
  }
});

await test('the settings brand mark uses the logo, not a stand-in glyph', () => {
  const brand = html['settings.html'].match(/<div class="dashboard__brand">[\s\S]*?<\/div>/)[0];
  assert.match(brand, /<img[^>]+class="dashboard__mark"[^>]+src="icons\/logo\.png/, 'the mark is the logo image');
  assert.ok(existsSync(repoPath('icons/logo.png')), 'and the logo file exists');
  assert.ok(isPng(repoPath('icons/logo.png')), 'and is a PNG');
  assert.ok(!/<svg/.test(brand), 'the placeholder SVG is gone');
});

await test('the stylesheet does not paint a background behind the logo', () => {
  // The mark used to be a glyph on a tinted rounded square; the logo is its own
  // filled circle, so any leftover background would ring it.
  const css = readFileSync(repoPath('dashboard.css'), 'utf8');
  const rule = css.match(/\.dashboard__mark\s*\{([^}]*)\}/)[1];
  assert.ok(!/background/.test(rule), 'no background on .dashboard__mark');
  assert.match(rule, /border-radius:\s*50%/, 'the mark is clipped to its own circle');
});

await test('the CSS change carries a new cache-busting version', () => {
  // dashboard.css is served with a ?v= token; without a bump a returning
  // browser keeps the old rule and the logo renders on the old tinted square.
  const tag = html['settings.html'].match(/<link rel="stylesheet" href="dashboard\.css\?v=([^"]+)"/);
  assert.ok(tag, 'dashboard.css is linked with a version');
  assert.notEqual(tag[1], '20260928h', 'the version changed with the stylesheet');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
