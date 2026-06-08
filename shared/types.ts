export interface HeroRollResult {
  heroInstanceId: string;
  die1: number;
  die2: number;
  total: number;
  requiredRoll: number;
  success: boolean;
  message: string;
}

export interface AbilityPromptOption {
  id: string;
  label: string;
  payload?: {
    playerId?: string;
    cardInstanceId?: string;
    [key: string]: unknown;
  };
}

export interface AbilityPrompt {
  promptId: string;
  heroInstanceId: string;
  promptType: 'selectPlayer' | 'selectCard' | 'discardCard' | 'confirm';
  message: string;
  options: AbilityPromptOption[];
  requesterId: string;
}

export interface PendingChallengeInfo {
  pendingPlayerId: string;
  pendingCardName: string;
  pendingCardType: 'hero' | 'item' | 'magic';
  eligibleChallengerIds: string[];
  challengerId?: string;
}

export interface ChallengeResolvedData {
  challengerWon: boolean;
  challengerName: string;
  challengedName: string;
  challengerRoll: number;
  challengerBonus: number;
  challengerTotalRoll: number;
  challengedRoll: number;
  cardName: string;
}

export interface ModifierPhaseInfo {
  heroInstanceId: string;
  rollingPlayerId: string;
  requiredRoll: number;
  currentTotal: number;
  die1: number;
  die2: number;
  persistentBonus: number;
  accumulatedModifier: number;
  phase: 'roller_turn' | 'opponent_turn';
  activePlayerId: string;
  rollContext: 'HERO_ABILITY' | 'ATTACK_MONSTER';
  rollType: 'hero_ability' | 'monster_attack';
  monsterName?: string;
  lowerBound?: number;
  modifiersPlayed: Array<{ playerName: string; cardName: string; amount: number; choiceLabel: string }>;
}

export interface MonsterAttackResultData {
  attackerName: string;
  monsterName: string;
  roll: number;
  requiredRoll: number;
  slew: boolean;
  effectText: string;
}

export interface ClientToServerEvents {
  pingServer: () => void;
  setUsername: (username: string) => void;
  startGame: () => void;
  rollForFirst: () => void;
  rollHeroAbility: (heroInstanceId: string) => void;
  activateHeroAbility: (heroInstanceId: string) => void;
  respondToAbilityPrompt: (promptId: string, selectedOptionId: string) => void;
  continueGame: () => void;
  choosePartyLeader: (instanceId: string) => void;
  playHero: (instanceId: string) => void;
  playItem: (itemInstanceId: string, targetHeroInstanceId: string) => void;
  playCursedItem: (itemInstanceId: string, targetPlayerId: string, targetHeroInstanceId: string) => void;
  playMagic: (cardInstanceId: string) => void;
  playChallenge: (challengeCardInstanceId: string) => void;
  passChallenge: () => void;
  playModifier: (modifierInstanceId: string, choiceIndex: number) => void;
  passModifier: () => void;
  attackMonster: (monsterInstanceId: string) => void;
  usePartyLeaderAbility: () => void;
  mulligan: () => void;
  drawFromMain: () => void;
  endTurn: () => void;
  quitGame: () => void;
}

export interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
  playersUpdated: (connectedPlayers: PlayerState[]) => void;
  stateUpdate: (state: GameState) => void;
  actionFailed: (message: string) => void;
  cardDrawn: (card: { instanceId: string; templateId: string }) => void;
  heroRollResult: (result: HeroRollResult) => void;
  abilityPrompt: (prompt: AbilityPrompt) => void;
  abilityResolution: (data: { message: string; heroInstanceId: string }) => void;
  heroPlayedFromAbility: (heroInstanceId: string) => void;
  heroPlayAccepted: (heroInstanceId: string) => void;
  challengeResolved: (data: ChallengeResolvedData) => void;
  monsterAttackResult: (data: MonsterAttackResultData) => void;
}

// need to fix clanker code
export type GameStatus = 'waiting' | 'rolling' | 'roll_complete' | 'party_leader_selection' | 'party_leader_review' | 'in_progress' | 'finished';
export type GamePhase = 'DRAW' | 'MAIN' | 'COMBAT' | 'RESOLUTION' | 'END';
export type CardType = 'hero' | 'item' | 'magic' | 'modifier' | 'challenge' | 'monster' | 'party_leader';
export type EffectType = 'damage' | 'heal' | 'draw' | 'buff' | 'challenge' | 'destroy' | 'steal' | 'sacrifice';

export interface CardTemplate {
  id: string;
  name: string;
  type: string;
  class?: string;
  [key: string]: unknown;
}

// need to fix clanker code
export interface GameState {
  gameId: string;
  status: GameStatus;
  activePlayerId: string;
  turnNumber: number;
  phase: GamePhase;
  players: Record<string, PlayerState>;
  stack: StackAction[];
  monsterDeck: CardInstance[];
  partyLeaderDeck: CardInstance[];
  mainDeck: CardInstance[];
  activeMonsters: MonsterInstance[];
  discardedMonsters: CardInstance[];
  discardPile: CardInstance[];
  cardTemplates: Record<string, CardTemplate>;
  diceRolls: Record<string, number>;
  availablePartyLeaderCards: CardInstance[];
  partyLeaderSelectionOrder: string[];
  currentSelectionPlayerId: string | undefined;
  rollWinnerId: string | undefined;
  lobbyLeaderId: string | undefined;
  currentRollerId: string | undefined;
  firstPlayerId: string | undefined;
  targetMonstersToWin: number | undefined;
  pendingChallenge?: PendingChallengeInfo;
  modifierPhase?: ModifierPhaseInfo;
}
// need to fix clanker code
export type Player = PlayerState;

export interface PlayerState {
  id: string;
  username: string | undefined;
  actionPoints: number;
  partyLeaderId: string | undefined;
  slainMonsters: CardInstance[];
  zones: {
    hand: CardInstance[];
    party: CardInstance[];
  };
}

// need to fix clanker code
export interface CardInstance {
  instanceId: string;
  templateId: string;
  cardType: CardType;
  equippedItem?: string;
  requirements?: CardRequirements;
  effectUsedThisTurn: boolean;
}

// need to fix clanker code
export interface MonsterInstance extends CardInstance {
  monsterLevel?: number;
  requirementH?: number;
}

// need to fix clanker code
export interface CardRequirements {
  minimumHeroCount?: number;
  heroClasses?: string[];
  monsterRequirement?: number;
  [key: string]: unknown;
}

// need to fix clanker code
export interface StackAction {
  actionId: string;
  sourcePlayerId: string;
  sourceCardInstanceId: string;
  targetInstanceId?: string;
  effectType: EffectType;
  value: number;
  modifierIds?: string[];
}