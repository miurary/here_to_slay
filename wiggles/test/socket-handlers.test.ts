import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deterministic dice for rollHeroAbility / attackMonster.
const dice = vi.hoisted(() => ({ next: [3, 3] as [number, number] }));
vi.mock('../src/dice.js', () => ({ roll2d6: () => dice.next, rollDie: () => dice.next[0] }));

import { handleConnection } from '../src/server.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster,
  type Harness, type FakeSocket, type EmittedEvent,
} from './harness.js';

beforeEach(() => { resetEngineState(); dice.next = [3, 3]; });

/** Register the connection handlers for a player's socket, then return it. */
const connect = (h: Harness, id: string): FakeSocket => {
  handleConnection(h.socket(id) as never);
  return h.socket(id);
};

// eslint-disable-next-line
const lastOf = (s: FakeSocket, event: string): any => {
  const es = s.emittedOf(event);
  return (es[es.length - 1] as EmittedEvent | undefined)?.args[0];
};

const respond = (h: Harness, responderId: string, optionId: string) => {
  const s = h.socket(responderId);
  s.fire('respondToAbilityPrompt', s.lastPrompt().promptId, optionId);
};
const respondMulti = (h: Harness, responderId: string, optionIds: string[]) => {
  const s = h.socket(responderId);
  s.fire('respondToAbilityPromptMulti', s.lastPrompt().promptId, optionIds);
};

describe('connection setup', () => {
  it('joins the room and broadcasts state on connect', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    const s = connect(h, 'p1');
    expect(s.data.roomCode).toBe(h.roomCode);
    expect(h.io.broadcasts.some(b => b.event === 'stateUpdate')).toBe(true);
  });

  it('emits roomNotFound and disconnects when the room does not exist', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    const h = createHarness(gs);
    const s = h.socket('p1');
    s.handshake.auth.roomCode = 'NOPE';
    handleConnection(s as never);
    expect(lastOf(s, 'roomNotFound')).toMatch(/not found/i);
    expect(s.disconnected).toBe(true);
  });
});

describe('drawFromMain', () => {
  it('draws a card and spends 1 AP on your turn', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', actionPoints: 3 }), buildPlayer({ id: 'p2' })], mainDeck: [makeCard('s_001')] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('drawFromMain');
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
    expect(gs.players['p1']!.actionPoints).toBe(2);
    expect(gs.gameLog.some(e => e.kind === 'action' && e.playerId === 'p1' && /drew a card/i.test(e.text))).toBe(true);
  });

  it('rejects drawing when it is not your turn', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })], activePlayerId: 'p1', mainDeck: [makeCard('s_001')] });
    const h = createHarness(gs);
    connect(h, 'p2').fire('drawFromMain');
    expect(gs.players['p2']!.zones.hand).toHaveLength(0);
    expect(lastOf(h.socket('p2'), 'actionFailed')).toMatch(/not your turn/i);
  });
});

describe('playHero', () => {
  it('plays a hero into the party (unchallenged) and spends 1 AP', () => {
    const hero = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [hero], actionPoints: 3 }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('playHero', hero.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId);
    expect(gs.players['p1']!.actionPoints).toBe(2);
    expect(gs.gameLog.some(e => e.kind === 'action' && e.playerId === 'p1' && /played /i.test(e.text))).toBe(true);
  });

  it('opens a challenge window when an opponent holds a challenge card', () => {
    const hero = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [hero] }), buildPlayer({ id: 'p2', hand: [makeCard('chal_001')] })] });
    const h = createHarness(gs);
    connect(h, 'p2'); // opponent must be connected to be an eligible challenger via socket lookup
    connect(h, 'p1').fire('playHero', hero.instanceId);
    expect(gs.pendingChallenge?.pendingPlayerId).toBe('p1');
    expect(gs.players['p1']!.zones.party).toHaveLength(0); // not yet resolved
  });

  it('rejects playing a hero without enough AP', () => {
    const hero = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [hero], actionPoints: 0 }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('playHero', hero.instanceId);
    expect(lastOf(h.socket('p1'), 'actionFailed')).toMatch(/AP/);
    expect(gs.players['p1']!.zones.party).toHaveLength(0);
  });
});

