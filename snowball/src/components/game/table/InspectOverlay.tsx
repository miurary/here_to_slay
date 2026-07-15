import type { GameState } from '../../../../../shared/types';
import { T, backdrop, panel, closeButton, classColor, effectiveClass, initialOf, displayName } from './tableUtils';
import Tooltip from './Tooltip';

interface InspectOverlayProps {
  gameState: GameState;
  playerId: string;
  onClose: () => void;
}

/** Read-only inspect of an opponent's table: leader, heroes + items, slain monsters. */
export default function InspectOverlay({ gameState, playerId, onClose }: InspectOverlayProps) {
  const player = gameState.players[playerId];
  if (!player) return null;
  const name = displayName(gameState, playerId);
  const party = player.zones.party;
  const leaderCard = party.find((c) => c.cardType === 'party_leader');
  const leaderTmpl = leaderCard ? gameState.cardTemplates[leaderCard.templateId] : undefined;
  const leaderColor = classColor(leaderTmpl?.class);
  const heroes = party.filter((c) => c.cardType === 'hero');
  const target = gameState.targetMonstersToWin ?? 3;
  const color = classColor(leaderTmpl?.class);

  return (
    <div style={backdrop} onClick={onClose}>
      <div className="gt-scroll" style={{ ...panel, width: 620, maxHeight: '76vh', overflowY: 'auto', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: '50%', color: '#1b1d24', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, background: color }}>{initialOf(name)}</span>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>{name}&rsquo;s table</span>
          <span style={{ fontSize: 10.5, color: T.muted }}>Hand {player.zones.hand.length} · Slain {player.slainMonsters?.length ?? 0} / {target}</span>
          <span onClick={onClose} style={closeButton}>Close</span>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
          <div style={{ width: 150, flexShrink: 0, background: T.cardBg, border: `1px solid ${leaderColor}`, borderRadius: 10, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontWeight: 700, fontSize: 11.5, lineHeight: 1.25 }}>{leaderTmpl?.name ?? 'No leader'}</span>
            <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.05em', color: leaderColor }}>LEADER · {(leaderTmpl?.class ?? '').toUpperCase()}</span>
            <span style={{ fontSize: 9.5, lineHeight: 1.45, color: T.text2, marginTop: 4 }}>{leaderTmpl?.abilityText ?? ''}</span>
          </div>
          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 7, alignContent: 'flex-start' }}>
            {heroes.length === 0 && <span style={{ fontSize: 10.5, color: T.muted }}>No heroes in party yet.</span>}
            {heroes.map((hero) => {
              const tmpl = gameState.cardTemplates[hero.templateId];
              const cls = effectiveClass(hero, gameState, player);
              const equippedTmpl = hero.equippedItem ? gameState.cardTemplates[party.find((c) => c.instanceId === hero.equippedItem)?.templateId ?? ''] : undefined;
              return (
                <div key={hero.instanceId} style={{ width: 165, background: T.cardBg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${classColor(cls)}`, borderRadius: 8, padding: '7px 9px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 11 }}>{tmpl?.name ?? hero.templateId}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: classColor(cls), whiteSpace: 'nowrap' }}>{(cls ?? '').toUpperCase()} · {tmpl?.rollToPlay ?? '?'}+</span>
                  </div>
                  <div style={{ fontSize: 9.5, color: T.text2, lineHeight: 1.4, marginTop: 3 }}>{tmpl?.abilityText ?? ''}</div>
                  {equippedTmpl && <div style={{ fontSize: 8.5, fontWeight: 700, marginTop: 4, color: T.itemBlue }}>⚙ {equippedTmpl.name}</div>}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid oklch(0.32 0.015 260)', paddingTop: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: T.muted2, letterSpacing: '0.07em' }}>SLAIN MONSTERS</span>
          {player.slainMonsters.map((m) => {
            const tmpl = gameState.cardTemplates[m.templateId];
            return (
              <Tooltip key={m.instanceId} text={tmpl?.slainEffectText}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: T.cardBg2, color: T.green, cursor: 'help' }}>{tmpl?.name ?? m.templateId}</span>
              </Tooltip>
            );
          })}
          {player.slainMonsters.length === 0 && <span style={{ fontSize: 10, color: T.disabled }}>No monsters slain yet</span>}
        </div>
      </div>
    </div>
  );
}
