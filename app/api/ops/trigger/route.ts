// app/api/ops/trigger/route.ts
// Dashboard-facing proxy so the CRON_SECRET never leaves the server.
// POST { action: 'heartbeat' | 'execute_step' }

import { NextRequest, NextResponse } from 'next/server';

const BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const SECRET = process.env.CRON_SECRET!;

export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();

    const endpoint =
      action === 'heartbeat'
        ? `${BASE}/api/ops/heartbeat`
        : `${BASE}/api/ops/execute-step`;

    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    // Safe JSON parse — some error responses may not be JSON
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text || 'Empty response from endpoint' };
    }

    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
