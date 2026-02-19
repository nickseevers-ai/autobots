'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Types ──────────────────────────────────────────────────────────────────
interface PipelineStats {
  total_brokers: number;
  pending_research: number;
  completed_research: number;
  emails_ready: number;
  emails_sent: number;
  failed_research: number;
}

interface Broker {
  id: string;
  license_number: string;
  name: string;
  city: string;
  county: string;
  license_type: string;
  research_status: string;
  outreach_status: string;
  scraped_at: string;
  website: string | null;
  email: string | null;
  estimated_team_size: string | null;
  research_notes: string | null;
}

interface OutreachEmail {
  id: string;
  broker_id: string | null;
  broker_name: string;
  city: string;
  county: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  broker_email: string | null; // joined from ca_brokers
}

interface AgentEvent {
  id: string;
  agent_id: string;
  kind: string;
  title: string;
  summary: string | null;
  created_at: string;
}

interface Mission {
  id: string;
  title: string;
  created_by: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': case 'ready': case 'active': return 'bg-green-100 text-green-700';
    case 'running': return 'bg-blue-100 text-blue-700';
    case 'pending': case 'approved': return 'bg-yellow-100 text-yellow-700';
    case 'failed': return 'bg-red-100 text-red-700';
    case 'sent': return 'bg-purple-100 text-purple-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function agentIcon(agentId: string): string {
  switch (agentId) {
    case 'prospector': return '🔍';
    case 'analyst': return '🧠';
    case 'content_marketer': return '✉️';
    case 'coordinator': return '🎯';
    case 'system': return '⚙️';
    default: return '🤖';
  }
}

// ── Stat Card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-1 shadow-sm">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</span>
      <span className={`text-3xl font-bold ${color ?? 'text-gray-900'}`}>{value}</span>
      {sub && <span className="text-xs text-gray-400">{sub}</span>}
    </div>
  );
}

