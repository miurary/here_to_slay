// analytics.ts — structured per-game JSONL event stream for offline analytics.
//
// Separate from log.ts: gameLog is a capped, human-readable feed rendered in
// the client; this stream is an uncapped, machine-readable record of the whole
// game. One line per event, and every line carries a full board snapshot
// (hands included) so analysis never has to replay the engine. Intentionally
// verbose — over-log now, prune in the analysis layer later.
//
// Lifecycle: beginGameSession() when a game starts, logGame() at every
// meaningful engine event, endGameSession() exactly once per game (win, lobby
// reset, or the room emptying). A room can host many games back to back, so
// sessions are keyed by gameId (room code) but each gets a unique file.
//
// Config (all env, read lazily so tests can override). The stream is OFF
// unless explicitly enabled, so dev servers never log; enable it in the prod
// task definition:
//   ANALYTICS_ENABLED=true      turn the stream on
//   ANALYTICS_DIR               where .jsonl files go (default <cwd>/analytics)
//   ANALYTICS_S3_BUCKET         if set, upload the finished file to S3 at game
//                               end and delete the local copy. The server runs
//                               on Fargate whose disk is ephemeral, so prod
//                               should always set this.
//   ANALYTICS_S3_PREFIX         key prefix (default games/)
//   ANALYTICS_S3_REGION         region override (else the SDK default chain)
//   ANALYTICS_S3_KEEP_LOCAL=true  keep the local file after a successful upload
//   ANALYTICS_CHECKPOINT_MS     min ms between mid-game checkpoint uploads
//                               (default 60000; only applies when S3 is set)
//
// Crash-interrupted games: with S3 configured, in-progress files are
// re-uploaded to the same key at most every ANALYTICS_CHECKPOINT_MS, so a hard
// kill (SIGKILL/OOM) loses at most the last interval. SIGTERM/SIGINT go
// through shutdownAnalytics() (see server.ts), which closes every open session
// with reason server_shutdown, and sweepOrphanedLogs() at boot ships any
// leftover files from a previous process on the same disk. A game whose file
// has no game_end line was crash-interrupted.
//
// Analytics must never break the game: writes are serialized per session on a
// promise chain and every fs/S3 failure is caught (logged once per session).

import { randomUUID } from 'crypto';
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';
import type { CardInstance, GameState, PlayerState } from '../../shared/src/types.js';
import type { S3Client as S3ClientType } from '@aws-sdk/client-s3';

const SCHEMA_VERSION = 1;

export type GameEndReason = 'win' | 'reset' | 'abandoned' | 'superseded' | 'server_shutdown';

interface Session {
  sessionId: string;
  filePath: string;
  /** The live state this session records, so shutdownAnalytics can close it. */
  gameState: GameState;
  seq: number;
  startedAt: number;
  lastCheckpointAt: number;
  /** Serializes appends so lines land in seq order. */
  chain: Promise<void>;
  errorLogged: boolean;
  ended: boolean;
}

const sessions = new Map<string, Session>();
// Finalization (last write + S3 ship) promises still in flight, for flushAnalytics.
const inflight = new Set<Promise<void>>();

const config = () => ({
  enabled: process.env.ANALYTICS_ENABLED === 'true',
  dir: process.env.ANALYTICS_DIR || path.resolve('analytics'),
  s3Bucket: process.env.ANALYTICS_S3_BUCKET,
  s3Prefix: process.env.ANALYTICS_S3_PREFIX ?? 'games/',
  s3Region: process.env.ANALYTICS_S3_REGION,
  keepLocal: process.env.ANALYTICS_S3_KEEP_LOCAL === 'true',
  checkpointMs: Number(process.env.ANALYTICS_CHECKPOINT_MS ?? 60_000),
});

const warnOnce = (session: Session, err: unknown) => {
  if (session.errorLogged) return;
  session.errorLogged = true;
  console.error(`[analytics] write failed for ${session.sessionId}:`, err);
};

// ── snapshots ────────────────────────────────────────────────────────────────
// equippedItem on a hero is the instanceId of an item card sitting in the same
// party zone; resolve it to a template id so lines are self-describing.
const equippedTemplateId = (player: PlayerState, itemInstanceId: string): string =>
  player.zones.party.find(c => c.instanceId === itemInstanceId)?.templateId ?? itemInstanceId;

