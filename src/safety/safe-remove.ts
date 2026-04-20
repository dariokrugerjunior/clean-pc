import fs from 'fs/promises';
import { normalize } from 'path';
import { SACRED_PATHS } from './sacred-paths.js';

export class SafetyError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SafetyError'; }
}

export class SecurityError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SecurityError'; }
}

function normLower(p: string): string {
  return normalize(p).toLowerCase();
}

function isBlocked(filePath: string): boolean {
  const n = normLower(filePath);
  return SACRED_PATHS.some(blocked => n === blocked || n.startsWith(blocked + '\\'));
}

/**
 * Safely remove a single file.
 *
 * Checks (in order):
 * 1. Sacred paths — hardcoded system directories, never deletable
 * 2. Symlink guard — detects symlink substitution (TOCTOU)
 * 3. Existence check — idempotent, skip if already gone
 * 4. Dry-run — skip actual deletion
 * 5. Delete via fs.rm
 *
 * Returns { success, error } — never throws (callers accumulate failures).
 */
export async function safeRemove(
  filePath: string,
  dryRun: boolean,
): Promise<{ success: boolean; error?: string }> {
  // 1. Sacred path check
  if (isBlocked(filePath)) {
    return { success: false, error: `BLOCKED: path is in a protected system directory` };
  }

  // 2. Symlink guard (TOCTOU protection)
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { success: true }; // already gone
    return { success: false, error: `lstat failed: ${String(err)}` };
  }

  if (stat.isSymbolicLink()) {
    return { success: false, error: `SECURITY: symlink detected at deletion time, skipping` };
  }

  // 3. Dry-run
  if (dryRun) return { success: true };

  // 4. Delete
  try {
    await fs.rm(filePath, { force: true, recursive: false });
    return { success: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { success: true }; // race: gone between lstat and rm
    return { success: false, error: String(err) };
  }
}
