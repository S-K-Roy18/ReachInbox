import { useEffect, useState } from 'react';
import LandingPage from './LandingPage';

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
      const res = await fetch('http://localhost:4000/api/auth/me', {
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
      await fetch('http://localhost:4000/api/auth/logout', {
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

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full bg-[#111111] border border-gray-800 rounded-2xl p-8 text-center shadow-xl">
        {user.avatarUrl && (
          <img
            src={user.avatarUrl}
            alt={user.name || 'User avatar'}
            className="w-20 h-20 rounded-full mx-auto mb-4 border-2 border-gray-700"
          />
        )}
        <h2 className="text-2xl font-bold mb-1">{user.name || 'User'}</h2>
        <p className="text-gray-400 text-sm mb-6">{user.email}</p>
        <div className="bg-[#1a1a1a] border border-gray-800 rounded-lg p-3 mb-6 text-xs text-green-400">
          ✓ Authenticated with Google OAuth
        </div>
        <button
          onClick={handleLogout}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 px-4 rounded-xl transition duration-200"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

export default App;

