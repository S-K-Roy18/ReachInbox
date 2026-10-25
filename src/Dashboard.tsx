import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { API_BASE_URL } from './config';

const API = API_BASE_URL;

type View = 'overview' | 'campaigns' | 'create' | 'details' | 'search' | 'integrations';
type RecipientStatus = 'PENDING' | 'QUEUED' | 'SENT' | 'FAILED';

interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface RecipientCounts {
  PENDING: number;
  QUEUED: number;
  SENT: number;
  FAILED: number;
}

interface Campaign {
  id: number;
  subject: string;
  startTime: string;
  delayBetweenEmails: number;
  hourlyLimit: number | null;
  status: string;
  createdAt: string;
  recipientCount: number;
  recipientCounts: RecipientCounts;
}

interface CampaignDetails {
  id: number;
  subject: string;
  body: string;
  startTime: string;
  delayBetweenEmails: number;
  hourlyLimit: number | null;
  status: string;
  createdAt: string;
  recipients: Array<{
    id: number;
    email: string;
    status: RecipientStatus;
    scheduledTime: string | null;
    sentTime: string | null;
    attemptCount: number;
    lastError: string | null;
  }>;
}

interface SearchPage<T> {
  total: number;
  page: number;
  pageSize: number;
  results: T[];
}

interface SlackStatus {
  connected: boolean;
  teamId: string | null;
  connectedAt: string | null;
}

interface ParsedEmails {
  valid: string[];
  invalid: string[];
  duplicateCount: number;
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : `Request failed (${response.status}).`);
  }
  return result as T;
}

function parseEmails(source: string): ParsedEmails {
  const input = source.replace(/^\uFEFF/, '').trim();
  const lines = input.split(/\r?\n/).filter((line) => line.trim());
  const firstLine = lines[0] ?? '';
  const delimiters = [',', ';', '\t'];
  const delimiter = delimiters
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length - 1 }))
    .sort((first, second) => second.count - first.count)[0];
  const isDelimited = delimiter.count > 0;
  const splitRow = (line: string) => {
    if (!isDelimited) return line.split(/[\s,;]+/);
    const values: string[] = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === '"' && line[index + 1] === '"' && quoted) { value += '"'; index++; }
      else if (character === '"') quoted = !quoted;
      else if (character === delimiter.candidate && !quoted) { values.push(value.trim()); value = ''; }
      else value += character;
    }
    values.push(value.trim());
    return values;
  };
  const rows = lines.map(splitRow);
  const header = rows[0]?.map((value) => value.trim().toLowerCase()) ?? [];
  const emailColumn = header.findIndex((value) => ['email', 'emails', 'e-mail', 'email address', 'email_address'].includes(value));
  const hasHeader = emailColumn >= 0;
  const candidates = rows.flatMap((row, rowIndex) => {
    if (hasHeader) return rowIndex === 0 ? [] : [row[emailColumn] ?? ''];
    return row;
  }).flatMap((value) => isDelimited ? [value] : value.split(/\s+/));
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const candidate of candidates) {
    const token = candidate.trim().replace(/^['"]|['"]$/g, '');
    if (!token || /^(emails?|e-mail|email address|email_address)$/i.test(token)) continue;
    const normalized = token.toLowerCase();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(normalized)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(normalized)) {
      duplicateCount++;
      continue;
    }
    seen.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid, duplicateCount };
}

function formatDate(value: string | null | undefined, includeTime = true): string {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    campaigns: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></>,
    create: <><path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="9"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    integrations: <><path d="M8 7V4m8 3V4M7 12h10M8 20v-3m8 3v-3"/><rect x="4" y="7" width="16" height="10" rx="3"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    back: <><path d="M19 12H5m6 6-6-6 6-6"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7" r="4"/><path d="M20 20v-1.5a4 4 0 0 0-3-3.87M16 3.2a4 4 0 0 1 0 7.6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    alert: <><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3l-7.5-13.1a2 2 0 0 0-3.4 0Z"/></>,
    slack: <><path d="M9.5 3a2 2 0 1 0 0 4h2V5a2 2 0 0 0-2-2ZM14.5 3a2 2 0 1 0 0 4h2V5a2 2 0 0 0-2-2ZM21 9.5a2 2 0 1 0-4 0v2h2a2 2 0 0 0 2-2ZM21 14.5a2 2 0 1 0-4 0v2h2a2 2 0 0 0 2-2ZM14.5 21a2 2 0 1 0 0-4h-2v2a2 2 0 0 0 2 2ZM9.5 21a2 2 0 1 0 0-4h-2v2a2 2 0 0 0 2 2ZM3 14.5a2 2 0 1 0 4 0v-2H5a2 2 0 0 0-2 2ZM3 9.5a2 2 0 1 0 4 0v-2H5a2 2 0 0 0-2 2Z"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  };
  return <svg {...common}>{paths[name] ?? paths.overview}</svg>;
}

