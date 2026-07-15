import { T } from '../game/table/tableUtils';
import { SEAT_COLORS } from './pregameUtils';

interface HomePanelProps {
  name: string;
  onNameChange: (value: string) => void;
  onNameSave: () => void;
  onCreateRoom: () => void;
  joinCode: string;
  onJoinChange: (value: string) => void;
  onJoinRoom: () => void;
}

const field: React.CSSProperties = {
  background: 'oklch(0.24 0.015 260)', border: `1px solid ${T.border}`, borderRadius: 7,
  color: T.text, fontSize: 12, fontWeight: 600, padding: '7px 10px', outline: 'none', fontFamily: 'inherit',
};
const goldBtn: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, background: T.gold, color: T.onGold, borderRadius: 8, cursor: 'pointer', textAlign: 'center',
};

/**
 * Home felt content: GUYSEB wordmark + one 620px panel that folds the old
 * three stacked cards into a name row and a Create | OR | Join split.
 */
export default function HomePanel({ name, onNameChange, onNameSave, onCreateRoom, joinCode, onJoinChange, onJoinRoom }: HomePanelProps) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <span className="gt-display" style={{ fontWeight: 800, fontSize: 44, color: T.gold, letterSpacing: '0.05em', textShadow: '0 4px 18px rgba(0,0,0,0.4)' }}>GUYSEB</span>
        <span style={{ fontSize: 13, color: '#d6dcd7' }}>Here to Slay online — start or join a room, then share the link with friends.</span>
      </div>

      <div style={{ background: 'oklch(0.2 0.02 260 / 0.94)', border: '1px solid oklch(0.4 0.02 260)', borderRadius: 14, padding: 22, width: 620, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 18, boxShadow: '0 24px 60px rgba(0,0,0,0.45)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 32, height: 32, borderRadius: '50%', background: SEAT_COLORS[0], color: '#1b1d24', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14 }}>{initial}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{name.trim() ? `Welcome back, ${name.trim()}` : 'Welcome — set your name'}</span>
            <span style={{ fontSize: 10.5, color: T.muted2 }}>This is how other players will see you.</span>
          </div>
          <input
            value={name}
            placeholder="Your name"
            onChange={(e) => onNameChange(e.target.value)}
            onBlur={onNameSave}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ ...field, width: 120 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'stretch' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Create a new room</span>
            <span style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, flex: 1 }}>Get a room code and invite up to 5 friends.</span>
            <span onClick={onCreateRoom} style={{ ...goldBtn, padding: '10px 0' }}>Create game room</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, width: 1, background: T.border }} />
            <span style={{ fontSize: 9.5, fontWeight: 700, color: T.disabled }}>OR</span>
            <span style={{ flex: 1, width: 1, background: T.border }} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Join an existing room</span>
            <span style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, flex: 1 }}>Enter the code your friend shared.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={joinCode}
                placeholder="ROOM CODE"
                onChange={(e) => onJoinChange(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') onJoinRoom(); }}
                style={{ ...field, flex: 1, width: 0, letterSpacing: '0.1em', fontWeight: 700, textTransform: 'uppercase' }}
              />
              <span onClick={onJoinRoom} style={{ ...goldBtn, padding: '10px 16px' }}>Join</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
