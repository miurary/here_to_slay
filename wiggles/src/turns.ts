// turns.ts — extracted from the original monolithic server.ts.
import type { GameState } from '../../shared/src/types.js';
import { heroesPlayedFromAbilityThisTurn, pendingChallenges, modifierPhases } from './state.js';
import { decrementTemporaryModifiers } from './util.js';
import { logGame } from './analytics.js';


const triggerEndTurn = (
  playerId: string,
  gameState: GameState,
  roomCode: string,
  sendRoomUpdate: () => void
) => {
  const currentPlayer = gameState.players[playerId];
  if (currentPlayer) decrementTemporaryModifiers(currentPlayer);
  delete gameState.roomFlags;
  delete gameState.forceEndTurn;

  const playerIds = Object.keys(gameState.players);
  if (playerIds.length === 0) return;

  const currentIndex = playerIds.findIndex((id) => id === playerId);
  const nextIndex = (currentIndex + 1) % playerIds.length;
  const nextPlayerId = playerIds[nextIndex] ?? '';

  gameState.activePlayerId = nextPlayerId;
  gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

  const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
  if (nextPlayer) {
    nextPlayer.actionPoints = 3;
    for (const slainMonster of nextPlayer.slainMonsters ?? []) {
      const mt = gameState.cardTemplates[slainMonster.templateId];
      if (mt?.slainEffect?.action === 'EXTRA_AP') {
        nextPlayer.actionPoints += mt.slainEffect.amount ?? 0;
      }
    }
    nextPlayer.zones.party.forEach((card) => { card.effectUsedThisTurn = false; });
    nextPlayer.zones.hand.forEach((card) => { card.effectUsedThisTurn = false; });
  }

  heroesPlayedFromAbilityThisTurn.delete(roomCode);
  pendingChallenges.delete(roomCode);
  delete gameState.pendingChallenge;
  modifierPhases.delete(roomCode);
  delete gameState.modifierPhase;

  logGame(gameState, 'turn_ended', { forced: true, nextPlayerId }, playerId);
  logGame(gameState, 'turn_started', {
    turnNumber: gameState.turnNumber,
    actionPoints: nextPlayer?.actionPoints,
  }, nextPlayerId);

  sendRoomUpdate();
};
export { triggerEndTurn };

