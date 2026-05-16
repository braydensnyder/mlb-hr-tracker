import { Routes, Route, NavLink, Link } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import PlayerDetail from './pages/PlayerDetail';
import Matchups from './pages/Matchups';
import HrTargets from './pages/HrTargets';
import Backtest from './pages/Backtest';
import Odds from './pages/Odds';

export default function App() {
  return (
    <div className="container">
      <header className="header">
        <Link to="/" className="brand" style={{ color: 'inherit' }}>
          HR <span className="accent">Tracker</span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/matchups">Matchups</NavLink>
          <NavLink to="/targets">HR Targets</NavLink>
          <NavLink to="/odds">Odds</NavLink>
          <NavLink to="/backtest">Backtest</NavLink>
        </nav>
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
