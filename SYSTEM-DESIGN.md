# Fragments — System Design

> **Interactive diagrams:** [Eraser whiteboard](https://app.eraser.io/workspace/GJ2443yFltnINMw2S76P?origin=share)
>
> ![System Architecture](System%20Architecture.png)
> *Figure 1 — Current architecture, bottlenecks, scaling strategy, cost reduction, and timeline*
>
> ![Suggested Enhancements](Suggests%20Enhancments.png)
> *Figure 2 — Caching layers, LLM failover, sandbox recovery, circuit breaker, CI/CD, observability, security, risks, and cost estimates*

---

## 1. Architecture Overview

Fragments is a Next.js 14 app on Vercel. Two-panel layout: chat on the left, code + live preview on the right. Users describe what they want, an LLM generates the code, and E2B runs it in an isolated sandbox.

### Services

| Service | What it does | How we talk to it |
|---------|-------------|-------------------|
| LLM Providers (Claude, GPT, Gemini, Mistral, Groq, etc.) | Generate code from prompts | SSE streaming — synchronous |
| E2B | Run generated code in containers (5 templates: Python, Next.js, Vue, Streamlit, Gradio) | REST — synchronous |
| Supabase | Auth (JWT) + Postgres (teams, user-team mapping) | REST |
| Upstash Redis | Rate limiting + short URL storage | REST |
| Morph API | Apply code patches to existing files | REST — synchronous |
| PostHog | Analytics, session replay | HTTP — async, non-blocking |

### API Endpoints

- `/api/chat` — streams structured JSON from the LLM (code + metadata). 300s timeout.
- `/api/morph-chat` — for editing existing code. LLM writes edit instructions, Morph applies the diff. 300s.
- `/api/sandbox` — creates E2B container, writes files, installs deps, runs code. 60s timeout.

### Communication Patterns

Right now everything is **synchronous** — REST calls or SSE streaming. No message queues, no WebSockets, no background workers. The chat route blocks until the LLM finishes streaming, then immediately fires a blocking call to create the sandbox. PostHog is the only async call.

I considered whether we'd need GraphQL, but with only 3 endpoints and Zod-validated structured responses, REST + SSE does the job. GraphQL would add client tooling overhead for no real benefit at this scale.

### What's missing

There's no conversation persistence. All state lives in `useState` — refresh the page and everything's gone. No conversation table, no fragment history. This is the first thing to fix for production.

---

## 2. Scalability & Performance

### The three bottlenecks I'd worry about

**Token blowup.** The app sends the full message history to the LLM on every request. No windowing, no trimming. Each assistant reply includes the complete generated source code. By turn 10, you're looking at 40-60K tokens per call. Cost grows quadratically. At 1K users doing 10 requests a day, that's roughly $24K/month just in LLM fees.

**Sandbox cold starts.** Every execution spins up a brand new E2B container — create, install deps, write files, run. 3 to 10 seconds of setup each time. No pooling, no reuse. We're billed per minute for that idle time.

**Serverless ceilings.** Chat route has a 300s hard limit, sandbox route 60s. A large `npm install` can exceed the sandbox timeout. And there's no background worker to resume anything that gets cut off.

### Day 1 plan — getting to 1K users

| What | Why |
|------|-----|
| Turn on Anthropic prompt caching | System prompt barely changes between calls. Caching it can cut up to 90% of those repeated tokens |
| Message windowing — last 5 turns + a summary | Drops per-request tokens from ~40K to ~10K |
| Warm sandbox pool — 10-20 pre-created per template | Grabs a ready container instead of creating one. Cold start drops from 5s to under a second |
| Tiered rate limits | Guests: keep IP-based (10/day). Logged-in users: limit by user_id, cap based on plan — Free 50/day, Pro 200/day, Enterprise custom |
| Persist conversations in Supabase | Users don't lose their work on page refresh |

Quick math: 1K users, 10 req/day each = 10K daily requests. Peak around 100 concurrent users, maybe 700 req/hour. With the optimizations above, budget lands around $8K/month.

### Evolving to 10K+

At 10K users the serverless model starts creaking. My approach:

- **Dedicated compute for sandbox orchestration** — move off Vercel functions to ECS or Fly.io. No more timeout ceiling.
- **Job queue** between the API layer and sandbox execution — SQS or Redis Streams. Gives backpressure and retry for free.
- **WebSockets** (Supabase Realtime) for sandbox status instead of the client waiting on a blocking HTTP call.
- **Smart model routing** — simple edit requests go to a cheaper, faster model. Full generation stays on Sonnet. Saves 40-50% on LLM costs.
- **Multi-region** — Vercel's edge already handles this for static assets. Add Supabase read replicas and pick the nearest E2B region.

Horizontal scaling for the API layer is essentially free since the routes are stateless.

### Caching — four layers

| Layer | What |
|-------|------|
| Browser | localStorage for preferences, React state for the conversation. Eventually IndexedDB for offline access |
| Edge | Vercel CDN for static assets |
| Redis | Rate limit counters, short URLs, and an LLM response cache (hash the prompt, return cached fragment if we've seen it before) |
| LLM provider | Anthropic's built-in prefix caching. The system prompt is identical across requests, so this kicks in automatically |

For the database, I'd add three tables to Supabase: `conversations` (user_id, messages as JSONB, created_at), `fragments` (conversation_id, code, template, version), and `execution_results` (fragment_id, result JSONB, sandbox_id). Index on `user_id + created_at`.

More moving parts, but it unlocks: resume after refresh, team sharing, usage analytics, cost tracking per user. Worth it.

---

## 3. Reliability & Fault Tolerance

### LLM failover

We already support multiple providers through the AI SDK, so the infrastructure for failover is mostly there. The chain:

1. **Claude Sonnet** (primary) — best code quality, supports prompt caching
2. **GPT-4** (fallback) — triggered on 5xx or if 30 seconds pass with no streaming tokens
3. **Gemini** (last resort) — if both above are down

A health check pings each provider every 60s and stores the status in Redis. Switching is automatic.

The trade-off here is output quality. Different models write different code. A fallback response might be worse. We deal with that by using the same system prompt everywhere, validating against the same Zod schema, and showing a subtle banner when the user is on a fallback provider.

### E2B sandbox recovery

1. Retry 3 times with exponential backoff (1s, 2s, 4s)
2. If all retries fail: show the generated code without a live preview. User can still copy it and run locally
3. If execution crashes mid-run: return whatever stdout was captured before the crash

Not ideal, but better than a blank error screen.

### Supabase outage

Session tokens are already cached client-side by the Supabase SDK, so existing users stay logged in. If the DB is unreachable, we skip the team lookup and assume the default tier. This means some free-tier users might temporarily bypass their limits. I'm okay with that — it's better than blocking everyone.

### Redis outage

Fall back to an in-memory rate limiter per serverless instance. It's not globally consistent — each instance counts separately, so throughput could spike to ~10x normal across all instances. But for a short outage, letting some extra requests through is much better than rejecting every user.

### Circuit breaker

Applied to LLM, E2B, and Morph API calls. Standard three-state pattern:

- **Closed** — normal operation, count failures
- **Open** — 5+ failures in 60s trips the circuit. Return fallback immediately, don't bother calling the failing service. Re-test after 30s
- **Half-open** — let one request through. If it works, close the circuit. If not, back to open

Straightforward to implement with a simple wrapper around our existing API calls.

---

## 4. Cost & Operational Efficiency

### LLM cost — the big one

LLM is 70%+ of the total bill. Here's what helps:

| Strategy | Impact | Effort |
|----------|--------|--------|
| Prompt caching | Up to 90% on the cached prefix | Low — it's an SDK flag |
| Message windowing | 60-70% fewer tokens per request | Medium |
| Model routing | 40-50% — cheap model for edits, expensive for generation | Medium |
| Response caching | 20-30% for repeated/similar queries | Medium |
| Hard token budget per team | Caps cost, prevents runaways | Low |

Without any of this: ~$0.08/request, ~$24K/month at 1K users.
With caching + windowing: ~$0.02/request, ~$6K/month. $18K saved. This is the first thing I'd ship.

### Observability

Three pillars:

**Logs** — structured JSON on every API route. Fields: request_id, user_id, latency_ms, tokens_used, provider, error. Pipe Vercel logs to Axiom or Datadog.

**Metrics** — LLM latency (p50/p95/p99), cost per request, sandbox creation time and failure rate, requests per second, active users. Grafana or Datadog for dashboards.

**Traces** — end-to-end distributed tracing: chat submit → rate limit check → LLM stream → sandbox creation → execution → response. OpenTelemetry + Jaeger.

Alert thresholds: LLM error rate > 5% for 5 min, sandbox failure > 10%, chat P95 > 30s, monthly LLM cost exceeding budget.

Currently the app has PostHog for frontend events but zero backend observability. That's a gap.

### CI/CD

```
PR → lint + test + build (parallel)
  → E2B template build (only if changed)
  → integration tests (mocked LLM)
  → Vercel preview deploy
  → Playwright E2E
  → merge → production auto-deploy
  → canary (5% traffic for 15 min)
  → full rollout or instant rollback
```

E2B templates deploy on a separate track: change detected → build with `-dev` suffix → test → promote to prod alias.

---

## 5. Security & Multi-Tenancy

### Data isolation

Five layers, each building on the one before:

| Layer | Implementation |
|-------|---------------|
| Authentication | Supabase Auth with JWT. Has to be mandatory — the current demo mode (no auth) can't exist in production. JWT carries user_id and team_id |
| Authorization | Postgres Row-Level Security. Users only read/write their own data. Team members share within team. Three roles: owner, admin, member |
| Resource isolation | Sandboxes tagged by team_id for usage billing. Rate limits per team. Monthly token budgets so one team can't blow the budget |
| Data protection | API keys encrypted at rest (or kept client-side only). Supabase encrypts by default. Sandbox code is ephemeral — gone in 10 minutes. Minimal PII: just email + team association |
| Network | CSP headers restrict iframe sources to *.e2b.app. CORS locked to our domain. JWT verified server-side on every request. E2B provides OS-level container isolation |

I thought about whether we'd need fully separate databases per organization. At this scale, no — shared DB with RLS is plenty for 10K users. If we land an enterprise client that demands physical isolation, we can revisit.

---

## 6. Estimation & Go-Live Plan

### Assumptions

- 1K users on day one, aiming for 10K by month 6
- 10 requests per user per day, 5 turns per conversation on average
- Peak concurrent: roughly 10% of total users
- US-East single region to start
- SLO targets: 99.5% uptime (~3.6h downtime budget/month), chat first-token P95 under 15s, sandbox creation P95 under 10s
- Shared infrastructure, logical isolation through RLS
- Conversation retention: 90 days. Sandboxes: 10 min (ephemeral)

### Roadmap

| Phase | When | Team | Focus |
|-------|------|------|-------|
| Foundation | Weeks 1-3 | 2 engineers | Mandatory auth, conversation persistence, structured logging, CI/CD with preview deploys, prompt caching |
| Reliability | Weeks 4-6 | 2 engineers | LLM failover, retries + circuit breakers, message windowing, per-user rate limits, Sentry |
| Scale prep | Weeks 7-9 | 3 engineers | Sandbox warm pool, WebSockets for status, cost dashboard, RLS policies, load testing at 1K concurrent |
| Launch | Week 10 | 3 engineers | Canary deploys, alerting rules, incident runbook, go live |
| Scale | Months 4-6 | 4 engineers | Multi-region, background job queue, model routing, enterprise features (SSO, dedicated sandboxes) |

### Top 3 risks

**E2B reliability at scale (HIGH).** We haven't tested what happens with 100 concurrent sandbox creates. It could be fine, or it could fall over. Plan: run a load test in week 1. If the numbers don't look good, evaluate CodeSandbox API or Fly.io machines as alternatives.

**LLM cost (HIGH).** Conversation length varies wildly. A single power user with 20-turn sessions costs more than 50 casual users. Plan: instrument token counting from day one so we have real data. Set hard budgets per team. Prompt caching isn't optional — it's table stakes.

**Context window limits (MEDIUM).** Long conversations will eventually hit the ceiling. The question is whether summarizing older turns degrades code generation quality. Plan: run a POC in week 2 — test windowing with 20-turn conversations and compare the output.

### Cost estimates

| Driver | 1K users/mo | 10K users/mo | Confidence |
|--------|-------------|--------------|------------|
| LLM API (optimized) | $6,000 | $45,000 | Low — depends heavily on usage patterns |
| E2B sandboxes | $2,000 | $15,000 | Medium — per-minute pricing is predictable |
| Vercel Pro | $20 | $150 | High |
| Supabase Pro | $25 | $75 | High |
| Upstash Redis | $10 | $50 | High |
| Monitoring (Axiom) | $50 | $200 | High |
| **Total** | **~$8,100** | **~$60,500** | |

The LLM line item dominates everything. Prompt caching + windowing alone cuts it from $24K to $6K. That's where I'd focus first.

---

## Trade-offs

| Choice | Reasoning | Downside | How we deal with it |
|--------|-----------|----------|---------------------|
| Stay on Vercel | Already deployed, auto-scales, zero ops overhead for Next.js | Can't run long processes | Add a queue service when we outgrow serverless |
| REST + SSE, not GraphQL | 3 endpoints with Zod-structured responses. GraphQL would add tooling and complexity for no practical gain | Less flexible if we add many client-facing queries | We're nowhere near that point |
| Supabase, not Firebase or Auth0 | Already integrated. Postgres gives us real SQL and RLS. Realtime is built in | Some vendor lock-in | SQL is portable. Auth is behind an abstraction |
| Keep it monolithic | 3 serverless routes handle 10K users. Splitting into microservices now would be premature | Tighter coupling | Clean module boundaries in /lib. Split later if a specific route bottlenecks |
| Ephemeral sandboxes, not persistent | Simpler, more secure, predictable cost. No state management or cleanup | Cold start latency on every execution | Warm pool solves this |
