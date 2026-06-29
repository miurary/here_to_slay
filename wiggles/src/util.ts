// util.ts — extracted from the original monolithic server.ts.
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, Effect, GameState, Player,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import { emitAbilityPrompt, buildPromptId } from './state.js';


const moveCardBetweenZones = (
  sourceZone: CardInstance[],
  destinationZone: CardInstance[],
  cardInstanceId: string
) => {
  const index = sourceZone.findIndex((card) => card.instanceId === cardInstanceId);
  if (index === -1) return undefined;
  const [card] = sourceZone.splice(index, 1);
  if (card) destinationZone.push(card);
  return card;
};

const getPlayerBySocketId = (gameState: GameState, socketId: string) => gameState.players[socketId];

const findHeroInPlayerParty = (player: Player | undefined, heroInstanceId: string) => player?.zones.party.find((card: CardInstance) => card.instanceId === heroInstanceId && card.cardType === 'hero');


const getPlayerRollBonus = (player: Player): number => {
  const modifiers = player.temporaryModifiers;
  if (!Array.isArray(modifiers)) return 0;
  return modifiers.reduce((total, modifier) => {
    if (modifier.modifierType === 'rollBonus' && typeof modifier.amount === 'number') {
      return total + modifier.amount;
    }
    return total;
  }, 0);
};

const decrementTemporaryModifiers = (player: Player) => {
  const modifiers = player.temporaryModifiers;
  if (!Array.isArray(modifiers)) return;
  const remainingModifiers = modifiers
    .map((modifier) => ({ ...modifier, duration: (modifier.duration ?? 0) - 1 }))
    .filter((modifier) => modifier.duration > 0);
  if (remainingModifiers.length > 0) {
    player.temporaryModifiers = remainingModifiers;
  } else {
    delete player.temporaryModifiers;
  }
};

const isOpponent = (playerId: string, activePlayerId: string) => playerId !== activePlayerId;

const getOpponentPlayerIds = (gameState: GameState, activePlayerId: string) =>
  Object.keys(gameState.players).filter((playerId) => playerId !== activePlayerId);

const getHeroEffectiveClass = (gameState: GameState, player: Player, hero: CardInstance): string | undefined => {
  const template = gameState.cardTemplates[hero.templateId];
  const baseClass = template?.class;
  if (!hero.equippedItem) return baseClass;
  const itemInstance = player.zones.party.find((c: CardInstance) => c.instanceId === hero.equippedItem);
  if (!itemInstance) return baseClass;
  const itemTemplate = gameState.cardTemplates[itemInstance.templateId];
  const passives = itemTemplate?.passiveModifiers;
  const classOverride = passives?.find(p => p.stat === 'class' && p.override);
  return classOverride?.override ?? baseClass;
};

// The 8 hero classes in the game. The class-based win needs any 7 of these 8
// represented in the party (see WIN_CLASS_COUNT_REQUIRED in checkWinCondition).
const WIN_CLASSES = ['berserker', 'fighter', 'bard', 'guardian', 'ranger', 'thief', 'wizard', 'necromancer'];
const WIN_CLASS_COUNT_REQUIRED = 7;

const checkWinCondition = (gameState: GameState, player: Player): boolean => {
  // Condition 1: enough monsters slain
  const slainCount = (player.slainMonsters ?? []).length;
  if (slainCount >= (gameState.targetMonstersToWin ?? 3)) return true;

  // Condition 2: any 7 of the 8 hero classes represented in the party
  const partyClasses = new Set(
    player.zones.party
      .map((card: CardInstance) => getHeroEffectiveClass(gameState, player, card)?.toLowerCase())
      .filter((c: string | undefined): c is string => !!c)
  );
  const distinctWinClasses = WIN_CLASSES.filter(cls => partyClasses.has(cls)).length;
  return distinctWinClasses >= WIN_CLASS_COUNT_REQUIRED;
};

const applyWinIfMet = (gameState: GameState, player: Player, playerId: string): boolean => {
  if (gameState.status === 'finished') return true;
  if (checkWinCondition(gameState, player)) {
    gameState.status = 'finished';
    gameState.winnerId = playerId;
    return true;
  }
  return false;
};

const promptForPlayerSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: Effect,
  eligiblePlayerIds: string[],
  message: string,
  remainingEffects: Effect[] = []
) => {
  const options = eligiblePlayerIds.map((playerId) => ({
    id: playerId,
    label: gameState.players[playerId]?.username || 'Player',
    payload: { playerId },
  }));

  emitAbilityPrompt(sourceSocket.id, {
    promptId: buildPromptId(),
    roomCode: sourceSocket.data.roomCode as string,
    heroInstanceId,
    sourcePlayerId: sourceSocket.id,
    promptType: 'selectPlayer',
    message,
    options,
    effect,
    remainingEffects,
  });
};

const promptForCardSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: Effect,
  cardOptions: CardInstance[],
  message: string,
  remainingEffects: Effect[] = []
) => {
  const options = cardOptions.map((card) => ({
    id: card.instanceId,
    label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${card.cardType})`,
    payload: { cardInstanceId: card.instanceId },
  }));

  emitAbilityPrompt(sourceSocket.id, {
    promptId: buildPromptId(),
    roomCode: sourceSocket.data.roomCode as string,
    heroInstanceId,
    sourcePlayerId: sourceSocket.id,
    promptType: 'selectCard',
    message,
    options,
    effect,
    remainingEffects,
  });
};

const playerHasSlainEffectFlag = (gameState: GameState, player: Player, flag: string): boolean =>
  (player.slainMonsters ?? []).some((m: CardInstance) => {
    const t = gameState.cardTemplates[m.templateId];
    return t?.slainEffect?.flag === flag;
  });

const playerHasSlainEffectAction = (gameState: GameState, player: Player, action: string): boolean =>
  (player.slainMonsters ?? []).some((m: CardInstance) => {
    const t = gameState.cardTemplates[m.templateId];
    return t?.slainEffect?.action === action;
  });

// Temporary player-level flags carried in temporaryModifiers (e.g. h_032 Mighty
// Blade 'blockHeroDestruction', h_034 Calming Voice 'blockSteal').
const playerHasTempFlag = (player: Player, modifierType: string): boolean =>
  Array.isArray(player.temporaryModifiers) &&
  player.temporaryModifiers.some((m) => m.modifierType === modifierType);
export {
  moveCardBetweenZones, getPlayerBySocketId, findHeroInPlayerParty, getPlayerRollBonus,
  decrementTemporaryModifiers, isOpponent, getOpponentPlayerIds, getHeroEffectiveClass,
  WIN_CLASSES, WIN_CLASS_COUNT_REQUIRED, checkWinCondition, applyWinIfMet,
  promptForPlayerSelection, promptForCardSelection,
  playerHasSlainEffectFlag, playerHasSlainEffectAction, playerHasTempFlag,
};

