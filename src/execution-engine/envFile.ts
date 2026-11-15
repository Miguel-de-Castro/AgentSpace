import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * .claude/plans/25-run-do-project.md - reading a repo's `.env.example` so the
 * supervisor can fill in the values, and rendering the `.env` that "Run" writes.
 * Pure text handling: no git, no database, no processes.
 */

export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"] as const;

export interface EnvVar {
  name: string;
  /** The value written in the example file (quotes removed); often empty or a placeholder. */
  default: string;
  /** The comment right above (or after) the variable, as a hint. */
  comment: string | null;
  /** The name suggests a credential, so the UI masks the field. */
  secret: boolean;
}

const SECRET_HINT = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;

export function looksSecret(name: string): boolean {
  return SECRET_HINT.test(name);
}

export function findEnvExample(folder: string): string | null {
  for (const file of ENV_EXAMPLE_FILES) {
    if (existsSync(join(folder, file))) return join(folder, file);
  }
  return null;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** Variables of an example file, in file order, first definition wins. */
export function parseEnvExample(text: string): EnvVar[] {
  const vars: EnvVar[] = [];
  const seen = new Set<string>();
  let pending: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      pending = [];
      continue;
    }
    if (line.startsWith("#")) {
      pending.push(line.replace(/^#+\s*/, ""));
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      pending = [];
      continue;
    }
    const [, name, rest] = match;
    let value = rest;
    let trailing: string | null = null;
    // An unquoted value ends at ` #`; a quoted one ends at its closing quote.
    const quoted = /^(["'])/.exec(rest.trim());
    if (quoted) {
      const close = rest.trim().indexOf(quoted[1], 1);
      if (close > 0) {
        value = rest.trim().slice(0, close + 1);
        const after = rest.trim().slice(close + 1).trim();
        if (after.startsWith("#")) trailing = after.replace(/^#+\s*/, "");
      }
    } else {
      const hash = rest.indexOf(" #");
      if (hash >= 0) {
        value = rest.slice(0, hash);
        trailing = rest.slice(hash).replace(/^\s*#+\s*/, "");
      }
    }
    if (!seen.has(name)) {
      seen.add(name);
      const comment = [...pending, trailing].filter((c): c is string => Boolean(c)).join(" ").trim();
      vars.push({ name, default: unquote(value), comment: comment || null, secret: looksSecret(name) });
    }
    pending = [];
  }
  return vars;
}

export function readEnvExample(folder: string): EnvVar[] {
  const file = findEnvExample(folder);
  return file ? parseEnvExample(readFileSync(file, "utf-8")) : [];
}

function renderValue(value: string): string {
  return /[\s#"'\\$`]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

/**
 * The `.env` text: every variable of the example, the saved value when there is
 * one, else the example's own default; then any saved extras the example doesn't
 * list.
 */
export function renderEnv(vars: EnvVar[], values: Record<string, string>): string {
  const lines: string[] = [];
  const listed = new Set<string>();
  for (const v of vars) {
    listed.add(v.name);
    lines.push(`${v.name}=${renderValue(values[v.name] ?? v.default)}`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!listed.has(name)) lines.push(`${name}=${renderValue(value)}`);
  }
  return lines.join("\n") + "\n";
}
