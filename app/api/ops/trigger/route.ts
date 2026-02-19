// app/api/ops/trigger/route.ts
// Dashboard-facing proxy so the CRON_SECRET never leaves the server.
// POST { action: 'heartbeat' | 'execute_step' }

import { NextRequest, NextResponse } from 'next/server';

const BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const SECRET = process.env.CRON_SECRET!;

export async function POST(req: NextRequest) {
  const { action } = await req.json();

  const endpoint =
    action === 'heartbeat'
      ? `${BASE}/api/ops/heartbeat`
      : `${BASE}/api/ops/execute-step`;

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
