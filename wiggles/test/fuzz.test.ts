/**
 * Fuzz simulator: plays full random games through the REAL socket handlers
 * (handleConnection + fake-io harness) and checks engine invariants after
 * every single action. Any crash, card-conservation violation, empty prompt,
 * or stuck game is recorded with its seed + action history so it reproduces
 * deterministically.
 *
 * Run modes:
 *   npm test                      — runs FUZZ_GAMES (default 25) games
 *   FUZZ_GAMES=500 npm run fuzz   — long hunt
 *   FUZZ_SEED=123456 npm run fuzz — replay exactly one failing game
 *
 * Every failure is also written to test/fuzz-failures/<seed>.json with the
 * full action log and a state snapshot at the moment of the violation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── seeded RNG (shared by the engine's dice and the fuzzer's choices) ────────
// vi.hoisted so the dice mock below can close over it.
const rng = vi.hoisted(() => {
  let s = 1;
  return {
    seed(v: number) { s = (v >>> 0) || 1; },
    // mulberry32
    next(): number {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
});

// The engine's crypto dice → seeded dice, so a game replays from its seed.
vi.mock('../src/dice.js', () => ({
  rollDie: () => 1 + Math.floor(rng.next() * 6),
  roll2d6: () => [1 + Math.floor(rng.next() * 6), 1 + Math.floor(rng.next() * 6)] as [number, number],
}));

import { handleConnection } from '../src/server.js';
import { abilityPromptRequests, pendingChallenges } from '../src/state.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer,
  type Harness, type FakeSocket, type AbilityPromptPayload,
} from './harness.js';
import type { GameState, CardInstance } from '../../shared/src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAILURE_DIR = join(__dirname, 'fuzz-failures');

const GAMES = Number(process.env.FUZZ_GAMES ?? 25);
const MAX_STEPS = Number(process.env.FUZZ_STEPS ?? 2500);
/** Steps with zero observable state change before we call the game stuck. */
const STUCK_LIMIT = 80;

// ── helpers ──────────────────────────────────────────────────────────────────
const pick = <T>(arr: T[]): T => arr[Math.floor(rng.next() * arr.length)]!;
const chance = (p: number): boolean => rng.next() < p;

interface ActionRecord { step: number; actor: string; event: string; args: unknown[] }
interface Violation { kind: string; detail: string; step: number }

interface GameReport {
  seed: number;
  steps: number;
  finished: boolean;
  violations: Violation[];
  /** Tail of the action log around the first violation (or the whole game if short). */
  actions: ActionRecord[];
  /** Template ids that left the deck (played/discarded/drawn into a party) — coverage signal. */
  templatesTouched: Set<string>;
}

/** All zones that main-deck cards may legally occupy. */
const mainZones = (gs: GameState): Array<[string, CardInstance[]]> => {
  const zones: Array<[string, CardInstance[]]> = [
    ['mainDeck', gs.mainDeck],
    ['discardPile', gs.discardPile],
  ];
  for (const p of Object.values(gs.players)) {
    zones.push([`hand:${p.id}`, p.zones.hand]);
    zones.push([`party:${p.id}`, p.zones.party]);
  }
  // While a challenge window is open, the played card is legitimately parked
  // in the engine's pendingChallenges map, outside any player zone.
  const pending = pendingChallenges.get(gs.gameId);
  if (pending) zones.push(['pendingChallenge', [pending.pendingCardInstance]]);
  return zones;
};

const monsterZones = (gs: GameState): Array<[string, CardInstance[]]> => {
  const zones: Array<[string, CardInstance[]]> = [
    ['monsterDeck', gs.monsterDeck],
    ['activeMonsters', gs.activeMonsters],
    ['discardedMonsters', gs.discardedMonsters],
  ];
  for (const p of Object.values(gs.players)) zones.push([`slain:${p.id}`, p.slainMonsters]);
  return zones;
};

/** Cheap structural fingerprint — if it doesn't change, nothing happened. */
const stateHash = (gs: GameState): string => {
  const parts: Array<string | number> = [
    gs.status, gs.turnNumber, gs.activePlayerId, gs.mainDeck.length, gs.discardPile.length,
    gs.activeMonsters.length, abilityPromptRequests.size,
    gs.pendingChallenge ? `ch:${gs.pendingChallenge.challengerId ?? '-'}:${gs.pendingChallenge.eligibleChallengerIds.join(',')}` : '',
    gs.modifierPhase ? `mod:${gs.modifierPhase.activePlayerId}:${gs.modifierPhase.accumulatedModifier}:${gs.modifierPhase.phase}` : '',
    gs.currentRollerId ?? '', gs.currentSelectionPlayerId ?? '',
    Object.keys(gs.diceRolls).length,
  ];
  for (const p of Object.values(gs.players)) {
    parts.push(p.id, p.actionPoints, p.zones.hand.length, p.zones.party.length, p.slainMonsters.length,
      p.zones.party.filter(c => c.effectUsedThisTurn).length);
  }
  return parts.join('|');
};

