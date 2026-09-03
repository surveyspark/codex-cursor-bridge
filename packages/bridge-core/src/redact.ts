/**
 * Secret redaction for logs, results, and persisted events.
 *
 * The bridge redacts common credential shapes before anything is written to
 * disk or returned to a host. Redaction is best-effort by design: it catches
 * common API keys, bearer tokens, cookies, private keys, passwords, and
 * authorization headers, but cannot detect arbitrary secrets.
 */

const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  // OpenAI-style keys
  {
    name: "openai-key",
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replace: "sk-***REDACTED***",
  },
  {
    name: "openai-project",
    re: /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
    replace: "sk-proj-***REDACTED***",
  },
  // Anthropic
  {
    name: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replace: "sk-ant-***REDACTED***",
  },
  // Cursor API key (functional env var name is never logged with value)
  {
    name: "cursor-key",
    re: /\bkey_[A-Za-z0-9]{20,}\b/g,
    replace: "key_***REDACTED***",
  },
  // GitHub tokens
  {
    name: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replace: "gh***REDACTED***",
  },
  {
    name: "github-finegrained",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: "github_pat_***REDACTED***",
  },
  // AWS
  {
    name: "aws-access-key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: "AKIA***REDACTED***",
  },
  {
    name: "aws-secret",
    re: /\b(?:aws)?_?secret_?access_?key\s*[:=]\s*\S+/gi,
    replace: "aws_secret_access_key=***REDACTED***",
  },
  // Google
  {
    name: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: "AIza***REDACTED***",
  },
  // Slack
  {
    name: "slack-token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "xox***-***REDACTED***",
  },
  // Bearer / authorization headers
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=?=?/gi,
    replace: "Bearer ***REDACTED***",
  },
  {
    name: "authorization-header",
    re: /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi,
    replace: "$1: ***REDACTED***",
  },
  // Cookies
  {
    name: "cookie-header",
    re: /\bcookie\s*:\s*[^\n\r]{4,}/gi,
    replace: "cookie: ***REDACTED***",
  },
  {
    name: "set-cookie",
    re: /\bset-cookie\s*:\s*[^\n\r]{4,}/gi,
    replace: "set-cookie: ***REDACTED***",
  },
  // Private key blocks (single line and multiline)
  {
    name: "private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: "***REDACTED-PRIVATE-KEY***",
  },
  // password assignments
  {
    name: "password-assignment",
    re: /\b(password|passwd|pwd|pass|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
    replace: "$1=***REDACTED***",
  },
  // JSON-style "apiKey": "..." fields
  {
    name: "json-api-key",
    re: /("(?:apiKey|api_key|secret|token|password|accessToken|access_token|refreshToken|refresh_token)"\s*:\s*")([^"]{4,})(")/g,
    replace: "$1***REDACTED***$3",
  },
  // JWTs
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: "***REDACTED-JWT***",
  },
];

export interface RedactionResult {
  text: string;
  matches: string[];
}

/** Redact secrets from a string. Returns the sanitized text and pattern names hit. */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const matches: string[] = [];
  for (const { name, re, replace } of PATTERNS) {
    // Reset lastIndex for safety with global regexes.
    re.lastIndex = 0;
    if (re.test(text)) {
      matches.push(name);
      re.lastIndex = 0;
      text = text.replace(re, replace);
    }
  }
  return { text, matches };
}

export function redactString(input: string): string {
  return redactSecrets(input).text;
}

/** Deeply redact strings inside a JSON-like structure. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretEnvName(k) && typeof v === "string") {
        out[k] = "***REDACTED***";
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Environment variable names whose values must never be logged. */
const SECRET_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_API_KEY",
  "SLACK_BOT_TOKEN",
]);

/** Returns true when the environment variable name looks like a secret. */
export function isSecretEnvName(name: string): boolean {
  if (SECRET_ENV_NAMES.has(name)) return true;
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(name);
}
