import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, parseProfileFilter } from '../src/config.js';

test('defaults: read only, every 5 minutes', () => {
  const config = normalizeConfig();
  assert.equal(config.apiKey, '');
  assert.equal(config.intervalMs, 300_000);
  assert.equal(config.allowCommands, false);
  assert.equal(config.allowDisable, false);
  assert.equal(config.filter, null);
  assert.equal(DEFAULTS.refresh_interval, '300');
});

test('the options: interval in the list only; disabling needs both options', () => {
  assert.equal(normalizeConfig({ refresh_interval: '3600' }).intervalMs, 3_600_000);
  assert.equal(normalizeConfig({ refresh_interval: '10' }).intervalMs, 300_000);
  assert.equal(normalizeConfig({ allow_disable_protection: true }).allowDisable, false);
  const both = normalizeConfig({ allow_commands: 'true', allow_disable_protection: true });
  assert.equal(both.allowCommands, true);
  assert.equal(both.allowDisable, true);
});

test('the API key: trimmed; an invisible character is said', () => {
  assert.equal(normalizeConfig({ api_key: '  abc  ' }).apiKey, 'abc');
  assert.equal(normalizeConfig({ api_key: 'abc' }).apiKeyInvalid, false);
  assert.equal(normalizeConfig({ api_key: 'a​c' }).apiKeyInvalid, true);
  assert.equal(normalizeConfig({ api_key: 'a c' }).apiKeyInvalid, true);
});

test('the profile filter', () => {
  assert.equal(parseProfileFilter(''), null);
  const filter = parseProfileFilter('abc123, def456;ghi789 x/y');
  assert.deepEqual([...filter.ids], ['abc123', 'def456', 'ghi789']);
  assert.deepEqual(filter.invalid, ['x/y']);
});
