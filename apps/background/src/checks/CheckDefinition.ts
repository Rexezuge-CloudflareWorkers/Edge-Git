import { isBuiltInCheckContext, normalizeContext } from '@edge-git/backend-services/checks';
import { validateWebhookUrl } from '@edge-git/backend-services/webhook';

// Custom check definitions live in the repo at the checked SHA so the check
// travels with the code it tests (Actions-style). `.edgegit/checks.json`:
// `{ "checks": [{ "context": "lint", "script": ".edgegit/checks/lint.js",
// "env": { "LEVEL": "strict" }, "allowHosts": ["example.com"] }] }`.
//
// Trust model: definitions and scripts are repo contents, so anyone with
// `write+` could already push equivalent code. The sandbox therefore grants
// no credentials and no network by default; `allowHosts` only permits
// exact-host https fetches (SSRF literals still rejected). Resource abuse is
// bounded by per-step CPU/memory/fetch caps enforced in CustomJsSandbox.

export const CHECKS_FILE_PATH = '.edgegit/checks.json';
export const CHECKS_SCRIPT_DIR = '.edgegit/checks/';
const MAX_DEFINITION_BYTES = 16_384;
const MAX_CHECKS = 20;
const MAX_ENV_VARS = 10;
const MAX_ENV_VALUE = 1024;
const MAX_ALLOW_HOSTS = 10;

export interface CustomCheckDefinition {
  context: string;
  scriptPath: string;
  env: Record<string, string>;
  allowHosts: string[];
}

interface RepoBlob {
  contentBase64?: string;
  isBinary?: boolean;
}

interface RepoStubShape {
  getBlob(args: { ref?: string; filepath: string }): Promise<RepoBlob | null>;
}

export function decodeBlobToText(blob: RepoBlob | null, maxBytes: number): string | null {
  if (!blob?.contentBase64 || blob.isBinary) return null;
  try {
    const binary = atob(blob.contentBase64);
    if (binary.length > maxBytes) return null;
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const SCRIPT_PATH_RE = /^\.edgegit\/checks\/\w[\w.-]{0,99}\.js$/;
const ENV_KEY_RE = /^[a-z_]\w{0,63}$/i;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseOne(raw: unknown, index: number): CustomCheckDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`checks[${index}] must be an object`);
  const entry = raw as Record<string, unknown>;
  let context: string;
  try {
    context = normalizeContext(entry.context);
  } catch {
    throw new Error(`checks[${index}].context must be 1-200 chars of letters, digits, ".", "-", "_", "/"`);
  }
  if (isBuiltInCheckContext(context)) throw new Error(`checks[${index}].context "${context}" is a reserved built-in context`);
  const scriptPath = typeof entry.script === 'string' ? entry.script.trim() : '';
  if (!SCRIPT_PATH_RE.test(scriptPath)) throw new Error(`checks[${index}].script must be a .js file directly under .edgegit/checks/`);
  const env: Record<string, string> = {};
  if (entry.env !== undefined && entry.env !== null) {
    if (typeof entry.env !== 'object' || Array.isArray(entry.env)) throw new Error(`checks[${index}].env must be an object`);
    const pairs = Object.entries(entry.env as Record<string, unknown>);
    if (pairs.length > MAX_ENV_VARS) throw new Error(`checks[${index}].env must have at most ${MAX_ENV_VARS} entries`);
    for (const [key, value] of pairs) {
      if (!ENV_KEY_RE.test(key)) throw new Error(`checks[${index}].env key "${key}" is not a valid env name`);
      if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) throw new Error(`checks[${index}].env["${key}"] must be a string of at most ${MAX_ENV_VALUE} chars`);
      env[key] = value;
    }
  }
  const allowHosts: string[] = [];
  if (entry.allowHosts !== undefined && entry.allowHosts !== null) {
    if (!Array.isArray(entry.allowHosts)) throw new Error(`checks[${index}].allowHosts must be an array of hostnames`);
    if (entry.allowHosts.length > MAX_ALLOW_HOSTS) throw new Error(`checks[${index}].allowHosts must have at most ${MAX_ALLOW_HOSTS} entries`);
    for (const host of entry.allowHosts) {
      if (typeof host !== 'string') throw new Error(`checks[${index}].allowHosts entries must be strings`);
      const normalized = host.trim().toLowerCase();
      if (normalized.length === 0 || normalized.length > 253 || !HOST_RE.test(normalized)) {
        throw new Error(`checks[${index}].allowHosts entry "${host}" is not a valid hostname`);
      }
      // Reuse the webhook SSRF guard (rejects localhost, loopback, and
      // private/reserved literals). DNS-resolved private IPs are not covered
      // (no resolver in the request path) — same documented limitation.
      try {
        validateWebhookUrl(`https://${normalized}/`);
      } catch {
        throw new Error(`checks[${index}].allowHosts entry "${host}" targets a loopback, private, or reserved address`);
      }
      if (!allowHosts.includes(normalized)) allowHosts.push(normalized);
    }
  }
  return { context, scriptPath, env, allowHosts };
}

// Pure: parse and validate checks.json text. Throws with a human-readable
// reason consumable as the run's output summary.
export function parseCheckDefinitionFile(text: string): CustomCheckDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${CHECKS_FILE_PATH} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${CHECKS_FILE_PATH} must be an object with a "checks" array`);
  const list = (parsed as Record<string, unknown>).checks;
  if (!Array.isArray(list)) throw new Error(`${CHECKS_FILE_PATH} must contain a "checks" array`);
  if (list.length > MAX_CHECKS) throw new Error(`${CHECKS_FILE_PATH} must define at most ${MAX_CHECKS} checks`);
  const seen = new Set<string>();
  const checks = list.map((raw, index) => parseOne(raw, index));
  for (const check of checks) {
    const key = check.context.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate context "${check.context}" in ${CHECKS_FILE_PATH}`);
    seen.add(key);
  }
  return checks;
}

export type LoadedDefinition = { state: 'absent' } | { state: 'ok'; checks: CustomCheckDefinition[] } | { state: 'error'; message: string };

// Load definitions at a SHA. `absent` means no file (custom contexts stay
// queued for external runners); `error` carries the summary for
// action_required runs.
export async function loadCheckDefinition(repoStub: RepoStubShape, headSha: string): Promise<LoadedDefinition> {
  const blob = await repoStub.getBlob({ ref: headSha, filepath: CHECKS_FILE_PATH }).catch(() => null);
  if (!blob) return { state: 'absent' };
  const text = decodeBlobToText(blob, MAX_DEFINITION_BYTES);
  if (text === null) return { state: 'error', message: `${CHECKS_FILE_PATH} is missing, binary, or larger than ${MAX_DEFINITION_BYTES} bytes` };
  try {
    return { state: 'ok', checks: parseCheckDefinitionFile(text) };
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid check definition file.' };
  }
}

export async function loadCheckScript(repoStub: RepoStubShape, headSha: string, scriptPath: string, maxBytes: number): Promise<string | null> {
  const blob = await repoStub.getBlob({ ref: headSha, filepath: scriptPath }).catch(() => null);
  return decodeBlobToText(blob, maxBytes);
}
