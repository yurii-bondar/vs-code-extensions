// What to look at before a push: credentials the agents' changes add, and git hooks they change. Read from the diff
// the push would publish; the question about the push shows it, and you decide.

/** A line the diff adds that looks like a credential, or a file that holds them by its name. */
interface SecretFinding {
  file: string;
  /** The line in the new file; none for a finding by name. */
  line?: number;
  /** What it looks like: "a GitHub token", "a private key". */
  what: string;
  /** The start of the match and its length, never the whole of it. */
  excerpt?: string;
}

// Every repetition is bounded: an added line can be a megabyte of minified code, and a pattern that may run to the end
// of the line from each place it starts takes the square of that, in the extension host where the guard answers too.

/** Patterns of credentials that are rarely anything else. */
const PATTERNS: { what: string; re: RegExp }[] = [
  { what: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { what: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/ },
  { what: 'a Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,255}/ },
  { what: 'a private key', re: /-----BEGIN (?:[A-Z]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/ },
  { what: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { what: 'a Stripe live key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,255}\b/ },
  { what: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { what: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,255}/ },
  { what: 'an OpenAI API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,255}/ },
  { what: 'an Atlassian API token', re: /\bATATT3[A-Za-z0-9_=-]{40,255}/ },
  { what: 'a Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,255}/ },
];

/** A password in a URL (`postgres://app:s3cret@db.prod…`, `redis://:s3cret@…`), except to this machine or a placeholder host. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^/\s:@'"]{0,255}:([^/\s@'"]{1,255})@([^/\s:'"?#]{1,255})/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[^.]+|.*\.(example|test|local|invalid))$/i;
const PLACEHOLDER = /^(\$\{?\w+\}?|<[^>]*>|\*+|x+|password|pass|secret|changeme|\{\{.*\}\})$/i;

/** Files that hold credentials by what they are called. */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx|keystore|jks)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?)$/i;

/**
 * Files that act outside the sandbox once pushed or used: a git hook manager's, which run when you use git in the repo;
 * `.lfsconfig`, which says where Git LFS uploads go; a `CLAUDE.md`, which every Claude Code session there takes as
 * instructions; Claude Code's and VS Code's settings (`.claude/`, `.mcp.json`, `.vscode/`), whose hooks, MCP servers and
 * tasks run (a change there you applied from an agent, or one of yours).
 */
const HOOK_FILE = /^(\.husky\/|\.githooks\/|\.git-hooks\/|\.lefthook\/|\.?lefthook(-local)?\.ya?ml$|\.pre-commit-config\.yaml$|\.lfsconfig$|\.claude\/|\.mcp\.json$|\.vscode\/)|(^|\/)CLAUDE\.md$/;

const excerptOf = (match: string): string => `${match.slice(0, 6)}… (${match.length} characters)`;

/**
 * Reads a unified diff (`git diff base..branch`): credentials on the lines it adds, files that hold credentials by
 * name, and changed files of git hook managers (`.husky/`, `lefthook.yml`) or of `hooksDir` (relative to the repo).
 */
function scanDiff(diff: string, { hooksDir }: { hooksDir?: string | undefined } = {}): { secrets: SecretFinding[]; hooks: string[] } {
  const secrets: SecretFinding[] = [];
  const hooks = new Set<string>();
  let file: string | null = null;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) {
      const name = text.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
      file = name === '/dev/null' ? null : name;
      if (file && SECRET_FILE.test(file)) secrets.push({ file, what: 'a file that holds credentials by its name' });
      if (file && (HOOK_FILE.test(file) || (hooksDir && hooksDir !== '.' && (file === hooksDir || file.startsWith(`${hooksDir}/`))))) hooks.add(file);
      continue;
    }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (text.startsWith('+')) {
      const added = text.slice(1);
      for (const { what, re } of PATTERNS) {
        const m = added.match(re);
        if (m) secrets.push({ file, line, what, excerpt: excerptOf(m[0]) });
      }
      const url = added.match(URL_PASSWORD);
      if (url && !LOCAL_HOST.test(url[2]!) && !PLACEHOLDER.test(url[1]!)) secrets.push({ file, line, what: 'a password in a URL', excerpt: excerptOf(url[0]) });
      line++;
    } else if (!text.startsWith('-') && !text.startsWith('\\')) line++;
  }
  return { secrets, hooks: [...hooks] };
}

export type { SecretFinding };
export { scanDiff };
