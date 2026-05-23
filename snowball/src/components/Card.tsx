import './Card.css';

interface CardProps {
  image: string;
  title: string;
  description?: string;
  onClick?: () => void;
}

export default function Card({ image, title, description, onClick }: CardProps) {
  return (
    <div className="card" onClick={onClick}>
      <div className="card-image">
        <img src={image} alt={title} />
      </div>
      <div className="card-content">
        <h3 className="card-title">{title}</h3>
        {description && <p className="card-description">{description}</p>}
      </div>
    </div>
  );
}