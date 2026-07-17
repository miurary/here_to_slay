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
  promptType: 'selectPlayer' | 'selectCard' | 'discardCard' | 'confirm' | 'multiSelectCard';
  message: string;
  options: AbilityPromptOption[];
  requesterId: string;
  /** For 'multiSelectCard': the min/max number of options the player must pick before confirming. */
  minSelections?: number;
  maxSelections?: number;
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
  /** True when the slay condition is "roll N or LESS" (m_011 Dracos): requiredRoll
      is the lower bound and the roll succeeds at or under it. */
  slayOnLow?: boolean;
  modifiersPlayed: Array<{ playerName: string; cardName: string; amount: number; choiceLabel: string }>;
}

export interface MonsterAttackResultData {
  attackerName: string;
  monsterName: string;
  roll: number;
  /** The slay threshold: minimum roll normally, or maximum roll when slayOnLow. */
  requiredRoll: number;
  /** True when this monster slays on "requiredRoll or less" (m_011 Dracos). */
  slayOnLow?: boolean;
  slew: boolean;
  effectText: string;
}

/**
 * In-game bug-report categories, worded by player-visible symptom (not by
 * engine subsystem). The client renders these as options; the server treats
 * any unknown id as 'other'.
 */
export const BUG_CATEGORIES = [
  { id: 'card_behavior', label: "A card didn't do what it says" },
  { id: 'dice_math', label: 'Dice, roll, or modifier math was wrong' },
  { id: 'stuck', label: "Game is stuck / I can't do anything" },
  { id: 'connection', label: 'Connection or sync problem' },
  { id: 'visual', label: 'Visual glitch' },
  { id: 'other', label: 'Other / suggestion' },
] as const;

export type BugCategory = typeof BUG_CATEGORIES[number]['id'];

export interface BugReportInput {
  category: BugCategory;
  description: string;
  /** Browser environment, filled in by the client at submit time. */
  client?: {
    userAgent?: string;
    viewport?: string;
  };
}

export interface ClientToServerEvents {
  pingServer: () => void;
  setUsername: (username: string) => void;
  startGame: () => void;
  toggleReady: () => void;
  /** Lobby leader only: set which main-deck templates are excluded from the next game. */
  setDeckExclusions: (excludedTemplateIds: string[]) => void;
  rollForFirst: () => void;
  rollHeroAbility: (heroInstanceId: string) => void;
  activateHeroAbility: (heroInstanceId: string) => void;
  respondToAbilityPrompt: (promptId: string, selectedOptionId: string) => void;
  respondToAbilityPromptMulti: (promptId: string, selectedOptionIds: string[]) => void;
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
  /** Opt in to a rematch on the game-over screen; the room returns to the lobby once everyone votes. */
  voteRematch: () => void;
  sendChat: (message: string) => void;
  reportBug: (report: BugReportInput) => void;
}

export interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
  bugReportAck: (result: { ok: boolean; message: string }) => void;
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
  roomFull: (message: string) => void;
  roomNotFound: (message: string) => void;
}

// need to fix clanker code
export type GameStatus = 'waiting' | 'rolling' | 'roll_complete' | 'party_leader_selection' | 'party_leader_review' | 'in_progress' | 'finished';
export type GamePhase = 'DRAW' | 'MAIN' | 'COMBAT' | 'RESOLUTION' | 'END';
export type CardType = 'hero' | 'item' | 'magic' | 'modifier' | 'challenge' | 'monster' | 'party_leader';
export type EffectType = 'damage' | 'heal' | 'draw' | 'buff' | 'challenge' | 'destroy' | 'steal' | 'sacrifice';

export interface Cost {
  type: string;
  cardType?: string;
  [key: string]: unknown;
}

export interface Effect {
  action: string;
  amount?: number;
  destination?: string;
  target?: string;
  cardType?: string;
  flag?: string;
  zone?: string;
  duration?: number;
  modifierType?: string;
  condition?: { type?: string; zone?: string; class?: string; cardClass?: string; amount?: number };
  remaining?: number;
  monsterName?: string;
  finalRoll?: number;
  effectText?: string;
  totalDiscards?: number;
  discardsDone?: number;
  rollBonusSoFar?: number;
  bonusPerCard?: number;
  [key: string]: unknown;
}

