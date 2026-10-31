// Admin colour system (plan Task 32): readable in light and dark, kiosk stays black/white.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const block = name => {
  const m = new RegExp(`/\\* tokens:${name} \\*/([\\s\\S]*?)/\\* end tokens:${name} \\*/`).exec(css);
  assert.ok(m, `missing tokens:${name} block`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(x => [x[1], x[2]]));
};
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const TABS = ['dashboard', 'roster', 'report', 'shifts', 'employees', 'payments', 'audit', 'settings'];
const TYPES = ['cafe', 'bakery', 'training', 'delivery', 'bake', 'bkyc', 'off'];

for(const mode of ['light']){
  test(`every colour pair is readable (WCAG ≥ 4.5) in ${mode} mode`, () => {
    const t = block(mode);
    for(const k of TABS) assert.ok(contrast(t[`c-${k}`], t[`c-${k}-soft`]) >= 4.5, `tab tint ${k}`);
    for(const k of TABS) assert.ok(contrast(t[`c-${k}`], t['on-accent']) >= 4.5, `tab ${k}: ${contrast(t[`c-${k}`], t['on-accent']).toFixed(2)}`);
    for(const k of TYPES) assert.ok(contrast(t[`t-${k}-bg`], t[`t-${k}-fg`]) >= 4.5, `type ${k}`);
    for(const k of ['on', 'break', 'late', 'ok']) assert.ok(contrast(t[`s-${k}`], t.paper) >= 4.5, `status ${k}`);
  });
}

test('each admin tab sets its accent; kiosk rules never use colour tokens', () => {
  for(const k of TABS) assert.match(css, new RegExp(`#app\\.admin\\[data-tab="${k}"\\]\\{--accent:var\\(--c-${k}\\)\\}`));
  const kioskRules = [...css.matchAll(/(^|\})\s*([^{}]*\.(kiosk|keys|pins|status|card|clockcard)[^{}]*)\{([^}]*)\}/gm)];
  assert.ok(kioskRules.length > 3);
  for(const r of kioskRules) assert.doesNotMatch(r[4], /var\(--(c|t|s)-/, r[2]);
});

test('one light theme: no dark mode rules, no theme switch', () => {
  assert.doesNotMatch(css, /prefers-color-scheme|data-theme="dark"/);
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.doesNotMatch(js, /themeCycle|name="theme"/);
});
