'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePackageInput, parsePagination } = require('../validation');

test('package payload is trimmed and optional description defaults to empty', () => {
  assert.deepEqual(validatePackageInput({ name: ' htop ', manager: ' zypper ' }), {
    ok: true,
    value: { name: 'htop', manager: 'zypper', description: '' }
  });
});

test('package payload rejects missing required properties', () => {
  assert.equal(validatePackageInput({ name: 'htop' }).ok, false);
  assert.equal(validatePackageInput({ manager: 'zypper' }).ok, false);
});

test('package payload rejects unknown properties', () => {
  assert.match(validatePackageInput({ name: 'htop', manager: 'zypper', admin: true }).error, /Unknown field/);
});

test('package payload rejects too-long descriptions', () => {
  assert.match(validatePackageInput({ name: 'htop', manager: 'zypper', description: 'x'.repeat(501) }).error, /500 characters/);
});

test('pagination has safe defaults', () => {
  assert.deepEqual(parsePagination({}), { ok: true, value: { page: 1, pageSize: 20, skip: 0 } });
});

test('pagination rejects invalid values and caps page size', () => {
  assert.equal(parsePagination({ page: '0' }).ok, false);
  assert.equal(parsePagination({ page: '1.5' }).ok, false);
  assert.equal(parsePagination({ pageSize: '101' }).ok, false);
  assert.equal(parsePagination({ page: '9007199254740991', pageSize: '100' }).ok, false);
});

test('pagination calculates skip correctly', () => {
  assert.deepEqual(parsePagination({ page: '3', pageSize: '10' }), {
    ok: true,
    value: { page: 3, pageSize: 10, skip: 20 }
  });
});
