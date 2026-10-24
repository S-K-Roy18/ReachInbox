# ReachInbox

A Gmail-inspired cold email outreach and scheduling platform built with React, Vite, TypeScript, Express, PostgreSQL, Prisma, Redis, and BullMQ.

ReachInbox lets users create email campaigns, import recipients, schedule delivery, monitor recipient statuses, and manage background email jobs through a web dashboard.

## Table of Contents

- [Features](#features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [Email Scheduling and Processing](#email-scheduling-and-processing)
- [Optional Integrations](#optional-integrations)
- [Available Scripts](#available-scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)

## Features

- Google OAuth authentication
- Email campaign creation and management
- Recipient management and CSV import
- Scheduled email delivery using BullMQ and Redis
- Persistent campaign and recipient records using PostgreSQL and Prisma
- Ethereal SMTP test email delivery
- Campaign and recipient status tracking
- Retry and failure handling through background job processing
- Rate limiting for supported API endpoints
- Bull Board dashboard for monitoring background jobs
- Restricted access to Bull Board through an administrator email allowlist
- Optional Slack OAuth integration and notifications
- Optional Elasticsearch indexing and search
- Responsive, Gmail-inspired user interface

## Technology Stack

### Frontend
- React
- Vite
- TypeScript
- CSS

### Backend
- Node.js
- Express
- TypeScript
- Prisma ORM
- PostgreSQL
- Google OAuth 2.0
- Express sessions

### Background Processing
- Redis
- BullMQ
- Bull Board

### Email and Integrations
- Ethereal Email for test email delivery
- Slack OAuth and notifications
- Elasticsearch for optional indexing and search

### Infrastructure
- Docker Compose
- PostgreSQL 15
- Redis 7

## Project Structure

```text
ReachInbox/
├── src/                       # React + Vite frontend
├── public/                    # Static frontend assets
├── backend/
│   ├── prisma/                # Prisma schema and migrations
│   ├── src/
│   │   ├── routes/             # API routes
│   │   ├── utils/              # Shared backend utilities
│   │   ├── workers/            # Background job processing
│   │   ├── app.ts              # Express application
│   │   ├── index.ts            # Backend entry point
│   │   └── worker.ts           # Standalone worker entry point
│   ├── .env.example            # Backend environment template
│   └── package.json
├── .env.example                # Local infrastructure examples
├── docker-compose.yml          # PostgreSQL and Redis services
├── package.json                # Frontend scripts and dependencies
└── README.md
```

The exact source files may vary as the project evolves.

## Prerequisites

Install the following before starting:

- Node.js 18 or newer
- npm
- Docker Desktop with Docker Compose
- Google Cloud OAuth 2.0 credentials
- An Ethereal Email account for test email delivery

Slack credentials and an Elasticsearch instance are only required if you want to enable those optional integrations.

## Quick Start

### 1. Start PostgreSQL and Redis

From the project root, run:

```bash
docker compose up -d
docker compose ps
```

Confirm that both the PostgreSQL and Redis containers are running and healthy.

The default local PostgreSQL configuration is:

- Host: `localhost`
- Port: `5432`
- Database: `postgres`
- Username: `postgres`
- Password: `postgres`

These defaults are intended for local development only.

### 2. Install dependencies

From the project root:

```bash
npm install
npm --prefix backend install
```

### 3. Configure environment variables

Create the backend environment file.

On macOS/Linux:

```bash
cp backend/.env.example backend/.env
```

On Windows PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
```

Open `backend/.env` and configure the required values. Do not leave placeholder OAuth, session, or SMTP credentials in place when running the corresponding features.

At minimum, configure:

- `DATABASE_URL`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `ETHEREAL_USER`
- `ETHEREAL_PASS`

See [Environment Variables](#environment-variables) for details.

### 4. Configure Google OAuth

In Google Cloud Console, configure an OAuth 2.0 client and add this authorized redirect URI:

```text
http://localhost:4000/api/auth/google/callback
```

Use the client ID and client secret provided by Google in `backend/.env`.

### 5. Generate Prisma Client and run migrations

From the project root:

```bash
npm --prefix backend run prisma:generate
npm --prefix backend run prisma:migrate
```

Ensure the PostgreSQL container is running and `DATABASE_URL` points to the correct database before running migrations.

### 6. Start the development servers

Open two terminals.

**Terminal 1 — Backend**

```bash
cd backend
npm run dev
```

**Terminal 2 — Frontend**

From the project root:

```bash
npm run dev
```

The frontend and backend should now be available at:

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend | http://localhost:4000 |
| Health endpoint | http://localhost:4000/api/health |

The backend entry point starts the API and its configured background processing. Check the backend logs to confirm the worker connects successfully.

## Environment Variables

Configure environment variables in `backend/.env`. The root `.env.example` documents the local PostgreSQL and Redis configuration.

| Variable | Purpose |
|---|---|
| `PORT` | Backend HTTP port |
| `DATABASE_URL` | PostgreSQL connection string |
| `FRONTEND_URL` | Frontend origin used by the backend |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | Google OAuth callback URL |
| `SESSION_SECRET` | Secret used to sign session data |
| `NODE_ENV` | Application environment |
| `REDIS_HOST` | Redis hostname |
| `REDIS_PORT` | Redis port |
| `ETHEREAL_USER` | Ethereal SMTP username |
| `ETHEREAL_PASS` | Ethereal SMTP password |
| `SLACK_CLIENT_ID` | Optional Slack OAuth client ID |
| `SLACK_CLIENT_SECRET` | Optional Slack OAuth client secret |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL |
| `SLACK_FRONTEND_REDIRECT_URL` | Frontend destination after Slack OAuth |
| `SLACK_TOKEN_ENCRYPTION_KEY` | Key used to encrypt stored Slack tokens |
| `ELASTICSEARCH_URL` | Optional Elasticsearch endpoint |
| `ELASTICSEARCH_API_KEY` | Optional Elasticsearch API key |
| `BULL_BOARD_ADMIN_EMAILS` | Comma-separated Google account emails permitted to access Bull Board |

### Example database URL

For the default local Docker Compose database:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

Use credentials that match your actual PostgreSQL configuration.

### Slack token encryption key

If Slack integration is enabled, configure a unique 32-byte encryption key encoded as 64 hexadecimal characters. Keep the key private and use a securely generated value.

### Optional services

- Slack OAuth requires the Slack client credentials, redirect URL, frontend redirect URL, and encryption key.
- Elasticsearch is optional; configure its endpoint and any required authentication before using search or indexing.
- Bull Board access is restricted by the configured administrator email allowlist.

## Authentication

ReachInbox uses Google OAuth 2.0 for authentication.

Configure the Google OAuth callback URL in both Google Cloud Console and the backend environment:

```text
http://localhost:4000/api/auth/google/callback
```

The backend uses Express sessions to maintain authenticated user sessions. Keep the session secret private and configure the appropriate frontend origin for local development.

## Email Scheduling and Processing

ReachInbox uses BullMQ and Redis to process scheduled email jobs asynchronously.

The general workflow is:

1. A user creates an email campaign and supplies recipients.
2. The backend stores campaign and recipient data in PostgreSQL.
3. Email jobs are added to the BullMQ queue with their scheduling information.
4. A background worker processes jobs when they become eligible.
5. The worker attempts delivery using the configured Ethereal SMTP transport.
6. Campaign and recipient statuses are updated as processing progresses.
7. Queue monitoring tools help inspect completed, waiting, and failed jobs.

Redis stores queue state, while PostgreSQL stores application records. Both services should be running before campaign processing begins.

### Test email delivery

Ethereal Email is intended for test delivery. It captures messages for inspection rather than delivering them to real recipient inboxes. Do not describe Ethereal test messages as real cold emails delivered to recipients.

## Optional Integrations

### Slack

Slack integration supports OAuth-based connection and configured notifications.

Configure the following redirect URL in your Slack application:

```text
http://localhost:4000/api/integrations/slack/callback
```

Also configure the frontend redirect URL and token encryption key in `backend/.env`.

### Elasticsearch

Elasticsearch can be configured for optional indexing and search.

Set `ELASTICSEARCH_URL` to your Elasticsearch endpoint and configure `ELASTICSEARCH_API_KEY` if the instance requires API-key authentication.

If Elasticsearch is not running or configured, Elasticsearch-dependent features may be unavailable.

### Bull Board

Bull Board provides a dashboard for inspecting background email jobs.

Access is restricted using `BULL_BOARD_ADMIN_EMAILS`, which contains a comma-separated list of permitted Google account email addresses. Configure the allowlist and sign in with an authorized account before accessing the queue dashboard.

## Available Scripts

### Frontend scripts

Run from the project root:

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and build the production frontend |
| `npm run lint` | Run the configured linter |
| `npm run preview` | Preview the production build |

### Backend scripts

Run from the `backend/` directory, or use `npm --prefix backend run <script>` from the project root.

| Command | Description |
|---|---|
| `npm run dev` | Start the backend development server |
| `npm run build` | Compile TypeScript |
| `npm start` | Run the compiled backend |
| `npm run worker` | Start the standalone worker script |
| `npm run prisma:generate` | Generate the Prisma Client |
| `npm run prisma:migrate` | Run the configured Prisma migration command |
| `npm run test` | Run the email pipeline test |
| `npm run test:pipeline` | Run the email pipeline test directly |
| `npm run test:campaigns` | Run campaign API tests |
| `npm run test:rate-limits` | Run rate-limiting tests |
| `npm run test:slack` | Run Slack integration tests |
| `npm run test:elasticsearch` | Run Elasticsearch integration tests |
| `npm run test:bull-board` | Run Bull Board access tests |
| `npm run smtp:verify` | Verify the configured SMTP connection |

The in-process worker and standalone worker are separate entry points. Avoid running both against the same queue unless you intentionally want multiple workers.

## Testing

### Production builds

From the project root:

```bash
npm --prefix backend run build
npm run build
```

### Backend integration checks

Run the supported tests individually:

```bash
npm --prefix backend run test:campaigns
npm --prefix backend run test:rate-limits
npm --prefix backend run test:slack
npm --prefix backend run test:elasticsearch
npm --prefix backend run test:bull-board
```

### Email pipeline test

```bash
npm --prefix backend run test:pipeline
```

The pipeline test depends on SMTP connectivity. Ethereal SMTP may occasionally time out, so a timeout should be investigated rather than treated as proof that the entire application is broken.

## Troubleshooting

### PostgreSQL connection errors

- Confirm the PostgreSQL container is healthy with `docker compose ps`.
- Verify that `DATABASE_URL` matches your PostgreSQL credentials and database.
- Run Prisma Client generation and migrations after configuring the database.
- Check that port `5432` is not being used by an unrelated PostgreSQL instance.

### Redis connection errors

- Confirm the Redis container is running and healthy.
- Verify `REDIS_HOST` and `REDIS_PORT`.
- Check whether another Redis instance is using port `6379`.

### Google OAuth errors

- Verify the client ID and secret.
- Confirm that the callback URL matches the URL configured in Google Cloud Console.
- Ensure the frontend and backend URLs are correct for the current environment.

### Email delivery test failures

- Confirm that `ETHEREAL_USER` and `ETHEREAL_PASS` are correct.
- Check SMTP connectivity and backend logs.
- Retry an SMTP timeout after verifying network connectivity.
- Use Ethereal's message preview to inspect test messages.

### Bull Board shows no workers

- Check the backend startup logs for worker initialization and Redis connection messages.
- Confirm that the backend process remains running.
- Ensure the queue and worker are configured to use the same Redis connection and queue name.
- Avoid starting duplicate worker processes unintentionally.

### Slack or Elasticsearch integration issues

- Confirm that all required integration variables are configured.
- Verify the callback URLs and credentials.
- Check service availability and backend logs.

## Security Notes

- Never commit `.env` or `backend/.env` files containing real credentials.
- Keep OAuth client secrets, SMTP passwords, session secrets, Slack encryption keys, and Elasticsearch API keys private.
- Commit `.env.example` files with placeholder values only.
- Use strong, unique secrets outside local development.
- Use HTTPS and secure session-cookie settings when deploying to production.
- Restrict Bull Board access to explicitly authorized accounts.
- Ethereal Email is for test messages, not production email delivery.

## License

Add the applicable license information here if the project is distributed under a license.
