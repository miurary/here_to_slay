import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../../../../shared/types';
import LogDrawer from '../game/table/LogDrawer';

interface PregameLogDrawerProps {
  myId: string;
  entries: LogEntry[];
  onSend: (message: string) => void;
}

/**
 * Wraps the shared game-screen LogDrawer with local open/unread state so it can
 * drop straight into the pre-game shell. New log entries bump the unread badge
 * while the drawer is closed; opening it clears the badge.
 */
export default function PregameLogDrawer({ myId, entries, onSend }: PregameLogDrawerProps) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const prevLen = useRef(entries.length);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    if (entries.length > prevLen.current) {
      if (!openRef.current) setUnread((u) => u + (entries.length - prevLen.current));
    }
    prevLen.current = entries.length;
  }, [entries.length]);

  const toggle = () => setOpen((o) => { const next = !o; if (next) setUnread(0); return next; });

  return <LogDrawer myId={myId} entries={entries} open={open} unread={unread} onToggle={toggle} onSend={onSend} />;
}