const snapshotPartyCard = (player: PlayerState, card: CardInstance) => ({
  templateId: card.templateId,
  cardType: card.cardType,
  ...(card.equippedItem ? { equippedItem: equippedTemplateId(player, card.equippedItem) } : {}),
});

const snapshotPlayer = (player: PlayerState) => ({
  username: player.username,
  actionPoints: player.actionPoints,
  partyLeaderId: player.partyLeaderId,
  hand: player.zones.hand.map(c => c.templateId),
  party: player.zones.party.map(c => snapshotPartyCard(player, c)),
  slainMonsters: (player.slainMonsters ?? []).map(c => c.templateId),
});

const snapshotState = (gameState: GameState) => ({
  status: gameState.status,
  turnNumber: gameState.turnNumber,
  activePlayerId: gameState.activePlayerId,
  mainDeckCount: gameState.mainDeck.length,
  monsterDeckCount: gameState.monsterDeck.length,
  discardCount: gameState.discardPile.length,
  activeMonsters: gameState.activeMonsters.map(m => m.templateId),
  players: Object.fromEntries(
    Object.entries(gameState.players).map(([id, p]) => [id, snapshotPlayer(p)]),
  ),
});

// ── S3 shipping ──────────────────────────────────────────────────────────────
// The SDK is imported dynamically (type-only import above is erased at build
// time) so servers that never set ANALYTICS_S3_BUCKET pay nothing for it.
let s3Client: S3ClientType | undefined;

// Uploads to a key derived from the basename, so mid-game checkpoints and the
// final game_end upload of the same session overwrite one another.
const uploadToS3 = async (filePath: string, removeLocal: boolean, keyPrefix?: string) => {
  const cfg = config();
  if (!cfg.s3Bucket) return;
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = (s3Client ??= new S3Client(cfg.s3Region ? { region: cfg.s3Region } : {}));
  const body = await readFile(filePath);
  await client.send(new PutObjectCommand({
    Bucket: cfg.s3Bucket,
    Key: `${keyPrefix ?? cfg.s3Prefix}${path.basename(filePath)}`,
    Body: body,
    ContentType: 'application/x-ndjson',
  }));
  if (removeLocal) await unlink(filePath);
};

// ── public API ───────────────────────────────────────────────────────────────

