# Agent System - Vercel Heartbeat Service

The heartbeat service for the multi-agent system. This Next.js application runs on Vercel and serves as the system's pulse, evaluating triggers, recovering stuck tasks, and maintaining overall system health.

## What it does

- **Trigger evaluation** - Checks enabled trigger rules and creates proposals when conditions are met (proactive agent tasks, failure detection, backlog monitoring)
- **Stale step recovery** - Detects mission steps stuck in "running" state for 30+ minutes and marks them as failed
- **Audit logging** - Records each heartbeat run to `ops_action_runs` for observability
- **Proposal pipeline** - All work flows through a single proposal service with daily quotas, cap gates, and optional auto-approve

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `CRON_SECRET` | Secret token to authenticate cron requests |

## Cron Schedule

The heartbeat runs every 5 minutes via Vercel Cron, configured in `vercel.json`:

```
*/5 * * * *  ->  GET /api/ops/heartbeat
```

Requests are authenticated with the `CRON_SECRET` via Bearer token in the Authorization header.

## Local Development

```bash
npm install
npm run dev
```

To test the heartbeat locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/ops/heartbeat
```

## Deployment

See the [main deployment guide](../README.md) for full setup instructions including Supabase schema, agent configuration, and Vercel deployment.
