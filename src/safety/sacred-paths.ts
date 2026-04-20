import { normalize } from 'path';

// These specific directories are NEVER deletable, regardless of any configuration.
// Intentionally narrow — we protect system binaries, not all of C:\Windows.
// C:\Windows\Temp and C:\Windows\Logs are legitimate cleanup targets and must NOT be here.
export const SACRED_PATHS: string[] = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Windows\\WinSxS',
  'C:\\Windows\\servicing',
  'C:\\Windows\\boot',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
].map(p => normalize(p).toLowerCase());
