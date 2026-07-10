import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Fake S3: records every PutObjectCommand input so tests can assert on
// uploads without AWS. Loaded lazily by analytics.ts, only when a bucket is set.
const s3 = vi.hoisted(() => ({ puts: [] as Array<{ Key: string; Body: Buffer }> }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(cmd: { input: { Key: string; Body: Buffer } }) {
      s3.puts.push(cmd.input);
      return Promise.resolve({});
    }
  },
  PutObjectCommand: class {
    constructor(public input: { Key: string; Body: Buffer }) {}
  },
}));

import { handleConnection } from '../src/server.js';
import {
  beginGameSession, endGameSession, logGame, flushAnalytics, resetAnalyticsState,
  shutdownAnalytics, sweepOrphanedLogs,
} from '../src/analytics.js';
import { applyWinIfMet } from '../src/util.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster,
  type Harness, type FakeSocket,
} from './harness.js';

// The stream is opt-in: each test enables it and points it at a throwaway dir.
let dir: string;

beforeEach(() => {
  resetEngineState();
  resetAnalyticsState();
  s3.puts = [];
  dir = mkdtempSync(path.join(os.tmpdir(), 'hts-analytics-'));
  process.env.ANALYTICS_ENABLED = 'true';
  process.env.ANALYTICS_DIR = dir;
});

