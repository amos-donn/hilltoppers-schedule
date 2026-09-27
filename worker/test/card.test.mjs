/**
 * Integration test for the schedule card (index.html).
 *
 * The settings page writes friend entries that carry courses, lunch wave, grade
 * and time format. This proves the existing card consumes that shape. It mounts
 * the real page (with the schedule data served locally) and then, rather than
 * asserting on the rendered text, drives the card's own display resolver with a
 * saved friend entry.
 *
 * Rendering the block names depends on the time of day -- outside school hours
 * the card correctly shows "School ended" -- so asserting on visible course
 * names would pass or fail depending on when the suite runs. The resolver is the
 * function the card uses to turn a friend's blockPrefs into a label, so testing
 * it directly proves the integration without depending on the clock.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The repository root, so the tests can be run from anywhere.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoPath = (...parts) => join(ROOT, ...parts);


const rawHtml = readFileSync(repoPath('index.html'), 'utf8');
const EST = 'America/New_York';

// A real school day for any weekday this might run on.
const specialDays = {};
for (let offset = -2; offset <= 14; offset++) {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: EST }).format(new Date(Date.now() + offset * 86400000));
  specialDays[key] = { type: 'abdec', color: 'Green Day' };
}
const abdec = readFileSync(repoPath('schedule/abdec.json'), 'utf8');

function serve(url) {
  if (url.endsWith('special_days.json')) return new Response(JSON.stringify(specialDays), { status: 200 });
  if (url.endsWith('special_periods.json')) return new Response('[]', { status: 200 });
  if (url.endsWith('day_type.json')) return new Response('{}', { status: 200 });
  if (url.endsWith('abdec.json')) return new Response(abdec, { status: 200 });
  return new Response('null', { status: 200 });
}

// jsdom runs the page's own inline script during parse, before the externals can
// be supplied, so strip every script and inject them in order.
const inline = rawHtml.split('<script>').pop().split('</script>')[0];
const html = rawHtml.replace(/<script[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(html, {
  url: 'https://amos-donn.github.io/hilltoppers-schedule/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (input) => serve(typeof input === 'string' ? input : input.url);
  },
});
const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

// Exactly what the settings page saves for a friend added from the directory.
const friend = {
  email: 'brave-heron-4821',
  name: 'Erin',
  grade: 11,
  lunchWave: 1,
  timeFormat: '24h',
  blockPrefs: {
    A: { name: 'Chemistry', alternating: false },
    B: { name: 'English', alternating: false },
    C: { name: 'Physics', alternating: false },
    D: { name: 'History', alternating: false },
    E: { name: 'Free Block', alternating: false, free: true },
  },
};
window.localStorage.setItem('friends', JSON.stringify([friend]));
window.localStorage.setItem('selectedFriend', 'brave-heron-4821');

for (const f of ['schedule-core.js', 'schedule-card.js']) {
  const s = window.document.createElement('script');
  s.textContent = readFileSync(repoPath(f), 'utf8');
  window.document.head.appendChild(s);
}
const s2 = window.document.createElement('script');
s2.textContent = inline;
window.document.body.appendChild(s2);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n        ${e && e.message}`); }
}

await test('the card mounts without error', async () => {
  await wait(300);
  assert.equal(errors.length, 0, errors.join(' | '));
  assert.ok(window.document.getElementById('root').children.length > 0, 'something rendered');
});

await test('the seeded friend appears as the selected friend', async () => {
  const text = window.document.getElementById('root').textContent;
  assert.match(text, /Erin/, 'the friend name is shown');
  assert.match(text, /brave-heron-4821/, 'and their profile ID');
});

await test('the card can load a real school day of blocks', async () => {
  const schedule = await window.HT.loadBlocksForDate(new Date());
  assert.notEqual(schedule.networkFailed, true, 'the schedule data loaded');
  assert.ok(schedule.blocks.length > 0, 'blocks are available to render');
});

await test('the saved friend entry resolves to their custom course names', async () => {
  // This is the exact function the card calls to label each block for a friend.
  const display = window.HT.resolveBlockDisplay('A Block', 'Green Day', friend.blockPrefs);
  assert.equal(display.label, 'Chemistry', 'the friend\'s own course name is used');
  assert.equal(display.isFree, false);

  const free = window.HT.resolveBlockDisplay('E Block', 'Green Day', friend.blockPrefs);
  assert.equal(free.isFree, true, 'a free block stays free');
});

await test('a friend with no courses still resolves to the real block name', async () => {
  // The card always passes a normalised prefs object, never a bare {}.
  const display = window.HT.resolveBlockDisplay('A Block', 'Green Day', window.HT.createEmptyPreferences());
  assert.equal(display.label, 'A Block', 'the default label is used rather than a blank');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length - passed ? 1 : 0);
