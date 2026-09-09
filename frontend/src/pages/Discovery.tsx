import { CrawlCandidates } from '../discovery/CrawlCandidates';
import { requestDraftNavigation } from '../discovery/useUnsavedChanges';
import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { ScanSearch, Smartphone, Link2, TrendingUp, ArrowRight } from 'lucide-react';
import { useApp } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { WebsiteAudit, SearchOpportunities } from '../discovery/WebsiteAudit';
import { AppStoreStudio } from '../discovery/AppStoreStudio';
import { Coverage } from '../discovery/Coverage';
import { TechnicalLab } from '../discovery/TechnicalLab';
import { Experiments } from '../discovery/Experiments';
import { ContentStudio } from '../discovery/ContentStudio';
import { BacklinkMonitor } from '../discovery/BacklinkMonitor';
import '../discovery/discovery.css';
const tabs = [
  { id: 'candidates', label: 'Link candidates', icon: Link2 },
  { id: 'coverage', label: 'Evidence coverage', icon: ScanSearch },
  { id: 'lab', label: 'Technical lab', icon: ScanSearch },
  { id: 'experiments', label: 'Measure changes', icon: TrendingUp },
  { id: 'content', label: 'Content studio', icon: ScanSearch },
  { id: 'audit', label: 'Website audit', icon: ScanSearch },
  { id: 'opportunities', label: 'Search opportunities', icon: TrendingUp },
  { id: 'apps', label: 'App store studio', icon: Smartphone },
  { id: 'backlinks', label: 'Backlinks', icon: Link2 },
];
export default function Discovery() {
  const { sites } = useApp();
  const { active } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const tab = tabs.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'audit';
  const selected = params.get('site');
  const siteId = sites.some((s) => s.id === selected) ? selected! : (sites[0]?.id ?? '');
  const canEdit = !!active?.permissions?.manage_content;
  function update(key: string, value: string) {
    if ((key === 'tab' ? tab : siteId) === value || !requestDraftNavigation()) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  }
  return (
    <div className="discovery-page">
      <header className="discovery-hero">
        <div>
          <span className="discovery-eyebrow">Your evidence. Your next move.</span>
          <h1>Discovery workbench</h1>
          <p>Find what holds you back. Make a useful change. Check what happened.</p>
        </div>
        <Link className="btn btn-secondary" to="/actions">
          Open work queue <ArrowRight size={16} />
        </Link>
      </header>
      <div className="discovery-toolbar">
        <label className="discovery-mobile-tool">
          <span>Tool</span>
          <select
            aria-label="Discovery tool"
            disabled={busy}
            value={tab}
            onChange={(e) => update('tab', e.target.value)}
          >
            {tabs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Discovery tools">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              disabled={busy}
              className={tab === id ? 'active' : ''}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => update('tab', id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <label>
          <span>Site</span>
          <select
            aria-label="Discovery site"
            value={siteId}
            disabled={busy || !sites.length}
            onChange={(e) => update('site', e.target.value)}
          >
            {!sites.length && <option value="">No sites yet</option>}
            {sites.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!canEdit && (
        <p className="discovery-note">
          Read-only access. A workspace member with content permission can run checks and save changes.
        </p>
      )}
      {!siteId && !['apps', 'lab', 'coverage'].includes(tab) ? (
        <div className="discovery-empty">
          <ScanSearch size={32} />
          <h2>Start with a website</h2>
          <p>Add a site to build a page inventory, measure search performance and monitor backlinks.</p>
          <Link className="btn btn-primary" to="/sites">
            Open sites
          </Link>
        </div>
      ) : (
        <div key={`${siteId}:${tab}`}>
          {tab === 'candidates' && <CrawlCandidates siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
          {tab === 'coverage' && <Coverage />}
          {tab === 'lab' && <TechnicalLab />}
          {tab === 'experiments' && <Experiments siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
          {tab === 'content' && <ContentStudio siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
          {tab === 'audit' && <WebsiteAudit siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
          {tab === 'opportunities' && <SearchOpportunities siteId={siteId} canEdit={canEdit} />}
          {tab === 'apps' && <AppStoreStudio siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
          {tab === 'backlinks' && <BacklinkMonitor siteId={siteId} canEdit={canEdit} setBusy={setBusy} />}
        </div>
      )}
      <footer className="discovery-principles">
        Built for self-hosting · Core checks need no paid API · Findings explain their evidence · No
        guaranteed rankings
      </footer>
    </div>
  );
}
