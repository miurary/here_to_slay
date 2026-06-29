import { describe, it, expect, beforeEach } from 'vitest';
import { getPartyLeaderHeroAbilityBonus } from '../src/rolls.js';
import { getMonsterAttackRollBonus, applyMonsterAttackEffects } from '../src/monsters.js';
import { getPartyLeaderChallengeBonus } from '../src/challenges.js';
import { processMagicCardSteps } from '../src/magic.js';
import { createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster } from './harness.js';

beforeEach(() => resetEngineState());

describe('party leaders — triggered / passive effects', () => {
  it('p_001 The Raging Manticore: slaying a monster draws 2 cards', () => {
    const monster = makeMonster('m_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', partyLeaderId: 'p_001' }), buildPlayer({ id: 'p2' })],
      activeMonsters: [monster],
      mainDeck: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')],
    });
    const h = createHarness(gs);
    applyMonsterAttackEffects(h.roomCode, h.socket('p1') as never, gs, gs.players['p1']!, monster, gs.cardTemplates['m_001']!, 8, h.sendRoomUpdate);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(1);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('p_002 The Fist of Reason: +2 to challenge rolls', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', partyLeaderId: 'p_002' }), buildPlayer({ id: 'p2' })] });
    expect(getPartyLeaderChallengeBonus(gs, 'p1')).toBe(2);
  });

  it('p_003 The Charismatic Song: +1 to hero-ability rolls', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', partyLeaderId: 'p_003' }), buildPlayer({ id: 'p2' })] });
    expect(getPartyLeaderHeroAbilityBonus(gs, 'p1')).toBe(1);
  });

  it('p_005 The Divine Arrow: +1 to monster-attack rolls', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', partyLeaderId: 'p_005' }), buildPlayer({ id: 'p2' })] });
    expect(getMonsterAttackRollBonus(gs, gs.players['p1']!)).toBe(1);
  });

  it('p_007 The Cloaked Sage: playing a Magic card draws a card', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', partyLeaderId: 'p_007' }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001')],
    });
    const h = createHarness(gs);
    const steps = gs.cardTemplates['s_002']!.effect!.steps ?? [gs.cardTemplates['s_002']!.effect as never];
    processMagicCardSteps(h.socket('p1') as never, gs, gs.players['p1']!, 's_002#magic', steps, undefined, true);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1); // the Cloaked Sage draw
  });

  // NOTE: p_004 (Protecting Horn, ON_MODIFIER_PLAYED), p_006 (Shadow Claw, ACTIVE STEAL_CARD)
  // and p_008 (Gnawing Dead, ACTIVE SEARCH_DISCARD) are driven by the playModifier /
  // usePartyLeaderAbility socket handlers and are covered in the socket-handler category.
});