afterEach(() => {
  delete process.env.ANALYTICS_ENABLED;
  delete process.env.ANALYTICS_DIR;
  delete process.env.ANALYTICS_S3_BUCKET;
  delete process.env.ANALYTICS_CHECKPOINT_MS;
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line
const readLines = async (): Promise<any[]> => {
  await flushAnalytics();
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(path.join(dir, files[0]!), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
};

const connect = (h: Harness, id: string): FakeSocket => {
  handleConnection(h.socket(id) as never);
  return h.socket(id);
};

describe('analytics event stream', () => {
  it('is a no-op when ANALYTICS_ENABLED is not set', async () => {
    delete process.env.ANALYTICS_ENABLED;
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    beginGameSession(gs);
    logGame(gs, 'hero_played', { templateId: 'h_001' }, 'p1');
    await endGameSession(gs, 'reset');
    await flushAnalytics();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('writes one JSONL line per event with monotonic seq and a full board snapshot', async () => {
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', hand: [makeCard('h_001')], partyLeaderId: 'p_001' }),
        buildPlayer({ id: 'p2' }),
      ],
      activeMonsters: [makeMonster('m_001')],
    });
    beginGameSession(gs);
    logGame(gs, 'hero_played', { templateId: 'h_001' }, 'p1');
    logGame(gs, 'turn_ended', { nextPlayerId: 'p2' }, 'p1');
    await endGameSession(gs, 'reset');

    const lines = await readLines();
    expect(lines.map(l => l.type)).toEqual(['hero_played', 'turn_ended', 'game_end']);
    expect(lines.map(l => l.seq)).toEqual([1, 2, 3]);
    expect(lines.every(l => l.sessionId === lines[0].sessionId)).toBe(true);

    // Every line carries the snapshot, hidden information included.
    const snap = lines[0].state;
    expect(snap.players.p1.hand).toEqual(['h_001']);
    expect(snap.players.p1.partyLeaderId).toBe('p_001');
    expect(snap.activeMonsters).toEqual(['m_001']);
    expect(lines[0].actorId).toBe('p1');
    expect(lines[2].payload.reason).toBe('reset');
    expect(lines[2].payload.durationMs).toBeTypeOf('number');
  });

  it('ends the session with reason win when applyWinIfMet fires', async () => {
    const winner = buildPlayer({
      id: 'p1',
      slainMonsters: [makeMonster('m_001'), makeMonster('m_002'), makeMonster('m_003')],
    });
    const gs = buildGameState({ players: [winner, buildPlayer({ id: 'p2' })], targetMonstersToWin: 3 });
    beginGameSession(gs);

    expect(applyWinIfMet(gs, winner, 'p1')).toBe(true);

    const lines = await readLines();
    const end = lines[lines.length - 1];
    expect(end.type).toBe('game_end');
    expect(end.payload.reason).toBe('win');
    expect(end.payload.winnerId).toBe('p1');
    expect(end.state.players.p1.slainMonsters).toHaveLength(3);
  });

  it('is idempotent on double endGameSession', async () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    beginGameSession(gs);
    logGame(gs, 'hero_played', {}, 'p1');
    await endGameSession(gs, 'win');
    await endGameSession(gs, 'reset');

    const lines = await readLines();
    expect(lines.filter(l => l.type === 'game_end')).toHaveLength(1);
  });

  it('records game_start and the turn-order rolls when handlers drive a real game', async () => {
    const gs = buildGameState({
      status: 'waiting',
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', ready: true })],
    });
    const h = createHarness(gs);
    const s1 = connect(h, 'p1');
    const s2 = connect(h, 'p2');

    s1.fire('startGame');
    expect(gs.status).toBe('rolling');
    s1.fire('rollForFirst');
    s2.fire('rollForFirst');
    // Lobby leader skips the roll_complete countdown into leader selection.
    s1.fire('continueGame');
    expect(gs.status).toBe('party_leader_selection');

    const lines = await readLines();
    const types = lines.map(l => l.type);
    expect(types[0]).toBe('game_start');
    expect(types.filter(t => t === 'turn_order_roll')).toHaveLength(2);
    expect(types).toContain('turn_order_decided');
    expect(types).toContain('party_leader_selection_started');

    const start = lines[0];
    expect(start.payload.players).toEqual([
      { id: 'p1', username: 'p1' },
      { id: 'p2', username: 'p2' },
    ]);
    // Starting hands were dealt before game_start, so its snapshot has them.
    expect(start.state.players.p1.hand).toHaveLength(5);

    const roll = lines.find(l => l.type === 'turn_order_roll');
    expect(roll.payload.total).toBe(roll.payload.die1 + roll.payload.die2);
  });

  it('closes every open session with reason server_shutdown on shutdownAnalytics', async () => {
    const gs1 = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    const gs2 = buildGameState({ players: [buildPlayer({ id: 'p2' })] });
    gs2.gameId = 'TEST2';
    beginGameSession(gs1);
    beginGameSession(gs2);
    logGame(gs1, 'hero_played', {}, 'p1');

    await shutdownAnalytics();

    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const lines = readFileSync(path.join(dir, file), 'utf8')
        .trim().split('\n').map(l => JSON.parse(l));
      const end = lines[lines.length - 1];
      expect(end.type).toBe('game_end');
      expect(end.payload.reason).toBe('server_shutdown');
    }
  });

  it('checkpoints in-progress games to S3 and overwrites with the final upload', async () => {
    process.env.ANALYTICS_S3_BUCKET = 'test-bucket';
    process.env.ANALYTICS_CHECKPOINT_MS = '0'; // checkpoint on every write

    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    beginGameSession(gs);
    logGame(gs, 'hero_played', {}, 'p1');
    logGame(gs, 'turn_ended', {}, 'p1');
    await endGameSession(gs, 'win');

    // Two checkpoints plus the final ship, all to the same key.
    expect(s3.puts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(s3.puts.map(p => p.Key)).size).toBe(1);
    expect(s3.puts[0]!.Key).toMatch(/^games\/.*TEST.*\.jsonl$/);

    // Earlier checkpoints hold the partial game; the last upload is complete.
    expect(s3.puts[0]!.Body.toString()).not.toContain('"game_end"');
    const finalBody = s3.puts[s3.puts.length - 1]!.Body.toString();
    expect(finalBody).toContain('"game_end"');

    // Local copy removed after the final upload.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('ships orphaned logs from a previous process on sweepOrphanedLogs', async () => {
    process.env.ANALYTICS_S3_BUCKET = 'test-bucket';
    const orphan = path.join(dir, '2026-07-05-DEAD-abc123.jsonl');
    writeFileSync(orphan, '{"type":"hero_played","seq":1}\n');

    await sweepOrphanedLogs();

    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0]!.Key).toBe('games/2026-07-05-DEAD-abc123.jsonl');
    expect(s3.puts[0]!.Body.toString()).toContain('hero_played');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('sweepOrphanedLogs is a no-op without an S3 bucket', async () => {
    const orphan = path.join(dir, '2026-07-05-DEAD-abc123.jsonl');
    writeFileSync(orphan, '{"seq":1}\n');
    await sweepOrphanedLogs();
    expect(s3.puts).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('persists a bug report with game context, stamps the event stream, and acks', async () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand: [makeCard('h_001')] }), buildPlayer({ id: 'p2' })],
    });
    const h = createHarness(gs);
    const s1 = connect(h, 'p1');
    beginGameSession(gs);
    logGame(gs, 'hero_played', {}, 'p1');

    s1.fire('reportBug', {
      category: 'card_behavior',
      description: '  Beary Wise discarded nothing  ',
      client: { userAgent: 'test-agent', viewport: '800x600' },
    });
    await flushAnalytics();

    expect(s1.emittedOf('bugReportAck')[0]!.args[0]).toEqual({
      ok: true, message: expect.stringMatching(/sent/i),
    });

    // Standalone bug file, trimmed description, enriched with game context.
    const bugsDir = path.join(dir, 'bugs');
    const bugFiles = readdirSync(bugsDir);
    expect(bugFiles).toHaveLength(1);
    const bug = JSON.parse(readFileSync(path.join(bugsDir, bugFiles[0]!), 'utf8'));
    expect(bug.category).toBe('card_behavior');
    expect(bug.description).toBe('Beary Wise discarded nothing');
    expect(bug.reporter).toEqual({ id: 'p1', username: 'p1' });
    expect(bug.game.session.sessionId).toContain('TEST');
    expect(bug.game.session.seq).toBe(1);
    expect(bug.client.userAgent).toBe('test-agent');

    // And a bug_report event in the game's stream, snapshot included.
    await endGameSession(gs, 'reset');
    const gameFile = readdirSync(dir).find(f => f.endsWith('.jsonl'))!;
    const lines = readFileSync(path.join(dir, gameFile), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    const event = lines.find(l => l.type === 'bug_report');
    expect(event.payload.category).toBe('card_behavior');
    expect(event.state.players.p1.hand).toEqual(['h_001']);
  });

  it('coerces unknown categories to other and rejects empty descriptions', async () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    const h = createHarness(gs);
    const s1 = connect(h, 'p1');

    s1.fire('reportBug', { category: 'nonsense', description: 'something broke' });
    s1.fire('reportBug', { category: 'visual', description: '   ' });
    await flushAnalytics();

    const acks = s1.emittedOf('bugReportAck').map(e => e.args[0]) as Array<{ ok: boolean }>;
    expect(acks[0]!.ok).toBe(true);
    expect(acks[1]!.ok).toBe(false);

    const bugFiles = readdirSync(path.join(dir, 'bugs'));
    expect(bugFiles).toHaveLength(1);
    const bug = JSON.parse(readFileSync(path.join(dir, 'bugs', bugFiles[0]!), 'utf8'));
    expect(bug.category).toBe('other');
    // No active session — the report still records that explicitly.
    expect(bug.game.session).toBeNull();
  });

  it('rate-limits repeat reports from the same connection', async () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    const h = createHarness(gs);
    const s1 = connect(h, 'p1');

    s1.fire('reportBug', { category: 'stuck', description: 'first' });
    s1.fire('reportBug', { category: 'stuck', description: 'second, too soon' });
    await flushAnalytics();

    const acks = s1.emittedOf('bugReportAck').map(e => e.args[0]) as Array<{ ok: boolean }>;
    expect(acks.map(a => a.ok)).toEqual([true, false]);
    expect(readdirSync(path.join(dir, 'bugs'))).toHaveLength(1);
  });

  it('uploads bug reports to S3 under the bugs/ prefix when configured', async () => {
    process.env.ANALYTICS_S3_BUCKET = 'test-bucket';
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' })] });
    const h = createHarness(gs);
    connect(h, 'p1').fire('reportBug', { category: 'connection', description: 'lag spike' });
    await flushAnalytics();

    expect(s3.puts).toHaveLength(1);
    // Bug files are named by room code.
    expect(s3.puts[0]!.Key).toMatch(new RegExp(`^bugs/.*${h.roomCode}.*\\.json$`));
    expect(s3.puts[0]!.Body.toString()).toContain('lag spike');
    // Local copy removed after upload.
    expect(readdirSync(path.join(dir, 'bugs'))).toHaveLength(0);
  });

  it('closes the session with reason reset when a player quits to the lobby', async () => {
    const gs = buildGameState({
      status: 'waiting',
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', ready: true })],
    });
    const h = createHarness(gs);
    const s1 = connect(h, 'p1');
    connect(h, 'p2');

    s1.fire('startGame');
    s1.fire('quitGame');

    const lines = await readLines();
    const end = lines[lines.length - 1];
    expect(end.type).toBe('game_end');
    expect(end.payload.reason).toBe('reset');
    expect(end.payload.resetBy).toBe('p1');
    // Snapshot taken before the lobby wipe, so the dealt hands are preserved.
    expect(end.state.players.p1.hand).toHaveLength(5);
  });
});
