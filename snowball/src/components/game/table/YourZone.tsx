import type { GameState } from '../../../../../shared/types';
import { T, classColor, effectiveClass } from './tableUtils';

interface YourZoneProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;
  rollBusy: boolean;
  /** The hero currently selected to roll (shows "ROLLING NOW"). */
  selectedHeroId: string | null;
  onSelectPartyHero: (heroInstanceId: string) => void;
  onOpenLeader: () => void;
  onEndTurn: () => void;
}

/**
 * The bottom "your zone" row: party-leader card (left), your party of heroes as
 * a wrapping grid of compact cards (center), and a right rail with the slain
 * tracker and the End turn button.
 */
export default function YourZone({ gameState, myId, isMyTurn, rollBusy, selectedHeroId, onSelectPartyHero, onOpenLeader, onEndTurn }: YourZoneProps) {
  const me = gameState.players[myId];
  const ap = me?.actionPoints ?? 0;
  const party = me?.zones.party ?? [];
  const heroes = party.filter((c) => c.cardType === 'hero');
  const leaderCard = party.find((c) => c.cardType === 'party_leader');
  const leaderTmpl = leaderCard ? gameState.cardTemplates[leaderCard.templateId] : undefined;
  const leaderColor = classColor(leaderTmpl?.class);
  const target = gameState.targetMonstersToWin ?? 3;
  const slain = me?.slainMonsters?.length ?? 0;

  return (
    <div style={{ display: 'flex', gap: 14, padding: '0 46px 12px 18px', alignItems: 'stretch', flexShrink: 0 }}>
      {/* leader */}
      <div
        onClick={onOpenLeader}
        title="View party leader"
        style={{ width: 122, flexShrink: 0, background: T.cardBg, border: `1px solid ${leaderColor}`, borderRadius: 10, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' }}
      >
        <span style={{ fontWeight: 700, fontSize: 11.5, lineHeight: 1.25 }}>{leaderTmpl?.name ?? 'Party Leader'}</span>
        <span style={{ fontSize: 8.5, color: leaderColor, fontWeight: 700, letterSpacing: '0.05em' }}>
          LEADER · {(leaderTmpl?.class ?? '').toUpperCase()}
        </span>
        <span style={{ fontSize: 9.5, lineHeight: 1.45, color: T.text2, marginTop: 4 }}>{leaderTmpl?.abilityText ?? ''}</span>
      </div>

      {/* party */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.muted2, letterSpacing: '0.07em' }}>YOUR PARTY · {heroes.length}</span>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {heroes.map((hero) => {
            const tmpl = gameState.cardTemplates[hero.templateId];
            const cls = effectiveClass(hero, gameState, me!);
            const used = hero.effectUsedThisTurn;
            const canRoll = isMyTurn && !used && ap >= 1 && !rollBusy;
            const rolling = selectedHeroId === hero.instanceId && rollBusy;
            const status = rolling ? 'ROLLING NOW…' : used ? 'USED THIS TURN' : canRoll ? 'CLICK TO ROLL · 1 ACTION' : 'READY';
            const equippedTmpl = hero.equippedItem ? gameState.cardTemplates[party.find((c) => c.instanceId === hero.equippedItem)?.templateId ?? ''] : undefined;
            return (
              <div
                key={hero.instanceId}
                onClick={() => canRoll && onSelectPartyHero(hero.instanceId)}
                style={{
                  width: 160, background: T.cardBg, border: `1px solid ${selectedHeroId === hero.instanceId ? T.gold : T.border}`,
                  borderLeft: `3px solid ${classColor(cls)}`, borderRadius: 8, padding: '7px 9px',
                  cursor: canRoll ? 'pointer' : 'default', transition: 'transform 0.15s, border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 11 }}>{tmpl?.name ?? hero.templateId}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: classColor(cls) }}>{tmpl?.rollToPlay ?? '?'}+</span>
                </div>
                <div style={{ fontSize: 9.5, color: T.text2, lineHeight: 1.4, marginTop: 3 }}>{tmpl?.abilityText ?? ''}</div>
                {equippedTmpl && (
                  <div style={{ fontSize: 8.5, fontWeight: 700, marginTop: 4, color: T.itemBlue }}>⚙ {equippedTmpl.name}</div>
                )}
                <div style={{ fontSize: 8, fontWeight: 700, marginTop: 4, color: used ? T.disabled : T.gold }}>{status}</div>
              </div>
            );
          })}
          {heroes.length === 0 && (
            <div style={{ color: T.muted, fontSize: 10.5, padding: '6px 0' }}>Play hero cards from your hand to your party.</div>
          )}
        </div>
      </div>

      {/* right rail */}
      <div style={{ width: 122, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'flex-end' }}>
        <div style={{ textAlign: 'center', fontSize: 10, color: T.muted2 }}>
          Slain <strong style={{ color: T.text }}>{slain}</strong> / {target}
        </div>
        <span
          onClick={() => isMyTurn && onEndTurn()}
          style={{
            background: isMyTurn ? T.gold : 'oklch(0.3 0.015 260)', color: isMyTurn ? T.onGold : T.disabled,
            fontWeight: 700, fontSize: 12.5, padding: 11, borderRadius: 9, textAlign: 'center',
            cursor: isMyTurn ? 'pointer' : 'default', transition: 'background 0.2s',
          }}
        >
          End turn
        </span>
      </div>
    </div>
  );
}
