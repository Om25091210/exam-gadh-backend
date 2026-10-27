# exam-gadh-backend

ExamGadh API: NestJS 11 (Node 22, TypeScript), Prisma 6, PostgreSQL 16. Modular monolith as approved in
`exam-gadh-docs/docs/architecture/ARCHITECTURE.pdf` (v0.1). Infrastructure lives in `exam-gadh-terraform`.

## What exists (milestone M2)
| Area | Endpoints | Notes |
|---|---|---|
| Health | `GET /health`, `GET /health/ready` | liveness / DB readiness |
| Auth | `POST /v1/auth/google`, `/refresh`, `/logout` | Google ID token only (no phone at launch). **One active session per user: a new login revokes all others** (`SESSION_REPLACED`). Refresh rotation + reuse detection. |
| Me | `GET/PATCH /v1/me` | profile, language, district, target exam, active entitlements |
| Content | `GET /v1/exams`, `/subjects`, `/notes`, `/notes/:id`, `/time` | paid notes enforce entitlements |
| Tests | `GET /v1/tests`, `POST /v1/tests/:id/attempts`, `PUT /v1/attempts/:id/answers`, `POST /v1/attempts/:id/submit`, `GET /v1/attempts/:id` | server-side timing, autosave, negative marking, resume, attempt limit, live-test window, no answer leakage before submit |
| Billing | `GET /v1/plans`, `POST /v1/billing/orders`, `/verify`, `/webhook`, `GET /v1/entitlements`, `POST /v1/coupons/redeem` | Razorpay only; server-side price; HMAC-verified verify + webhook, idempotent |

Not built yet (later milestones): admin API and import, current affairs, PYQ archive endpoints, analytics/leaderboard, doubts,
study planner, interview questions, notifications, live-test lobby / battle (WebSocket), Redis, account export/delete.

All errors share one shape: `{ "error": { "code", "message", "details?" } }`.

## Run locally
```bash
cp .env.example .env            # fill GOOGLE_CLIENT_IDS and a JWT_SECRET (>= 32 chars)
docker compose up -d db         # PostgreSQL on :5432
pnpm install
pnpm prisma migrate deploy
pnpm seed                       # 6 exams, subjects, plans, SAMPLE questions/tests (idempotent)
pnpm start:dev                  # http://localhost:3000, Swagger at /docs (non-production only)
```

## Test
Tests are integration tests against a real PostgreSQL (no DB mocks):
```bash
export DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/examgadh_test   # a throwaway database
pnpm test          # applies migrations to that database, then runs 49 tests
pnpm lint && pnpm typecheck && pnpm build
```
The suite truncates every table in `DATABASE_URL_TEST`; never point it at real data.

## Configuration (env)
See `.env.example`. In production the process refuses to start without `DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_IDS`,
`RAZORPAY_*` and `CORS_ORIGINS`. Secrets come from SSM Parameter Store / Secrets Manager on the server, never from git.
Parameter names under `/examgadh/<env>/`: `jwt_secret`, `razorpay_key_id`, `razorpay_key_secret`,
`razorpay_webhook_secret`, `google_client_ids`.

## Database
`prisma/schema.prisma` + committed migrations in `prisma/migrations`. Create a migration with
`pnpm prisma migrate dev --name <change>`; deploys run `prisma migrate deploy` before the new image starts.

## Contract for clients
`pnpm openapi` writes `openapi.json`; the frontend monorepo generates its typed client from it (CI uploads it as an artifact).

## Docker
`Dockerfile` builds a small arm64-friendly image (Graviton `t4g`). Not yet exercised end-to-end here: CI builds it on every PR.
