import { useState } from 'react';
import type { LogEntry } from '../../../../../shared/types';
import { T, closeButton } from './tableUtils';

interface LogDrawerProps {
  myId: string;
  entries: LogEntry[];
  open: boolean;
  unread: number;
  onToggle: () => void;
  onSend: (message: string) => void;
}

function entryColor(entry: LogEntry, myId: string): string {
  if (entry.kind === 'chat') return T.muted;
  if (entry.kind === 'action' && entry.playerId === myId) return T.gold;
  return '#cfd3db';
}

/**
 * Right slide-out log & chat drawer. Newest entries sit at the bottom
 * (column-reverse); a chat box sends on Enter. When closed it collapses to a
 * vertical edge tab with an unread badge.
 */
export default function LogDrawer({ myId, entries, open, unread, onToggle, onSend }: LogDrawerProps) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };
  // column-reverse renders the first child at the bottom, so feed newest-first.
  const newestFirst = [...entries].reverse();

  return (
    <>
      <div
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 300, background: T.drawerBg,
          borderLeft: '1px solid oklch(0.32 0.015 260)', zIndex: 40, display: 'flex', flexDirection: 'column',
          padding: 16, gap: 10, transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.28s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: T.muted }}>LOG &amp; CHAT</span>
          <span onClick={onToggle} style={closeButton}>Close ›</span>
        </div>
        <div className="gt-scroll" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse', gap: 7, fontSize: 11.5, lineHeight: 1.45, color: '#cfd3db' }}>
          {newestFirst.map((e) => (
            <div key={e.id} style={{ color: entryColor(e, myId) }}>
              {e.kind === 'chat' ? <><strong>{e.username || 'Player'}:</strong> {e.text}</> : e.text}
            </div>
          ))}
          {entries.length === 0 && <div style={{ color: T.disabled }}>No activity yet.</div>}
        </div>
        <input
          className="gt-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Message the table… (Enter)"
          maxLength={500}
        />
      </div>

      {!open && (
        <div
          onClick={onToggle}
          style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', background: T.cardBg2, border: '1px solid oklch(0.36 0.015 260)', borderRight: 'none', borderRadius: '10px 0 0 10px', padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer', zIndex: 30 }}
        >
          <span style={{ writingMode: 'vertical-rl', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: T.muted }}>LOG &amp; CHAT</span>
          {unread > 0 && (
            <span style={{ width: 18, height: 18, borderRadius: '50%', background: T.red, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700 }}>{Math.min(9, unread)}</span>
          )}
        </div>
      )}
    </>
  );
}
