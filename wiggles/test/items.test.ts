import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deterministic dice: the roll-trigger items fire on a pass/fail outcome, so we
// control roll2d6() per test. (vi.hoisted lets the mock factory see this object.)
const dice = vi.hoisted(() => ({ next: [1, 1] as [number, number] }));
vi.mock('../src/dice.js', () => ({
  roll2d6: () => dice.next,
  rollDie: () => dice.next[0],
}));

import { executeRollAndEmit } from '../src/rolls.js';
import { resolveHeroDestruction } from '../src/effects.js';
import { getHeroEffectiveClass } from '../src/util.js';
import { handlePromptResponse } from '../src/promptResponse.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard,
  type Harness,
} from './harness.js';
import type { GameState, CardInstance } from '../../shared/src/types.js';

beforeEach(() => { resetEngineState(); dice.next = [1, 1]; });

/** Roll the equipped hero's effect for the caster. */
const roll = (h: Harness, gs: GameState, casterId: string, hero: CardInstance, pre = 0) =>
  executeRollAndEmit(h.socket(casterId) as never, gs, gs.players[casterId]!, hero, pre, h.sendRoomUpdate);

const respond = (h: Harness, responderId: string, optionId: string) => {
  const prompt = h.socket(responderId).lastPrompt();
  handlePromptResponse(h.socket(responderId) as never, prompt.promptId, optionId, h.sendRoomUpdate);
};

/** Equip `item` to `hero` and return [hero, item] for placing in a party. */
const equip = (hero: CardInstance, item: CardInstance): [CardInstance, CardInstance] => {
  hero.equippedItem = item.instanceId;
  return [hero, item];
};

describe('items — class-override masks (passive)', () => {
  const masks: Array<[item: string, cls: string]> = [
    ['i_002', 'ranger'], ['i_005', 'fighter'], ['i_006', 'bard'], ['i_007', 'thief'],
    ['i_008', 'wizard'], ['i_009', 'necromancer'], ['i_013', 'berserker'], ['i_014', 'guardian'],
  ];
  for (const [item, cls] of masks) {
    it(`${item}: overrides the equipped hero's class to ${cls}`, () => {
      const hero = makeCard('h_043'); // Peanut is a bard by default
      const mask = makeCard(item);
      const [h0, i0] = equip(hero, mask);
      const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [h0, i0] }), buildPlayer({ id: 'p2' })] });
      expect(getHeroEffectiveClass(gs, gs.players['p1']!, hero)).toBe(cls);
    });
  }
});

describe('items — Decoy Doll (i_011) redirect', () => {
  it('absorbs a destruction: the doll is discarded and the hero survives', () => {
    const doll = makeCard('i_011');
    const hero = makeCard('h_043', { equippedItem: doll.instanceId });
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', party: [hero, doll] })] });
    const msg = resolveHeroDestruction(gs, 'p2', hero.instanceId);
    expect(msg).toMatch(/Decoy Doll/i);
    expect(gs.players['p2']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId); // survived
    expect(gs.players['p2']!.zones.party.map(c => c.instanceId)).not.toContain(doll.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(doll.instanceId);
    expect(hero.equippedItem).toBeUndefined();
  });
});

describe('items — on-roll triggers (fail/success)', () => {
  // h_003 Vicious Wildcat has rollToPlay 12, so dice [1,1] = 2 is always a failure.
  const failingHero = () => makeCard('h_003');
  // h_045 Napping Nibbles has rollToPlay 2, so dice [6,6] = 12 is always a success.
  const succeedingHero = () => makeCard('h_045');

  it('i_010 Particularly Rusty Coin: a failed roll draws a card automatically', () => {
    const item = makeCard('i_010');
    const [hero, it0] = equip(failingHero(), item);
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [hero, it0] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001')],
    });
    const h = createHarness(gs);
    dice.next = [1, 1];
    roll(h, gs, 'p1', hero);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
  });

  it('i_012 Silver Lining: a failed roll grants +2 to all rolls this turn', () => {
    const item = makeCard('i_012');
    const [hero, it0] = equip(failingHero(), item);
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero, it0] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    dice.next = [1, 1];
    roll(h, gs, 'p1', hero);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 2, duration: 1 });
  });

  it('i_001 Goblet of Caffeination: a failed roll may sacrifice the goblet to reroll', () => {
    const item = makeCard('i_001');
    const [hero, it0] = equip(failingHero(), item);
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero, it0] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    dice.next = [1, 1];
    roll(h, gs, 'p1', hero);
    const prompt = h.socket('p1').lastPrompt();
    expect(prompt.promptType).toBe('confirm');
    respond(h, 'p1', 'use'); // sacrifice the goblet and reroll
    expect(gs.discardPile.map(c => c.instanceId)).toContain(item.instanceId);
    expect(hero.equippedItem).toBeUndefined();
    expect(h.socket('p1').emittedOf('heroRollResult').length).toBeGreaterThanOrEqual(2); // original + reroll
  });

  it('ci_003 Dragon\'s Bile: a failed roll forces sacrificing a Hero', () => {
    const item = makeCard('ci_003');
    const [hero, it0] = equip(failingHero(), item);
    const victim = makeCard('h_006');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero, it0, victim] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    dice.next = [1, 1];
    roll(h, gs, 'p1', hero);
    const prompt = h.socket('p1').lastPrompt();
    expect(prompt.promptType).toBe('selectCard');
    respond(h, 'p1', victim.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(victim.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).not.toContain(victim.instanceId);
  });

  it('ci_004 Suspiciously Shiny Coin: a successful roll forces a discard', () => {
    const item = makeCard('ci_004');
    const [hero, it0] = equip(succeedingHero(), item);
    const handCard = makeCard('s_001');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero, it0], hand: [handCard] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    dice.next = [6, 6];
    roll(h, gs, 'p1', hero);
    const prompt = h.socket('p1').lastPrompt();
    expect(prompt.promptType).toBe('discardCard');
    respond(h, 'p1', handCard.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(handCard.instanceId);
  });
});

// NOTE: i_003 (Really Big Ring, +2), i_004 (Biggest Ring Ever, discard-for-bonus),
// ci_002 (Snake's Eyes, -2), ci_001 (Sealing Key, heroEffectLocked) and ci_005
// (Soulbound Grimoire, rollCostAP) act inside the rollHeroAbility socket handler
// (ON_HERO_ROLL_ATTEMPT / pre-roll / lock / AP-cost), so they are covered in the
// socket-handler category rather than here.