/** Start a fresh analytics session for this room's new game. */
export const beginGameSession = (gameState: GameState): void => {
  const cfg = config();
  if (!cfg.enabled) return;

  // startGame while a previous session is somehow still open (e.g. a room that
  // was reset without endGameSession) — close it out rather than interleave.
  if (sessions.get(gameState.gameId)?.ended === false) {
    endGameSession(gameState, 'superseded');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const sessionId = `${stamp}-${gameState.gameId}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const session: Session = {
    sessionId,
    filePath: path.join(cfg.dir, `${sessionId}.jsonl`),
    gameState,
    seq: 0,
    startedAt,
    lastCheckpointAt: startedAt,
    chain: mkdir(cfg.dir, { recursive: true }).then(() => undefined),
    errorLogged: false,
    ended: false,
  };
  session.chain = session.chain.catch(err => warnOnce(session, err));
  sessions.set(gameState.gameId, session);
};

/**
 * Append one event line for the game this state belongs to. No-op when no
 * session is active (lobby traffic, analytics disabled, or already ended).
 */
export const logGame = (
  gameState: GameState,
  type: string,
  payload?: Record<string, unknown>,
  actorId?: string,
): void => {
  const session = sessions.get(gameState.gameId);
  if (!session || session.ended) return;

  session.seq += 1;
  const actorName = actorId ? gameState.players[actorId]?.username : undefined;
  const line = JSON.stringify({
    v: SCHEMA_VERSION,
    sessionId: session.sessionId,
    gameId: gameState.gameId,
    seq: session.seq,
    ts: Date.now(),
    type,
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(payload ? { payload } : {}),
    state: snapshotState(gameState),
  }) + '\n';

  session.chain = session.chain
    .then(() => appendFile(session.filePath, line))
    .catch(err => warnOnce(session, err));

  // Mid-game checkpoint: re-ship the partial file so a hard kill (no signal,
  // no shutdown hook) loses at most the last checkpointMs of events.
  const cfg = config();
  const now = Date.now();
  if (cfg.s3Bucket && now - session.lastCheckpointAt >= cfg.checkpointMs) {
    session.lastCheckpointAt = now;
    session.chain = session.chain
      .then(() => uploadToS3(session.filePath, false))
      .catch(err => warnOnce(session, err));
  }
};

/**
 * Write the terminal game_end event and close the session; if S3 is configured
 * the finished file is uploaded (and by default removed locally). Idempotent.
 * Fire-and-forget for the server; tests can await the returned promise.
 */
export const endGameSession = (
  gameState: GameState,
  reason: GameEndReason,
  payload?: Record<string, unknown>,
): Promise<void> => {
  const session = sessions.get(gameState.gameId);
  if (!session || session.ended) return Promise.resolve();

  logGame(gameState, 'game_end', {
    reason,
    durationMs: Date.now() - session.startedAt,
    turnNumber: gameState.turnNumber,
    ...(gameState.winnerId ? {
      winnerId: gameState.winnerId,
      winnerUsername: gameState.players[gameState.winnerId]?.username,
    } : {}),
    ...payload,
  });

  session.ended = true;
  sessions.delete(gameState.gameId);

  const done = session.chain
    .then(() => uploadToS3(session.filePath, !config().keepLocal))
    .catch(err => warnOnce(session, err));
  inflight.add(done);
  void done.finally(() => inflight.delete(done));
  return done;
};

/**
 * Close every open session with reason server_shutdown and wait for the final
 * writes/uploads. Called from the SIGTERM/SIGINT handlers in server.ts — on
 * ECS this is the deploy/scale-down path, so mid-game logs still ship.
 */
export const shutdownAnalytics = (): Promise<void> => {
  for (const session of [...sessions.values()]) {
    void endGameSession(session.gameState, 'server_shutdown');
  }
  return flushAnalytics();
};

/**
 * Ship any .jsonl files left on disk by a previous process (a crash that never
 * reached endGameSession) and remove them locally. Called once at boot, before
 * any session exists, so everything in the directory is an orphan. No-op
 * unless analytics and S3 are both configured.
 */
export const sweepOrphanedLogs = async (): Promise<void> => {
  const cfg = config();
  if (!cfg.enabled || !cfg.s3Bucket) return;
  let files: string[];
  try {
    files = (await readdir(cfg.dir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return; // no directory yet — nothing to sweep
  }
  for (const file of files) {
    try {
      await uploadToS3(path.join(cfg.dir, file), true);
      console.log(`[analytics] shipped orphaned game log ${file}`);
    } catch (err) {
      console.error(`[analytics] failed to ship orphaned log ${file}:`, err);
    }
  }
};

/**
 * Where the current game sits in its analytics stream, for cross-referencing a
 * bug report against the exact moment in the JSONL replay. Undefined when no
 * session is active (lobby, analytics disabled).
 */
export const currentSessionInfo = (
  gameState: GameState,
): { sessionId: string; seq: number } | undefined => {
  const session = sessions.get(gameState.gameId);
  return session && !session.ended
    ? { sessionId: session.sessionId, seq: session.seq }
    : undefined;
};

/**
 * Persist a player-submitted bug report as a standalone JSON file under
 * <dir>/bugs/, shipped to S3 under bugs/ when a bucket is configured.
 * Unlike the event stream this is NOT gated on ANALYTICS_ENABLED — a bug
 * report is an explicit user action and should never be dropped silently.
 */
export const saveBugReport = (
  roomCode: string,
  report: Record<string, unknown>,
): Promise<void> => {
  const cfg = config();
  const stamp = new Date().toISOString().slice(0, 10);
  const bugsDir = path.join(cfg.dir, 'bugs');
  const filePath = path.join(bugsDir, `${stamp}-${roomCode}-${randomUUID().slice(0, 8)}.json`);

  const done = (async () => {
    await mkdir(bugsDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(report, null, 2));
    await uploadToS3(filePath, !cfg.keepLocal, 'bugs/');
  })().catch(err => console.error('[analytics] bug report save failed:', err));

  inflight.add(done);
  void done.finally(() => inflight.delete(done));
  return done;
};

/** Await every pending write and upload. Test-only convenience. */
export const flushAnalytics = async (): Promise<void> => {
  await Promise.all([...sessions.values()].map(s => s.chain).concat([...inflight]));
};

/** Drop all in-memory session state (does not touch files). Test-only. */
export const resetAnalyticsState = (): void => {
  sessions.clear();
  inflight.clear();
  s3Client = undefined;
};
