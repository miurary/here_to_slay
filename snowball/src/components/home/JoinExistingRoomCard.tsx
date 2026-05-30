interface JoinExistingRoomCardProps {
    roomCode: string;
    setRoomCode: (roomCode: string) => void;
    handleJoinRoom: (event: React.FormEvent<HTMLFormElement>) => void;
}

export default function JoinExistingRoomCard({ roomCode, setRoomCode, handleJoinRoom }: JoinExistingRoomCardProps) {
    return(
        <div className="panel">
                <h2>Join an existing room</h2>
                <form onSubmit={handleJoinRoom}>
                <input
                    type="text"
                    value={roomCode}
                    onChange={(event) => setRoomCode(event.target.value)}
                    placeholder="Room Code"
                    style={{ width: '100%', maxWidth: '240px', padding: '0.75rem', marginBottom: '0.75rem' }}
                />
                <button type="submit" className="primaryButton">
                    Join Room
                </button>
                </form>
            </div>
    );
}
