import { useEffect, useRef, useState } from 'react';
import type { AbilityPrompt, CardInstance, ChallengeResolvedData, GameState, MonsterAttackResultData } from '../../../../../shared/types';
import { FELT_COLORS } from './tableUtils';
import './table.css';

import SeatBar from './SeatBar';
import TurnStrip from './TurnStrip';
import Felt from './Felt';
import RollStrip from './RollStrip';
import MonsterRollStrip from './MonsterRollStrip';
import PromptStrip from './PromptStrip';
import YourZone from './YourZone';
import SelectedCardBar from './SelectedCardBar';
import TableHand from './TableHand';
import LogDrawer from './LogDrawer';
import DiscardOverlay from './DiscardOverlay';
import InspectOverlay from './InspectOverlay';
import { AbilityPromptOverlay, ItemPickerOverlay, CursedItemPickerOverlay, LeaderOverlay } from './TableModals';

export interface GameTableProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;

  // Hero-ability roll state (drives the felt roll strip).
  selectedHeroId: string | null;
  selectedHeroLocation: 'hand' | 'party' | null;
  playHeroPromptOpen: boolean;
  isHeroRolling: boolean;
  rolledDice: { die1: number; die2: number } | null;
  playHeroRollResult: string | null;
  heroRollResult: string | null;
  pendingHeroAbilityActivationId: string | null;
  onSelectPartyHero: (heroInstanceId: string) => void;
  onRollPlayHero: () => void;
  onSkipPlayHero: () => void;
  onRollPartyHero: () => void;
  onActivateHeroAbility: (heroInstanceId: string) => void;
  onCloseHeroRoll: () => void;

  // Playing hand cards.
  onPlayHandCard: (card: CardInstance) => void;

  // Item / cursed-item target pickers.
  itemPickerOpen: boolean;
  pendingItemPlayId: string | null;
  onConfirmItem: (heroInstanceId: string) => void;
  onCancelItem: () => void;
  cursedPickerOpen: boolean;
  selectedTargetOpponentId: string | null;
  onSelectCurseOpponent: (opponentId: string) => void;
  onConfirmCursedItem: (heroInstanceId: string) => void;
  onCancelCursedItem: () => void;

  // Modifier window.
  onPlayModifier: (modifierInstanceId: string, choiceIndex: number) => void;
  onPassModifier: () => void;

  // Challenge window.
  eligibleChallengeCards: CardInstance[];
  challengeResult: ChallengeResolvedData | null;
  onClearChallengeResult: () => void;
  onPlayChallenge: (cardInstanceId: string) => void;
  onPassChallenge: () => void;

  // Monsters / deck / turn.
  onAttackMonster: (monsterInstanceId: string) => void;
  monsterAttackResult: MonsterAttackResultData | null;
  onClearMonsterResult: () => void;
  onDrawFromMain: () => void;
  onMulligan: () => void;
  onEndTurn: () => void;

  // Party leader.
  leaderOpen: boolean;
  onOpenLeader: () => void;
  onCloseLeader: () => void;
  onUseLeaderAbility: () => void;
  actionMessage: string | null;

  // Ability prompts.
  abilityPrompt: AbilityPrompt | null;
  abilityPromptQueueLength: number;
  multiSelected: string[];
  onToggleMulti: (optionId: string) => void;
  onRespondPrompt: (optionId: string) => void;
  onRespondPromptMulti: () => void;

  // Chat + leave.
  onSendChat: (message: string) => void;
  onLeave: () => void;
}

/**
 * The redesigned in-progress game screen ("1c" poker-table layout). Everything
 * here is driven by the server-authoritative GameState and the socket handlers
 * threaded down from Game.tsx — no local game simulation. This component owns
 * only view state: hand selection, the log drawer, the open browse overlay, the
 * felt toast, and the unread counter.
 */
