import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Game from './Game';
import BugReportButton from './components/BugReportButton';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/game/:roomCode" element={<Game />} />
      </Routes>
      <BugReportButton />
    </BrowserRouter>
  );
}
