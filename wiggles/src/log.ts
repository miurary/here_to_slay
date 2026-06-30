import type { GameState, LogEntry } from '../../shared/src/types.js';

/** Cap the log so a long game can't grow state unbounded. */
const MAX_LOG_ENTRIES = 200;

/** Append an entry to the game's combined chat/action log (oldest first). */
export const logEvent = (
  gameState: GameState,
  kind: LogEntry['kind'],
  text: string,
  player?: { id: string; username?: string | undefined },
): void => {
  const entry: LogEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    kind,
    text,
  };
  if (player?.id) entry.playerId = player.id;
  if (player?.username) entry.username = player.username;
  gameState.gameLog.push(entry);
  if (gameState.gameLog.length > MAX_LOG_ENTRIES) {
    gameState.gameLog.splice(0, gameState.gameLog.length - MAX_LOG_ENTRIES);
  }
};

/** Best-effort display name for an action log line. */
export const nameOf = (gameState: GameState, playerId: string | undefined): string =>
  (playerId && gameState.players[playerId]?.username) || 'A player';
