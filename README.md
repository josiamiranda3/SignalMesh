# SIGNALMESH

**Research & Evidence Intelligence Platform**

> **Version 0.2.4.3.** SignalMesh is deployed at [https://signalmess.app.space](https://signalmess.app.space).
> Production runs as a Cloudflare Worker using DeepSpace Auth and DeepSpace Records.
> The Node.js + SQLite runtime remains available for local development and automated tests.
> The interface supports English (default) and Brazilian Portuguese.

SignalMesh turns scattered information into organized, analyzed, and human-validated evidence.
It is not a chatbot: it is a research workspace where relevant conclusions remain linked to the
sources that support them, while decisions about evidence remain human, recorded, and auditable.

---

## Live application

- **Production:** [https://signalmess.app.space](https://signalmess.app.space)
- **Repository:** [https://github.com/josiamiranda3/SignalMesh](https://github.com/josiamiranda3/SignalMesh)

## What the product does

A researcher defines a **topic** and an **objective**. SignalMesh then:

1. Builds a search query and retrieves external sources through **Exa**.
2. Lets the researcher select results and store them as **evidence**, preserving URL,
   excerpt, retrieved content when available, and prioritization metadata.
3. Sends the selected evidence to **Google Gemini** for a structured analysis containing
   an executive summary, findings with references, contradictions, limitations, gaps, and
   alignment with the investigation objective.
4. Validates the model output against the actual evidence set before accepting it.
5. Records a **human decision** for each evidence item (approved, rejected, or under review),
   including justification and a history of changes.
6. Maintains an **audit trail** of operations.
7. Exports investigation data as JSON and CSV while preserving relationships.

## Core principle

> Every relevant conclusion must be traceable to the sources that support it.

This principle is enforced by the application. Before an analysis is accepted, the server checks
that every cited `evidenceId` belongs to the evidence set actually provided to the model.
A reference that does not exist in that set invalidates the analysis. The invalid result is
recorded as failed rather than presented as a valid conclusion.

AI organizes and compares evidence; it does not establish truth. Approving an evidence item
means that a person considers it suitable for a particular investigation. It does not certify
that the source is scientifically, legally, or universally true.

## Main capabilities

### Investigations
Create, list, edit, archive, and delete investigations. Search by title, topic, or objective;
filter by status and sort results. The objective is required and remains central to search,
analysis, and source-alignment scoring.

Statuses: `draft`, `active`, `completed`, and `archived`.

### External research (Exa)
The backend calls `POST https://api.exa.ai/search` using a server-side API key. Queries combine
the topic, keywords, and investigation objective, with an optional user override. Results expose
title, URL, domain, excerpt, date, author, retrieved content, and whether full content was
actually available. The interface communicates content availability instead of implying that
every result includes full text. Automatic retries are not performed.

### Evidence management
Evidence records preserve provenance. URL normalization removes tracking parameters such as
`utm_*` and `gclid`, fragments, and trailing slashes for duplicate detection. Evidence can
include researcher notes and a prioritization score with component-level explanations.

### AI-assisted analysis (Google Gemini)
The application requests structured output through `responseSchema`, validates it against its
own schema, and checks every cited evidence ID against the actual input set. Source content is
treated as untrusted data.

### Human validation
A researcher can approve, reject, or request review of an evidence item. Rejection and review
require a justification. Each change creates a new event with the previous status; the history
is not silently overwritten.

### Dashboard, history, and exports
Dashboard indicators are derived from persisted records. Audit history can be consulted by
investigation and globally. JSON and CSV exports preserve entity relationships and scope.

### Cost and usage safeguards
The application implements per-user and global daily limits, duplicate-request protection,
and explicit switches for external and paid operations. Production limits and switches are
described in [docs/deployment.md](docs/deployment.md).

## Architecture

```text
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ PRODUCTION — Cloudflare Worker   │   │ LOCAL / TEST — Node.js            │
│ worker.ts                        │   │ server/dev.ts                     │
│  - DeepSpace Auth (JWT verify)    │   │  - local session                  │
│  - DeepSpace Records (DO)         │   │  - SQLite (node:sqlite)           │
└─────────────────┬────────────────┘   └─────────────────┬────────────────┘
                  │                                      │
                  └──────────────► server/app.ts ◄────────┘
                                  Hono application
                                         │
                              server/services/index.ts
                                  business services
                                         │
                           server/repositories/ports.ts
                              repository interfaces
```

Both persistence adapters implement the same repository interfaces. Automated tests exercise
the Node/SQLite path and the Records adapter contract. Production behavior is separately
described in [docs/production-validation.md](docs/production-validation.md).

## Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24.x / Cloudflare Workers |
| Frontend | React 19.3.1 |
| Build | Vite 8.3.8 |
| Styling | Tailwind CSS 4.3.5 |
| Routing | react-router-dom 7.18.6 |
| Backend | Hono 4.13.19 |
| Platform SDK / CLI | DeepSpace 0.44.2 |
| Deployment tooling | Wrangler 4.79.0 |
| Validation | Zod 4.6.7 |
| Local database | SQLite via `node:sqlite` |
| Language | TypeScript 5.9.3 |
| Tests | Node.js test runner |

## Repository structure

```text
.
├── worker.ts
├── wrangler.toml
├── vite.config.ts
├── shared/                 # shared client/server contracts and schemas
├── src/                    # React application, pages, components, hooks and styles
├── server/
│   ├── app.ts               # platform-neutral Hono application
│   ├── dev.ts               # local Node runtime
│   ├── services/            # business services and runtime composition
│   ├── repositories/        # repository ports and adapters
│   ├── integrations/        # Exa and Gemini integrations
│   └── migration/           # SQLite-to-Records migration support
├── scripts/
└── docs/                    # architecture, security, testing and operations
```

## Requirements

- Node.js `>=22.15.0 <23`, `>=24 <25`, or `>=26 <27`.
- npm `>=11.6.0`.
- Chrome or Edge for browser-based test suites (set `CHROME_PATH` if needed).

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file for local development:

```bash
cp .env.example .env
```

### Production secrets

The Exa and Gemini API keys are server-side secrets. They must be configured in the deployment
platform's secret store and must never be committed to the repository, embedded in frontend
code, or pasted into issue reports.

Secret names:

- `EXA_API_KEY`
- `GEMINI_API_KEY`

Do not put secret values in `wrangler.toml`. See
[docs/api-integrations.md](docs/api-integrations.md) and
[docs/deployment.md](docs/deployment.md).

### Local runtime

The Node runtime uses `.env`. Important variables include:

| Variable | Purpose |
|---|---|
| `PORT` | Local API port |
| `APP_ORIGIN` | Origin used for cookies and CSRF validation |
| `DATABASE_URL` | SQLite database path |
| `SESSION_SECRET` | Local session signing secret |
| `ENABLE_EXTERNAL_APIS` | Enables external provider calls |
| `ENABLE_PAID_OPERATIONS` | Explicit paid-operation gate |
| `EXA_API_KEY` | Exa key, server-side only |
| `GEMINI_API_KEY` | Gemini key, server-side only |
| `RESEARCH_DAILY_LIMIT` | Per-user daily research limit |
| `ANALYSIS_DAILY_LIMIT` | Per-user daily analysis limit |

Use the example file as the source of truth for the complete local environment-variable list.

## Local development

### Node API

```bash
npm run dev
```

### Frontend with Vite

```bash
npm run dev:web
```

### Build and preview

```bash
npm run build
npm run preview
```

The local Node/SQLite runtime is intended for development and tests. It is not the production
authentication or persistence implementation.

## Tests and verification

Useful commands:

```bash
npm run typecheck
npm run lint
npm run test
npm run test:e2e
npm run test:flows
npm run audit:design
npm run test:worker
npm run verify
```

The repository contains unit, integration, Worker-contract, browser-flow, and design checks.
Test counts are version- and working-tree-dependent; consult the latest CI or execution log
rather than treating historical counts in older reports as current results.

A local Windows `workerd`/Miniflare runtime failure was observed during development. This is
distinct from the production deployment and is documented in the operational notes. Do not
interpret a local runtime limitation as proof that the deployed Worker is unavailable.

## Exa integration

- Endpoint: `POST https://api.exa.ai/search`
- Authentication: `x-api-key` request header.
- The backend maps provider errors, timeouts, invalid JSON, and rate limits.
- The application does not perform automatic retries.

See [docs/api-integrations.md](docs/api-integrations.md).

## Google Gemini integration

- Uses the Gemini `generateContent` API.
- Requests structured JSON output with a response schema.
- Default configured model: `gemini-2.5-flash`.
- Revalidates the response schema and all evidence references before persistence.

## Persistence

| Runtime | Storage |
|---|---|
| Production Worker | DeepSpace Records backed by a Durable Object |
| Local Node runtime | SQLite via `node:sqlite` |

The application enforces owner isolation in service logic and through the Records permissions
model. See [docs/database.md](docs/database.md).

## Authentication

| Runtime | Authentication |
|---|---|
| Production Worker | DeepSpace Auth; JWT verification is performed by the platform integration |
| Local Node runtime | Local session implementation for development and tests |

The production application does not use the local Node login path. See
[docs/security.md](docs/security.md).

## Security principles

- Authorization is checked server-side.
- Records are scoped to their owner.
- Mutating requests use origin/CSRF protections.
- Provider credentials remain server-side.
- Source content is treated as untrusted input, including in model prompts.
- Logs must not contain credentials, access tokens, or unnecessary request bodies.
- User exports must not include credentials, tokens, or another user's records.

## Export formats

- **JSON:** metadata, investigation, evidence, analyses, validations, and activity.
- **CSV:** UTF-8 with BOM and record-type identification.
- Export scopes include full investigation, evidence, analyses, validations, and history.

## Known limitations and scope

- SignalMesh is designed around owner-scoped investigations; multi-user collaboration and
  shared workspaces are not presented as implemented features.
- Full source text depends on what the external provider returns.
- AI-generated analysis is decision support, not an independent verification of truth.
- Production persistence and real provider workflows are documented in the production
  validation record. A specific concurrency guarantee should only be claimed when supported
  by a production concurrency test.
- Local development tooling may behave differently from the deployed Worker environment.

## Deployment status

**Production is published:** [https://signalmess.app.space](https://signalmess.app.space).

The production workflow has been manually exercised with real Exa research and Gemini analysis.
The reported validation details, usage figures, and scope of the checks are recorded in
[docs/production-validation.md](docs/production-validation.md).

Deployment instructions, configuration, safeguards, and operational cautions are in
[docs/deployment.md](docs/deployment.md). The historical v0.2.4.3 audit remains available at
[docs/audit-integrada-v0.2.4.3.md](docs/audit-integrada-v0.2.4.3.md).

## Documentation

| Document | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Runtime architecture, layers, identity, and isolation |
| [docs/database.md](docs/database.md) | Collections, persistence constraints, and migration |
| [docs/security.md](docs/security.md) | Authentication, authorization, secrets, and threat model |
| [docs/api-integrations.md](docs/api-integrations.md) | Exa and Gemini endpoints, payloads, errors, and costs |
| [docs/testing.md](docs/testing.md) | Test strategy, suites, and known limitations |
| [docs/decisions.md](docs/decisions.md) | Architectural decisions and rejected alternatives |
| [docs/deployment.md](docs/deployment.md) | Production deployment status and operating procedure |
| [docs/production-validation.md](docs/production-validation.md) | Manual production validation record |
| [docs/changes-fechamento.md](docs/changes-fechamento.md) | Quota reservation design and validation limits |
| [docs/audit-integrada-v0.2.4.3.md](docs/audit-integrada-v0.2.4.3.md) | Historical v0.2.4.3 audit report |

## License

Private project. All rights reserved by the owner.
