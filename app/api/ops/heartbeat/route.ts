import { runHeartbeat } from '@/lib/heartbeat.js';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runHeartbeat();
  return Response.json(result);
}
