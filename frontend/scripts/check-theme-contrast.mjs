import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../src/index.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

function collectVariables(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  const variables = new Map();

  for (const [, block] of blocks) {
    for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      variables.set(match[1], match[2].trim());
    }
  }

  return variables;
}

function parseHsl(value) {
  const match = value.match(/^hsl\(\s*(-?[\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  assert(match, `Expected an opaque hsl() colour, received: ${value}`);

  const [, hueText, saturationText, lightnessText] = match;
  const hue = ((Number(hueText) % 360) + 360) % 360;
  const saturation = Number(saturationText) / 100;
  const lightness = Number(lightnessText) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;

  let rgb;
  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  return rgb.map((channel) => channel + offset);
}

function luminance(value) {
  return parseHsl(value)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function requireVariables(themeName, variables, names) {
  for (const name of names) {
    assert(variables.has(name), `${themeName} theme is missing --${name}`);
  }
}

const dark = collectVariables(':root');
const light = collectVariables(':root[data-theme="light"]');
const requiredThemeVariables = [
  'bg-base',
  'bg-card',
  'bg-input',
  'bg-input-disabled',
  'bg-input-readonly',
  'border-focus',
  'text-primary',
  'text-secondary',
  'text-dim',
  'text-placeholder',
  'text-disabled',
  'text-on-accent',
  'accent',
  'ok',
  'warn',
  'error',
  'info',
  'violet',
  'cyan',
  'lime',
  'backdrop-soft',
  'backdrop-strong',
];

requireVariables('Dark', dark, requiredThemeVariables);
requireVariables('Light', light, requiredThemeVariables);

assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark/s, 'Dark native controls must opt in to dark color-scheme');
assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/s, 'Light native controls must opt in to light color-scheme');
assert.match(css, /input:not\(\[type='checkbox'\]\)/, 'Bare text-like inputs must use the shared control styles');
assert.match(css, /select option, select optgroup/, 'Native select menus must receive theme colours');
assert.match(css, /::placeholder/, 'Inputs must define a themed placeholder state');
assert.match(css, /:disabled/, 'Inputs must define a themed disabled state');
assert.match(css, /:-webkit-autofill/, 'Autofilled inputs must preserve the active theme');

const textPairs = [
  ['text-primary', 'bg-input'],
  ['text-secondary', 'bg-input'],
  ['text-dim', 'bg-input'],
  ['text-placeholder', 'bg-input'],
  ['text-disabled', 'bg-input-disabled'],
  ['accent', 'bg-input'],
  ['ok', 'bg-card'],
  ['warn', 'bg-card'],
  ['error', 'bg-card'],
  ['info', 'bg-card'],
  ['violet', 'bg-card'],
  ['cyan', 'bg-card'],
  ['lime', 'bg-card'],
];

for (const [themeName, variables] of [['Dark', dark], ['Light', light]]) {
  for (const [foregroundName, backgroundName] of textPairs) {
    const ratio = contrast(variables.get(foregroundName), variables.get(backgroundName));
    assert(
      ratio >= 4.5,
      `${themeName} --${foregroundName} on --${backgroundName} has ${ratio.toFixed(2)}:1 contrast; expected at least 4.5:1`,
    );
  }

  const onAccentRatio = contrast(variables.get('text-on-accent'), variables.get('accent'));
  assert(
    onAccentRatio >= 4.5,
    `${themeName} --text-on-accent on --accent has ${onAccentRatio.toFixed(2)}:1 contrast; expected at least 4.5:1`,
  );
}

console.log('Theme contract passed: native controls are covered and both palettes meet WCAG AA text contrast.');
