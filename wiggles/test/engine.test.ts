import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deterministic dice for the roll-phase tests.
const dice = vi.hoisted(() => ({ next: [3, 3] as [number, number] }));
vi.mock('../src/dice.js', () => ({ roll2d6: () => dice.next, rollDie: () => dice.next[0] }));

import { drawCards, initializeDecks, loadAllCardTemplates } from '../src/cards.js';
import { checkWinCondition, applyWinIfMet, decrementTemporaryModifiers } from '../src/util.js';
import { triggerEndTurn } from '../src/turns.js';
import { getOpponentsWithModifiers, executeRollAndEmit, finalizeRoll } from '../src/rolls.js';
import { modifierPhases } from '../src/state.js';
import { createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster } from './harness.js';

beforeEach(() => { resetEngineState(); dice.next = [3, 3]; });

describe('deck setup', () => {
  it('loadAllCardTemplates loads every card category', () => {
    const t = loadAllCardTemplates();
    expect(t['h_001']).toBeDefined();   // hero
    expect(t['s_001']).toBeDefined();   // magic
    expect(t['i_001']).toBeDefined();   // item
    expect(t['ci_001']).toBeDefined();  // cursed item
    expect(t['mod_001']).toBeDefined(); // modifier
    expect(t['chal_001']).toBeDefined();// challenge
    expect(t['m_001']).toBeDefined();   // monster
    expect(t['p_001']).toBeDefined();   // party leader
  });

  it('initializeDecks builds shuffled decks and honors deckCount', () => {
    const { monsterDeck, partyLeaderDeck, mainDeck } = initializeDecks();
    expect(monsterDeck).toHaveLength(17);     // one per monster
    expect(partyLeaderDeck).toHaveLength(8);  // one per leader
    // s_001 Destructive Spell has deckCount 2 → two instances in the main deck.
    expect(mainDeck.filter(c => c.templateId === 's_001')).toHaveLength(2);
    // every instance has a unique instanceId
    const ids = new Set(mainDeck.map(c => c.instanceId));
    expect(ids.size).toBe(mainDeck.length);
  });

  it('drawCards removes cards from the top of a deck', () => {
    const deck = [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')];
    const drawn = drawCards(deck, 2);
    expect(drawn).toHaveLength(2);
    expect(deck).toHaveLength(1);
  });
});

describe('temporary modifier durations', () => {
  it('decrements durations and drops expired modifiers', () => {
    const p = buildPlayer({ id: 'p1', temporaryModifiers: [
      { modifierType: 'rollBonus', amount: 5, duration: 1 },   // expires
      { modifierType: 'blockSteal', amount: 0, duration: 2 },  // survives → 1
    ] });
    decrementTemporaryModifiers(p);
    expect(p.temporaryModifiers).toEqual([{ modifierType: 'blockSteal', amount: 0, duration: 1 }]);
  });

  it('clears the array entirely once the last modifier expires', () => {
    const p = buildPlayer({ id: 'p1', temporaryModifiers: [{ modifierType: 'rollBonus', amount: 5, duration: 1 }] });
    decrementTemporaryModifiers(p);
    expect(p.temporaryModifiers).toBeUndefined();
  });
});

describe('turn flow — triggerEndTurn', () => {
  it('advances the active player, resets AP/flags, expires modifiers, clears used markers', () => {
    const usedHero = makeCard('h_043', { effectUsedThisTurn: true });
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', temporaryModifiers: [{ modifierType: 'rollBonus', amount: 5, duration: 1 }] }),
        buildPlayer({ id: 'p2', party: [usedHero], actionPoints: 0 }),
      ],
      activePlayerId: 'p1',
      roomFlags: { lockModifiers: true },
    });
    gs.forceEndTurn = 'p1';
    const h = createHarness(gs);

    triggerEndTurn('p1', gs, h.roomCode, h.sendRoomUpdate);

    expect(gs.activePlayerId).toBe('p2');
    expect(gs.players['p2']!.actionPoints).toBe(3);
    expect(usedHero.effectUsedThisTurn).toBe(false);
    expect(gs.players['p1']!.temporaryModifiers).toBeUndefined(); // expired at end of owner's turn
    expect(gs.roomFlags).toBeUndefined();
    expect(gs.forceEndTurn).toBeUndefined();
  });

  it('grants slain-monster EXTRA_AP to the next player', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', slainMonsters: [makeMonster('m_002')] })],
      activePlayerId: 'p1',
    });
    const h = createHarness(gs);
    triggerEndTurn('p1', gs, h.roomCode, h.sendRoomUpdate);
    expect(gs.players['p2']!.actionPoints).toBe(4); // base 3 + EXTRA_AP 1
  });
});