describe('attackMonster', () => {
  it('spends 2 AP and slays the monster on a strong roll', () => {
    const monster = makeMonster('m_007'); // upper 10, requires 1 hero
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')], actionPoints: 3 }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    dice.next = [6, 6]; // 12 >= 10
    connect(h, 'p1').fire('attackMonster', monster.instanceId);
    expect(gs.players['p1']!.actionPoints).toBe(1);
    expect(gs.players['p1']!.slainMonsters.map(c => c.instanceId)).toContain(monster.instanceId);
  });

  it('rejects an attack when monster requirements are unmet', () => {
    const monster = makeMonster('m_001'); // needs a necromancer
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')], actionPoints: 3 }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('attackMonster', monster.instanceId);
    expect(lastOf(h.socket('p1'), 'actionFailed')).toMatch(/Requirements not met/i);
    expect(gs.players['p1']!.actionPoints).toBe(3); // not charged
  });

  it('logs a slain result to the game log on a strong roll', () => {
    const monster = makeMonster('m_007'); // upper 10, requires 1 hero
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')], actionPoints: 3 }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    dice.next = [6, 6]; // 12 >= 10
    connect(h, 'p1').fire('attackMonster', monster.instanceId);
    const slain = gs.gameLog.filter(e => e.kind === 'action' && /slew/i.test(e.text));
    expect(slain).toHaveLength(1);
    expect(slain[0]!.text).toMatch(/^p1 slew /); // harness sets username to the socket id
    expect(slain[0]!.playerId).toBe('p1');
  });

  it('logs a failed result to the game log on a weak roll', () => {
    const monster = makeMonster('m_007'); // upper 10, requires 1 hero
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', username: 'Alice', party: [makeCard('h_043')], actionPoints: 3 }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    dice.next = [1, 1]; // 2 < 10, no modifiers in hand so it resolves immediately
    connect(h, 'p1').fire('attackMonster', monster.instanceId);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(0);
    const failed = gs.gameLog.filter(e => e.kind === 'action' && /attack on .* failed/i.test(e.text));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.text).toMatch(/needed 10/);
  });

  it('records a chat message in the game log', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('sendChat', '  hello world  ');
    const chats = gs.gameLog.filter(e => e.kind === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0]!.text).toBe('hello world'); // trimmed
    expect(chats[0]!.username).toBe('p1'); // harness sets username to the socket id
    expect(chats[0]!.playerId).toBe('p1');
  });

  it('ignores an empty chat message', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('sendChat', '   ');
    expect(gs.gameLog.filter(e => e.kind === 'chat')).toHaveLength(0);
  });
});

describe('rollHeroAbility — equipped item modifiers (ON_HERO_ROLL_ATTEMPT)', () => {
  const equippedRoll = (heroId: string, itemId: string, extra: Partial<{ ap: number; hand: ReturnType<typeof makeCard>[] }> = {}) => {
    const item = makeCard(itemId);
    const hero = makeCard(heroId, { equippedItem: item.instanceId });
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero, item], actionPoints: extra.ap ?? 3, hand: extra.hand ?? [] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    return { gs, h, hero, item };
  };

  it('i_003 Really Big Ring: +2 to the roll', () => {
    const { gs, h, hero } = equippedRoll('h_001', 'i_003'); // rollToPlay 7
    dice.next = [3, 3]; // base 6, +2 ring = 8
    connect(h, 'p1').fire('rollHeroAbility', hero.instanceId);
    expect(lastOf(h.socket('p1'), 'heroRollResult').total).toBe(8);
    expect(lastOf(h.socket('p1'), 'heroRollResult').success).toBe(true);
    void gs;
  });

  it('ci_002 Snake\'s Eyes: -2 to the roll', () => {
    const { h, hero } = equippedRoll('h_045', 'ci_002'); // rollToPlay 2
    dice.next = [3, 3]; // base 6, -2 = 4
    connect(h, 'p1').fire('rollHeroAbility', hero.instanceId);
    expect(lastOf(h.socket('p1'), 'heroRollResult').total).toBe(4);
  });

  it('ci_001 Sealing Key: rolling is blocked and AP is refunded', () => {
    const { gs, h, hero } = equippedRoll('h_001', 'ci_001', { ap: 3 });
    connect(h, 'p1').fire('rollHeroAbility', hero.instanceId);
    expect(lastOf(h.socket('p1'), 'actionFailed')).toMatch(/locked/i);
    expect(h.socket('p1').emittedOf('heroRollResult')).toHaveLength(0);
    expect(gs.players['p1']!.actionPoints).toBe(3); // refunded
  });

  it('ci_005 Soulbound Grimoire: rolling costs 2 AP total', () => {
    const { gs, h, hero } = equippedRoll('h_045', 'ci_005', { ap: 3 });
    dice.next = [6, 6];
    connect(h, 'p1').fire('rollHeroAbility', hero.instanceId);
    expect(gs.players['p1']!.actionPoints).toBe(1); // 3 - 2
    expect(h.socket('p1').emittedOf('heroRollResult').length).toBeGreaterThan(0);
  });

  it('i_004 Biggest Ring Ever: discard a card for +2 to the roll', () => {
    const discardable = makeCard('s_001');
    const { gs, h, hero } = equippedRoll('h_001', 'i_004', { hand: [discardable] }); // rollToPlay 7
    dice.next = [3, 3]; // base 6; +2 per discarded card
    connect(h, 'p1').fire('rollHeroAbility', hero.instanceId);
    expect(h.socket('p1').lastPrompt().promptType).toBe('multiSelectCard');
    respondMulti(h, 'p1', [discardable.instanceId]);
    expect(lastOf(h.socket('p1'), 'heroRollResult').total).toBe(8); // 6 + 1*2
    expect(gs.discardPile.map(c => c.instanceId)).toContain(discardable.instanceId);
  });
});

