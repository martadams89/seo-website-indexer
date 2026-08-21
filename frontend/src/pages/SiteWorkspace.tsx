import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileWarning,
  Globe2,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  api,
  type AiPrompt,
  type Site,
  type SiteAnalytics,
  type SiteFileSnapshot,
  type SiteProbe,
  type UrlFailureRecord,
  type WorkItem,
} from "../api";
import { useApp, useToast } from "../AppContext";
import { useWorkspace } from "../workspace/WorkspaceContext";

type SiteTab =
  | "overview"
  | "indexing"
  | "search"
  | "ai"
  | "issues"
  | "settings";
const TABS: Array<{ id: SiteTab; label: string; icon: typeof Globe2 }> = [
  { id: "overview", label: "Overview", icon: Globe2 },
  { id: "indexing", label: "Indexing", icon: Search },
  { id: "search", label: "Search", icon: BarChart3 },
  { id: "ai", label: "AI visibility", icon: Bot },
  { id: "issues", label: "Issues", icon: FileWarning },
  { id: "settings", label: "Settings", icon: Settings },
];

interface SiteWorkspaceData {
  site: Site;
  analytics: SiteAnalytics | null;
  failures: UrlFailureRecord[];
  prompts: AiPrompt[];
  work: WorkItem[];
}

function statusTone(ok: boolean | null): string {
  return ok === null ? "neutral" : ok ? "good" : "bad";
}

