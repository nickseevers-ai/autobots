// app/api/ops/execute-step/route.ts
// THE MISSING PIECE - Actually runs queued mission steps.
// Called by a Vercel cron job every 5 minutes.
// Picks up to 3 queued steps and executes them via the right worker.
//
// Step kinds → workers:
//   scrape_dre      → dre-scraper.js
//   research        → analyst.js
//   write_content   → content-marketer.js
//   analyze         → (future: generic analyzer)

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { executeScrapeDREStep } from '@/lib/workers/dre-scraper';
import { executeResearchStep } from '@/lib/workers/analyst';
import { executeWriteContentStep } from '@/lib/workers/content-marketer';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Step shape coming from Supabase
interface MissionStep {
  id: string;
  mission_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  step_order: number;
}

// Map step kinds to their worker functions
const STEP_WORKERS: Record<string, (step: MissionStep) => Promise<{ success: boolean; error?: string }>> = {
  scrape_dre: executeScrapeDREStep,
  research: executeResearchStep,
  write_content: executeWriteContentStep,
};

// Max steps to run per cron tick (keep under Vercel's 10s serverless limit)
const MAX_STEPS_PER_RUN = 1;

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const results = {
    executed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    steps: [] as { id: string; kind: string; outcome: string; error?: string }[],
  };

  try {
    console.log('[EXECUTE-STEP] Starting step execution run...');

    // Grab the next queued steps (oldest first)
    const { data: steps, error } = await supabase
      .from('ops_mission_steps')
      .select('*, ops_missions!inner(status, created_by)')
      .eq('status', 'queued')
      // Only run steps for approved missions
      .eq('ops_missions.status', 'approved')
      .order('created_at', { ascending: true })
      .limit(MAX_STEPS_PER_RUN);

    if (error) {
      console.error('[EXECUTE-STEP] Error fetching queued steps:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!steps || steps.length === 0) {
      console.log('[EXECUTE-STEP] No queued steps to run.');
      return NextResponse.json({ message: 'No queued steps', results });
    }

    console.log(`[EXECUTE-STEP] Found ${steps.length} queued step(s) to run.`);

    for (const step of steps) {
      const worker = STEP_WORKERS[step.kind];

      if (!worker) {
        console.log(`[EXECUTE-STEP] No worker for step kind: ${step.kind} (step ${step.id})`);
        results.skipped++;
        results.steps.push({ id: step.id, kind: step.kind, outcome: 'skipped_no_worker' });
        continue;
      }

      console.log(`[EXECUTE-STEP] Running ${step.kind} step ${step.id} for mission ${step.mission_id}`);

      try {
        const outcome = await worker(step);
        results.executed++;

        if (outcome.success) {
          results.succeeded++;
          results.steps.push({ id: step.id, kind: step.kind, outcome: 'success' });
        } else {
          results.failed++;
          results.steps.push({ id: step.id, kind: step.kind, outcome: 'failed', error: outcome.error });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[EXECUTE-STEP] Uncaught error in worker for step ${step.id}:`, err);
        results.failed++;
        results.steps.push({ id: step.id, kind: step.kind, outcome: 'error', error: errMsg });

        // Mark step as failed
        await supabase
          .from('ops_mission_steps')
          .update({
            status: 'failed',
            error_message: errMsg,
            completed_at: new Date().toISOString(),
          })
          .eq('id', step.id);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[EXECUTE-STEP] Done in ${duration}ms. Executed: ${results.executed}, Success: ${results.succeeded}, Failed: ${results.failed}`);

    // Log run to audit table
    await supabase.from('ops_action_runs').insert({
      action_type: 'execute_step',
      status: results.failed > 0 ? 'partial' : 'success',
      summary: results,
      duration_ms: duration,
    });

    return NextResponse.json({ success: true, results, duration_ms: duration });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[EXECUTE-STEP] Fatal error:', error);

    await supabase.from('ops_action_runs').insert({
      action_type: 'execute_step',
      status: 'failed',
      error_message: errMsg,
      duration_ms: Date.now() - startTime,
    });

    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
