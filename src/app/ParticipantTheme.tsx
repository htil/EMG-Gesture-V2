import { useState } from 'react';
import { Outlet } from 'react-router';

// Visual preference only; never read or write the study-session storage.
const STORAGE_KEY = 'emg-ui-theme';

export default function ParticipantTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(STORAGE_KEY, next); }
    catch { /* Storage can be unavailable; the control still works this visit. */ }
  }

  return (
    <div data-participant-theme={theme}>
      <div className="participant-theme-toolbar">
        <button type="button" className="participant-theme-toggle" aria-pressed={theme === 'light'} onClick={toggleTheme}>
          <span aria-hidden="true">{theme === 'light' ? '☀' : '☾'}</span> Light mode
        </button>
      </div>
      <Outlet />
    </div>
  );
}
