// challenges.ts — extracted from the original monolithic server.ts.
import type {
  CardTemplate, GameState,
} from '../../shared/src/types.js';
import { getSocketByPlayerId, getIo, pendingChallenges, markHeroPlayedFromAbility } from './state.js';
import type { PendingChallengeState } from './state.js';
import { getHeroEffectiveClass, moveCardBetweenZones, applyWinIfMet } from './util.js';
import { logGame } from './analytics.js';
import { processMagicCardSteps } from './magic.js';
import { getSlainMonsterRollBonus } from './rolls.js';


const getEligibleChallengerIds = (gameState: GameState, activePlayerId: string): string[] =>
  // h_030 Iron Resolve: the active player's card plays cannot be challenged
  // for the rest of their turn (room flags clear at end of turn).
  gameState.roomFlags?.blockAllChallenges ? [] :
  Object.entries(gameState.players)
    .filter(([pid]) => pid !== activePlayerId)
    .filter(([, player]) =>
      player.zones.hand.some(card => {
        if (card.cardType !== 'challenge') return false;
        const template = gameState.cardTemplates[card.templateId];
        const req = template?.onEvent?.requirement;
        if (!req) return true;
        if (req.cardType === 'hero' && req.class && req.eligibility === 'self') {
          return player.zones.party.some(
            partyCard => getHeroEffectiveClass(gameState, player, partyCard) === req.class
          );
        }
        return true;
      })
    )
    .map(([pid]) => pid);

const getChallengeCardBonus = (template: CardTemplate | undefined): number => {
  if (!template) return 0;
  const effects = template.onEvent?.effects;
  if (!effects) return 0;
  const modifyRoll = effects.find(e => e.action === 'MODIFY_ROLL');
  return modifyRoll?.amount ?? 0;
};

const getPartyLeaderChallengeBonus = (gameState: GameState, playerId: string): number => {
  const player = gameState.players[playerId];
  if (!player?.partyLeaderId) return 0;
  const leaderTemplate = gameState.cardTemplates[player.partyLeaderId];
  if (
    leaderTemplate?.effect?.triggerEvent === 'ON_CHALLENGE' &&
    leaderTemplate.effect.action === 'PERSISTENT_MODIFIER' &&
    leaderTemplate.effect.applies_to === 'CHALLENGE_ROLLS'
  ) {
    return leaderTemplate.effect.modifier ?? 0;
  }
  return 0;
};

const openChallengeWindow = (roomCode: string, gameState: GameState, pending: PendingChallengeState) => {
  const cardTemplate = gameState.cardTemplates[pending.pendingCardInstance.templateId];
  const pendingCardName = cardTemplate?.name ?? pending.pendingCardInstance.templateId;
  gameState.pendingChallenge = {
    pendingPlayerId: pending.pendingPlayerId,
    pendingCardName,
    pendingCardType: pending.pendingCardType,
    eligibleChallengerIds: [...pending.eligibleChallengerIds],
  };
  pendingChallenges.set(roomCode, pending);
  logGame(gameState, 'challenge_window_opened', {
    cardTemplateId: pending.pendingCardInstance.templateId,
    cardType: pending.pendingCardType,
    eligibleChallengerIds: [...pending.eligibleChallengerIds],
  }, pending.pendingPlayerId);
};

const executePendingCardPlay = (roomCode: string, pending: PendingChallengeState, gameState: GameState) => {
  const player = gameState.players[pending.pendingPlayerId];
  if (!player) return;

  logGame(gameState, 'card_play_resolved', {
    cardTemplateId: pending.pendingCardInstance.templateId,
    cardType: pending.pendingCardType,
    ...(pending.itemTargetPlayerId ? { itemTargetPlayerId: pending.itemTargetPlayerId } : {}),
  }, pending.pendingPlayerId);

  if (pending.pendingCardType === 'hero') {
    player.zones.party.push(pending.pendingCardInstance);
    applyWinIfMet(gameState, player, pending.pendingPlayerId);
    markHeroPlayedFromAbility(roomCode, pending.pendingCardInstance.instanceId);
    const playerSocket = getSocketByPlayerId(pending.pendingPlayerId);
    if (playerSocket) playerSocket.emit('heroPlayAccepted', pending.pendingCardInstance.instanceId);
  } else if (pending.pendingCardType === 'item') {
    const targetPlayer = gameState.players[pending.itemTargetPlayerId ?? pending.pendingPlayerId];
    if (targetPlayer) {
      targetPlayer.zones.party.push(pending.pendingCardInstance);
      const targetHero = targetPlayer.zones.party.find(c => c.instanceId === pending.itemTargetHeroInstanceId);
      if (targetHero) targetHero.equippedItem = pending.pendingCardInstance.instanceId;
    }
  } else if (pending.pendingCardType === 'magic') {
    gameState.discardPile.push(pending.pendingCardInstance);
    const playerSocket = getSocketByPlayerId(pending.pendingPlayerId);
    if (playerSocket && pending.magicSteps) {
      processMagicCardSteps(
        playerSocket,
        gameState,
        player,
        pending.pendingCardInstance.instanceId,
        pending.magicSteps,
        undefined,
        true
      );
    }
  }
};

const resolveChallengeRollOff = (
  roomCode: string,
  pending: PendingChallengeState,
  gameState: GameState,
  sendRoomUpdate: () => void
) => {
  if (!pending.challengerId) return;
  const challenger = gameState.players[pending.challengerId];
  const challenged = gameState.players[pending.pendingPlayerId];
  if (!challenger || !challenged) return;

  const challengerRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
  const challengerBonus = pending.challengerRollBonus
    + getPartyLeaderChallengeBonus(gameState, pending.challengerId)
    + getSlainMonsterRollBonus(gameState, challenger, 'CHALLENGE_ROLLS');
  const challengerTotalRoll = challengerRoll + challengerBonus;
  const challengedRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;

  const challengerWon = challengerTotalRoll > challengedRoll;

  logGame(gameState, 'challenge_resolved', {
    challengerId: pending.challengerId,
    challengedPlayerId: pending.pendingPlayerId,
    challengerRoll,
    challengerBonus,
    challengerTotalRoll,
    challengedRoll,
    challengerWon,
    cardTemplateId: pending.pendingCardInstance.templateId,
    cardType: pending.pendingCardType,
    cardFate: challengerWon ? 'discarded' : 'played',
  }, pending.challengerId);

  if (pending.challengeCardInstanceId) {
    moveCardBetweenZones(challenger.zones.hand, gameState.discardPile, pending.challengeCardInstanceId);
  }

  const cardTemplate = gameState.cardTemplates[pending.pendingCardInstance.templateId];
  const cardName = cardTemplate?.name ?? pending.pendingCardInstance.templateId;

  if (challengerWon) {
    gameState.discardPile.push(pending.pendingCardInstance);
  } else {
    executePendingCardPlay(roomCode, pending, gameState);
  }

  delete gameState.pendingChallenge;
  pendingChallenges.delete(roomCode);

  getIo().to(roomCode).emit('challengeResolved', {
    challengerWon,
    challengerName: challenger.username ?? pending.challengerId,
    challengedName: challenged.username ?? pending.pendingPlayerId,
    challengerRoll,
    challengerBonus,
    challengerTotalRoll,
    challengedRoll,
    cardName,
  });

  sendRoomUpdate();
};
export {
  getEligibleChallengerIds, getChallengeCardBonus, getPartyLeaderChallengeBonus,
  openChallengeWindow, executePendingCardPlay, resolveChallengeRollOff,
};

