import { describe, it, expect, beforeEach, vi } from 'vitest';

const dice = vi.hoisted(() => ({ next: [3, 3] as [number, number] }));
vi.mock('../src/dice.js', () => ({ roll2d6: () => dice.next, rollDie: () => dice.next[0] }));

import { handleConnection } from '../src/server.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard,
  type Harness,
} from './harness.js';
import type { CardInstance } from '../../shared/src/types.js';

beforeEach(() => { resetEngineState(); dice.next = [3, 3]; });

const connect = (h: Harness, id: string) => { handleConnection(h.socket(id) as never); return h.socket(id); };

/**
 * Roller A (active) holds hero h_001 (rollToPlay 7). dice 3+3=6 → a failing roll
 * that opens a modifier phase. Opponents B and C hold the given modifier cards.
 * NOTE: the player's hand IS the passed array, and playing splices from it, so
 * tests capture instanceIds up front rather than indexing the live array.
 */
const setup = (aMods: string[], bMods: string[], cMods: string[] = []) => {
  const hero = makeCard('h_001');
  const mk = (ids: string[]) => ids.map(m => makeCard(m));
  const aHand = mk(aMods), bHand = mk(bMods), cHand = mk(cMods);
  const gs = buildGameState({
    players: [
      buildPlayer({ id: 'A', party: [hero], hand: aHand, actionPoints: 3 }),
      buildPlayer({ id: 'B', hand: bHand }),
      buildPlayer({ id: 'C', hand: cHand }),
    ],
    activePlayerId: 'A',
  });
  const h = createHarness(gs);
  connect(h, 'A'); connect(h, 'B'); connect(h, 'C');
  const ids = (cards: CardInstance[]) => cards.map(c => c.instanceId);
  return { gs, h, hero, a: ids(aHand), b: ids(bHand), c: ids(cHand) };
};

const lastRoll = (h: Harness) =>
  h.socket('A').emittedOf('heroRollResult').at(-1)!.args[0] as { total: number; success: boolean };

describe('modifier phase — opponent cycling (long strings of plays/passes)', () => {
  it('cycles through opponents repeatedly while cards keep being played', () => {
    const { gs, h, hero, b, c } = setup([], ['mod_001', 'mod_001'], ['mod_001']);
    h.socket('A').fire('rollHeroAbility', hero.instanceId);
    expect(gs.modifierPhase?.phase).toBe('opponent_turn');

    h.socket('B').fire('playModifier', b[0], 0); // +2
    h.socket('B').fire('passModifier');
    h.socket('C').fire('playModifier', c[0], 0); // +2
    h.socket('C').fire('passModifier');          // queue empties → a card was played → rebuild (B still holds one)
    h.socket('B').fire('playModifier', b[1], 0); // +2 in the second cycle
    h.socket('B').fire('passModifier');          // no cards left anywhere → finalize

    expect(gs.modifierPhase).toBeUndefined();
    expect(lastRoll(h).total).toBe(12); // 6 + three +2 modifiers
    expect(lastRoll(h).success).toBe(true);
  });

  it('lets opponents respond to each other across cycles', () => {
    // B plays in cycle 1; after C reacts, the queue rebuilds so B can react to C.
    const { gs, h, hero, b, c } = setup([], ['mod_001', 'mod_001'], ['mod_001']);
    h.socket('A').fire('rollHeroAbility', hero.instanceId);
    h.socket('B').fire('playModifier', b[0], 1); // -2
    h.socket('B').fire('passModifier');
    h.socket('C').fire('playModifier', c[0], 0); // +2 (cancels B)
    h.socket('C').fire('passModifier');
    // Cycle 2: B still holds a card and gets another turn to respond.
    expect(gs.modifierPhase).toBeDefined();
    expect((gs.modifierPhase as { activePlayerId: string }).activePlayerId).toBe('B');
  });

  it('finalizes immediately when every opponent passes without playing', () => {
    const { gs, h, hero } = setup([], ['mod_001'], ['mod_001']);
    h.socket('A').fire('rollHeroAbility', hero.instanceId);
    h.socket('B').fire('passModifier');
    h.socket('C').fire('passModifier');
    expect(gs.modifierPhase).toBeUndefined();
    expect(lastRoll(h).total).toBe(6); // unchanged
  });
});

describe('modifier phase — the roller can respond (regression for the rebuild fix)', () => {
  it('comes back around to the roller after an opponent plays a modifier', () => {
    const { gs, h, hero, a, b } = setup(['mod_001'], ['mod_001']);
    h.socket('A').fire('rollHeroAbility', hero.instanceId); // roller_turn (A holds a modifier)
    expect(gs.modifierPhase?.phase).toBe('roller_turn');
    h.socket('A').fire('passModifier');            // A defers → opponent_turn
    h.socket('B').fire('playModifier', b[0], 1);   // B plays -2 (total → 4)
    h.socket('B').fire('passModifier');

    // The rotation returns to the roller, who reacts with their own modifier.
    expect(gs.modifierPhase, 'roller should get a chance to respond').toBeDefined();
    expect((gs.modifierPhase as { activePlayerId: string }).activePlayerId).toBe('A');
    h.socket('A').fire('playModifier', a[0], 0);   // A responds +2 (total → 6)
    h.socket('A').fire('passModifier');            // nobody has cards left → finalize

    expect(h.socket('A').emittedOf('actionFailed').map(e => e.args[0]))
      .not.toContain('It is not your turn to play a modifier.');
    expect(gs.modifierPhase).toBeUndefined();
    expect(lastRoll(h).total).toBe(6); // 6 - 2 + 2; both modifiers counted
  });

  it('keeps looping the roller + opponents until everyone passes consecutively', () => {
    // A and B each hold two +2 modifiers; everyone plays everything, across laps.
    const { gs, h, hero } = setup(['mod_001', 'mod_001'], ['mod_001', 'mod_001']);
    h.socket('A').fire('rollHeroAbility', hero.instanceId);

    // Drive the phase generically: whoever is active plays a modifier if they have
    // one, otherwise passes — until the phase finalizes.
    let guard = 0;
    while (gs.modifierPhase && guard++ < 100) {
      const active = (gs.modifierPhase as { activePlayerId: string }).activePlayerId;
      const card = gs.players[active]!.zones.hand.find(c => c.cardType === 'modifier');
      h.socket(active).fire(card ? 'playModifier' : 'passModifier', ...(card ? [card.instanceId, 0] : []));
    }

    expect(gs.modifierPhase).toBeUndefined();
    expect(lastRoll(h).total).toBe(14); // 6 + four +2 modifiers (two each from A and B)
  });
});
