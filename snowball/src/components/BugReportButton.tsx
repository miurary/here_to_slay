import { useState, useSyncExternalStore } from 'react';
import { BUG_CATEGORIES, type BugCategory } from '../../../shared/types';
import { getActiveSocket, subscribeActiveSocket } from '../utils/socketRef';

const MAX_DESCRIPTION = 2000;

const fabStyle: React.CSSProperties = {
    position: 'fixed', bottom: '0.75rem', left: '0.75rem', zIndex: 1200,
    padding: '0.45rem 0.85rem', fontSize: '0.85rem',
    backgroundColor: 'rgba(30, 30, 40, 0.85)', color: 'white',
    border: '1px solid rgba(255,255,255,0.25)', borderRadius: '999px',
    cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
};
const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1300,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(90vw, 460px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    color: '#08060d',
};
const pillStyle = (selected: boolean): React.CSSProperties => ({
    padding: '0.4rem 0.75rem', fontSize: '0.85rem', borderRadius: '999px',
    border: selected ? '1px solid #007bff' : '1px solid #ccc',
    backgroundColor: selected ? '#007bff' : 'white',
    color: selected ? 'white' : '#08060d', cursor: 'pointer',
});
const sendBtnStyle = (enabled: boolean): React.CSSProperties => ({
    padding: '0.6rem 1.25rem', fontSize: '0.95rem',
    backgroundColor: enabled ? '#007bff' : '#ccc', color: 'white',
    border: 'none', borderRadius: '8px', cursor: enabled ? 'pointer' : 'not-allowed',
});
const cancelBtnStyle: React.CSSProperties = {
    padding: '0.6rem 1rem', fontSize: '0.95rem', backgroundColor: 'transparent',
    color: '#6b6375', border: '1px solid #ccc', borderRadius: '8px', cursor: 'pointer',
};

/**
 * Always-visible floating bug-report button. The report goes over the active
 * game socket, where the server enriches it with the room's state and its
 * position in the analytics stream — so from the home page (no socket) the
 * modal explains that reports can only be sent from inside a game.
 */
export default function BugReportButton() {
    const socket = useSyncExternalStore(subscribeActiveSocket, getActiveSocket);
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState<BugCategory | null>(null);
    const [description, setDescription] = useState('');
    const [status, setStatus] = useState<'editing' | 'sending' | 'sent'>('editing');
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        setOpen(false);
        setCategory(null);
        setDescription('');
        setStatus('editing');
        setError(null);
    };

    const canSend = !!socket && !!category && description.trim().length > 0 && status === 'editing';

    const handleSend = () => {
        if (!socket || !category) return;
        setStatus('sending');
        setError(null);
        const timeout = setTimeout(() => {
            setStatus('editing');
            setError('No response from the server — please try again.');
        }, 5000);
        socket.once('bugReportAck', (result) => {
            clearTimeout(timeout);
            if (result.ok) {
                setStatus('sent');
                setTimeout(close, 1400);
            } else {
                setStatus('editing');
                setError(result.message);
            }
        });
        socket.emit('reportBug', {
            category,
            description: description.trim(),
            client: {
                userAgent: navigator.userAgent,
                viewport: `${window.innerWidth}x${window.innerHeight}`,
            },
        });
    };

    return (
        <>
            <button type="button" style={fabStyle} onClick={() => setOpen(true)}>
                🐞 Report a bug
            </button>
            {open && (
                <div style={overlayStyle} onClick={close}>
                    <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 0.75rem' }}>Report a bug</h3>
                        {status === 'sent' ? (
                            <p style={{ margin: '1rem 0' }}>✅ Thanks — your report was sent.</p>
                        ) : (
                            <>
                                {!socket && (
                                    <p style={{ fontSize: '0.9rem', color: '#a00', margin: '0 0 0.75rem' }}>
                                        Bug reports can only be sent from inside a game room.
                                    </p>
                                )}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                    {BUG_CATEGORIES.map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            style={pillStyle(category === c.id)}
                                            onClick={() => setCategory(c.id)}
                                        >
                                            {c.label}
                                        </button>
                                    ))}
                                </div>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    maxLength={MAX_DESCRIPTION}
                                    rows={5}
                                    placeholder="What happened? What did you expect to happen?"
                                    style={{
                                        width: '100%', boxSizing: 'border-box', padding: '0.6rem',
                                        fontSize: '0.95rem', fontFamily: 'inherit', borderRadius: '8px',
                                        border: '1px solid #ccc', resize: 'vertical',
                                    }}
                                />
                                <div style={{ fontSize: '0.75rem', color: '#6b6375', textAlign: 'right', margin: '0.25rem 0 0.75rem' }}>
                                    {description.length}/{MAX_DESCRIPTION}
                                </div>
                                {error && (
                                    <p style={{ fontSize: '0.85rem', color: '#a00', margin: '0 0 0.75rem' }}>{error}</p>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                                    <button type="button" style={cancelBtnStyle} onClick={close}>Cancel</button>
                                    <button type="button" style={sendBtnStyle(canSend)} disabled={!canSend} onClick={handleSend}>
                                        {status === 'sending' ? 'Sending…' : 'Send report'}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
