/**
 * Coverage test for src/motion.css.
 *
 * The keymap's key settle-in comes from `transition: all` on the keycap family,
 * which lives in the official bundles and therefore cannot be edited - so the
 * override has to cover every one of those rules. This test pins the set of
 * official rules (each one read out of the official main.js component styles)
 * and fails if motion.css stops neutralising any of them.
 *
 * It also checks the override is properly scoped: it must only touch the keycap
 * family, must not use `animation: none` (that would drop the -active keycaps'
 * end state), and must not claim any property other than transition /
 * animation-duration.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'src', 'motion.css'), 'utf8');

/** Official rules that make keys settle in or fade, as found in the shipped bundle. */
const OFFICIAL = [
  { selector: '.keycap-wrapper', motion: 'transition', classes: ['keycap-wrapper'] },
  { selector: '.keycap-wrapper > .keycap-key > .keycap', motion: 'transition', classes: ['keycap', 'keycap-key'] },
  { selector: '.keycap-wrapper .wheel-direction > div', motion: 'transition', classes: ['wheel-direction'] },
  { selector: '.keycap-wrapper .stick-direction > div', motion: 'transition', classes: ['stick-direction'] },
  { selector: '.keycap-wrapper .keycap-left > div', motion: 'transition', classes: ['keycap-left'] },
  { selector: '.keycap-wrapper .keycap-right > div', motion: 'transition', classes: ['keycap-right'] },
  { selector: '.wheel-direction-up', motion: 'animation', classes: ['wheel-direction-up'] },
  { selector: '.wheel-direction-down', motion: 'animation', classes: ['wheel-direction-down'] },
  { selector: '.stick-direction-up', motion: 'animation', classes: ['stick-direction-up'] },
  { selector: '.stick-direction-down', motion: 'animation', classes: ['stick-direction-down'] },
  { selector: '.stick-direction-left', motion: 'animation', classes: ['stick-direction-left'] },
  { selector: '.stick-direction-right', motion: 'animation', classes: ['stick-direction-right'] },
  { selector: '.keycap-left-active', motion: 'animation', classes: ['keycap-left-active'] },
  { selector: '.keycap-right-active', motion: 'animation', classes: ['keycap-right-active'] },
];

/** Parse the override into { selectors: [...], body } blocks, comments stripped. */
function parseRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes('@')) continue;
    const selectors = match[1]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    rules.push({ selectors, body: match[2].replace(/\s+/g, ' ').trim() });
  }
  return rules;
}

const rules = parseRules(css);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. Every official motion rule must be neutralised by a scoped !important rule.
for (const entry of OFFICIAL) {
  const wanted = entry.motion === 'transition' ? 'transition: none !important' : 'animation-duration: 0s !important';
  const hit = rules.find(
    (rule) => rule.body.includes(wanted) && rule.selectors.some((s) => entry.classes.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(s))),
  );
  check(`覆盖 ${entry.selector} 的 ${entry.motion}`, Boolean(hit), hit ? hit.selectors.join(', ') : '未覆盖');
}

// 2. Scoping: only the keycap family may be touched.
const ALLOWED = /keycap|wheel-direction|stick-direction/;
const stray = rules.flatMap((r) => r.selectors).filter((s) => !ALLOWED.test(s));
check('覆盖范围仅限键帽家族', stray.length === 0, stray.join(' | ') || '没有越界选择器');

// 3. `animation: none` would freeze the -active keycaps at their start position.
check('未使用 animation:none（保住了 -active 终态）', !/animation\s*:\s*none/.test(css), '');

// 4. No other property is forced.
const forced = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([a-z-]+)\s*:[^;{}]*!important/g)].map((m) => m[1]);
const unwanted = [...new Set(forced)].filter((p) => p !== 'transition' && p !== 'animation-duration');
check('只强制 transition / animation-duration', unwanted.length === 0, unwanted.join(' | ') || '干净');

// 5. The -active rules must keep the animation's fill behaviour.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
check('保留了动画终态语义（未改 fill-mode / display）', !/fill-mode|display\s*:/.test(code), '');

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -> ${c.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);