// ── invariant checks ─────────────────────────────────────────────────────────
const checkInvariants = (
  gs: GameState,
  initialMain: Set<string>,
  initialMonsters: Set<string>,
  step: number,
): Violation[] => {
  const v: Violation[] = [];

  // 1. Card conservation: every main-deck card in exactly one zone, none
  //    created or destroyed. (Party leaders are excluded: availablePartyLeaderCards
  //    intentionally aliases the deck during selection.)
  for (const [label, initial, zones] of [
    ['main', initialMain, mainZones(gs)],
    ['monster', initialMonsters, monsterZones(gs)],
  ] as const) {
    const seen = new Map<string, string>();
    for (const [zone, cards] of zones) {
      for (const c of cards) {
        if (c.cardType === 'party_leader') continue;
        const prev = seen.get(c.instanceId);
        if (prev) v.push({ kind: 'duplicate-card', detail: `${label} card ${c.templateId} (${c.instanceId}) is in both ${prev} and ${zone}`, step });
        seen.set(c.instanceId, zone);
      }
    }
    for (const id of initial) {
      if (!seen.has(id)) v.push({ kind: 'vanished-card', detail: `${label} card ${id} is in no zone`, step });
    }
    for (const id of seen.keys()) {
      if (!initial.has(id)) v.push({ kind: 'materialized-card', detail: `${label} card ${id} appeared from nowhere`, step });
    }
  }

  // 2. Sane player state.
  for (const p of Object.values(gs.players)) {
    if (p.actionPoints < 0) v.push({ kind: 'negative-ap', detail: `${p.id} has ${p.actionPoints} AP`, step });
    if (p.actionPoints > 20) v.push({ kind: 'runaway-ap', detail: `${p.id} has ${p.actionPoints} AP`, step });
    if (p.zones.hand.length > 40) v.push({ kind: 'runaway-hand', detail: `${p.id} holds ${p.zones.hand.length} cards`, step });
  }
  if (gs.status === 'in_progress' && !gs.players[gs.activePlayerId]) {
    v.push({ kind: 'orphan-active-player', detail: `activePlayerId ${gs.activePlayerId} is not a player`, step });
  }

  // 3. No empty prompts: a prompt with zero options is a softlock (and violates
  //    the whiff rule — no legal target should mean no prompt at all).
  for (const req of abilityPromptRequests.values()) {
    if (req.options.length === 0) {
      v.push({ kind: 'empty-prompt', detail: `prompt ${req.promptId} (${req.effect.action}) has no options`, step });
    }
    if (!gs.players[req.sourcePlayerId]) {
      v.push({ kind: 'orphan-prompt', detail: `prompt ${req.promptId} sourced by unknown player ${req.sourcePlayerId}`, step });
    }
  }

  return v;
};

// ── action selection ─────────────────────────────────────────────────────────
/** Find prompts that are still open (their promptId is live in the engine map). */
const openPrompts = (h: Harness, gs: GameState): Array<{ socket: FakeSocket; prompt: AbilityPromptPayload }> => {
  const out: Array<{ socket: FakeSocket; prompt: AbilityPromptPayload }> = [];
  for (const id of Object.keys(gs.players)) {
    const s = h.socket(id);
    for (const p of s.prompts()) {
      if (abilityPromptRequests.has(p.promptId)) out.push({ socket: s, prompt: p });
    }
  }
  return out;
};

interface Chosen { socket: FakeSocket; event: string; args: unknown[] }

