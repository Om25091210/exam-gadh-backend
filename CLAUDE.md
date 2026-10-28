# exam-gadh-backend — project map for Claude

NestJS 11 + Prisma 6 + PostgreSQL 16 API for ExamGadh (CGPSC / Vyapam exam prep). Signed design:
`exam-gadh-docs/docs/architecture/ARCHITECTURE.pdf`. Engineering docs: `exam-gadh-docs/docs/*.md`
(REQUIREMENTS_CHECKLIST, GAP_REPORT, DECISIONS, BLOCKERS, PERMISSIONS).

## Commands
```
pnpm install                      # pnpm is pinned by package.json "packageManager"
pnpm prisma generate
pnpm lint && pnpm typecheck && pnpm build
pnpm test                         # integration tests need DATABASE_URL_TEST (a throwaway PostgreSQL); it is TRUNCATED
pnpm seed                         # idempotent sample data (DATABASE_URL)
pnpm openapi                      # writes openapi.json (client contract)
pnpm start:dev
```
Local DB for tests: `initdb`/`pg_ctl` or `docker compose up -d db`; then
`DATABASE_URL_TEST=postgresql://postgres@localhost:5433/examgadh_test pnpm test`.

## Layout
```
src/
  app.module.ts, main.ts, bootstrap.ts   shared pipeline (validation, filter, helmet, CORS, prefix /v1)
  config/            env loading + fail-fast validation
  common/            api-error, filter, clock (injectable time), rich-text (sanitiser)
  auth/ access/ users/ content/ billing/ health/    first-generation modules (service talks to Prisma)
  modules/<feature>/ newer modules: controller, service, (repository), schemas
    attempts/        test engine: start/resume, autosave, sections, submit, finalizer (auto-submit), results, leaderboard
    tests/           catalog + publishing (freeze versions)
    questions/       per-type bilingual schemas (zod), duplicate hashing
    settings/        runtime settings with defaults
prisma/schema.prisma, migrations/, seed.ts
test/                *.e2e-spec.ts (real DB), fixtures.ts, helpers.ts (FakeClock, fake Google, fake gateway)
```

## Rules that matter
- Scoring only on the server. Answer keys and explanations never leave the server before submit/result release
  (`publicQuestionView` strips them; tests assert it).
- Test versions are immutable once published (DB triggers + `publishTestVersion`). Attempts bind to a version and
  its frozen snapshot. Editing = `createDraftFromLatest` then publish.
- One final result per attempt: row lock + `AttemptResult` primary key. Never compute a result outside `AttemptFinalizer.finalize`.
- Time: use the injected `Clock`, never `new Date()` in engine code (tests move a fake clock).
- Errors: `ApiError(status, CODE, message)`; stable machine codes; clients switch on `error.code`.
- Students: Google sign-in only, one active session per user (newest login wins). No password/phone (DECISIONS D-001).
- Migrations: edit `schema.prisma`, generate SQL with `prisma migrate diff` (see docs/MIGRATIONS.md), add hand-written
  constraints at the end of the migration file, apply with `migrate deploy`. `prisma migrate dev/reset` is blocked for AI sessions.
