import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// AI llms.txt generation: gather real page context (stubbed) and drive a
// configured provider (stubbed) to produce the file. Verifies provider
// selection, context gathering, code-fence stripping and persistence.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-genllms-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'genllms-secret';

type DbMod = typeof import('../db/database.js');
type GenMod = typeof import('../ai/generate-llms.js');
let db: DbMod;
let gen: GenMod;

beforeAll(async () => {
  db = await import('../db/database.js');
  gen = await import('../ai/generate-llms.js');
});

function makeSite() {
  const id = `s-${randomUUID().slice(0, 8)}`;
  const host = `${id}.example.com`;
  db.upsertSite({ id, name: 'Acme Co', domain: host, sitemap_url: `https://${host}/sitemap.xml`, gsc_url: `https://${host}/`, enabled: 1, workspace_id: null });
  db.upsertUrlState({ url: `https://${host}/`, site_id: id });
  db.upsertUrlState({ url: `https://${host}/pricing`, site_id: id });
  db.upsertUrlState({ url: `https://${host}/docs/start`, site_id: id });
  db.upsertUrlState({ url: `https://${host}/llms.txt`, site_id: id }); // non-HTML, must be excluded
  return db.getSiteById(id)!;
}

describe('AI llms.txt generation', () => {
  it('picks the configured provider and returns cleaned content', async () => {
    const site = makeSite();
    db.setSetting('anthropic_api_key', 'sk-test');
    expect(gen.llmsGenerationProvider()).toBe('anthropic');

    const scanned: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('api.anthropic.com')) {
        // Model wraps output in a code fence — we must strip it.
        return { ok: true, status: 200, json: async () => ({ content: [{ text: '```markdown\n# Acme Co\n\n> Acme builds widgets.\n\n## Docs\n- [Start](https://acme.com/docs/start): getting started.\n```' }] }) } as unknown as Response;
      }
      scanned.push(u);
      return { ok: true, status: 200, text: async () => `<html><head><title>Page ${u}</title><meta name="description" content="About ${u}"></head><body><h1>H1</h1></body></html>` } as unknown as Response;
    }));

    const result = await gen.generateLlmsTxt(site);
    expect(result.provider).toBe('anthropic');
    expect(result.content.startsWith('# Acme Co')).toBe(true);
    expect(result.content).not.toContain('```');           // fence stripped
    expect(result.content).toContain('[Start](https://acme.com/docs/start)');
    expect(result.pagesScanned).toBeGreaterThan(0);
    // The non-HTML llms.txt URL must not have been scraped.
    expect(scanned.some(u => u.endsWith('/llms.txt'))).toBe(false);
    vi.restoreAllMocks();
  });

  it('refuses when no AI provider is configured', async () => {
    const site = makeSite();
    db.setSetting('anthropic_api_key', '');
    db.setSetting('openai_api_key', '');
    db.setSetting('gemini_api_key', '');
    db.setSetting('xai_api_key', '');
    db.setSetting('perplexity_api_key', '');
    expect(gen.llmsGenerationProvider()).toBeNull();
    await expect(gen.generateLlmsTxt(site)).rejects.toThrow(/No AI provider/);
  });

  it('persists and clears custom llms content', () => {
    const site = makeSite();
    db.setSiteLlmsContent(site.id, '# Custom\n\n> mine\n');
    expect(db.getSiteById(site.id)!.llms_txt_content).toContain('# Custom');
    db.setSiteLlmsContent(site.id, '');
    expect(db.getSiteById(site.id)!.llms_txt_content ?? null).toBeNull();
  });
});
