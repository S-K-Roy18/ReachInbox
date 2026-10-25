// Frontend configuration
// Reads VITE_API_URL from environment with fallback to http://localhost:4000 for local development.
export const API_BASE_URL: string = (
  (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:4000'
).replace(/\/+$/, '');
