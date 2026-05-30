interface CreateNewRoomCardProps {
    handleCreateRoom: () => void;
  }

export default function CreateNewRoomCard({ handleCreateRoom }: CreateNewRoomCardProps) {
return (
          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2>Create a new room</h2>
            <p>Generate a room code and invite friends to join.</p>
            <button type="button" onClick={handleCreateRoom} className="primaryButton">
              Create Game Room
            </button>
          </div>
    );
}