describe('roll / modifier phase', () => {
  it('getOpponentsWithModifiers lists opponents holding a Modifier card', () => {
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', hand: [makeCard('mod_001')] }), // roller's own hand is excluded
        buildPlayer({ id: 'p2', hand: [makeCard('mod_002')] }),
        buildPlayer({ id: 'p3', hand: [makeCard('s_001')] }),   // no modifier
      ],
    });
    expect(getOpponentsWithModifiers(gs, 'p1')).toEqual(['p2']);
  });

  it('executeRollAndEmit opens a modifier phase when an opponent can react', () => {
    const hero = makeCard('h_001'); // rollToPlay 7
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [hero] }), buildPlayer({ id: 'p2', hand: [makeCard('mod_001')] })],
    });
    const h = createHarness(gs);
    dice.next = [3, 3]; // total 6
    executeRollAndEmit(h.socket('p1') as never, gs, gs.players['p1']!, hero, 0, h.sendRoomUpdate);
    expect(gs.modifierPhase).toBeDefined();
    expect(gs.modifierPhase?.phase).toBe('opponent_turn');
    expect(gs.modifierPhase?.rollingPlayerId).toBe('p1');
  });

  it('finalizeRoll resolves the phase, clears it, and emits the roll result', () => {
    const hero = makeCard('h_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [hero] }), buildPlayer({ id: 'p2', hand: [makeCard('mod_001')] })],
    });
    const h = createHarness(gs);
    dice.next = [3, 3];
    executeRollAndEmit(h.socket('p1') as never, gs, gs.players['p1']!, hero, 0, h.sendRoomUpdate);
    const phase = modifierPhases.get(h.roomCode)!;
    finalizeRoll(h.roomCode, phase, gs, h.sendRoomUpdate);
    expect(gs.modifierPhase).toBeUndefined();
    expect(modifierPhases.get(h.roomCode)).toBeUndefined();
    expect(h.socket('p1').emittedOf('heroRollResult').length).toBeGreaterThan(0);
  });

  it('resolves immediately (no phase) when nobody holds a modifier', () => {
    const hero = makeCard('h_001');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    dice.next = [6, 6];
    executeRollAndEmit(h.socket('p1') as never, gs, gs.players['p1']!, hero, 0, h.sendRoomUpdate);
    expect(gs.modifierPhase).toBeUndefined();
    expect(h.socket('p1').emittedOf('heroRollResult').length).toBe(1);
  });
});

describe('win conditions', () => {
  const distinctClassHeroes = ['h_001', 'h_003', 'h_005', 'h_007', 'h_009', 'h_011', 'h_015', 'h_043'];
  // necromancer, berserker, guardian, fighter, ranger, thief, wizard, bard

  it('wins on slaying the target number of monsters (default 3)', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_001'), makeMonster('m_002'), makeMonster('m_003')] }), buildPlayer({ id: 'p2' })],
    });
    expect(checkWinCondition(gs, gs.players['p1']!)).toBe(true);
  });

  it('does not win with only 2 monsters slain', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_001'), makeMonster('m_002')] }), buildPlayer({ id: 'p2' })],
    });
    expect(checkWinCondition(gs, gs.players['p1']!)).toBe(false);
  });

  it('wins with 7 of the 8 hero classes represented in the party', () => {
    const party = distinctClassHeroes.slice(0, 7).map(id => makeCard(id));
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party }), buildPlayer({ id: 'p2' })] });
    expect(checkWinCondition(gs, gs.players['p1']!)).toBe(true);
  });

  it('does not win with only 6 distinct classes', () => {
    const party = distinctClassHeroes.slice(0, 6).map(id => makeCard(id));
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party }), buildPlayer({ id: 'p2' })] });
    expect(checkWinCondition(gs, gs.players['p1']!)).toBe(false);
  });

  it('applyWinIfMet marks the game finished and records the winner', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_001'), makeMonster('m_002'), makeMonster('m_003')] }), buildPlayer({ id: 'p2' })],
    });
    expect(applyWinIfMet(gs, gs.players['p1']!, 'p1')).toBe(true);
    expect(gs.status).toBe('finished');
    expect(gs.winnerId).toBe('p1');
  });
});