function StatusPill({ status }: { status: string }) {
  const className = `status-pill status-${status.toLowerCase()}`;
  return <span className={className}><span className="status-dot" />{statusLabel(status)}</span>;
}

function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignError, setCampaignError] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [details, setDetails] = useState<CampaignDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [searchTab, setSearchTab] = useState<'campaigns' | 'recipients'>('campaigns');
  const [campaignResults, setCampaignResults] = useState<SearchPage<Record<string, unknown>> | null>(null);
  const [recipientResults, setRecipientResults] = useState<SearchPage<Record<string, unknown>> | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [slackLoading, setSlackLoading] = useState(true);
  const [queueDashboardAuthorized, setQueueDashboardAuthorized] = useState(false);
  const [form, setForm] = useState({ subject: '', body: '', startTime: '', delayBetweenEmails: '0', hourlyLimit: '' });
  const [emailSource, setEmailSource] = useState('');
  const [importSummary, setImportSummary] = useState<ParsedEmails>({ valid: [], invalid: [], duplicateCount: 0 });

  const loadCampaigns = async () => {
    setCampaignsLoading(true);
    setCampaignError('');
    try {
      const data = await apiRequest<Campaign[]>('/api/campaigns');
      setCampaigns(data);
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : 'Campaigns could not be loaded.');
    } finally {
      setCampaignsLoading(false);
    }
  };

  const loadIntegrations = async () => {
    try {
      const [slack, admin] = await Promise.all([
        apiRequest<SlackStatus>('/api/integrations/slack/status'),
        apiRequest<{ authorized: boolean }>('/api/admin/queue-dashboard-access'),
      ]);
      setSlackStatus(slack);
      setQueueDashboardAuthorized(admin.authorized);
    } catch {
      setSlackStatus(null);
      setQueueDashboardAuthorized(false);
    } finally {
      setSlackLoading(false);
    }
  };

  useEffect(() => {
    void loadCampaigns();
    void loadIntegrations();
    const slackResult = new URLSearchParams(window.location.search).get('slack');
    if (slackResult === 'connected') setNotice('Slack is connected.');
    if (slackResult === 'error') setNotice('Slack connection could not be completed.');
    if (slackResult) window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (view !== 'details' || selectedCampaignId === null) return;
    let active = true;
    setDetailsLoading(true);
    setPageError('');
    apiRequest<CampaignDetails>(`/api/campaigns/${selectedCampaignId}`)
      .then((data) => { if (active) setDetails(data); })
      .catch((error: unknown) => { if (active) setPageError(error instanceof Error ? error.message : 'Campaign could not be loaded.'); })
      .finally(() => { if (active) setDetailsLoading(false); });
    return () => { active = false; };
  }, [view, selectedCampaignId]);

  const openCampaign = (campaignId: number) => {
    setSelectedCampaignId(campaignId);
    setDetails(null);
    setView('details');
    setPageError('');
    setMobileNavOpen(false);
  };

  const refreshCampaigns = async () => {
    await loadCampaigns();
    if (selectedCampaignId !== null) {
      try {
        setDetails(await apiRequest<CampaignDetails>(`/api/campaigns/${selectedCampaignId}`));
      } catch (error) {
        setPageError(error instanceof Error ? error.message : 'Campaign could not be refreshed.');
      }
    }
  };

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    const content = await file.text();
    setEmailSource(content);
    setImportSummary(parseEmails(content));
  };

  const handleCreateCampaign = async (event: FormEvent) => {
    event.preventDefault();
    setActionLoading(true);
    setPageError('');
    setNotice('');
    const parsedEmails = parseEmails(emailSource);
    setImportSummary(parsedEmails);
    if (!form.subject.trim() || !form.body.trim()) {
      setPageError('Add a subject and email body before creating the campaign.');
      setActionLoading(false);
      return;
    }
    if (parsedEmails.invalid.length > 0) {
      setPageError(`Fix ${parsedEmails.invalid.length} invalid email address${parsedEmails.invalid.length === 1 ? '' : 'es'} before continuing.`);
      setActionLoading(false);
      return;
    }

    try {
      const campaign = await apiRequest<Campaign>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          subject: form.subject.trim(),
          body: form.body,
          startTime: form.startTime ? new Date(form.startTime).toISOString() : undefined,
          delayBetweenEmails: Number(form.delayBetweenEmails),
          hourlyLimit: form.hourlyLimit ? Number(form.hourlyLimit) : null,
        }),
      });
      if (parsedEmails.valid.length > 0) {
        await apiRequest(`/api/campaigns/${campaign.id}/recipients`, {
          method: 'POST',
          body: JSON.stringify({ emails: parsedEmails.valid }),
        });
      }
      setForm({ subject: '', body: '', startTime: '', delayBetweenEmails: '0', hourlyLimit: '' });
      setEmailSource('');
      setNotice('Campaign created. Review its recipients before scheduling.');
      await loadCampaigns();
      openCampaign(campaign.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Campaign could not be created.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSchedule = async () => {
    if (!details) return;
    setActionLoading(true);
    setPageError('');
    setNotice('');
    try {
      const result = await apiRequest<{ scheduledCount: number; status: string }>(`/api/campaigns/${details.id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(result.scheduledCount > 0 ? `Scheduled ${result.scheduledCount} recipient${result.scheduledCount === 1 ? '' : 's'}.` : 'No new recipients needed scheduling.');
      await refreshCampaigns();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Campaign could not be scheduled.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    setSearchLoading(true);
    setSearchError('');
    try {
      const q = (searchTab === 'campaigns' ? campaignSearch : recipientSearch).trim();
      const params = new URLSearchParams({ page: '1', pageSize: '20' });
      if (q) params.set('q', q);
      if (searchTab === 'campaigns') {
        setCampaignResults(await apiRequest<SearchPage<Record<string, unknown>>>(`/api/search/campaigns?${params}`));
      } else {
        setRecipientResults(await apiRequest<SearchPage<Record<string, unknown>>>(`/api/search/recipients?${params}`));
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Search is unavailable.');
    } finally {
      setSearchLoading(false);
    }
  };

  const navTo = (target: View) => {
    setView(target);
    setPageError('');
    setNotice('');
    setMobileNavOpen(false);
  };

  const totals = campaigns.reduce((result, campaign) => ({
    scheduled: result.scheduled + (campaign.recipientCounts?.QUEUED ?? 0),
    sent: result.sent + (campaign.recipientCounts?.SENT ?? 0),
    failed: result.failed + (campaign.recipientCounts?.FAILED ?? 0),
    pending: result.pending + (campaign.recipientCounts?.PENDING ?? 0),
  }), { scheduled: 0, sent: 0, failed: 0, pending: 0 });

  const pageTitle: Record<View, string> = {
    overview: 'Overview', campaigns: 'Campaigns', create: 'New campaign', details: 'Campaign details', search: 'Search', integrations: 'Integrations',
  };

  return (
    <div className="dashboard-shell">
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`dashboard-sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="mail" size={20} /></div>
          <div><strong>ReachInbox</strong><span>OUTREACH WORKSPACE</span></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="workspace-switcher"><span className="workspace-avatar">R</span><span><strong>Personal workspace</strong><small>Signed in</small></span><span className="chevron">⌄</span></div>
        <nav className="side-nav" aria-label="Main navigation">
          <p className="nav-label">WORKSPACE</p>
          <NavItem icon="overview" label="Overview" active={view === 'overview'} onClick={() => navTo('overview')} />
          <NavItem icon="campaigns" label="Campaigns" active={view === 'campaigns' || view === 'details'} onClick={() => navTo('campaigns')} />
          <NavItem icon="create" label="Create campaign" active={view === 'create'} onClick={() => navTo('create')} />
          <NavItem icon="search" label="Search" active={view === 'search'} onClick={() => navTo('search')} />
          <p className="nav-label nav-label-spaced">SETTINGS</p>
          <NavItem icon="integrations" label="Integrations" active={view === 'integrations'} onClick={() => navTo('integrations')} />
          {queueDashboardAuthorized && <a className="side-nav-item" href={`${API}/admin/queues`} target="_blank" rel="noreferrer"><span className="nav-icon"><Icon name="clock" /></span><span>Queue monitor</span><Icon name="arrow" size={14} /></a>}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help"><span className="help-mark">?</span><span><strong>Need a hand?</strong><small>Contact support</small></span><Icon name="arrow" size={14} /></div>
          <div className="sidebar-user">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="user-avatar-fallback">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>}
            <span className="sidebar-user-info"><strong>{user.name || 'ReachInbox user'}</strong><small>{user.email}</small></span>
            <button className="icon-button user-menu-button" aria-label="Open account menu" onClick={() => setProfileOpen(!profileOpen)}><span>•••</span></button>
            {profileOpen && <div className="profile-menu"><button onClick={onLogout}><Icon name="logout" size={16} />Sign out</button></div>}
          </div>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Icon name="menu" /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-separator">/</span><strong>{pageTitle[view]}</strong></div>
          <div className="topbar-actions">
            <button className="topbar-search" onClick={() => navTo('search')}><Icon name="search" size={17} /><span>Search campaigns, recipients...</span><kbd>⌘ K</kbd></button>
            <button className="topbar-avatar" aria-label="Account menu" onClick={() => setProfileOpen(!profileOpen)}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.name || user.email).slice(0, 1).toUpperCase()}</button>
          </div>
        </header>

        <div className="dashboard-content">
          {notice && <div className="notice-banner" role="status"><span className="notice-check"><Icon name="check" size={15} /></span>{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}><Icon name="close" size={15} /></button></div>}
          {pageError && <div className="error-banner" role="alert"><Icon name="alert" size={17} />{pageError}<button aria-label="Dismiss error" onClick={() => setPageError('')}><Icon name="close" size={15} /></button></div>}
          {campaignError && <div className="error-banner" role="alert"><Icon name="alert" size={17} />{campaignError}<button onClick={() => void loadCampaigns()}>Retry</button></div>}

          {view === 'overview' && <OverviewView userName={user.name || user.email.split('@')[0]} campaigns={campaigns} totals={totals} loading={campaignsLoading} onCreate={() => navTo('create')} onOpen={openCampaign} />}
          {view === 'campaigns' && <CampaignListView campaigns={campaigns} loading={campaignsLoading} onCreate={() => navTo('create')} onOpen={openCampaign} />}
          {view === 'create' && <CreateCampaignView form={form} setForm={setForm} emailSource={emailSource} setEmailSource={(source) => { setEmailSource(source); setImportSummary(parseEmails(source)); }} importSummary={importSummary} onFile={handleImportFile} onSubmit={handleCreateCampaign} loading={actionLoading} onCancel={() => navTo('campaigns')} />}
          {view === 'details' && <CampaignDetailsView details={details} loading={detailsLoading} actionLoading={actionLoading} onSchedule={handleSchedule} onBack={() => navTo('campaigns')} />}
          {view === 'search' && <SearchView campaignSearch={campaignSearch} setCampaignSearch={setCampaignSearch} recipientSearch={recipientSearch} setRecipientSearch={setRecipientSearch} tab={searchTab} setTab={setSearchTab} campaignResults={campaignResults} recipientResults={recipientResults} loading={searchLoading} error={searchError} onSearch={handleSearch} onOpen={openCampaign} />}
          {view === 'integrations' && <IntegrationsView slackStatus={slackStatus} loading={slackLoading} onConnect={() => { window.location.href = `${API}/api/integrations/slack/oauth`; }} onRefresh={() => { setSlackLoading(true); void loadIntegrations(); }} />}
        </div>
      </main>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return <button className={`side-nav-item ${active ? 'active' : ''}`} onClick={onClick}><span className="nav-icon"><Icon name={icon} /></span><span>{label}</span>{active && <span className="nav-active-mark" />}</button>;
}