export default function GameTable(props: GameTableProps) {
  const { gameState, myId, isMyTurn } = props;

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [overlay, setOverlay] = useState<{ type: 'discard' } | { type: 'inspect'; playerId: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const feltColor = FELT_COLORS[0];

  // Every new log entry raises a transient felt toast and (while the drawer is
  // closed) bumps the unread badge.
  const entries = gameState.gameLog ?? [];
  const prevLen = useRef(entries.length);
  const drawerOpenRef = useRef(drawerOpen);
  useEffect(() => { drawerOpenRef.current = drawerOpen; }, [drawerOpen]);
  useEffect(() => {
    if (entries.length <= prevLen.current) { prevLen.current = entries.length; return; }
    const added = entries.length - prevLen.current;
    prevLen.current = entries.length;
    setToast(entries[entries.length - 1]?.text ?? null);
    if (!drawerOpenRef.current) setUnread((u) => u + added);
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
    // Fire only when the log grows; `entries` is read through the length guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  const toggleDrawer = () => setDrawerOpen((o) => { const next = !o; if (next) setUnread(0); return next; });

  const me = gameState.players[myId];
  const selectedCard = selectedCardId ? me?.zones.hand.find((c) => c.instanceId === selectedCardId) ?? null : null;

  // The roll strip stands in for the old HeroAbilityModal: it opens for a
  // just-played hero (play mode) or a selected party hero (party mode).
  const selectedHero = props.selectedHeroId
    ? me?.zones.hand.find((c) => c.instanceId === props.selectedHeroId) ?? me?.zones.party.find((c) => c.instanceId === props.selectedHeroId) ?? null
    : null;
  const rollStripOpen = !!selectedHero && (props.playHeroPromptOpen || props.selectedHeroLocation === 'party');
  const rollMode: 'play' | 'party' = props.playHeroPromptOpen ? 'play' : 'party';
  const rollBusy = rollStripOpen || !!gameState.modifierPhase || !!gameState.pendingChallenge;

  const strips = (
    <>
      {rollStripOpen && selectedHero && (
        <RollStrip
          key={`${selectedHero.instanceId}-${rollMode}`}
          gameState={gameState}
          myId={myId}
          hero={selectedHero}
          mode={rollMode}
          isMyTurn={isMyTurn}
          isHeroRolling={props.isHeroRolling}
          rolledDice={props.rolledDice}
          resultMessage={rollMode === 'play' ? props.playHeroRollResult : props.heroRollResult}
          pendingHeroAbilityActivationId={props.pendingHeroAbilityActivationId}
          onRollPlay={props.onRollPlayHero}
          onSkipPlay={props.onSkipPlayHero}
          onRollParty={props.onRollPartyHero}
          onActivate={props.onActivateHeroAbility}
          onPlayModifier={props.onPlayModifier}
          onPassModifier={props.onPassModifier}
          onClose={props.onCloseHeroRoll}
        />
      )}
      <MonsterRollStrip
        gameState={gameState}
        myId={myId}
        monsterAttackResult={props.monsterAttackResult}
        onClearMonsterResult={props.onClearMonsterResult}
        onPlayModifier={props.onPlayModifier}
        onPassModifier={props.onPassModifier}
      />
      <PromptStrip
        gameState={gameState}
        myId={myId}
        challengeResult={props.challengeResult}
        eligibleChallengeCards={props.eligibleChallengeCards}
        onClearChallengeResult={props.onClearChallengeResult}
        onPlayChallenge={props.onPlayChallenge}
        onPassChallenge={props.onPassChallenge}
        onPlayModifier={props.onPlayModifier}
        onPassModifier={props.onPassModifier}
      />
    </>
  );

  const playSelected = (card: CardInstance) => {
    props.onPlayHandCard(card);
    setSelectedCardId(null);
  };

  return (
    <div className="gt-root">
      <SeatBar
        gameState={gameState}
        myId={myId}
        onInspect={(playerId) => setOverlay({ type: 'inspect', playerId })}
        onLeave={props.onLeave}
      />

      <TurnStrip gameState={gameState} myId={myId} />

      <Felt
        gameState={gameState}
        myId={myId}
        isMyTurn={isMyTurn}
        feltColor={feltColor}
        rollBusy={rollBusy}
        toast={toast}
        onDraw={props.onDrawFromMain}
        onMulligan={props.onMulligan}
        onOpenDiscard={() => setOverlay({ type: 'discard' })}
        onAttackMonster={props.onAttackMonster}
        strips={strips}
      />

      <YourZone
        gameState={gameState}
        myId={myId}
        isMyTurn={isMyTurn}
        rollBusy={rollBusy}
        selectedHeroId={props.selectedHeroId}
        onSelectPartyHero={props.onSelectPartyHero}
        onOpenLeader={props.onOpenLeader}
        onEndTurn={props.onEndTurn}
      />

      <SelectedCardBar
        gameState={gameState}
        myId={myId}
        isMyTurn={isMyTurn}
        card={selectedCard}
        onPlay={playSelected}
        onClose={() => setSelectedCardId(null)}
      />

      <TableHand
        gameState={gameState}
        myId={myId}
        isMyTurn={isMyTurn}
        selectedCardId={selectedCardId}
        onSelect={(id) => setSelectedCardId((cur) => (cur === id ? null : id))}
      />

      <LogDrawer
        myId={myId}
        entries={entries}
        open={drawerOpen}
        unread={unread}
        onToggle={toggleDrawer}
        onSend={props.onSendChat}
      />

      {/* ── Browse overlays ─────────────────────────────────────────────── */}
      {overlay?.type === 'discard' && <DiscardOverlay gameState={gameState} onClose={() => setOverlay(null)} />}
      {overlay?.type === 'inspect' && <InspectOverlay gameState={gameState} playerId={overlay.playerId} onClose={() => setOverlay(null)} />}

      {/* ── Target pickers / prompts / leader ───────────────────────────── */}
      {props.itemPickerOpen && props.pendingItemPlayId && (
        <ItemPickerOverlay gameState={gameState} myId={myId} itemInstanceId={props.pendingItemPlayId} onConfirm={props.onConfirmItem} onCancel={props.onCancelItem} />
      )}
      {props.cursedPickerOpen && (
        <CursedItemPickerOverlay
          gameState={gameState}
          myId={myId}
          selectedOpponentId={props.selectedTargetOpponentId}
          onSelectOpponent={props.onSelectCurseOpponent}
          onConfirm={props.onConfirmCursedItem}
          onCancel={props.onCancelCursedItem}
        />
      )}
      {props.abilityPrompt && (
        <AbilityPromptOverlay
          prompt={props.abilityPrompt}
          queueLength={props.abilityPromptQueueLength}
          multiSelected={props.multiSelected}
          onToggleMulti={props.onToggleMulti}
          onRespond={props.onRespondPrompt}
          onRespondMulti={props.onRespondPromptMulti}
        />
      )}
      {props.leaderOpen && (
        <LeaderOverlay
          gameState={gameState}
          myId={myId}
          isMyTurn={isMyTurn}
          actionMessage={props.actionMessage}
          onUseAbility={props.onUseLeaderAbility}
          onClose={props.onCloseLeader}
        />
      )}
    </div>
  );
}
