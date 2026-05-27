import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Game from './Game';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/game/:roomCode" element={<Game />} />
      </Routes>
    </BrowserRouter>
  );
}