function MetricCard({ label, value, note, tone, icon }: { label: string; value: number; note: string; tone: string; icon: string }) {
  return <article className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon} size={18} /></span></div><strong className="metric-value">{value.toLocaleString()}</strong><span className="metric-note">{note}</span></article>;
}

function OverviewView({ userName, campaigns, totals, loading, onCreate, onOpen }: { userName: string; campaigns: Campaign[]; totals: { scheduled: number; sent: number; failed: number; pending: number }; loading: boolean; onCreate: () => void; onOpen: (id: number) => void }) {
  const recent = [...campaigns].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);
  const total = totals.scheduled + totals.sent + totals.failed + totals.pending;
  const segments = [
    { label: 'Sent', value: totals.sent, className: 'segment-sent' },
    { label: 'Scheduled', value: totals.scheduled, className: 'segment-scheduled' },
    { label: 'Pending', value: totals.pending, className: 'segment-pending' },
    { label: 'Failed', value: totals.failed, className: 'segment-failed' },
  ];
  return <>
    <div className="page-heading overview-heading"><div><p className="eyebrow">YOUR OUTREACH, AT A GLANCE</p><h1>Good {timeGreeting()}, {userName.split(' ')[0]}.</h1><p className="page-subtitle">Here’s what’s happening across your campaigns.</p></div><button className="primary-button" onClick={onCreate}><Icon name="create" size={17} />New campaign</button></div>
    <section className="metrics-grid" aria-label="Recipient metrics">
      <MetricCard label="Scheduled" value={totals.scheduled} note="Queued for delivery" tone="blue" icon="calendar" />
      <MetricCard label="Sent" value={totals.sent} note="Accepted by the mail server" tone="green" icon="check" />
      <MetricCard label="Pending" value={totals.pending} note="Waiting to be scheduled" tone="yellow" icon="clock" />
      <MetricCard label="Failed" value={totals.failed} note="Need your attention" tone="red" icon="alert" />
    </section>
    <section className="overview-grid">
      <article className="panel activity-panel"><div className="panel-heading"><div><h2>Recipient activity</h2><p>Current status across all campaigns</p></div><span className="panel-period">ALL TIME</span></div>
        {loading ? <div className="skeleton skeleton-chart" /> : total === 0 ? <EmptyInline title="No recipient activity yet" detail="Add recipients to a campaign to see activity here." /> : <>
          <div className="activity-total"><strong>{total.toLocaleString()}</strong><span>Total recipients</span></div>
          <div className="activity-bar" role="img" aria-label={segments.map((segment) => `${segment.label}: ${segment.value}`).join(', ')}>{segments.map((segment) => segment.value > 0 && <span key={segment.label} className={segment.className} style={{ width: `${Math.max((segment.value / total) * 100, 2)}%` }} />)}</div>
          <div className="activity-legend">{segments.map((segment) => <div key={segment.label}><span className={`legend-dot ${segment.className}`} />{segment.label}<strong>{segment.value}</strong></div>)}</div>
        </>}
      </article>
      <article className="panel focus-panel"><div className="panel-heading"><div><h2>Workspace snapshot</h2><p>Campaigns you’re running</p></div><span className="snapshot-icon"><Icon name="campaigns" /></span></div>
        <div className="snapshot-number">{loading ? '—' : campaigns.length}</div><p className="snapshot-caption">{campaigns.length === 1 ? 'campaign in your workspace' : 'campaigns in your workspace'}</p>
        <div className="snapshot-divider" /><div className="snapshot-foot"><span>Latest campaign</span><strong>{recent[0]?.subject ?? '—'}</strong></div>
      </article>
    </section>
    <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent campaigns</h2><p>Your latest outreach activity</p></div><button className="text-button" onClick={() => onCreate()}>Create campaign <Icon name="arrow" size={15} /></button></div>
      <CampaignTable campaigns={recent} loading={loading} onOpen={onOpen} />
    </section>
  </>;
}

