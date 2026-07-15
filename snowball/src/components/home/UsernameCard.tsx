interface UsernameCardProps {
    nameSaved: boolean;
    name: string;
    setName: React.Dispatch<React.SetStateAction<string>>;
    handleSaveName: () => void;
}

export default function UsernameCard({ nameSaved, name, setName, handleSaveName }: UsernameCardProps) {
    return (
        <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2>Ready to play?</h2>
            {nameSaved && name ? (
              <div style={{ fontSize: '1rem', color: '#e8e9ee' }}>
                Welcome {name}!
              </div>
            ) : (
              <>
                <label htmlFor="name" style={{ display: 'block', marginBottom: '0.5rem' }}>
                  Username
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter a username"
                  style={{ width: '100%', maxWidth: '360px', padding: '0.75rem', marginBottom: '0.75rem' }}
                />
                <button type="button" onClick={handleSaveName} className="primaryButton">
                  Save Username
                </button>
              </>
            )}
        </div>
    );
}