describe('usePartyLeaderAbility — active leaders', () => {
  it('p_006 The Shadow Claw: spend 1 AP to pull a card from a chosen opponent', () => {
    const leader = makeCard('p_006');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [leader], partyLeaderId: 'p_006', actionPoints: 3 }), buildPlayer({ id: 'p2', hand: [makeCard('s_001')] })],
    });
    const h = createHarness(gs);
    connect(h, 'p1').fire('usePartyLeaderAbility');
    respond(h, 'p1', h.socket('p1').lastPrompt().options[0]!.id); // choose p2
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
    expect(gs.players['p2']!.zones.hand).toHaveLength(0);
    expect(gs.players['p1']!.actionPoints).toBe(2);
  });

  it('p_008 The Gnawing Dead: spend 2 AP to recover a card from the discard pile', () => {
    const leader = makeCard('p_008');
    const wanted = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [leader], partyLeaderId: 'p_008', actionPoints: 3 }), buildPlayer({ id: 'p2' })],
      discardPile: [wanted],
    });
    const h = createHarness(gs);
    connect(h, 'p1').fire('usePartyLeaderAbility');
    respond(h, 'p1', wanted.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(wanted.instanceId);
    expect(gs.players['p1']!.actionPoints).toBe(1);
  });
});

describe('playModifier — modifier phase + The Protecting Horn (p_004)', () => {
  it('an opponent\'s modifier adds to the roll; p_004 grants an extra +1', () => {
    const hero = makeCard('h_001'); // rollToPlay 7
    const mod = makeCard('mod_001'); // +2 / -2
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [hero], actionPoints: 3 }),
        buildPlayer({ id: 'p2', hand: [mod], partyLeaderId: 'p_004' }),
      ],
    });
    const h = createHarness(gs);
    connect(h, 'p1'); connect(h, 'p2');
    dice.next = [3, 3]; // base 6 → fails 7, opening a modifier phase
    h.socket('p1').fire('rollHeroAbility', hero.instanceId);
    expect(gs.modifierPhase).toBeDefined();
    h.socket('p2').fire('playModifier', mod.instanceId, 0); // choose +2
    // +2 from the modifier, +1 from The Protecting Horn (amount > 0)
    expect(gs.modifierPhase?.accumulatedModifier).toBe(3);
  });
});

describe('endTurn / mulligan / choosePartyLeader / disconnect', () => {
  it('endTurn advances to the next player and refills AP', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', actionPoints: 1 }), buildPlayer({ id: 'p2', actionPoints: 0 })], activePlayerId: 'p1' });
    const h = createHarness(gs);
    connect(h, 'p1').fire('endTurn');
    expect(gs.activePlayerId).toBe('p2');
    expect(gs.players['p2']!.actionPoints).toBe(3);
    expect(gs.gameLog.some(e => e.kind === 'system' && /ended their turn/i.test(e.text))).toBe(true);
  });

  it('endTurn is rejected while a challenge is pending', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [makeCard('chal_001')] }) ] });
    const h = createHarness(gs);
    connect(h, 'p2');
    const hero = makeCard('h_043');
    gs.players['p1']!.zones.hand.push(hero);
    connect(h, 'p1');
    h.socket('p1').fire('playHero', hero.instanceId); // opens a challenge window
    h.socket('p1').fire('endTurn');
    expect(lastOf(h.socket('p1'), 'actionFailed')).toMatch(/challenge/i);
    expect(gs.activePlayerId).toBe('p1');
  });

  it('mulligan discards the hand and draws 5 for 3 AP', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand: [makeCard('s_001'), makeCard('s_002')], actionPoints: 3 }), buildPlayer({ id: 'p2' })],
      mainDeck: Array.from({ length: 6 }, (_, i) => makeCard(`s_00${i + 1}`)),
    });
    const h = createHarness(gs);
    connect(h, 'p1').fire('mulligan');
    expect(gs.players['p1']!.zones.hand).toHaveLength(5);
    expect(gs.players['p1']!.actionPoints).toBe(0);
    expect(gs.gameLog.some(e => e.kind === 'action' && e.playerId === 'p1' && /mulligan/i.test(e.text))).toBe(true);
  });

  it('choosePartyLeader assigns the leader and advances selection', () => {
    const leader = makeCard('p_001');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })], status: 'party_leader_selection' });
    gs.currentSelectionPlayerId = 'p1';
    gs.availablePartyLeaderCards = [leader];
    gs.partyLeaderSelectionOrder = ['p1', 'p2'];
    const h = createHarness(gs);
    connect(h, 'p1').fire('choosePartyLeader', leader.instanceId);
    expect(gs.players['p1']!.partyLeaderId).toBe('p_001');
    expect(gs.currentSelectionPlayerId).toBe('p2');
    expect(gs.gameLog.some(e => e.kind === 'system' && /party leader/i.test(e.text))).toBe(true);
  });

  it('disconnect removes the player from the room', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    connect(h, 'p1'); connect(h, 'p2');
    h.socket('p2').fire('disconnect');
    expect(gs.players['p2']).toBeUndefined();
    expect(gs.players['p1']).toBeDefined();
  });
});
