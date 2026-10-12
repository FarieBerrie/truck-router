import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import RoutesPage from './pages/RoutesPage.jsx';
import PlanPage from './pages/PlanPage.jsx';
import RoutePage from './pages/RoutePage.jsx';

function TruckIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--green)" />
      <path d="M6 20V11h11v9M17 14h5l4 4v2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="11" cy="22" r="2.6" fill="#fff" />
      <circle cx="22" cy="22" r="2.6" fill="#fff" />
    </svg>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <TruckIcon />
          <span>Truck Router</span>
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Routes
          </NavLink>
          <NavLink to="/plan" className="nav-cta">
            + Plan routes
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<RoutesPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/routes/:id" element={<RoutePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