// ── Email Modal ────────────────────────────────────────────────────────────
function EmailModal({ email, onClose }: { email: OutreachEmail; onClose: () => void }) {
  const mailtoHref = email.broker_email
    ? `mailto:${email.broker_email}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`
    : null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">{email.broker_name} · {email.city}, CA</p>
            <h3 className="font-semibold text-gray-900">{email.subject}</h3>
            {email.broker_email && (
              <p className="text-xs text-blue-600 mt-0.5">To: {email.broker_email}</p>
            )}
            {!email.broker_email && (
              <p className="text-xs text-amber-500 mt-0.5">⚠ No email found yet — run more research steps</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="p-6">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 leading-relaxed">{email.body}</pre>
        </div>
        <div className="p-4 border-t border-gray-100 flex gap-2 justify-between items-center">
          <div className="flex gap-2">
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(email.status)}`}>{email.status}</span>
            <span className="text-xs text-gray-400 py-1">{timeAgo(email.created_at)}</span>
          </div>
          <div className="flex gap-2">
            {mailtoHref ? (
              <a
                href={mailtoHref}
                className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1"
              >
                ✉ Open in Email Client
              </a>
            ) : (
              <button
                disabled
                className="text-xs bg-gray-200 text-gray-400 px-4 py-1.5 rounded-lg font-medium cursor-not-allowed flex items-center gap-1"
                title="No email address found for this broker yet"
              >
                ✉ No Address Yet
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pipeline Controls ──────────────────────────────────────────────────────
type TriggerStatus = 'idle' | 'running' | 'success' | 'error';

interface TriggerResult {
  status: TriggerStatus;
  message: string;
}

function PipelineControls({ onDone }: { onDone: () => void }) {
  const [heartbeat, setHeartbeat] = useState<TriggerResult>({ status: 'idle', message: '' });
  const [execute, setExecute] = useState<TriggerResult>({ status: 'idle', message: '' });

  async function runAction(action: 'heartbeat' | 'execute_step', setter: (r: TriggerResult) => void) {
    setter({ status: 'running', message: 'Running…' });
    try {
      const res = await fetch('/api/ops/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (res.ok) {
        const msg = action === 'heartbeat'
          ? `Done! Triggers evaluated: ${data.triggers?.evaluated ?? 0}, fired: ${data.triggers?.fired ?? 0}`
          : `Done! Steps executed: ${data.results?.executed ?? 0}, succeeded: ${data.results?.succeeded ?? 0}`;
        setter({ status: 'success', message: msg });
        setTimeout(onDone, 1500); // refresh dashboard data
      } else {
        setter({ status: 'error', message: data.error ?? 'Something went wrong' });
      }
    } catch (e: unknown) {
      setter({ status: 'error', message: e instanceof Error ? e.message : 'Network error' });
    }
  }

  function StatusBadge({ result }: { result: TriggerResult }) {
    if (result.status === 'idle') return null;
    const colors = {
      running: 'bg-blue-50 text-blue-700 border-blue-200',
      success: 'bg-green-50 text-green-700 border-green-200',
      error: 'bg-red-50 text-red-700 border-red-200',
    };
    return (
      <p className={`text-xs px-3 py-1.5 rounded-lg border mt-2 ${colors[result.status]}`}>
        {result.status === 'running' && <span className="inline-block animate-spin mr-1">⟳</span>}
        {result.message}
      </p>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <h2 className="font-semibold text-gray-700 text-sm mb-4 flex items-center gap-2">
        <span>⚡</span> Pipeline Controls
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Scrape DRE Brokers */}
        <div className="border border-gray-100 rounded-xl p-4 bg-gray-50">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🔍</span>
            <span className="font-semibold text-sm text-gray-800">Scrape DRE Brokers</span>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Runs the heartbeat which checks all triggers — including the DRE scraper. Kicks off a new batch of CA broker leads.
          </p>
          <button
            disabled={heartbeat.status === 'running'}
            onClick={() => runAction('heartbeat', setHeartbeat)}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {heartbeat.status === 'running' ? '⟳ Running…' : '▶ Run Heartbeat'}
          </button>
          <StatusBadge result={heartbeat} />
        </div>

        {/* Execute Next Step */}
        <div className="border border-gray-100 rounded-xl p-4 bg-gray-50">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">⚙️</span>
            <span className="font-semibold text-sm text-gray-800">Execute Next Step</span>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Picks up the next queued mission step and runs it — research, email writing, or DRE scraping.
          </p>
          <button
            disabled={execute.status === 'running'}
            onClick={() => runAction('execute_step', setExecute)}
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {execute.status === 'running' ? '⟳ Running…' : '▶ Execute Step'}
          </button>
          <StatusBadge result={execute} />
        </div>

      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [emails, setEmails] = useState<OutreachEmail[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<OutreachEmail | null>(null);
  const [activeTab, setActiveTab] = useState<'brokers' | 'emails' | 'missions'>('brokers');
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    try {
      // Pipeline stats via view
      const { data: statsData } = await supabase
        .from('v_broker_pipeline')
        .select('*')
        .single();
      if (statsData) setStats(statsData as PipelineStats);

      // Recent brokers
      const { data: brokersData } = await supabase
        .from('ca_brokers')
        .select('id, license_number, name, city, county, license_type, research_status, outreach_status, scraped_at, website, email, estimated_team_size, research_notes')
        .order('scraped_at', { ascending: false })
        .limit(50);
      if (brokersData) setBrokers(brokersData as Broker[]);

      // Ready emails - join broker email from ca_brokers
      const { data: emailsData } = await supabase
        .from('ops_outreach_emails')
        .select('id, broker_id, broker_name, city, county, subject, body, status, created_at, ca_brokers(email)')
        .order('created_at', { ascending: false })
        .limit(30);
      if (emailsData) {
        const mapped = emailsData.map((e: Record<string, unknown>) => ({
          ...e,
          broker_email: (e.ca_brokers as { email?: string } | null)?.email ?? null,
        }));
        setEmails(mapped as OutreachEmail[]);
      }

      // Recent agent events
      const { data: eventsData } = await supabase
        .from('ops_agent_events')
        .select('id, agent_id, kind, title, summary, created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (eventsData) setEvents(eventsData as AgentEvent[]);

      // Recent missions
      const { data: missionsData } = await supabase
        .from('ops_missions')
        .select('id, title, created_by, status, created_at, completed_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (missionsData) setMissions(missionsData as Mission[]);

      setLastRefresh(new Date());
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-pulse">🤖</div>
          <p className="text-gray-500 text-sm">Loading pipeline...</p>
        </div>
      </div>
    );
  }

  const pipelinePercent = stats && stats.total_brokers > 0
    ? Math.round((stats.emails_ready + stats.emails_sent) / stats.total_brokers * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">RC</div>
            <div>
              <h1 className="font-semibold text-gray-900">RealComply Autobots</h1>
              <p className="text-xs text-gray-500">CA Broker Lead Pipeline</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">Refreshed {timeAgo(lastRefresh.toISOString())}</span>
            <button
              onClick={fetchData}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg transition-colors"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard label="Total Brokers" value={stats?.total_brokers ?? 0} />
          <StatCard label="Pending Research" value={stats?.pending_research ?? 0} color="text-yellow-600" />
          <StatCard label="Researched" value={stats?.completed_research ?? 0} color="text-blue-600" />
          <StatCard label="Emails Ready" value={stats?.emails_ready ?? 0} color="text-green-600" sub="ready to send" />
          <StatCard label="Emails Sent" value={stats?.emails_sent ?? 0} color="text-purple-600" />
          <StatCard label="Pipeline" value={`${pipelinePercent}%`} color="text-blue-700" sub="brokers with emails" />
        </div>

        {/* Pipeline Controls */}
        <PipelineControls onDone={fetchData} />

        {/* Pipeline progress bar */}
        {(stats?.total_brokers ?? 0) > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-700 text-sm">Pipeline Progress</h2>
              <span className="text-xs text-gray-500">{stats?.total_brokers} brokers total</span>
            </div>
            <div className="flex gap-1 h-4 rounded-full overflow-hidden bg-gray-100">
              {(stats?.emails_sent ?? 0) > 0 && (
                <div className="bg-purple-500 transition-all" style={{ width: `${(stats!.emails_sent / stats!.total_brokers) * 100}%` }} title="Sent" />
              )}
              {(stats?.emails_ready ?? 0) > 0 && (
                <div className="bg-green-500 transition-all" style={{ width: `${(stats!.emails_ready / stats!.total_brokers) * 100}%` }} title="Ready" />
              )}
              {(stats?.completed_research ?? 0) > 0 && (
                <div className="bg-blue-400 transition-all" style={{ width: `${(stats!.completed_research / stats!.total_brokers) * 100}%` }} title="Researched" />
              )}
              {(stats?.pending_research ?? 0) > 0 && (
                <div className="bg-yellow-300 transition-all" style={{ width: `${(stats!.pending_research / stats!.total_brokers) * 100}%` }} title="Pending" />
              )}
            </div>
            <div className="flex gap-4 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-300 inline-block" /> Pending</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Researched</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Email Ready</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> Sent</span>
            </div>
          </div>
        )}

        {/* Two column layout: main content + activity feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left: tabbed main content */}
          <div className="lg:col-span-2 space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 shadow-sm w-fit">
              {(['brokers', 'emails', 'missions'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
                    activeTab === tab ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab === 'brokers' && `Brokers (${brokers.length})`}
                  {tab === 'emails' && `Emails (${emails.length})`}
                  {tab === 'missions' && `Missions (${missions.length})`}
                </button>
              ))}
            </div>

            {/* Brokers tab */}
            {activeTab === 'brokers' && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {brokers.length === 0 ? (
                  <div className="p-12 text-center text-gray-400">
                    <p className="text-3xl mb-3">🔍</p>
                    <p className="font-medium">No brokers scraped yet</p>
                    <p className="text-sm mt-1">The DRE scraper will populate this automatically</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 bg-gray-50">
                          <th className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase">Name</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase">Location</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase hidden md:table-cell">Contact</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase">Research</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-500 text-xs uppercase">Outreach</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {brokers.map(b => (
                          <tr key={b.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900">{b.name}</div>
                              <div className="text-xs text-gray-400">{b.license_number}</div>
                              {b.website && (
                                <a href={b.website.startsWith('http') ? b.website : `https://${b.website}`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline truncate block max-w-[160px]">
                                  🌐 {b.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                </a>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-600">
                              <div>{b.city}</div>
                              <div className="text-xs text-gray-400">{b.county} Co.</div>
                            </td>
                            <td className="px-4 py-3 hidden md:table-cell">
                              {b.email ? (
                                <a href={`mailto:${b.email}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                                  <span>✉</span>
                                  <span className="truncate max-w-[140px]">{b.email}</span>
                                </a>
                              ) : (
                                <span className="text-xs text-gray-300">{b.research_status === 'completed' ? 'Not found' : '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(b.research_status)}`}>
                                {b.research_status}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(b.outreach_status)}`}>
                                {b.outreach_status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Emails tab */}
            {activeTab === 'emails' && (
              <div className="space-y-3">
                {emails.length === 0 ? (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center text-gray-400">
                    <p className="text-3xl mb-3">✉️</p>
                    <p className="font-medium">No emails written yet</p>
                    <p className="text-sm mt-1">Emails appear here once brokers are researched</p>
                  </div>
                ) : (
                  emails.map(email => (
                    <div
                      key={email.id}
                      className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 hover:border-blue-300 cursor-pointer transition-colors"
                      onClick={() => setSelectedEmail(email)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-gray-900 text-sm truncate">{email.broker_name}</span>
                            <span className="text-xs text-gray-400 shrink-0">{email.city}, CA</span>
                          </div>
                          <p className="text-sm text-gray-700 font-medium truncate">{email.subject}</p>
                          {email.broker_email ? (
                            <p className="text-xs text-blue-500 mt-0.5 truncate">To: {email.broker_email}</p>
                          ) : (
                            <p className="text-xs text-amber-400 mt-0.5">No email address yet</p>
                          )}
                          <p className="text-xs text-gray-400 mt-1 line-clamp-1">
                            {email.body.split('\n').find(l => l.trim().length > 10) ?? ''}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(email.status)}`}>{email.status}</span>
                          <span className="text-xs text-gray-400">{timeAgo(email.created_at)}</span>
                          {email.broker_email && (
                            <a
                              href={`mailto:${email.broker_email}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}
                              onClick={e => e.stopPropagation()}
                              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded font-medium mt-1"
                            >
                              Send ✉
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Missions tab */}
            {activeTab === 'missions' && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {missions.length === 0 ? (
                  <div className="p-12 text-center text-gray-400">
                    <p className="text-3xl mb-3">🎯</p>
                    <p className="font-medium">No missions yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {missions.map(m => (
                      <div key={m.id} className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-lg">{agentIcon(m.created_by)}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{m.title}</p>
                            <p className="text-xs text-gray-400">{m.created_by} · {timeAgo(m.created_at)}</p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${statusColor(m.status)}`}>{m.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Activity feed */}
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-700 text-sm px-1">Agent Activity</h2>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {events.length === 0 ? (
                <div className="p-8 text-center text-gray-400">
                  <p className="text-2xl mb-2">⚡</p>
                  <p className="text-sm">No activity yet</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50 max-h-[600px] overflow-y-auto">
                  {events.map(e => (
                    <div key={e.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <span className="text-base mt-0.5 shrink-0">{agentIcon(e.agent_id)}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-gray-800 leading-snug">{e.title}</p>
                          {e.summary && (
                            <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{e.summary}</p>
                          )}
                          <p className="text-xs text-gray-300 mt-1">{timeAgo(e.created_at)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Agent status cards */}
            <h2 className="font-semibold text-gray-700 text-sm px-1 pt-2">Agents</h2>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: 'prospector', label: 'Prospector', desc: 'DRE scraping' },
                { id: 'analyst', label: 'Analyst', desc: 'Broker research' },
                { id: 'content_marketer', label: 'Marketer', desc: 'Email writing' },
                { id: 'coordinator', label: 'Coordinator', desc: 'Planning' },
              ].map(agent => {
                const lastEvent = events.find(e => e.agent_id === agent.id);
                return (
                  <div key={agent.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span>{agentIcon(agent.id)}</span>
                      <span className="text-xs font-semibold text-gray-700">{agent.label}</span>
                    </div>
                    <p className="text-xs text-gray-400">{agent.desc}</p>
                    {lastEvent ? (
                      <p className="text-xs text-gray-300 mt-1">{timeAgo(lastEvent.created_at)}</p>
                    ) : (
                      <p className="text-xs text-gray-300 mt-1">No activity</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>

      {/* Email modal */}
      {selectedEmail && (
        <EmailModal email={selectedEmail} onClose={() => setSelectedEmail(null)} />
      )}
    </div>
  );
}
