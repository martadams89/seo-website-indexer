import { readResponseText, safeFetch } from '../security/outbound-url.js';

async function fetchUrl(url: string): Promise<{ text: string; statusCode: number }> {
  try {
    const response = await safeFetch(url, {
      headers: { 'User-Agent': 'OrganicCommand/1.0 (auditor)' },
      signal: AbortSignal.timeout(15_000),
    }, { label: 'GEO audit URL' });
    return { text: await readResponseText(response, 1_000_000, 'GEO audit response'), statusCode: response.status };
  } catch {
    return { text: '', statusCode: 0 };
  }
}

/**
 * Checks robots.txt rules to identify blocks targeting major AI bots:
 * GPTBot, Google-Extended, PerplexityBot, ClaudeBot.
 */
export async function auditRobotsTxt(domain: string): Promise<string> {
  let host = domain;
  if (host.includes('://')) host = host.split('://')[1];
  if (host.includes('/')) host = host.split('/')[0];
  
  const url = `https://${host}/robots.txt`;
  try {
    const { text, statusCode } = await fetchUrl(url);
    if (statusCode !== 200) {
      return 'ALLOWED'; // No robots.txt means all bots are allowed
    }

    const aiBots = ['gptbot', 'google-extended', 'perplexitybot', 'claudebot'];
    const lines = text.split('\n').map(l => l.trim().toLowerCase());
    
    let currentAgent = '';
    const blockedAgents = new Set<string>();

    for (const line of lines) {
      if (line.startsWith('#') || !line) continue;
      
      if (line.startsWith('user-agent:')) {
        currentAgent = line.split('user-agent:')[1].trim();
      } else if (line.startsWith('disallow:')) {
        const path = line.split('disallow:')[1].trim();
        // Disallowing root / blocks the bot
        if (path === '/' || path === '/*') {
          if (aiBots.includes(currentAgent)) {
            blockedAgents.add(currentAgent);
          } else if (currentAgent === '*') {
            // Wildcard Disallow blocks all bots unless explicitly overridden
            blockedAgents.add('*');
          }
        }
      }
    }

    if (blockedAgents.size > 0) {
      return `BLOCKED: ${[...blockedAgents].join(', ')}`;
    }
    return 'ALLOWED';
  } catch {
    return 'ALLOWED';
  }
}

/**
 * Checks for the existence of /llms.txt at the web root.
 */
export async function probeLlmsTxt(domain: string): Promise<string> {
  let host = domain;
  if (host.includes('://')) host = host.split('://')[1];
  if (host.includes('/')) host = host.split('/')[0];
  
  const url = `https://${host}/llms.txt`;
  try {
    const { statusCode } = await fetchUrl(url);
    return statusCode === 200 ? 'OK' : 'MISSING';
  } catch {
    return 'MISSING';
  }
}

export interface SchemaAuditResult {
  hasSchema: number;
  schemaTypes: string;
}

/**
 * Parses page HTML content to detect and inventory types of JSON-LD schemas.
 */
export function parseSemanticSchema(html: string): SchemaAuditResult {
  const schemaRegex = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = [...html.matchAll(schemaRegex)];
  
  if (matches.length === 0) {
    return { hasSchema: 0, schemaTypes: '' };
  }

  const foundTypes = new Set<string>();

  for (const match of matches) {
    try {
      const blockText = match[1].trim();
      // Robust regex capture matching structural types inside json blocks
      const typeMatches = [...blockText.matchAll(/"@type"\s*:\s*["']([^"']+)["']/g)];
      for (const tm of typeMatches) {
        foundTypes.add(tm[1]);
      }
    } catch { /* ignore JSON block parsing issues */ }
  }

  if (foundTypes.size > 0) {
    return {
      hasSchema: 1,
      schemaTypes: [...foundTypes].join(', ')
    };
  }

  return { hasSchema: 0, schemaTypes: '' };
}