function CampaignListView({ campaigns, loading, onCreate, onOpen }: { campaigns: Campaign[]; loading: boolean; onCreate: () => void; onOpen: (id: number) => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">OUTREACH</p><h1>Campaigns</h1><p className="page-subtitle">Create, review, and schedule your email outreach.</p></div><button className="primary-button" onClick={onCreate}><Icon name="create" size={17} />New campaign</button></div><section className="panel campaign-list-panel"><div className="panel-heading"><div><h2>All campaigns</h2><p>{loading ? 'Loading campaigns…' : `${campaigns.length} ${campaigns.length === 1 ? 'campaign' : 'campaigns'}`}</p></div></div><CampaignTable campaigns={campaigns} loading={loading} onOpen={onOpen} /></section></>;
}

function CampaignTable({ campaigns, loading, onOpen }: { campaigns: Campaign[]; loading: boolean; onOpen: (id: number) => void }) {
  if (loading) return <div className="table-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
  if (campaigns.length === 0) return <EmptyInline title="No campaigns yet" detail="Create your first campaign to get started." />;
  return <div className="table-scroll"><table className="campaign-table"><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Scheduled start</th><th>Send interval</th><th /></tr></thead><tbody>{campaigns.map((campaign) => <tr key={campaign.id} onClick={() => onOpen(campaign.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(campaign.id); }}><td><div className="campaign-name-cell"><span className="campaign-table-icon"><Icon name="mail" size={16} /></span><span><strong>{campaign.subject}</strong><small>Created {formatDate(campaign.createdAt, false)}</small></span></div></td><td><StatusPill status={campaign.status} /></td><td><span className="recipient-count">{campaign.recipientCount.toLocaleString()}</span><small className="recipient-count-label">recipients</small></td><td>{formatDate(campaign.startTime)}</td><td>{campaign.delayBetweenEmails}s between emails</td><td><button className="row-arrow" aria-label={`Open ${campaign.subject}`}><Icon name="arrow" size={16} /></button></td></tr>)}</tbody></table></div>;
}

function CreateCampaignView({ form, setForm, emailSource, setEmailSource, importSummary, onFile, onSubmit, loading, onCancel }: { form: { subject: string; body: string; startTime: string; delayBetweenEmails: string; hourlyLimit: string }; setForm: (form: { subject: string; body: string; startTime: string; delayBetweenEmails: string; hourlyLimit: string }) => void; emailSource: string; setEmailSource: (source: string) => void; importSummary: ParsedEmails; onFile: (file?: File) => void; onSubmit: (event: FormEvent) => void; loading: boolean; onCancel: () => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">BUILD AN OUTREACH</p><h1>New campaign</h1><p className="page-subtitle">Set your message and delivery pace. You can review recipients before scheduling.</p></div><button className="secondary-button" onClick={onCancel}><Icon name="back" size={16} />Back to campaigns</button></div>
    <form className="create-layout" onSubmit={onSubmit}>
      <div className="create-main-column">
        <section className="panel form-panel"><div className="form-section-heading"><span className="step-number">01</span><div><h2>Campaign details</h2><p>Choose a clear subject and write your email.</p></div></div>
          <label className="field-label">Campaign subject<input className="text-input" maxLength={200} value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="e.g. A quick introduction" required /></label>
          <label className="field-label">Email body<textarea className="text-input body-input" maxLength={80000} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} placeholder="Write the message your recipients will receive…" required /></label>
          <div className="field-footnote">Personalization and templates can be added later.</div>
        </section>
        <section className="panel form-panel"><div className="form-section-heading"><span className="step-number step-blue">02</span><div><h2>Recipients</h2><p>Paste addresses or import a CSV or text file.</p></div></div>
          <div className="recipient-import-actions"><label className="secondary-button upload-button"><Icon name="upload" size={16} />Import .csv or .txt<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => onFile(event.target.files?.[0])} /></label><span>or paste addresses below</span></div>
          <textarea className="text-input recipient-input" value={emailSource} onChange={(event) => setEmailSource(event.target.value)} placeholder={'name@company.com\nsecond@company.com'} aria-label="Recipient email addresses" />
          <div className="import-summary"><span><strong>{importSummary.valid.length}</strong> valid</span><span><strong>{importSummary.duplicateCount}</strong> duplicates</span><span className={importSummary.invalid.length ? 'invalid-count' : ''}><strong>{importSummary.invalid.length}</strong> invalid</span></div>
          {importSummary.invalid.length > 0 && <p className="field-error">Invalid: {importSummary.invalid.slice(0, 3).join(', ')}{importSummary.invalid.length > 3 ? ` and ${importSummary.invalid.length - 3} more` : ''}</p>}
        </section>
      </div>
      <aside className="create-side-column">
        <section className="panel form-panel"><div className="form-section-heading"><span className="step-number step-yellow">03</span><div><h2>Delivery schedule</h2><p>Control when and how quickly messages are sent.</p></div></div>
          <label className="field-label">Start date and time<input className="text-input" type="datetime-local" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} /></label>
          <label className="field-label">Delay between emails<span className="input-with-suffix"><input className="text-input" type="number" min="0" max="86400" step="1" value={form.delayBetweenEmails} onChange={(event) => setForm({ ...form, delayBetweenEmails: event.target.value })} /><span>seconds</span></span></label>
          <label className="field-label">Hourly limit <span className="optional-label">OPTIONAL</span><span className="input-with-suffix"><input className="text-input" type="number" min="1" max="100000" step="1" value={form.hourlyLimit} onChange={(event) => setForm({ ...form, hourlyLimit: event.target.value })} placeholder="No limit" /><span>emails / hour</span></span></label>
          <p className="schedule-note"><Icon name="clock" size={15} />Recipients are added as pending. Scheduling is a separate step after campaign creation.</p>
        </section>
        <div className="create-form-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={loading}>{loading ? <span className="spinner" /> : <Icon name="check" size={16} />}{loading ? 'Creating…' : 'Create campaign'}</button></div>
      </aside>
    </form>
  </>;
}