const chooseAction = (h: Harness, gs: GameState, stuckFor: number): Chosen | undefined => {
  // Open prompts always take priority — a real game can't proceed past them.
  const prompts = openPrompts(h, gs);
  if (prompts.length > 0) {
    const { socket, prompt } = pick(prompts);
    if (prompt.promptType === 'multiSelectCard') {
      const min = prompt.minSelections ?? 1;
      const max = Math.min(prompt.maxSelections ?? prompt.options.length, prompt.options.length);
      const k = Math.min(min + Math.floor(rng.next() * (max - min + 1)), prompt.options.length);
      const shuffled = prompt.options.slice().sort(() => rng.next() - 0.5);
      return { socket, event: 'respondToAbilityPromptMulti', args: [prompt.promptId, shuffled.slice(0, k).map(o => o.id)] };
    }
    return { socket, event: 'respondToAbilityPrompt', args: [prompt.promptId, pick(prompt.options).id] };
  }

  switch (gs.status) {
    case 'rolling': {
      const roller = gs.currentRollerId;
      if (!roller) return undefined;
      return { socket: h.socket(roller), event: 'rollForFirst', args: [] };
    }
    case 'roll_complete':
    case 'party_leader_review': {
      const leader = gs.lobbyLeaderId ?? Object.keys(gs.players)[0]!;
      return { socket: h.socket(leader), event: 'continueGame', args: [] };
    }
    case 'party_leader_selection': {
      const chooser = gs.currentSelectionPlayerId;
      if (!chooser || gs.availablePartyLeaderCards.length === 0) return undefined;
      return { socket: h.socket(chooser), event: 'choosePartyLeader', args: [pick(gs.availablePartyLeaderCards).instanceId] };
    }
    case 'in_progress':
      break; // handled below
    default:
      return undefined;
  }

  // Modifier phase: only the phase's active player may act.
  if (gs.modifierPhase) {
    const actor = gs.modifierPhase.activePlayerId;
    const player = gs.players[actor];
    const s = h.socket(actor);
    const modifiers = player?.zones.hand.filter(c => c.cardType === 'modifier') ?? [];
    if (modifiers.length > 0 && chance(0.5)) {
      return { socket: s, event: 'playModifier', args: [pick(modifiers).instanceId, Math.floor(rng.next() * 2)] };
    }
    return { socket: s, event: 'passModifier', args: [] };
  }

  // Challenge window: eligible players challenge or pass.
  if (gs.pendingChallenge && !gs.pendingChallenge.challengerId) {
    const eligible = gs.pendingChallenge.eligibleChallengerIds.filter(id => gs.players[id]);
    if (eligible.length > 0) {
      const actor = pick(eligible);
      const s = h.socket(actor);
      const challenges = gs.players[actor]!.zones.hand.filter(c => c.cardType === 'challenge');
      if (challenges.length > 0 && chance(0.4)) {
        return { socket: s, event: 'playChallenge', args: [pick(challenges).instanceId] };
      }
      return { socket: s, event: 'passChallenge', args: [] };
    }
  }

  // Normal turn: the active player picks a random plausible move. Illegal
  // choices are fine — they fuzz the server's validation paths.
  const actor = gs.activePlayerId;
  const player = gs.players[actor];
  if (!player) return undefined;
  const s = h.socket(actor);

  // Anti-flake: if random moves have gone nowhere for a while (empty deck, all
  // abilities spent, unattackable monsters), do what a real player would and
  // end the turn. A genuine softlock still trips the stuck detector, because
  // then even endTurn changes nothing.
  if (stuckFor >= STUCK_LIMIT / 2) return { socket: s, event: 'endTurn', args: [] };

  const hand = player.zones.hand;
  const heroesInHand = hand.filter(c => c.cardType === 'hero');
  const itemsInHand = hand.filter(c => c.cardType === 'item');
  const magicInHand = hand.filter(c => c.cardType === 'magic');
  const partyHeroes = Object.values(gs.players).flatMap(p => p.zones.party.filter(c => c.cardType === 'hero'));
  const myPartyHeroes = player.zones.party.filter(c => c.cardType === 'hero');

  const moves: Array<{ weight: number; make: () => Chosen }> = [];
  const add = (weight: number, make: () => Chosen) => moves.push({ weight, make });

  if (player.actionPoints > 0) {
    add(2, () => ({ socket: s, event: 'drawFromMain', args: [] }));
    if (heroesInHand.length > 0) add(4, () => ({ socket: s, event: 'playHero', args: [pick(heroesInHand).instanceId] }));
    if (magicInHand.length > 0) add(3, () => ({ socket: s, event: 'playMagic', args: [pick(magicInHand).instanceId] }));
    if (itemsInHand.length > 0 && partyHeroes.length > 0) {
      add(3, () => {
        const item = pick(itemsInHand);
        const template = gs.cardTemplates[item.templateId];
        if (template?.type === 'cursed_item') {
          const opponents = Object.values(gs.players).filter(p => p.id !== actor && p.zones.party.some(c => c.cardType === 'hero'));
          const target = opponents.length > 0 ? pick(opponents) : player;
          const targetHero = target.zones.party.filter(c => c.cardType === 'hero');
          return { socket: s, event: 'playCursedItem', args: [item.instanceId, target.id, targetHero.length ? pick(targetHero).instanceId : ''] };
        }
        return { socket: s, event: 'playItem', args: [item.instanceId, pick(partyHeroes).instanceId] };
      });
    }
    if (myPartyHeroes.length > 0) {
      add(5, () => ({ socket: s, event: 'activateHeroAbility', args: [pick(myPartyHeroes).instanceId] }));
      add(1, () => ({ socket: s, event: 'rollHeroAbility', args: [pick(myPartyHeroes).instanceId] }));
    }
    add(1, () => ({ socket: s, event: 'usePartyLeaderAbility', args: [] }));
  }
  if (player.actionPoints >= 2 && gs.activeMonsters.length > 0) {
    add(5, () => ({ socket: s, event: 'attackMonster', args: [pick(gs.activeMonsters).instanceId] }));
  }
  if (player.actionPoints >= 3 && gs.mainDeck.length >= 5) {
    add(1, () => ({ socket: s, event: 'mulligan', args: [] }));
  }
  // endTurn is always available so the game can make progress.
  add(player.actionPoints === 0 ? 10 : 1, () => ({ socket: s, event: 'endTurn', args: [] }));

  const total = moves.reduce((sum, m) => sum + m.weight, 0);
  let roll = rng.next() * total;
  for (const m of moves) {
    roll -= m.weight;
    if (roll <= 0) return m.make();
  }
  return moves[moves.length - 1]!.make();
};