export interface TemplateEffect {
  action?: string;
  triggerEvent?: string;
  applies_to?: string;
  modifier?: number;
  amount?: number;
  isOptional?: boolean;
  flag?: string;
  modifierType?: string;
  steps?: Effect[];
  [key: string]: unknown;
}

export interface TemplateTrigger {
  event: string;
  scope: string;
  optional?: boolean;
  effects: Effect[];
  cost?: Array<{ type?: string; max?: number; [key: string]: unknown }>;
}

export interface CardTemplate {
  id: string;
  name: string;
  type: string;
  class?: string;
  subtype?: string;
  rollToPlay?: number;
  effect?: TemplateEffect;
  effects?: Effect[];
  activeSkill?: { effects: Effect[]; costs?: Cost[]; targetRequirement?: { eligibility?: string; zone?: string; cardType?: string } };
  requirements?: Array<{ class: string; amount: number }>;
  trigger?: TemplateTrigger;
  slainEffect?: TemplateEffect;
  passiveModifiers?: Array<{ stat: string; value?: unknown; override?: string }>;
  choices?: Array<{
    label?: string;
    effects?: Effect[];
    conditionalUpgrades?: Array<{
      condition?: { rollContext?: string };
      effects?: Effect[];
      label?: string;
    }>;
  }>;
  onEvent?: {
    requirement?: { cardType?: string; class?: string; eligibility?: string };
    effects?: Effect[];
  };
  upperBound?: number;
  lowerBound?: number;
  upperBoundEffect?: Effect[];
  lowerBoundEffect?: Effect[];
  upperBoundText?: string;
  lowerBoundText?: string;
  targetRequirement?: { eligibility?: string; zone?: string; cardType?: string };
  abilityText?: string;
  slainEffectText?: string;
  /** Number of copies of this template to put in the deck (default 1). */
  deckCount?: number;
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
  /** Lobby deck editor: main-deck template ids the leader has excluded from the
      next game. Empty/undefined means the full deck. Monsters and party leaders
      live in separate decks and cannot be excluded. */
  excludedCardIds?: string[];
  pendingChallenge?: PendingChallengeInfo;
  modifierPhase?: ModifierPhaseInfo;
  winnerId?: string;
  /** While status is 'finished': ids of players who have voted for a rematch.
      When every connected player has voted the room resets to the lobby. */
  rematchVotes?: string[];
  /** Epoch ms when active play began (status → 'in_progress'). */
  gameStartedAt?: number;
  /** Epoch ms when the game was won (status → 'finished'). */
  gameEndedAt?: number;
  /** Running count of cards drawn from the main deck during play (for end-game stats). */
  cardsDrawn?: number;
  /** Epoch ms when the server will auto-advance out of roll_complete /
      party_leader_review; clients render a countdown from it. */
  autoAdvanceAt?: number;
  roomFlags?: Record<string, boolean>;
  forceEndTurn?: string;
  /** Ordered feed of chat messages and action log entries, oldest first. */
  gameLog: LogEntry[];
}

/** A single entry in the combined chat + action-log feed. */
export interface LogEntry {
  id: string;
  /** Epoch millis when the entry was created. */
  ts: number;
  /** 'chat' = a player message; 'action' = something a player did; 'system' = game events. */
  kind: 'chat' | 'action' | 'system';
  /** The acting/speaking player's id, when applicable. */
  playerId?: string;
  /** Display name captured at log time (players can leave). */
  username?: string;
  /** The message text (chat) or human-readable action description. */
  text: string;
}
// need to fix clanker code
export type Player = PlayerState;

export interface PlayerState {
  /** Stable player identity (client-generated UUID), not the socket id. */
  id: string;
  username: string | undefined;
  /** Lobby ready-up flag; only meaningful while the game status is 'waiting'. */
  ready?: boolean;
  /** false while the seat is held for a disconnected player (grace period);
      undefined/true means connected. */
  connected?: boolean;
  actionPoints: number;
  partyLeaderId: string | undefined;
  slainMonsters: CardInstance[];
  zones: {
    hand: CardInstance[];
    party: CardInstance[];
  };
  temporaryModifiers?: Array<{ modifierType: string; amount: number; duration: number }>;
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