export default function SiteWorkspacePage() {
  const { siteId = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { refresh } = useApp();
  const { active } = useWorkspace();
  const toast = useToast();
  const tab = (
    TABS.some((item) => item.id === params.get("tab"))
      ? params.get("tab")
      : "overview"
  ) as SiteTab;
  const [data, setData] = useState<SiteWorkspaceData | null>(null);
  const [probe, setProbe] = useState<SiteProbe | null>(null);
  const [fileHistory, setFileHistory] = useState<SiteFileSnapshot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    domain: "",
    sitemap_url: "",
    gsc_url: "",
    deploy_webhook_url: "",
    enabled: true,
  });
  const canManage = !!active?.permissions?.manage_sites;

  const load = useCallback(async () => {
    setError("");
    try {
      const [sites, analyticsResult, failures, prompts, work, history] =
        await Promise.all([
          api.getSites(),
          api.getSiteAnalytics(siteId).catch(() => null),
          api.getUrlFailures(),
          api.getAiPrompts(),
          api.getWorkItems({ include_snoozed: true, limit: 300 }),
          api.getSiteFileHistory(siteId),
        ]);
      const site = sites.find((row) => row.id === siteId);
      if (!site) {
        setError("Website not found in this workspace.");
        return;
      }
      setData({
        site,
        analytics: analyticsResult,
        failures: failures.filter((row) => row.site_id === siteId),
        prompts: prompts.filter((row) => row.site_id === siteId),
        work: work.filter((row) => row.site_id === siteId),
      });
      setFileHistory(history);
      setDraft({
        name: site.name,
        domain: site.domain,
        sitemap_url: site.sitemap_url,
        gsc_url: site.gsc_url,
        deploy_webhook_url: site.deploy_webhook_url ?? "",
        enabled: !!site.enabled,
      });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Website workspace could not be loaded.",
      );
    }
  }, [siteId]);
  useEffect(() => {
    load();
  }, [load, active?.id]);

  const snapshot = data?.analytics?.snapshot;
  const indexRate = snapshot?.urls_total
    ? Math.round((snapshot.urls_indexed / snapshot.urls_total) * 100)
    : null;
  const activeWork = useMemo(
    () =>
      data?.work.filter(
        (item) => !["done", "dismissed"].includes(item.status),
      ) ?? [],
    [data],
  );

  async function runProbe() {
    setBusy("probe");
    try {
      setProbe(await api.probeSite(siteId));
      toast("success", "Website connection checked");
    } catch (probeError) {
      toast(
        "error",
        probeError instanceof Error
          ? probeError.message
          : "Connection check failed",
      );
    }
    setBusy(null);
  }

  async function deployGeo() {
    setBusy("deploy");
    try {
      const result = await api.deployGeo(siteId);
      const failed = [result.robots, result.llms, result.llmsSitemap].filter(
        (item) => !item.ok,
      );
      if (failed.length)
        throw new Error(
          failed.map((item) => `${item.target}: ${item.message}`).join(" · "),
        );
      toast("success", "Discovery files deployed");
      await load();
    } catch (deployError) {
      toast(
        "error",
        deployError instanceof Error
          ? deployError.message
          : "Deployment failed",
      );
    }
    setBusy(null);
  }

  async function refreshDiscovery() {
    setBusy("discovery");
    try {
      await api.getLlmsAudit(siteId);
      setFileHistory(await api.getSiteFileHistory(siteId));
      toast("success", "Live discovery files audited");
    } catch (auditError) {
      toast(
        "error",
        auditError instanceof Error
          ? auditError.message
          : "Discovery audit failed",
      );
    }
    setBusy(null);
  }

  async function saveSettings() {
    setBusy("save");
    try {
      await api.updateSite(siteId, {
        ...draft,
        enabled: draft.enabled ? 1 : 0,
        deploy_webhook_url: draft.deploy_webhook_url || null,
      });
      await Promise.all([load(), refresh()]);
      toast("success", "Website settings saved");
    } catch (saveError) {
      toast(
        "error",
        saveError instanceof Error
          ? saveError.message
          : "Settings could not be saved",
      );
    }
    setBusy(null);
  }

  if (error)
    return (
      <div className="site-workspace-error">
        <AlertTriangle />
        <h1>Website unavailable</h1>
        <p>{error}</p>
        <button
          className="btn btn-secondary"
          onClick={() => navigate("/sites")}
        >
          <ArrowLeft size={13} /> Back to sites
        </button>
      </div>
    );
  if (!data)
    return <div className="page-loading">Opening website workspace…</div>;
  const { site, analytics, failures, prompts, work } = data;

  return (
    <div className="site-workspace">
      <header className="site-workspace-header">
        <div className="site-workspace-identity">
          <Link to="/sites" aria-label="Back to sites">
            <ArrowLeft />
          </Link>
          <span className="site-monogram">
            {site.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <span>Website workspace</span>
            <h1>{site.name}</h1>
            <a
              href={
                /^https?:\/\//i.test(site.domain)
                  ? site.domain
                  : `https://${site.domain}`
              }
              target="_blank"
              rel="noreferrer"
            >
              {site.domain}
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
        <div className="site-workspace-status">
          <span className={site.enabled ? "good" : "neutral"}>
            <i />
            {site.enabled ? "Monitoring active" : "Paused"}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy === "probe"}
            onClick={runProbe}
          >
            {busy === "probe" ? (
              <RefreshCw className="spin" />
            ) : (
              <ShieldCheck />
            )}{" "}
            Test connection
          </button>
        </div>
      </header>
      <nav className="site-workspace-tabs" aria-label={`${site.name} sections`}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setParams({ tab: id })}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </nav>

      {probe && (
        <section className="site-probe-summary" aria-live="polite">
          <span className={statusTone(probe.sitemap.ok)}>
            {probe.sitemap.ok ? <CheckCircle2 /> : <AlertTriangle />}
            <strong>Sitemap</strong>
            {probe.sitemap.ok
              ? `${probe.sitemap.urlCount} URLs discovered`
              : probe.sitemap.error || "Unavailable"}
          </span>
          <span className={statusTone(site.indexNowVerified)}>
            {site.indexNowVerified ? <CheckCircle2 /> : <AlertTriangle />}
            <strong>IndexNow</strong>
            {site.indexNowVerified
              ? "Ownership verified"
              : "Key needs verification"}
          </span>
        </section>
      )}

      {tab === "overview" && (
        <div className="site-overview-grid">
          <section className="site-health-card">
            <div>
              <span>Index coverage</span>
              <strong>{indexRate == null ? "—" : `${indexRate}%`}</strong>
              <small>
                {snapshot?.urls_indexed ?? 0} of {snapshot?.urls_total ?? 0}{" "}
                known URLs
              </small>
            </div>
            <div className="site-health-track">
              <i style={{ width: `${indexRate ?? 0}%` }} />
            </div>
            <p>
              {indexRate == null
                ? "Run this website to establish its first indexing baseline."
                : indexRate >= 80
                  ? "Coverage is healthy. Review stale pages and exceptions next."
                  : "Coverage needs attention. Open Indexing for the evidence."}
            </p>
          </section>
          <section className="site-workspace-kpis">
            <article>
              <Search />
              <span>
                <strong>{snapshot?.urls_stale ?? 0}</strong>stale URLs
              </span>
            </article>
            <article>
              <AlertTriangle />
              <span>
                <strong>{failures.length}</strong>submission failures
              </span>
            </article>
            <article>
              <Bot />
              <span>
                <strong>{prompts.length}</strong>AI prompts
              </span>
            </article>
            <article>
              <FileWarning />
              <span>
                <strong>{activeWork.length}</strong>open actions
              </span>
            </article>
          </section>
          <section className="site-next-actions">
            <header>
              <div>
                <span>What needs attention</span>
                <h2>Next actions</h2>
              </div>
              <Sparkles />
            </header>
            {activeWork.slice(0, 5).map((item) => (
              <Link to={`/actions?site=${encodeURIComponent(site.id)}`} key={item.id}>
                <span className={`signal-badge ${item.severity}`}>
                  {item.severity}
                </span>
                <strong>{item.title}</strong>
                <small>
                  {item.description ||
                    "Review the evidence and record the outcome."}
                </small>
              </Link>
            ))}
            {!activeWork.length && (
              <div className="ops-empty compact">
                <CheckCircle2 />
                <strong>No open actions</strong>
                <span>
                  This website has no unresolved evidence-backed work.
                </span>
              </div>
            )}
          </section>
          <section className="site-connections-card">
            <header>
              <span>Connection health</span>
              <h2>Discovery and search</h2>
            </header>
            <dl>
              <div>
                <dt>Google Search Console</dt>
                <dd className={site.google_account_id ? "good" : "bad"}>
                  {site.google_account_id ? "Connected" : "Needs account"}
                </dd>
              </div>
              <div>
                <dt>Bing Webmaster</dt>
                <dd className={site.bing_account_id ? "good" : "neutral"}>
                  {site.bing_account_id ? "Connected" : "Optional"}
                </dd>
              </div>
              <div>
                <dt>IndexNow key</dt>
                <dd className={site.indexNowVerified ? "good" : "bad"}>
                  {site.indexNowVerified ? "Verified" : "Needs verification"}
                </dd>
              </div>
              <div>
                <dt>robots.txt</dt>
                <dd>{site.robots_txt_status || "Awaiting audit"}</dd>
              </div>
              <div>
                <dt>llms.txt</dt>
                <dd>{site.llms_txt_status || "Awaiting audit"}</dd>
              </div>
            </dl>
          </section>
        </div>
      )}

      {tab === "indexing" && (
        <div className="site-tab-layout">
          <section className="ops-card">
            <div className="ops-card-head">
              <div>
                <span>Coverage pipeline</span>
                <h2>Indexing state</h2>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={runProbe}
                disabled={busy === "probe"}
              >
                <RefreshCw className={busy === "probe" ? "spin" : ""} /> Refresh
                evidence
              </button>
            </div>
            <div className="site-index-funnel">
              <span>
                <strong>{snapshot?.urls_total ?? 0}</strong>Known URLs
              </span>
              <i />
              <span>
                <strong>{snapshot?.urls_submitted ?? 0}</strong>Submitted
              </span>
              <i />
              <span>
                <strong>{snapshot?.urls_indexed ?? 0}</strong>Indexed
              </span>
            </div>
            <div className="index-state-list">
              {analytics?.states.map((state) => (
                <div key={state.state}>
                  <span>{state.state || "Unknown"}</span>
                  <strong>{state.count}</strong>
                </div>
              ))}
              {!analytics?.states.length && (
                <div className="ops-empty compact">
                  No Search Console states have been retained yet.
                </div>
              )}
            </div>
          </section>
          <aside className="ops-card">
            <div className="ops-card-head">
              <div>
                <span>Machine discovery</span>
                <h2>GEO files</h2>
              </div>
              <UploadCloud />
            </div>
            <p>
              Deploy and verify robots.txt, llms.txt and the LLM sitemap using
              the configured reviewed delivery method.
            </p>
            <div className="site-discovery-actions">
              <button
                className="btn btn-secondary"
                disabled={busy === "discovery"}
                onClick={refreshDiscovery}
              >
                {busy === "discovery" ? (
                  <RefreshCw className="spin" />
                ) : (
                  <ShieldCheck />
                )}{" "}
                Audit live files
              </button>
              <button
                className="btn btn-primary"
                disabled={!canManage || busy === "deploy"}
                onClick={deployGeo}
              >
                {busy === "deploy" ? (
                  <RefreshCw className="spin" />
                ) : (
                  <UploadCloud />
                )}{" "}
                Deploy files
              </button>
            </div>
          </aside>
          <section className="ops-card full">
            <div className="ops-card-head">
              <div>
                <span>Change evidence</span>
                <h2>Discovery file history</h2>
              </div>
              <strong>{fileHistory.length} changes</strong>
            </div>
            <div className="file-history-list">
              {fileHistory.slice(0, 12).map((row) => (
                <article key={row.id}>
                  <span
                    className={`file-history-state ${row.matches_generated === 1 ? "match" : row.matches_generated === 0 ? "drift" : ""}`}
                  >
                    <i />
                    {row.matches_generated === 1
                      ? "Matches generated"
                      : row.matches_generated === 0
                        ? "Drift detected"
                        : "Deployment"}
                  </span>
                  <strong>{row.file_kind}</strong>
                  <small>
                    {row.source} · {row.http_status ?? "n/a"} ·{" "}
                    {new Date(row.observed_at).toLocaleString()}
                  </small>
                  <code>{row.content_hash.slice(0, 10)}</code>
                  <em>
                    +{row.added_lines} / −{row.removed_lines} lines
                  </em>
                </article>
              ))}
              {!fileHistory.length && (
                <div className="ops-empty compact">
                  <ShieldCheck />
                  <strong>No file history yet</strong>
                  <span>
                    Audit the live files to establish a baseline. Later changes
                    are stored only when content or status differs.
                  </span>
                </div>
              )}
            </div>
          </section>
          {failures.length > 0 && (
            <section className="ops-card full">
              <div className="ops-card-head">
                <div>
                  <span>Retry backoff</span>
                  <h2>Submission failures</h2>
                </div>
                <strong>{failures.length}</strong>
              </div>
              {failures.map((row) => (
                <div className="site-failure-row" key={`${row.api}:${row.url}`}>
                  <span className="signal-badge high">{row.api}</span>
                  <code>{row.url}</code>
                  <strong>{row.fail_count} failures</strong>
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {tab === "search" && (
        <div className="site-tab-layout">
          <section className="ops-card full">
            <div className="ops-card-head">
              <div>
                <span>Retained Search Console evidence</span>
                <h2>Coverage history</h2>
              </div>
              <Link
                className="btn btn-primary btn-sm"
                to={`/insights/search/${site.id}`}
              >
                Open full search detail <ExternalLink />
              </Link>
            </div>
            <div className="site-trend-table">
              <div>
                <span>Date</span>
                <span>Known</span>
                <span>Indexed</span>
                <span>Stale</span>
              </div>
              {analytics?.trend
                .slice(-14)
                .reverse()
                .map((point) => (
                  <div key={point.day}>
                    <strong>{new Date(point.day).toLocaleDateString()}</strong>
                    <span>{point.urls_total}</span>
                    <span>{point.urls_indexed}</span>
                    <span>{point.urls_stale}</span>
                  </div>
                ))}
              {!analytics?.trend.length && (
                <div className="ops-empty compact">
                  Run snapshots over time to build a search trend.
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "ai" && (
        <div className="site-tab-layout">
          <section className="ops-card full">
            <div className="ops-card-head">
              <div>
                <span>Buyer-question coverage</span>
                <h2>AI visibility prompts</h2>
              </div>
              <Link className="btn btn-primary btn-sm" to="/insights/ai">
                Open AI visibility <ExternalLink />
              </Link>
            </div>
            <div className="site-prompt-list">
              {prompts.map((prompt) => (
                <article key={prompt.id}>
                  <span className={`category-chip category-${prompt.category}`}>
                    {prompt.category}
                  </span>
                  <strong>{prompt.prompt}</strong>
                  <small>
                    {prompt.locale} · {prompt.device} · {prompt.cadence}
                  </small>
                </article>
              ))}
              {!prompts.length && (
                <div className="ops-empty compact">
                  <Bot />
                  <strong>No site-specific prompts</strong>
                  <span>
                    Add buyer questions in AI visibility and scope them to this
                    website.
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "issues" && (
        <div className="site-tab-layout">
          <section className="ops-card full">
            <div className="ops-card-head">
              <div>
                <span>Evidence-backed remediation</span>
                <h2>Website actions</h2>
              </div>
              <Link className="btn btn-primary btn-sm" to={`/actions?site=${encodeURIComponent(site.id)}`}>
                Open work centre <ExternalLink />
              </Link>
            </div>
            <div className="site-issue-list">
              {work.map((item) => (
                <article key={item.id} className={item.status}>
                  <span className={`signal-badge ${item.severity}`}>
                    {item.severity}
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description || "No description supplied."}</p>
                    <small>
                      {item.source.replaceAll("_", " ")} ·{" "}
                      {item.status.replaceAll("_", " ")}
                    </small>
                  </div>
                </article>
              ))}
              {!work.length && (
                <div className="ops-empty compact">
                  <CheckCircle2 />
                  <strong>No recorded issues</strong>
                  <span>
                    Automated findings and manually assigned work will appear
                    here.
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "settings" && (
        <div className="site-tab-layout">
          <section className="ops-card site-settings-card">
            <div className="ops-card-head">
              <div>
                <span>Website identity</span>
                <h2>Core configuration</h2>
              </div>
              <Settings />
            </div>
            <div className="form-grid">
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label>
                Domain
                <input
                  value={draft.domain}
                  onChange={(event) =>
                    setDraft({ ...draft, domain: event.target.value })
                  }
                />
              </label>
              <label className="full">
                Sitemap URL
                <input
                  value={draft.sitemap_url}
                  onChange={(event) =>
                    setDraft({ ...draft, sitemap_url: event.target.value })
                  }
                />
              </label>
              <label className="full">
                Search Console property
                <input
                  value={draft.gsc_url}
                  onChange={(event) =>
                    setDraft({ ...draft, gsc_url: event.target.value })
                  }
                />
              </label>
              <label className="full">
                Deployment webhook
                <input
                  value={draft.deploy_webhook_url}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      deploy_webhook_url: event.target.value,
                    })
                  }
                  placeholder="https://…"
                />
                <small>
                  HTTPS only by default. Private targets require an explicit
                  server allowlist.
                </small>
              </label>
              <label className="checkbox-label full">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, enabled: event.target.checked })
                  }
                />{" "}
                Monitor this website
              </label>
            </div>
            <button
              className="btn btn-primary"
              disabled={
                !canManage ||
                busy === "save" ||
                !draft.name.trim() ||
                !draft.domain.trim() ||
                !draft.sitemap_url.trim()
              }
              onClick={saveSettings}
            >
              {busy === "save" ? <RefreshCw className="spin" /> : <Save />} Save
              website
            </button>
          </section>
          <aside className="ops-card">
            <div className="ops-card-head">
              <div>
                <span>Advanced delivery</span>
                <h2>Credentials and ownership</h2>
              </div>
              <ShieldCheck />
            </div>
            <p>
              Google/Bing account assignment, FTP credentials, IndexNow
              ownership and destructive actions remain in the advanced Sites
              manager.
            </p>
            <Link className="btn btn-secondary" to="/sites">
              Open advanced site manager
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
}
