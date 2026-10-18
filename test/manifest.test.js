// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, REFRESH_INTERVALS } from '../src/constants.js';
import { buildProfileDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-nextdns:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-nextdns');
  assert.equal(lock.name, 'gladys-nextdns');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with NextDNS/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec NextDNS/);
  assert.match(read('docs/en.md'), /never been tested against a real NextDNS account/i);
  assert.match(read('docs/fr.md'), /jamais été testée sur un vrai compte NextDNS/i);
});

test('the license (no name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  // Only the placeholder of the appendix: no year, no holder.
  assert.doesNotMatch(license, /Copyright\s+(\(c\)|©|\d{4})/i);
  assert.doesNotMatch(license, /LM1LC3N7|lmilcent|Louis/i);
  assert.match(
    read('THIRD_PARTY_NOTICES.md'),
    /bieniu\/nextdns[\s\S]*5\.1\.0[\s\S]*Apache License/,
  );
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; commands off by default; the key is a secret', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.refresh_interval.options.map((o) => o.value),
    REFRESH_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'api_key',
    'profiles',
    'refresh_interval',
    'security_section',
    'allow_commands',
    'allow_disable_protection',
  ]);
  assert.equal(fields.api_key.type, 'secret');
  assert.match(fields.api_key.description.en, /never shown again, sent only to api\.nextdns\.io/);
  assert.match(
    fields.api_key.description.fr,
    /jamais réaffichée, envoyée seulement à api\.nextdns\.io/,
  );
  // A secret field is NOT encrypted by Gladys (kept in its database): never say so.
  const keyTexts = JSON.stringify(fields.api_key);
  assert.doesNotMatch(keyTexts, /chiffr|encrypt/i);
  for (const doc of ['docs/en.md', 'docs/fr.md', 'README.md']) {
    assert.doesNotMatch(
      read(doc),
      /(cl[ée]|key)[^.\n]{0,40}(chiffr|encrypt)|(chiffr|encrypt)[^.\n]{0,20}(cl[ée] d|API key)/i,
      `${doc} never says the key is encrypted`,
    );
  }
  assert.equal(fields.allow_commands.default, false);
  assert.equal(fields.allow_disable_protection.default, false);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  for (const absent of ['scene_actions', 'scene_triggers', 'widgets']) {
    assert.equal(manifest[absent], undefined, absent);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('units and categories: only those of the core; never a switch', () => {
  const gladys = createFakeGladys({ selector: 'nextdns' });
  const device = buildProfileDevice(gladys, { id: 'abc123', name: 'Home' }, ['tiktok']);
  const allowed = new Set(['counter-sensor', 'unknown', 'text']);
  for (const feature of device.features) {
    assert.ok(allowed.has(feature.category), `${feature.name}: ${feature.category}`);
    // None of these categories lists a unit in DEVICE_FEATURE_UNITS_BY_CATEGORY.
    assert.equal(feature.unit, undefined, feature.name);
  }
  assert.ok(Object.values(DEVICE_FEATURE_UNITS).length > 0);
  assert.equal(new Set(device.features.map((f) => f.external_id)).size, device.features.length);
  const select = device.features.find((f) => f.type === 'select');
  const values = select.supported_options.map((o) => o.value);
  assert.equal(new Set(values).size, values.length, 'no duplicate option');
  assert.ok(select.supported_options.every((o) => typeof o.label === 'string' && o.label.trim()));
});
