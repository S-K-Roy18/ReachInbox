
import { API_BASE_URL } from './config';

function LandingPage() {
  const currentYear = new Date().getFullYear();
  return (
    <div className="relative min-h-screen bg-[#050505] text-white flex flex-col items-center justify-center overflow-hidden">
      <div className="relative text-center px-4 z-10">
        <h1 className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl font-bold leading-tight">
          <span className="font-sans">Reach</span>
          <span className="font-serif italic">
            <span style={{color: '#4285F4'}}>I</span>
            <span style={{color: '#EA4335'}}>n</span>
            <span style={{color: '#FBBC05'}}>b</span>
            <span style={{color: '#34A853'}}>o</span>
            <span style={{color: '#4285F4'}}>x</span>
          </span>
        </h1>
        <p className="italic text-lg md:text-2xl mt-4">Outreach, on your time.</p>
        <p className="uppercase text-xs md:text-sm text-gray-400 tracking-wider mt-2">
          INTELLIGENT EMAIL SCHEDULING · BUILT FOR MODERN TEAMS
        </p>
                  <div className="mt-8 flex flex-row gap-4 justify-center items-center">
            <a href={`${API_BASE_URL}/api/auth/google`} className="bg-white text-black rounded-full px-6 py-3 flex items-center hover:bg-gray-200 transition">Sign In<span className="ml-2" aria-hidden="true">→</span></a>



          <a href={`${API_BASE_URL}/api/auth/google`} className="border border-gray-500 text-white rounded-full px-6 py-3 hover:bg-gray-800 transition">Sign Up</a>
        </div>
      </div>

      {/* Grid wave effect */}
      <svg
        className="absolute left-0 w-full h-[220px] sm:h-[320px] bottom-0 pointer-events-none z-0"
        viewBox="0 0 1440 200"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ WebkitMaskImage: 'linear-gradient(to bottom, transparent, black)', maskImage: 'linear-gradient(to bottom, transparent, black)' }}
      >
        <defs>
          <linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#4285F4" />
            <stop offset="25%" stopColor="#EA4335" />
            <stop offset="50%" stopColor="#FBBC05" />
            <stop offset="75%" stopColor="#34A853" />
            <stop offset="100%" stopColor="#4285F4" />
          </linearGradient>
          <pattern id="gridPattern" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M0 0 L20 0 M0 0 L0 20" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#gridPattern)" />
        <path d="M0,100 Q360,0 720,100 T1440,100 L1440,200 L0,200 Z" fill="url(#waveGrad)" opacity="0.3" />
      </svg>

      <footer className="absolute bottom-4 w-full text-center text-xs text-gray-500">
        REACHINBOX<br />
        PRECISION OUTREACH. SIMPLIFIED. © {currentYear}
      </footer>
    </div>
  );
}

export default LandingPage;
