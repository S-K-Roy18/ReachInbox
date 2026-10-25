import { useEffect, useState } from 'react';
import LandingPage from './LandingPage';
import Dashboard from './Dashboard';
import { API_BASE_URL } from './config';
import './dashboard.css';

interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/me`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setUser(null);
      window.history.pushState({}, '', '/');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center text-gray-400">
        <div className="animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <LandingPage />;
  }

  return <Dashboard user={user} onLogout={handleLogout} />;
}

export default App;

