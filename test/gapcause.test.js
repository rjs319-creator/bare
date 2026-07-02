'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyGapCause, gapTake, GAP_CAUSE_FADE, TAKE_THRESHOLD } = require('../lib/gapgo');

test('classifyGapCause: no news → NONE', () => {
  assert.equal(classifyGapCause([]), 'NONE');
  assert.equal(classifyGapCause(null), 'NONE');
});

test('classifyGapCause: offering/dilution → FADE_OFFERING (highest priority)', () => {
  assert.equal(classifyGapCause([{ title: 'Acme announces $50M public offering priced at $4.00' }]), 'FADE_OFFERING');
  assert.equal(classifyGapCause([{ title: 'Acme prices registered direct offering' }]), 'FADE_OFFERING');
  // dilution wins over a co-occurring positive catalyst (priority order)
  assert.equal(classifyGapCause([{ title: 'Acme wins FDA approval and prices a convertible notes offering' }]), 'FADE_OFFERING');
});

test('classifyGapCause: matches headlines only (ignores body boilerplate)', () => {
  // an offering mention only in the body must NOT flag FADE (avoids large-cap false-positives)
  assert.equal(classifyGapCause([{ title: 'Acme reports strong quarter', text: 'Elsewhere, XYZ priced a public offering' }]), 'OTHER');
});

test('classifyGapCause: M&A → MA', () => {
  assert.equal(classifyGapCause([{ title: 'BigCo to acquire Acme in $2B buyout' }]), 'MA');
  assert.equal(classifyGapCause([{ title: 'Acme agrees to be acquired' }]), 'MA');
});

test('classifyGapCause: continue-catalysts', () => {
  assert.equal(classifyGapCause([{ title: 'Acme gets FDA approval for lead drug' }]), 'FDA');
  assert.equal(classifyGapCause([{ title: 'Acme awarded $100M government contract' }]), 'CONTRACT');
  assert.equal(classifyGapCause([{ title: 'Acme beats estimates, raises guidance' }]), 'GUIDE');
});

test('classifyGapCause: news present but uncategorized → OTHER', () => {
  assert.equal(classifyGapCause([{ title: 'Analyst mentions Acme in sector roundup' }]), 'OTHER');
});

test('GAP_CAUSE_FADE contains offering + M&A only', () => {
  assert.ok(GAP_CAUSE_FADE.has('FADE_OFFERING'));
  assert.ok(GAP_CAUSE_FADE.has('MA'));
  assert.ok(!GAP_CAUSE_FADE.has('FDA'));
});

test('gapTake: backward compatible (2-arg) unchanged', () => {
  assert.equal(gapTake(TAKE_THRESHOLD, 'risk-on'), true);
  assert.equal(gapTake(TAKE_THRESHOLD - 1, 'risk-on'), false);
  assert.equal(gapTake(99, 'risk-off'), false);
});

test('gapTake: skipFadeCauses opt-in skips offering/M&A, keeps continue-causes', () => {
  const hi = 99;
  // default OFF → FADE still taken
  assert.equal(gapTake(hi, 'risk-on', { cause: 'FADE_OFFERING' }), true);
  // opt-in ON → FADE skipped
  assert.equal(gapTake(hi, 'risk-on', { cause: 'FADE_OFFERING', skipFadeCauses: true }), false);
  assert.equal(gapTake(hi, 'risk-on', { cause: 'MA', skipFadeCauses: true }), false);
  // continue-causes and newsless still taken with skip on
  assert.equal(gapTake(hi, 'risk-on', { cause: 'FDA', skipFadeCauses: true }), true);
  assert.equal(gapTake(hi, 'risk-on', { cause: 'NONE', skipFadeCauses: true }), true);
});
