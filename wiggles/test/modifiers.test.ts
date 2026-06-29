import { describe, it, expect, beforeEach } from 'vitest';
import { getModifierAmount, getModifierChoiceLabel, modifierDiscardsHand } from '../src/rolls.js';
import { resetEngineState, templates } from './harness.js';

beforeEach(() => resetEngineState());

describe('modifier cards — amount / label / discard-hand resolution', () => {
  const t = (id: string) => templates()[id];

  it('mod_001: two fixed choices (+2 / -2)', () => {
    expect(getModifierAmount(t('mod_001'), 0, 'HERO_ABILITY')).toBe(2);
    expect(getModifierAmount(t('mod_001'), 1, 'HERO_ABILITY')).toBe(-2);
    expect(getModifierChoiceLabel(t('mod_001'), 0, 'HERO_ABILITY')).toBe('+2');
  });

  it('mod_002: conditional upgrade to +4 in the ATTACK_MONSTER context', () => {
    expect(getModifierAmount(t('mod_002'), 0, 'HERO_ABILITY')).toBe(2);
    expect(getModifierAmount(t('mod_002'), 0, 'ATTACK_MONSTER')).toBe(4);
    expect(getModifierChoiceLabel(t('mod_002'), 0, 'ATTACK_MONSTER')).toBe('+4');
  });

  it('mod_003 / mod_006: fixed choice pairs', () => {
    expect(getModifierAmount(t('mod_003'), 0, 'HERO_ABILITY')).toBe(3);
    expect(getModifierAmount(t('mod_003'), 1, 'HERO_ABILITY')).toBe(-1);
    expect(getModifierAmount(t('mod_006'), 0, 'HERO_ABILITY')).toBe(1);
    expect(getModifierAmount(t('mod_006'), 1, 'HERO_ABILITY')).toBe(-3);
  });

  it('mod_004 / mod_005: single-effect modifiers (no choices)', () => {
    expect(getModifierAmount(t('mod_004'), 0, 'HERO_ABILITY')).toBe(4);
    expect(getModifierAmount(t('mod_005'), 0, 'HERO_ABILITY')).toBe(-4);
  });

  it('mod_007: +7 and discards the rest of your hand', () => {
    expect(getModifierAmount(t('mod_007'), 0, 'HERO_ABILITY')).toBe(7);
    expect(modifierDiscardsHand(t('mod_007'), 0, 'HERO_ABILITY')).toBe(true);
    expect(modifierDiscardsHand(t('mod_001'), 0, 'HERO_ABILITY')).toBe(false);
  });
});
