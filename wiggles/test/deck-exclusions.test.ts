/**
 * Lobby deck editor: the leader excludes main-deck templates before the game
 * starts (setDeckExclusions), and startGame builds the deck without them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleConnection } from '../src/server.js';
import { initializeDecks } from '../src/cards.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, templates,
  type Harness, type FakeSocket, type EmittedEvent,
} from './harness.js';
import type { GameState } from '../../shared/src/types.js';

beforeEach(() => resetEngineState());

const connect = (h: Harness, id: string): FakeSocket => {
  handleConnection(h.socket(id) as never);
  return h.socket(id);
};

// eslint-disable-next-line
const lastOf = (s: FakeSocket, event: string): any => {
  const es = s.emittedOf(event);
  return (es[es.length - 1] as EmittedEvent | undefined)?.args[0];
};

const lobby = (): { gs: GameState; h: Harness } => {
  const gs = buildGameState({
    status: 'waiting',
    players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', ready: true })],
  });
  const h = createHarness(gs);
  connect(h, 'p1'); // lobby leader (first player)
  connect(h, 'p2');
  return { gs, h };
};

describe('initializeDecks with exclusions', () => {
  it('omits every copy of an excluded template and keeps the rest', () => {
    const full = initializeDecks();
    const trimmed = initializeDecks(['h_001', 'm_card_challenge']); // hero + (invalidly named id is just absent)
    expect(full.mainDeck.some(c => c.templateId === 'h_001')).toBe(true);
    expect(trimmed.mainDeck.some(c => c.templateId === 'h_001')).toBe(false);
    // Only h_001's copies are missing.
    const copies = full.mainDeck.filter(c => c.templateId === 'h_001').length;
    expect(trimmed.mainDeck.length).toBe(full.mainDeck.length - copies);
    // Separate decks are untouched.
    expect(trimmed.monsterDeck.length).toBe(full.monsterDeck.length);
    expect(trimmed.partyLeaderDeck.length).toBe(full.partyLeaderDeck.length);
  });
});

describe('setDeckExclusions', () => {
  it('lets the leader exclude main-deck cards and broadcasts the room update', () => {
    const { gs, h } = lobby();
    h.socket('p1').fire('setDeckExclusions', ['h_001', 'i_001', 'ci_001', 'mod_001']);
    expect(gs.excludedCardIds).toEqual(expect.arrayContaining(['h_001', 'i_001', 'ci_001']));
    expect(h.io.broadcasts.some(b => b.event === 'stateUpdate')).toBe(true);
  });

  it('drops unknown ids, monsters, party leaders, and duplicates', () => {
    const { gs, h } = lobby();
    const someMonster = Object.values(templates()).find(t => t.type === 'monster')!.id;
    const someLeader = Object.values(templates()).find(t => t.type === 'party_leader')!.id;
    h.socket('p1').fire('setDeckExclusions', ['h_002', 'h_002', 'nope_999', someMonster, someLeader]);
    expect(gs.excludedCardIds).toEqual(['h_002']);
  });

  it('rejects non-leaders', () => {
    const { gs, h } = lobby();
    h.socket('p2').fire('setDeckExclusions', ['h_001']);
    expect(gs.excludedCardIds).toBeUndefined();
    expect(lastOf(h.socket('p2'), 'actionFailed')).toMatch(/host/i);
  });

  it('is a no-op once the game has left the lobby', () => {
    const { gs, h } = lobby();
    gs.status = 'in_progress';
    h.socket('p1').fire('setDeckExclusions', ['h_001']);
    expect(gs.excludedCardIds).toBeUndefined();
  });
});

describe('startGame with exclusions', () => {
  it('deals a deck containing no excluded templates', () => {
    const { gs, h } = lobby();
    h.socket('p1').fire('setDeckExclusions', ['h_001', 'h_002', 'i_001']);
    h.socket('p1').fire('startGame');
    expect(gs.status).toBe('rolling');
    const everywhere = [
      ...gs.mainDeck,
      ...Object.values(gs.players).flatMap(p => p.zones.hand),
    ];
    for (const banned of ['h_001', 'h_002', 'i_001']) {
      expect(everywhere.some(c => c.templateId === banned)).toBe(false);
    }
  });

  it('refuses to start when too few cards remain', () => {
    const { gs, h } = lobby();
    // Exclude every main-deck template.
    const allMain = Object.values(templates())
      .filter(t => !['monster', 'party_leader'].includes(t.type))
      .map(t => t.id);
    h.socket('p1').fire('setDeckExclusions', allMain);
    h.socket('p1').fire('startGame');
    expect(gs.status).toBe('waiting');
    expect(lastOf(h.socket('p1'), 'actionFailed')).toMatch(/excluded/i);
  });
});
