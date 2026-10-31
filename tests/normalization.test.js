'use strict';

/**
 * Country detection and server-name normalization tests.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCountry,
  flagFor,
  codeFromFlag,
} = require('../src/services/country-detector');
const { normalizeServerName } = require('../src/services/configuration-parser');

describe('normalizeServerName', () => {
  const cases = [
    ['Netherlands 001', 'Netherlands 01'],
    ['Netherlands 002', 'Netherlands 02'],
    ['Netherlands 010', 'Netherlands 10'],
    ['Netherlands 1', 'Netherlands 01'],
    ['Netherlands 100', 'Netherlands 100'],
    ['United States 781', 'United States 781'],
    ['United States 007', 'United States 07'],
    ['Canada 794', 'Canada 794'],
    ['Japan 010', 'Japan 10'],
    ['PlainName', 'PlainName'],
    ['  Extra   spaces  ', 'Extra spaces'],
    ['Server-0042', 'Server 42'],
    ['No digits here', 'No digits here'],
    ['123', '123'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" -> "${expected}"`, () => {
      assert.equal(normalizeServerName(input), expected);
    });
  }

  test('does not touch digits in the middle of a name', () => {
    assert.equal(normalizeServerName('B1 tunnel 007'), 'B1 tunnel 07');
  });
});

describe('detectCountry', () => {
  test('reads the country from a leading flag emoji', () => {
    const result = detectCountry('🇺🇸 United States 001');
    assert.equal(result.code, 'US');
    assert.equal(result.name, 'United States');
    assert.equal(result.flag, '🇺🇸');
  });

  test('flag emoji works even without a name', () => {
    const result = detectCountry('🇯🇵 003');
    assert.equal(result.code, 'JP');
    assert.equal(result.flag, '🇯🇵');
  });

  test('resolves exact country names', () => {
    assert.equal(detectCountry('Germany 004').code, 'DE');
    assert.equal(detectCountry('The Netherlands 005').code, 'NL');
    assert.equal(detectCountry('Netherlands 005').code, 'NL');
    assert.equal(detectCountry('Russia 007').code, 'RU');
    assert.equal(detectCountry('United Kingdom 006').code, 'GB');
  });

  test('common aliases resolve', () => {
    assert.equal(detectCountry('USA 12').code, 'US');
    assert.equal(detectCountry('UK 07').code, 'GB');
    assert.equal(detectCountry('Holland 03').code, 'NL');
    assert.equal(detectCountry('South Korea 05').code, 'KR');
    assert.equal(detectCountry('Czech Republic 02').code, 'CZ');
  });

  test('prefix match only when conservative', () => {
    assert.equal(detectCountry('Germany FRA-01').code, 'DE');
  });

  test('unknown labels return null instead of inventing a country', () => {
    assert.equal(detectCountry('MysteryNode 12'), null);
    assert.equal(detectCountry('srv-01.example.net'), null);
    assert.equal(detectCountry(''), null);
    assert.equal(detectCountry(null), null);
    assert.equal(detectCountry('42'), null);
  });

  test('does not misread random numbers as countries', () => {
    assert.equal(detectCountry('Server 010'), null);
    assert.equal(detectCountry('Node 47'), null);
  });
});

describe('flagFor / codeFromFlag', () => {
  test('builds flag emoji from ISO codes', () => {
    assert.equal(flagFor('US'), '🇺🇸');
    assert.equal(flagFor('jp'), '🇯🇵');
    assert.equal(flagFor('ZZ'), ''); // invalid code
    assert.equal(flagFor('TOOLONG'), '');
  });

  test('codeFromFlag ignores non-flag emoji', () => {
    assert.equal(codeFromFlag('🔥 hot server'), null);
    assert.equal(codeFromFlag('no emoji here'), null);
    assert.equal(codeFromFlag('🇺🇸 leading'), 'US');
  });
});