// ── one full game ────────────────────────────────────────────────────────────
const runGame = (seed: number, gameIndex: number): GameReport => {
  rng.seed(seed);
  resetEngineState();

  const numPlayers = 2 + Math.floor(rng.next() * 3); // 2–4
  const ids = Array.from({ length: numPlayers }, (_, i) => `p${i + 1}`);
  const gs = buildGameState({
    status: 'waiting',
    players: ids.map(id => buildPlayer({ id, actionPoints: 0 })),
  });
  gs.gameId = `FUZZ${gameIndex}`; // unique room per game so stray timers can't cross-talk
  gs.targetMonstersToWin = 1 + Math.floor(rng.next() * 3); // 1–3: mix of short and long games
  const h = createHarness(gs);

  const actions: ActionRecord[] = [];
  const violations: Violation[] = [];
  let step = 0;

  const fire = (socket: FakeSocket, event: string, args: unknown[]) => {
    actions.push({ step, actor: String(socket.data.playerId), event, args });
    try {
      socket.fire(event, ...args);
    } catch (err) {
      violations.push({
        kind: 'crash',
        detail: `${event}(${JSON.stringify(args)}) by ${String(socket.data.playerId)} threw: ${(err as Error).stack ?? String(err)}`,
        step,
      });
    }
  };

  // Lobby: connect everyone, ready up, start. Half the games run with a random
  // slice of the deck excluded via the lobby deck editor, so thin-deck and
  // deck-empty paths get fuzzed too.
  for (const id of ids) handleConnection(h.socket(id) as never);
  for (const id of ids.slice(1)) fire(h.socket(id), 'toggleReady', []);
  if (chance(0.5)) {
    const mainIds = Object.values(gs.cardTemplates)
      .filter(t => !['monster', 'party_leader'].includes(t.type))
      .map(t => t.id);
    const cut = rng.next() * 0.5; // exclude up to ~half the templates
    fire(h.socket(ids[0]!), 'setDeckExclusions', [mainIds.filter(() => chance(cut))]);
  }
  fire(h.socket(ids[0]!), 'startGame', []);
  if (gs.status === 'waiting') {
    // The random exclusion cut too deep for this player count — retry with the full deck.
    fire(h.socket(ids[0]!), 'setDeckExclusions', [[]]);
    fire(h.socket(ids[0]!), 'startGame', []);
  }

  if (gs.status === 'waiting') {
    violations.push({ kind: 'start-failed', detail: 'startGame did not leave the lobby', step });
    return { seed, steps: 0, finished: false, violations, actions, templatesTouched: new Set() };
  }

  // Census taken right after dealing: these exact instances must persist.
  const initialMain = new Set<string>(mainZones(gs).flatMap(([, cards]) => cards.map(c => c.instanceId)));
  const initialMonsters = new Set<string>(monsterZones(gs).flatMap(([, cards]) => cards.map(c => c.instanceId)));

  let lastHash = stateHash(gs);
  let stuckFor = 0;

  for (step = 1; step <= MAX_STEPS; step++) {
    if (gs.status === 'finished') break;

    const action = chooseAction(h, gs, stuckFor);
    if (!action) {
      violations.push({ kind: 'no-action', detail: `fuzzer found nothing to do in status=${gs.status} (roller=${gs.currentRollerId}, selector=${gs.currentSelectionPlayerId})`, step });
      break;
    }
    fire(action.socket, action.event, action.args);

    violations.push(...checkInvariants(gs, initialMain, initialMonsters, step));

    const hash = stateHash(gs);
    if (hash === lastHash) {
      stuckFor++;
      if (stuckFor >= STUCK_LIMIT) {
        violations.push({
          kind: 'stuck',
          detail: `no observable state change for ${STUCK_LIMIT} actions (status=${gs.status}, active=${gs.activePlayerId}, AP=${gs.players[gs.activePlayerId]?.actionPoints}, prompts=${abilityPromptRequests.size}, challenge=${JSON.stringify(gs.pendingChallenge ?? null)}, modifier=${JSON.stringify(gs.modifierPhase ?? null)})`,
          step,
        });
        break;
      }
    } else {
      stuckFor = 0;
      lastHash = hash;
    }

    // Fail fast once something is broken — later violations are usually noise.
    if (violations.length > 0) break;
  }

  // Coverage: anything in a party, the discard pile, or slain is a card whose
  // play/resolution path actually ran this game.
  const templatesTouched = new Set<string>();
  for (const c of gs.discardPile) templatesTouched.add(c.templateId);
  for (const p of Object.values(gs.players)) {
    for (const c of p.zones.party) templatesTouched.add(c.templateId);
    for (const c of p.slainMonsters) templatesTouched.add(c.templateId);
  }
  for (const c of gs.discardedMonsters) templatesTouched.add(c.templateId);

  return { seed, steps: step, finished: gs.status === 'finished', violations, actions, templatesTouched };
};

