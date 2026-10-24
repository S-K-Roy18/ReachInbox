# ReachInbox — Email Scheduling Platform

A Gmail-inspired email scheduling platform built with React, Vite, TypeScript, Express, PostgreSQL, Prisma, Redis, and BullMQ.

ReachInbox enables users to create email campaigns, import recipients, schedule email delivery, and monitor campaign progress through a web dashboard. Background jobs are processed asynchronously, while PostgreSQL stores campaign and recipient records.

## Table of Contents

- [Features](#features)
- [Technology Stack](#technology-stack)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [How Scheduling Works](#how-scheduling-works)
- [Persistence and Restart Recovery](#persistence-and-restart-recovery)
- [Rate Limiting and Concurrency](#rate-limiting-and-concurrency)
- [Frontend Features](#frontend-features)
- [Backend Features](#backend-features)
- [Email Delivery and Ethereal SMTP](#email-delivery-and-ethereal-smtp)
- [Optional Integrations](#optional-integrations)
- [Available Scripts](#available-scripts)
- [Testing](#testing)
- [Assumptions and Trade-offs](#assumptions-and-trade-offs)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)

## Features

- Google OAuth authentication and session-based access
- Email campaign creation and management
- Recipient management and CSV import
- Scheduled email processing using BullMQ and Redis
- PostgreSQL persistence through Prisma ORM
- Recipient-level delivery status tracking
- Background email processing and retry handling
- API rate limiting
- Bull Board queue monitoring with restricted access
- Optional Slack OAuth integration and notifications
- Optional Elasticsearch indexing and search
- Gmail-inspired dashboard for campaign management

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, TypeScript, CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL, Prisma ORM |
| Queue | BullMQ, Redis |
| Authentication | Google OAuth 2.0, Express sessions |
| Email testing | Ethereal SMTP |
| Queue monitoring | Bull Board |
| Optional search | Elasticsearch |
| Optional notifications | Slack OAuth |
| Infrastructure | Docker Compose |

## Architecture Overview

ReachInbox separates the user interface, API, persistent application data, and background email processing.

```text
React + Vite Frontend
         |
         | HTTP requests / authenticated sessions
         v
Express + TypeScript API
         |
         +----------------------+
         |                      |
         v                      v
PostgreSQL                  Redis + BullMQ
(Prisma ORM)                     |
                                 v
                          Email Worker
                                 |
                                 v
                           Ethereal SMTP

Optional services:
Slack integration | Elasticsearch | Bull Board
```

### Component responsibilities

- **Frontend:** Provides authentication, campaign creation, recipient import, campaign tables, and status monitoring.
- **Backend API:** Validates requests, handles authentication, manages campaigns, and coordinates queue operations.
- **PostgreSQL:** Stores application records, including campaign and recipient data.
- **Redis and BullMQ:** Manage queued email jobs and scheduling information.
- **Email worker:** Processes eligible jobs and attempts email delivery.
- **Ethereal SMTP:** Captures test messages for inspection.
- **Bull Board:** Provides a restricted interface for inspecting queue jobs.
- **Slack and Elasticsearch:** Provide optional notification and search/indexing functionality.

## Project Structure

```text
ReachInbox/
├── src/                       # React + Vite frontend
├── public/                    # Static frontend assets
├── backend/
│   ├── prisma/                # Prisma schema and migrations
│   ├── src/
│   │   ├── routes/             # API routes
│   │   ├── utils/              # Shared utilities
│   │   ├── workers/            # Background worker implementation
│   │   ├── app.ts              # Express application
│   │   ├── index.ts            # Backend entry point
│   │   └── worker.ts           # Standalone worker entry point
│   ├── .env.example
│   └── package.json
├── .env.example                # Local infrastructure configuration
├── docker-compose.yml
├── package.json
└── README.md
```

## Prerequisites

Install the following:

- Node.js 18 or newer
- npm
- Docker Desktop with Docker Compose
- Google Cloud OAuth 2.0 credentials
- An Ethereal Email account for test email delivery

Slack and Elasticsearch credentials are optional unless you intend to use those integrations.

## Getting Started

### 1. Start PostgreSQL and Redis

Run these commands from the project root:

```bash
docker compose up -d
docker compose ps
```

Confirm that both PostgreSQL and Redis are running and healthy.

### 2. Install dependencies

From the project root:

```bash
npm install
npm --prefix backend install
```

### 3. Configure environment variables

Create the backend environment file.

**Windows PowerShell:**

```powershell
Copy-Item backend/.env.example backend/.env
```

**macOS/Linux:**

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and configure the required credentials and connection settings.

### 4. Configure Google OAuth

Create an OAuth 2.0 client in Google Cloud Console.

Add this authorized redirect URI:

```text
http://localhost:4000/api/auth/google/callback
```

Set the corresponding client ID and client secret in `backend/.env`.

### 5. Generate Prisma Client and run migrations

From the project root:

```bash
npm --prefix backend run prisma:generate
npm --prefix backend run prisma:migrate
```

Ensure that PostgreSQL is running and `DATABASE_URL` points to the correct database.

### 6. Start the backend

Open a terminal:

```bash
cd backend
npm run dev
```

The backend entry point starts the API and the configured in-process background worker.

### 7. Start the frontend

Open another terminal from the project root:

```bash
npm run dev
```

### Local URLs

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend | http://localhost:4000 |
| Health endpoint | http://localhost:4000/api/health |

## Environment Variables

Configure backend variables in `backend/.env`. The root `.env.example` documents local Docker infrastructure variables.

| Variable | Purpose |
|---|---|
| `PORT` | Backend HTTP port |
| `DATABASE_URL` | PostgreSQL connection string |
| `FRONTEND_URL` | Frontend origin |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | Google OAuth callback |
| `SESSION_SECRET` | Secret used for session signing |
| `NODE_ENV` | Application environment |
| `REDIS_HOST` | Redis hostname |
| `REDIS_PORT` | Redis port |
| `ETHEREAL_USER` | Ethereal SMTP username |
| `ETHEREAL_PASS` | Ethereal SMTP password |
| `SLACK_CLIENT_ID` | Optional Slack OAuth client ID |
| `SLACK_CLIENT_SECRET` | Optional Slack OAuth client secret |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL |
| `SLACK_FRONTEND_REDIRECT_URL` | Frontend redirect after Slack OAuth |
| `SLACK_TOKEN_ENCRYPTION_KEY` | Encryption key for stored Slack tokens |
| `ELASTICSEARCH_URL` | Optional Elasticsearch endpoint |
| `ELASTICSEARCH_API_KEY` | Optional Elasticsearch API key |
| `BULL_BOARD_ADMIN_EMAILS` | Comma-separated Google account emails allowed to access Bull Board |

The root `.env.example` includes:

```dotenv
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
ETHEREAL_USER=your_ethereal_username
ETHEREAL_PASS=your_ethereal_password
```

For the default local PostgreSQL configuration, the backend connection string is:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

These example credentials are for local development only. Use appropriate secrets and credentials for other environments.

### Slack encryption key

If Slack integration is enabled, configure a unique 32-byte key represented by 64 hexadecimal characters. Keep the key private.

## How Scheduling Works

ReachInbox uses BullMQ and Redis for asynchronous email scheduling rather than relying on an in-memory timer or a cron-based scheduler.

The scheduling workflow is:

1. The user creates a campaign and supplies recipient information.
2. The API validates the request and stores the campaign and recipient records in PostgreSQL.
3. Email jobs are added to the BullMQ queue with their scheduling information.
4. BullMQ makes scheduled jobs eligible for processing when their delay has elapsed.
5. The worker picks up eligible jobs and attempts delivery through the configured SMTP transport.
6. Recipient statuses and campaign progress are updated as processing completes.
7. Queue state can be inspected through Bull Board when access is authorized.

Redis-backed delayed jobs allow scheduling state to survive an API process restart, provided Redis data is retained and the queue is configured correctly.

## Persistence and Restart Recovery

ReachInbox uses PostgreSQL and Redis for different types of persistence.

### PostgreSQL persistence

PostgreSQL stores application records, including campaign and recipient data. Prisma provides the database access layer and migration workflow.

Because these records are stored in the database, they can remain available after the backend process restarts.

### Queue persistence

BullMQ stores job data in Redis. The Docker Compose configuration uses a named Redis volume, allowing Redis data to persist across ordinary container restarts.

This supports recovery of queued and delayed jobs after a backend restart, assuming Redis data is retained and the queue has not been cleared.

### Restart verification

To verify the required restart scenario:

1. Create a campaign with recipients scheduled for a future time.
2. Confirm that the campaign and jobs are queued.
3. Stop the backend process without deleting Redis data or database records.
4. Restart the backend.
5. Confirm that the worker reconnects and the future jobs remain available.
6. Wait for the scheduled time and verify the resulting recipient statuses.

A successful restart test should be demonstrated in the project video. Do not claim the scenario has passed until you have verified it in the running application.

## Rate Limiting and Concurrency

### Rate limiting

The backend includes rate-limiting protection for supported API endpoints.

Rate limiting helps reduce excessive requests and protects the API from abusive request patterns. The precise limits, time windows, and endpoint coverage should be read from the current implementation and documented here if they are important to reproduce the behavior.

### Worker concurrency

BullMQ workers process jobs asynchronously. Concurrency controls how many jobs a worker can process simultaneously.

Higher concurrency can increase throughput but can also increase pressure on SMTP services, Redis, and the database. Lower concurrency reduces simultaneous processing but may increase queue latency.

The actual concurrency value and any queue-level rate limits depend on the worker configuration. They should be documented using the values configured in the source code rather than assumed defaults.

### Failure handling

Jobs that encounter transient failures may be retried according to their configured retry policy. Failed and completed jobs can be inspected through Bull Board when the administrator has access.

A retry is not a guarantee of exactly-once email delivery: an SMTP operation can succeed even if a later status update fails. Delivery behavior should therefore be evaluated with this limitation in mind.

## Frontend Features

The frontend provides the user interface for interacting with the scheduling service.

Implemented areas include:

- Login through Google OAuth
- Campaign creation
- Recipient management and CSV import
- Campaign dashboard and status tables
- Scheduled and sent recipient status visibility
- Campaign progress monitoring
- Integration-related UI where configured

The frontend is built with React, Vite, and TypeScript.

## Backend Features

The backend provides:

- Express API endpoints
- Google OAuth and session-based authentication
- Campaign and recipient persistence through Prisma and PostgreSQL
- BullMQ queue integration
- Scheduled background email processing
- Rate limiting on supported endpoints
- Recipient and campaign status updates
- Slack integration support
- Elasticsearch integration support
- Protected Bull Board queue monitoring

The exact API routes and feature availability are determined by the current backend implementation.

## Email Delivery and Ethereal SMTP

Ethereal Email is used for test email delivery.

It allows test messages to be captured and inspected without sending them to actual recipient inboxes. This makes it suitable for demonstrating email scheduling and worker processing during development.

To configure it:

1. Create an Ethereal test account.
2. Copy its SMTP credentials into `ETHEREAL_USER` and `ETHEREAL_PASS`.
3. Restart the backend after updating the environment.
4. Create a test campaign and inspect the resulting message through Ethereal.

**Important:** A recipient marked `Sent` indicates that the configured delivery operation succeeded according to the application's processing logic. With Ethereal, this does not mean the email reached a real recipient's inbox.

## Optional Integrations

### Slack

Slack integration supports OAuth-based connection and configured notifications.

Configure the callback URL in the Slack application:

```text
http://localhost:4000/api/integrations/slack/callback
```

Provide the Slack client credentials, redirect settings, and encryption key in `backend/.env`.

### Elasticsearch

Elasticsearch can be configured for optional indexing and search.

Set `ELASTICSEARCH_URL` to the service endpoint and configure `ELASTICSEARCH_API_KEY` if the service requires API-key authentication.

Elasticsearch-dependent features require a reachable and appropriately configured service.

### Bull Board

Bull Board provides a dashboard for inspecting queue jobs.

Configure `BULL_BOARD_ADMIN_EMAILS` with a comma-separated list of authorized Google account email addresses. Only authorized users should be able to access the protected queue dashboard.

## Available Scripts

### Frontend scripts

Run from the project root:

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and build the frontend |
| `npm run lint` | Run the configured linter |
| `npm run preview` | Preview the production build |

### Backend scripts

Run from the `backend` directory, or use `npm --prefix backend run <script>` from the project root.

| Command | Description |
|---|---|
| `npm run dev` | Start the backend development server |
| `npm run build` | Compile TypeScript |
| `npm start` | Run the compiled backend |
| `npm run worker` | Start the standalone worker entry point |
| `npm run prisma:generate` | Generate Prisma Client |
| `npm run prisma:migrate` | Run the configured migration command |
| `npm run test` | Run the email pipeline test |
| `npm run test:pipeline` | Run the email pipeline test |
| `npm run test:campaigns` | Run campaign API tests |
| `npm run test:rate-limits` | Run rate-limiting tests |
| `npm run test:slack` | Run Slack integration tests |
| `npm run test:elasticsearch` | Run Elasticsearch integration tests |
| `npm run test:bull-board` | Run Bull Board access tests |
| `npm run smtp:verify` | Verify the configured SMTP connection |

The API entry point starts the configured in-process worker. The standalone worker script is a separate entry point; avoid running both against the same queue unintentionally.

## Testing

### Production builds

Run from the project root:

```bash
npm --prefix backend run build
npm run build
```

### Backend checks

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

The pipeline test depends on SMTP connectivity and can be affected by intermittent SMTP timeouts. Investigate connection failures and confirm worker behavior before treating a timeout as a code failure.

## Assumptions and Trade-offs

- **Ethereal instead of production SMTP:** Ethereal is used to demonstrate scheduling and message processing without sending real emails.
- **PostgreSQL and Redis have separate responsibilities:** PostgreSQL stores application records, while Redis stores queue state.
- **Queue-based scheduling:** BullMQ and Redis are used for delayed job execution rather than relying on an in-memory scheduler.
- **Optional integrations:** Slack and Elasticsearch require additional configuration and are not necessary for the basic local setup.
- **Worker execution:** The application entry point starts the configured in-process worker. A separate worker entry point is also available.
- **SMTP delivery limitations:** Test SMTP acceptance does not guarantee delivery to a real recipient.
- **Restart behavior:** Recovery depends on retaining the Redis queue data and PostgreSQL records.
- **Delivery semantics:** SMTP and database updates cannot be treated as one atomic operation; duplicate attempts can be possible in failure scenarios.

Document any additional shortcuts or deviations from the assignment requirements here if applicable.

## Troubleshooting

### PostgreSQL connection errors

- Run `docker compose ps` and verify that PostgreSQL is healthy.
- Check that `DATABASE_URL` matches the database credentials.
- Ensure port `5432` is available.
- Generate Prisma Client and apply migrations.

### Redis connection errors

- Confirm the Redis container is healthy.
- Verify `REDIS_HOST` and `REDIS_PORT`.
- Ensure port `6379` is available.
- Check the backend logs for queue connection errors.

### Google OAuth errors

- Verify the client ID and secret.
- Ensure the callback URL matches Google Cloud Console.
- Confirm that frontend and backend origins are configured correctly.

### SMTP errors

- Check the Ethereal username and password.
- Verify SMTP connectivity.
- Inspect backend logs and retry after a transient timeout.
- Check Ethereal's message preview for captured test messages.

### Bull Board shows no workers

- Inspect backend startup logs.
- Confirm that the worker has connected to Redis.
- Check that the worker and queue use the same Redis connection and queue configuration.
- Avoid running duplicate workers unintentionally.

### Slack or Elasticsearch errors

- Check that the relevant integration variables are configured.
- Verify callback URLs and credentials.
- Confirm that the external service is reachable.

## Security Notes

- Never commit `.env` or `backend/.env` files containing real credentials.
- Keep OAuth secrets, SMTP passwords, session secrets, encryption keys, and API keys private.
- Commit example environment files with placeholder values only.
- Use strong secrets and secure session-cookie settings in production.
- Restrict Bull Board access to authorized accounts.
- Do not use the local default database credentials in a production environment.

## License

Add the applicable license information here if the project is distributed under a license.
