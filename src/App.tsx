import { Routes, Route, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import PlayerDetail from './pages/PlayerDetail';
import Matchups from './pages/Matchups';
import HrTargets from './pages/HrTargets';
import Backtest from './pages/Backtest';
import Odds from './pages/Odds';
import ClubhouseMenu from './components/ClubhouseMenu';

export default function App() {
  return (
    <div className="container">
      <header className="header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {/* Logo image already contains the 'HR TRACKER' wordmark, so we
            don't render text alongside it. Image lives in /public so Vite
            serves it from the site root. alt= keeps it accessible. */}
        <Link to="/" className="brand" style={{ color: 'inherit', display: 'inline-flex', alignItems: 'center' }} aria-label="HR Tracker — home">
          <img
            src="/hr-tracker-logo.png"
            alt="HR Tracker"
            style={{
              height: 44,
              width: 'auto',
              display: 'block',
              borderRadius: 8,
            }}
          />
        </Link>
        {/* Single branded menu — replaces inline nav links on both
            desktop and mobile (no separate hamburger). */}
        <ClubhouseMenu />
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/matchups" element={<Matchups />} />
        <Route path="/targets" element={<HrTargets />} />
        <Route path="/odds" element={<Odds />} />
        <Route path="/backtest" element={<Backtest />} />
        <Route path="/player/:playerId" element={<PlayerDetail />} />
        <Route
          path="*"
          element={
            <div className="panel">
              <h2>Not found</h2>
              <p className="subtle">That page doesn’t exist. <Link to="/">Back to dashboard</Link>.</p>
            </div>
          }
        />
      </Routes>
    </div>
  );
}
