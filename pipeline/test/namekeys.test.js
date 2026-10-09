import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personsFromOwnerName, propertyKeys, signalKeys, isEntity } from '../src/namekeys.js';

test('property couples sharing a last name', () => {
  assert.deepEqual(propertyKeys('DUGAN LESLIE R/SYLVIA D'), ['DUGAN|LESLIE', 'DUGAN|SYLVIA']);
  assert.deepEqual(propertyKeys('MENDOZA JOSE PABLO R & GUILLEYMINA G'), ['MENDOZA|JOSE', 'MENDOZA|GUILLEYMINA']);
});

test('property couples with different last names', () => {
  assert.deepEqual(propertyKeys('BIRACH KAREN A/JAMES/WEAVER SUSAN M'), ['BIRACH|KAREN', 'BIRACH|JAMES', 'WEAVER|SUSAN']);
});

test('suffixes and trusts are ignored', () => {
  assert.deepEqual(propertyKeys('LOPEZ RAMIRO JR'), ['LOPEZ|RAMIRO']);
  assert.deepEqual(propertyKeys('DODSON DEE WARD W JR/VIRGINIA'), ['DODSON|DEE', 'DODSON|VIRGINIA']);
  assert.deepEqual(personsFromOwnerName('SMITH JOHN A TR')[0], { last: 'SMITH', first: 'JOHN', middle: 'A' });
});

test('entities produce no person keys', () => {
  assert.equal(isEntity('PUKA 2302 LLC'), true);
  assert.equal(isEntity('DC RANCH ASSOCIATION INC'), true);
  assert.deepEqual(propertyKeys('JM MCDOWELL INVESTMENTS LLC'), []);
  assert.deepEqual(signalKeys('LOANDEPOT COM').keys, []);
});

test('signal keys cover both name orders', () => {
  const a = signalKeys('MCDONALD LEONARD J');
  const b = signalKeys('LEONARD J MCDONALD');
  assert.ok(a.keys.includes('MCDONALD|LEONARD'));
  assert.ok(b.keys.includes('MCDONALD|LEONARD'));
  assert.ok(signalKeys('David Wesley Oyler').keys.includes('OYLER|DAVID'));
  assert.ok(signalKeys('FLORES JOSE RENE RODRIGUEZ').keys.includes('FLORES|JOSE'));
});

test('signal middles captured for tie-breaks', () => {
  assert.ok(signalKeys('Donald G Szibdat').middles.includes('G'));
  assert.ok(signalKeys('David Wesley Oyler').middles.includes('WESLEY'));
});