// ── the test ─────────────────────────────────────────────────────────────────
describe(`fuzz: ${GAMES} random games through the real socket handlers`, () => {
  const realRandom = Math.random;
  beforeAll(() => { Math.random = () => rng.next(); });
  afterAll(() => { Math.random = realRandom; resetEngineState(); });

  it('completes every game without crashes, lost cards, or softlocks', () => {
    const masterSeed = process.env.FUZZ_SEED
      ? Number(process.env.FUZZ_SEED)
      : Math.floor(realRandom() * 0xffffffff);
    const singleSeed = Boolean(process.env.FUZZ_SEED);

    const failures: GameReport[] = [];
    let finished = 0;
    let totalSteps = 0;
    const touched = new Set<string>();
    const games = singleSeed ? 1 : GAMES;

    for (let i = 0; i < games; i++) {
      const seed = singleSeed ? masterSeed : (masterSeed + i * 0x9e3779b9) >>> 0;
      const report = runGame(seed, i);
      if (report.finished) finished++;
      totalSteps += report.steps;
      for (const t of report.templatesTouched) touched.add(t);
      if (report.violations.length > 0) {
        // Keep only the action tail — full logs of long games drown the report.
        report.actions = report.actions.slice(-120);
        failures.push(report);
      }
    }

    // Coverage summary: how much of the card pool the fuzz run actually exercised.
    // eslint-disable-next-line no-console
    console.log(
      `[fuzz] master seed ${masterSeed}: ${games} games, ${finished} finished, ` +
      `avg ${Math.round(totalSteps / games)} steps/game, ${touched.size} distinct card templates exercised`
    );

    if (failures.length > 0) {
      mkdirSync(FAILURE_DIR, { recursive: true });
      const file = join(FAILURE_DIR, `fuzz-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify({ masterSeed, gamesRun: games, failures }, null, 2));

      const summary = failures.map(f =>
        `seed=${f.seed} step=${f.violations[0]!.step}: [${f.violations[0]!.kind}] ${f.violations[0]!.detail.split('\n')[0]}`
      ).join('\n');
      expect.fail(
        `${failures.length}/${games} fuzzed games hit violations (master seed ${masterSeed}, report: ${file}):\n${summary}\n` +
        `Replay one game with: FUZZ_SEED=<seed> npx vitest run test/fuzz.test.ts`
      );
    }

    // Not a hard assertion — random players are bad at winning — but if NO game
    // in a real population ever finishes, the win condition itself is probably
    // unreachable. (Skipped for single-seed replays and tiny runs, where one
    // unlucky step-capped game is normal.)
    if (!singleSeed && games >= 20) {
      expect(finished, 'no fuzzed game ever reached "finished"').toBeGreaterThan(0);
    }
  }, 300_000);
});
