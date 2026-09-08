import { apiFetch } from '../api/client';
export type AuditJob = {
  id: string;
  site_id: string;
  state: string;
  completed: number;
  total: number;
  error: string | null;
};
export async function waitForAudit(
  id: string,
  onProgress: (job: AuditJob) => void,
  signal?: AbortSignal,
): Promise<AuditJob> {
  for (;;) {
    const job = await discovery.get<AuditJob>(`jobs/${id}`, signal);
    onProgress(job);
    if (job.state !== 'running') return job;
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(new DOMException('Polling cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', stop);
        resolve();
      }, 1500);
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  }
}
export type Finding = {
  code: string;
  url: string;
  area: string;
  severity: string;
  title: string;
  evidence: string;
  fix: string;
  source: string;
};
export type PageEvidence = {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  canonical: string;
  words: number;
  h1: string[];
  schemaTypes: string[];
  links: Array<{ url: string; anchor: string; rel: string[] }>;
};
export type AuditReport = {
  id: string;
  site_id: string;
  observed_at: string;
  attempted: number;
  inventory: number;
  pages: PageEvidence[];
  failures: Array<{ url: string; error: string }>;
  findings: Finding[];
  methodology: string;
};
export type AuditData = {
  history: Array<Pick<AuditReport, 'id' | 'observed_at' | 'attempted' | 'inventory'>>;
  report: AuditReport | null;
  comparison: {
    comparablePages: number;
    new: Finding[];
    resolved: Finding[];
    persisting: Finding[];
    unverified: Finding[];
  } | null;
};
export type ListingDraft = {
  platform: 'apple' | 'google';
  locale: string;
  name: string;
  subtitle: string;
  description: string;
  keywords: string;
  promotional_text: string;
  target_terms: string[];
};
export type ListingAnalysis = {
  fields: Array<{ field: string; length: number; limit: number; required: boolean; status: string }>;
  findings: Array<{ title: string; detail: string; kind: string }>;
  terms: Array<{ term: string; fields: string[] }>;
  source: string;
  methodology: string;
};
export type AppListing = {
  id: string;
  site_id: string | null;
  draft: ListingDraft;
  analysis: ListingAnalysis;
  created_at: string;
  updated_at: string;
};
export type Backlink = {
  notes: string;
  enabled: number;
  id: string;
  site_id: string;
  source_url: string;
  target_url: string;
  provenance: string;
  status: string;
  evidence: {
    status?: number;
    final_url?: string;
    anchors?: string[];
    rel?: string[];
    targets?: string[];
    links?: Array<{ url: string; anchor: string; rel: string[] }>;
    error?: string;
    changes?: string[];
    previous_status?: string;
  };
  first_seen: string;
  checked_at: string | null;
};
export type OpportunityData = {
  from: string;
  previousFrom: string;
  to: string;
  methodology: string;
  opportunities: Array<{
    site_id: string;
    site_name: string;
    query: string;
    clicks: number;
    impressions: number;
    previous_clicks: number;
    previous_impressions: number;
    position: number;
    current_days: number;
    previous_days: number;
    kind: string;
    ctr: number;
    reason: string;
    confidence: string;
  }>;
};
export const discovery = {
  get: <T>(path: string, signal?: AbortSignal) => apiFetch<T>(`/api/platform/discovery/${path}`, { signal }),
  post: <T>(path: string, data: unknown) =>
    apiFetch<T>(`/api/platform/discovery/${path}`, { method: 'POST', body: JSON.stringify(data) }),
};
