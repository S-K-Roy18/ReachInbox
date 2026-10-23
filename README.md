# ReachInbox

Gmail-inspired cold email outreach platform.

## Project Structure

```
ReachInbox/
├── src/                  # React + Vite frontend
├── backend/              # Express + TypeScript backend
│   ├── prisma/           # Prisma schema & migrations
│   └── src/              # Backend source
├── docker-compose.yml    # PostgreSQL service
└── ...
```

## Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Google Cloud OAuth 2.0 credentials

## Quick Start

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Configure environment

```bash
# Copy and edit backend env
cp backend/.env.example backend/.env
# Fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and SESSION_SECRET
```

### 3. Install dependencies

```bash
# Frontend
npm install

# Backend
cd backend && npm install
```

### 4. Run Prisma migrations

```bash
cd backend
npx prisma generate
npx prisma migrate dev
```

### 5. Start development servers

```bash
# Frontend (from project root)
npm run dev

# Backend (from backend/)
cd backend && npm run dev
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:4000
- Health:   http://localhost:4000/api/health

## Backend Scripts

| Script              | Description                      |
|---------------------|----------------------------------|
| `npm run dev`       | Start dev server with hot reload |
| `npm run build`     | Compile TypeScript to `dist/`    |
| `npm start`         | Run compiled production build    |
| `npm run prisma:generate` | Generate Prisma client    |
| `npm run prisma:migrate`  | Run database migrations   |

## Environment Variables

See `backend/.env.example` for all required variables.
See `.env.example` for Docker Compose PostgreSQL credentials.
