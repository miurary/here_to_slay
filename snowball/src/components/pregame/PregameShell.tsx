import type { ReactNode } from 'react';
import { T, feltBackground, FELT_COLORS } from '../game/table/tableUtils';
import '../game/table/table.css';

interface PregameShellProps {
  /** Show the ROOM code + copy invite + name input + Leave chrome (everything but Home). */
  showRoomChrome: boolean;
  roomCode?: string;
  onCopyInvite?: () => void;
  /** Inline name field (header). Saves on Enter/blur. */
  name?: string;
  onNameChange?: (value: string) => void;
  onNameSave?: () => void;
  onLeave?: () => void;

  statusMain: string;
  statusSub?: string;
  /** Gold when the state needs the player's action; neutral otherwise. */
  statusGold?: boolean;

  toast?: string | null;
  /** The shared log & chat drawer (+ edge tab), or nothing (Home). */
  logDrawer?: ReactNode;
  children: ReactNode;
}

const nameInput: React.CSSProperties = {
  background: 'oklch(0.24 0.015 260)', border: `1px solid ${T.border}`, borderRadius: 7,
  color: T.text, fontSize: 12, fontWeight: 600, padding: '6px 10px', width: 110, outline: 'none',
  fontFamily: 'inherit',
};
const ghostGold: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, border: '1px solid oklch(0.5 0.06 85)', color: T.gold,
  padding: '5px 11px', borderRadius: 7, cursor: 'pointer',
};

/**
 * The shared frame for every pre-game phase (and Home): GUYSEB header with
 * optional room chrome, a centered status pill, the felt stage that centers its
 * children, an optional felt toast, and the shared log/chat drawer. Matches the
 * game screen's tokens so the whole flow reads as one system.
 */
export default function PregameShell(props: PregameShellProps) {
  const { showRoomChrome, roomCode, onCopyInvite, name, onNameChange, onNameSave, onLeave,
    statusMain, statusSub, statusGold, toast, logDrawer, children } = props;

  return (
    <div className="gt-root">
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: T.headerBg, padding: '12px 18px', flexShrink: 0 }}>
        <span className="gt-display" style={{ fontWeight: 800, fontSize: 16, color: T.gold, letterSpacing: '0.04em' }}>GUYSEB</span>
        {showRoomChrome && (
          <>
            <span style={{ width: 1, height: 18, background: T.border }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: T.muted }}>ROOM</span>
            <span className="gt-display" style={{ fontWeight: 700, fontSize: 15, color: T.text, letterSpacing: '0.08em' }}>{roomCode}</span>
            <span onClick={onCopyInvite} style={ghostGold}>Copy invite link</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {showRoomChrome && (
          <>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: T.muted2 }}>YOUR NAME</span>
            <input
              value={name ?? ''}
              onChange={(e) => onNameChange?.(e.target.value)}
              onBlur={onNameSave}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={nameInput}
            />
            <span onClick={onLeave} style={{ fontSize: 11, fontWeight: 600, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 7, padding: '6px 13px', cursor: 'pointer' }}>Leave room</span>
          </>
        )}
      </div>

      {/* status pill */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 999, padding: '8px 20px', background: statusGold ? T.gold : 'oklch(0.3 0.015 260)', color: statusGold ? T.onGold : T.text2, transition: 'background 0.3s, color 0.3s' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.1em' }}>{statusMain}</span>
          {statusSub && <span style={{ fontSize: 11.5, fontWeight: 500, opacity: 0.85 }}>{statusSub}</span>}
        </div>
      </div>

      {/* felt */}
      <div style={{ flex: 1, margin: '12px 46px 18px 18px', borderRadius: 18, border: '1px solid rgba(255,255,255,0.09)', background: feltBackground(FELT_COLORS[0]), position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {toast && (
          <div style={{ position: 'absolute', top: 14, right: 14, background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.5)`, borderRadius: 10, padding: '9px 14px', fontSize: 11.5, fontWeight: 600, color: T.text, animation: 'gt-toastIn 0.25s ease', zIndex: 30 }}>
            {toast}
          </div>
        )}
        {children}
      </div>

      {logDrawer}
    </div>
  );
}
