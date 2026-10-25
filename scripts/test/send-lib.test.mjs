import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySmtpError, randomDelayMs, domainOf, isTruthy, parseSendN } from '../send-lib.mjs';

test('smtp classification', () => {
  assert.equal(classifySmtpError({ code: 'EAUTH', responseCode: 535 }), 'abort');
  assert.equal(classifySmtpError({ code: 'ECONNECTION' }), 'abort');
  assert.equal(classifySmtpError({ code: 'EENVELOPE', responseCode: 550 }), 'bounce');
  assert.equal(classifySmtpError({ responseCode: 553 }), 'bounce');
  assert.equal(classifySmtpError({ responseCode: 421 }), 'abort');
  assert.equal(classifySmtpError({ responseCode: 535 }), 'abort');
  assert.equal(classifySmtpError(new Error('boom')), 'abort');
});

test('delay bounds', () => {
  assert.equal(randomDelayMs(45, 120, () => 0), 45000);
  assert.equal(randomDelayMs(45, 120, () => 1), 120000);
});

test('helpers', () => {
  assert.equal(domainOf('Bob@Example.COM'), 'example.com');
  assert.equal(isTruthy('true'), true);
  assert.equal(isTruthy(''), false);
  assert.equal(parseSendN(''), null);
  assert.equal(parseSendN('3'), 3);
  assert.equal(parseSendN('0'), null);
});