function CampaignDetailsView({ details, loading, actionLoading, onSchedule, onBack }: { details: CampaignDetails | null; loading: boolean; actionLoading: boolean; onSchedule: () => void; onBack: () => void }) {
  if (loading || !details) return <><button className="back-link" onClick={onBack}><Icon name="back" size={16} />Campaigns</button><div className="panel details-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></>;
  const recipientCounts = details.recipients.reduce((counts, recipient) => {
    counts[recipient.status]++;
    return counts;
  }, { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0 });
  const canSchedule = ['DRAFT', 'SCHEDULED', 'RUNNING'].includes(details.status) && recipientCounts.PENDING + recipientCounts.QUEUED > 0;
  return <><button className="back-link" onClick={onBack}><Icon name="back" size={16} />Campaigns</button>
    <div className="page-heading details-heading"><div><p className="eyebrow">CAMPAIGN {details.id}</p><h1>{details.subject}</h1><p className="page-subtitle">Created {formatDate(details.createdAt, false)}</p></div><div className="detail-heading-actions"><StatusPill status={details.status} />{canSchedule && <button className="primary-button" onClick={onSchedule} disabled={actionLoading}><Icon name="calendar" size={16} />{actionLoading ? 'Scheduling…' : 'Schedule eligible recipients'}</button>}</div></div>
    <section className="detail-metrics"><DetailMetric label="Pending" value={recipientCounts.PENDING} color="yellow" /><DetailMetric label="Scheduled" value={recipientCounts.QUEUED} color="blue" /><DetailMetric label="Sent" value={recipientCounts.SENT} color="green" /><DetailMetric label="Failed" value={recipientCounts.FAILED} color="red" /></section>
    <section className="panel recipient-panel"><div className="panel-heading"><div><h2>Recipients</h2><p>{details.recipients.length} total recipients</p></div><div className="detail-schedule-meta"><span><Icon name="calendar" size={14} />{formatDate(details.startTime)}</span><span><Icon name="clock" size={14} />{details.delayBetweenEmails}s interval</span>{details.hourlyLimit && <span><Icon name="users" size={14} />{details.hourlyLimit}/hour</span>}</div></div>
      {details.recipients.length === 0 ? <EmptyInline title="No recipients yet" detail="Add recipients from the campaign list before scheduling." /> : <div className="table-scroll"><table className="campaign-table recipient-table"><thead><tr><th>Email address</th><th>Status</th><th>Scheduled time</th><th>Sent time</th><th>Attempts</th></tr></thead><tbody>{details.recipients.map((recipient) => <tr key={recipient.id}><td><span className="recipient-email"><Icon name="mail" size={15} />{recipient.email}</span></td><td><StatusPill status={recipient.status} /></td><td>{formatDate(recipient.scheduledTime)}</td><td>{formatDate(recipient.sentTime)}</td><td>{recipient.attemptCount}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function DetailMetric({ label, value, color }: { label: string; value: number; color: string }) {
  return <div className={`detail-metric detail-${color}`}><span>{label}</span><strong>{value}</strong></div>;
}

function SearchView({ campaignSearch, setCampaignSearch, recipientSearch, setRecipientSearch, tab, setTab, campaignResults, recipientResults, loading, error, onSearch, onOpen }: { campaignSearch: string; setCampaignSearch: (value: string) => void; recipientSearch: string; setRecipientSearch: (value: string) => void; tab: 'campaigns' | 'recipients'; setTab: (tab: 'campaigns' | 'recipients') => void; campaignResults: SearchPage<Record<string, unknown>> | null; recipientResults: SearchPage<Record<string, unknown>> | null; loading: boolean; error: string; onSearch: (event: FormEvent) => void; onOpen: (id: number) => void }) {
  const results = tab === 'campaigns' ? campaignResults : recipientResults;
  return <><div className="page-heading"><div><p className="eyebrow">FIND ANYTHING</p><h1>Search</h1><p className="page-subtitle">Search campaign subjects and recipient email addresses.</p></div></div><section className="panel search-panel"><div className="search-tabs"><button className={tab === 'campaigns' ? 'selected' : ''} onClick={() => setTab('campaigns')}>Campaigns</button><button className={tab === 'recipients' ? 'selected' : ''} onClick={() => setTab('recipients')}>Recipients</button></div><form className="search-form" onSubmit={onSearch}><Icon name="search" size={19} /><input value={tab === 'campaigns' ? campaignSearch : recipientSearch} onChange={(event) => tab === 'campaigns' ? setCampaignSearch(event.target.value) : setRecipientSearch(event.target.value)} placeholder={tab === 'campaigns' ? 'Search campaign subjects…' : 'Search recipient emails…'} maxLength={120} /><button className="primary-button" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button></form>
      {error && <div className="search-unavailable"><Icon name="alert" size={17} /><div><strong>Search is unavailable</strong><p>{error}</p></div></div>}
      {results && !error && <><div className="search-result-meta">{results.total} result{results.total === 1 ? '' : 's'} · Page {results.page}</div>{results.results.length === 0 ? <EmptyInline title="No matching results" detail="Try another search or check the search term." /> : <div className="search-results">{results.results.map((result, index) => tab === 'campaigns' ? <button className="search-result-row" key={`${String(result.campaignId)}-${index}`} onClick={() => onOpen(Number(result.campaignId))}><span className="campaign-table-icon"><Icon name="mail" size={16} /></span><span className="search-result-main"><strong>{String(result.subject ?? 'Campaign')}</strong><small>Campaign #{String(result.campaignId)}</small></span><StatusPill status={String(result.status ?? 'DRAFT')} /><Icon name="arrow" size={16} /></button> : <div className="search-result-row" key={`${String(result.recipientId)}-${index}`}><span className="campaign-table-icon"><Icon name="users" size={16} /></span><span className="search-result-main"><strong>{String(result.email ?? 'Recipient')}</strong><small>Campaign #{String(result.campaignId)}</small></span><StatusPill status={String(result.status ?? 'PENDING')} /></div>)}</div>}</>}
      {!results && !error && <EmptyInline title="Search your workspace" detail="Results are scoped to your account and appear here." />}
    </section></>;
}

function IntegrationsView({ slackStatus, loading, onConnect, onRefresh }: { slackStatus: SlackStatus | null; loading: boolean; onConnect: () => void; onRefresh: () => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">WORKSPACE CONNECTIONS</p><h1>Integrations</h1><p className="page-subtitle">Connect the services that keep your outreach workflow moving.</p></div></div><section className="integrations-grid"><article className="panel integration-card"><div className="integration-card-top"><span className="integration-logo slack-logo"><Icon name="slack" size={26} /></span><StatusPill status={loading ? 'LOADING' : slackStatus?.connected ? 'CONNECTED' : 'DISCONNECTED'} /></div><h2>Slack</h2><p>Get a direct message when a campaign reaches its hourly sending limit.</p><div className="integration-details">{loading ? <span>Checking connection…</span> : slackStatus?.connected ? <><span className="integration-connected"><span className="status-dot" />Connected</span><span>Team {slackStatus.teamId}</span><span>Connected {formatDate(slackStatus.connectedAt, false)}</span></> : <span>Not connected</span>}</div><div className="integration-actions">{!loading && !slackStatus?.connected && <button className="primary-button" onClick={onConnect}><Icon name="slack" size={16} />Connect Slack</button>}<button className="secondary-button" onClick={onRefresh}>Refresh status</button></div></article><article className="integration-note"><span className="note-line" /><div><strong>Notifications stay focused</strong><p>Slack alerts go to the connected user’s direct message. Email scheduling continues if Slack is unavailable.</p></div></article></section></>;
}

function EmptyInline({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="mail" size={20} /></span><strong>{title}</strong><p>{detail}</p></div>;
}

function timeGreeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

export default Dashboard;