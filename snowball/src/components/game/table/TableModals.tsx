import type { AbilityPrompt, GameState } from '../../../../../shared/types';
import { T, backdrop, panel, closeButton, goldButton, ghostButton, classColor, displayName } from './tableUtils';

/* ── Ability prompt (selectPlayer / selectCard / discard / confirm / multi) ── */
interface AbilityPromptOverlayProps {
  prompt: AbilityPrompt;
  queueLength: number;
  multiSelected: string[];
  onToggleMulti: (optionId: string) => void;
  onRespond: (optionId: string) => void;
  onRespondMulti: () => void;
}
export function AbilityPromptOverlay({ prompt, queueLength, multiSelected, onToggleMulti, onRespond, onRespondMulti }: AbilityPromptOverlayProps) {
  const isMulti = prompt.promptType === 'multiSelectCard';
  const min = prompt.minSelections ?? 0;
  const canConfirm = multiSelected.length >= min;
  return (
    <div style={{ ...backdrop, zIndex: 80 }}>
      <div style={{ ...panel, width: 'min(90vw, 480px)', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 17 }}>Choose</span>
          {queueLength > 1 && <span style={{ fontSize: 10.5, color: T.muted }}>{queueLength - 1} more pending</span>}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: T.text2, lineHeight: 1.5 }}>{prompt.message}</p>
        {isMulti ? (
          <>
            <div className="gt-scroll" style={{ display: 'grid', gap: 7, maxHeight: '48vh', overflowY: 'auto' }}>
              {prompt.options.map((o) => {
                const selected = multiSelected.includes(o.id);
                return (
                  <span key={o.id} onClick={() => onToggleMulti(o.id)} style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, textAlign: 'left', border: `1px solid ${selected ? T.gold : T.border}`, background: selected ? 'oklch(0.3 0.03 85 / 0.25)' : T.cardBg, color: T.text, fontWeight: selected ? 700 : 400 }}>
                    {selected ? '☑' : '☐'} {o.label}
                  </span>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 11, color: T.muted }}>{multiSelected.length} selected{prompt.maxSelections ? ` / ${prompt.maxSelections} max` : ''}</span>
              <span onClick={() => canConfirm && onRespondMulti()} style={{ ...goldButton, opacity: canConfirm ? 1 : 0.5 }}>Confirm</span>
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {prompt.options.map((o) => (
              <span key={o.id} onClick={() => onRespond(o.id)} style={{ ...goldButton, textAlign: 'center', padding: '9px 14px' }}>{o.label}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Equip an item onto one of my heroes ─────────────────────────────────── */
interface ItemPickerOverlayProps {
  gameState: GameState;
  myId: string;
  itemInstanceId: string;
  onConfirm: (heroInstanceId: string) => void;
  onCancel: () => void;
}
export function ItemPickerOverlay({ gameState, myId, itemInstanceId, onConfirm, onCancel }: ItemPickerOverlayProps) {
  const itemName = gameState.cardTemplates[gameState.players[myId]?.zones.hand.find((c) => c.instanceId === itemInstanceId)?.templateId ?? '']?.name ?? 'Item';
  const heroes = gameState.players[myId]?.zones.party.filter((c) => c.cardType === 'hero' && !c.equippedItem) ?? [];
  return (
    <div style={{ ...backdrop, zIndex: 80 }} onClick={onCancel}>
      <div style={{ ...panel, width: 'min(90vw, 440px)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 16 }}>Equip {itemName}</span>
          <span onClick={onCancel} style={closeButton}>Cancel</span>
        </div>
        {heroes.length === 0 ? (
          <span style={{ fontSize: 12, color: T.red }}>No heroes available (every hero already has an item).</span>
        ) : (
          <div style={{ display: 'grid', gap: 7 }}>
            {heroes.map((h) => (
              <span key={h.instanceId} onClick={() => onConfirm(h.instanceId)} style={{ ...ghostButton, textAlign: 'left', padding: '8px 12px', color: T.text }}>
                {gameState.cardTemplates[h.templateId]?.name ?? h.templateId}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Cursed item: pick an opponent, then one of their heroes ──────────────── */
interface CursedItemPickerOverlayProps {
  gameState: GameState;
  myId: string;
  selectedOpponentId: string | null;
  onSelectOpponent: (opponentId: string) => void;
  onConfirm: (heroInstanceId: string) => void;
  onCancel: () => void;
}
export function CursedItemPickerOverlay({ gameState, myId, selectedOpponentId, onSelectOpponent, onConfirm, onCancel }: CursedItemPickerOverlayProps) {
  const opponents = Object.values(gameState.players).filter((p) => p.id !== myId);
  const target = selectedOpponentId ? gameState.players[selectedOpponentId] : null;
  const heroes = target?.zones.party.filter((c) => c.cardType === 'hero' && !c.equippedItem) ?? [];
  return (
    <div style={{ ...backdrop, zIndex: 80 }} onClick={onCancel}>
      <div style={{ ...panel, width: 'min(90vw, 440px)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 16 }}>Play cursed item</span>
          <span onClick={onCancel} style={closeButton}>{selectedOpponentId ? 'Back' : 'Cancel'}</span>
        </div>
        {!selectedOpponentId ? (
          <>
            <span style={{ fontSize: 12, color: T.text2 }}>Choose an opponent to curse:</span>
            <div style={{ display: 'grid', gap: 7 }}>
              {opponents.map((p) => (
                <span key={p.id} onClick={() => onSelectOpponent(p.id)} style={{ ...ghostButton, textAlign: 'left', padding: '8px 12px', color: T.text, borderColor: classColor(p.partyLeaderId ? gameState.cardTemplates[p.partyLeaderId]?.class : undefined) }}>
                  {displayName(gameState, p.id)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: T.text2 }}>Choose a hero from {displayName(gameState, selectedOpponentId)} to curse:</span>
            {heroes.length === 0 ? (
              <span style={{ fontSize: 12, color: T.red }}>No eligible heroes (every hero already has an item).</span>
            ) : (
              <div style={{ display: 'grid', gap: 7 }}>
                {heroes.map((h) => (
                  <span key={h.instanceId} onClick={() => onConfirm(h.instanceId)} style={{ ...ghostButton, textAlign: 'left', padding: '8px 12px', color: T.text }}>
                    {gameState.cardTemplates[h.templateId]?.name ?? h.templateId}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Party leader detail + use-ability ───────────────────────────────────── */
interface LeaderOverlayProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;
  actionMessage: string | null;
  onUseAbility: () => void;
  onClose: () => void;
}
export function LeaderOverlay({ gameState, myId, isMyTurn, actionMessage, onUseAbility, onClose }: LeaderOverlayProps) {
  const leaderCard = gameState.players[myId]?.zones.party.find((c) => c.cardType === 'party_leader');
  if (!leaderCard) return null;
  const tmpl = gameState.cardTemplates[leaderCard.templateId];
  const color = classColor(tmpl?.class);
  const isOptional = tmpl?.effect?.isOptional === true;
  const alreadyUsed = leaderCard.effectUsedThisTurn ?? false;
  const canUse = isMyTurn && isOptional && !alreadyUsed;
  return (
    <div style={{ ...backdrop, zIndex: 80 }} onClick={onClose}>
      <div style={{ ...panel, width: 'min(90vw, 420px)', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 17 }}>{tmpl?.name ?? 'Party leader'}</span>
          <span onClick={onClose} style={closeButton}>Close</span>
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color }}>LEADER · {(tmpl?.class ?? '').toUpperCase()}</span>
        <span style={{ fontSize: 12, color: T.text2, lineHeight: 1.5 }}>{tmpl?.abilityText ?? ''}</span>
        {isOptional && (
          <span onClick={() => canUse && onUseAbility()} style={{ ...goldButton, textAlign: 'center', padding: '9px 14px', opacity: canUse ? 1 : 0.5 }}>
            {alreadyUsed ? 'Ability used this turn' : 'Use ability'}
          </span>
        )}
        {actionMessage && <span style={{ fontSize: 11.5, color: T.red }}>{actionMessage}</span>}
      </div>
    </div>
  );
}
