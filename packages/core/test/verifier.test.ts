import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { verify } from '../src/verifier/verifier.js';
import { checkProtectedPath, isUnderUserContentDir } from '../src/verifier/rules.js';
import { prov } from '../src/graph/provenance.js';
import type { Candidate } from '../src/scanners/types.js';

function cand(subjectKey: string, over: Partial<Candidate> = {}): Candidate {
  return {
    category: 'junk',
    action: 'trash',
    subjectKey,
    subjectType: 'File',
    label: path.basename(subjectKey),
    sizeBytes: 10,
    smartSelected: true,
    provenance: prov('junk-scanner@1', 'sandbox.junk.caches', {}, 0.9),
    detail: {},
    ...over,
  };
}

describe('checkProtectedPath (pure path logic — never touches /System)', () => {
  it('rejects the hard-deny roots', () => {
    for (const p of [
      '/System/Library/Caches/x',
      '/usr/lib/libfoo.dylib',
      '/bin/ls',
      '/sbin/mount',
      '/private/var/db/thing',
      '/Library/Extensions/x.kext',
    ]) {
      expect(checkProtectedPath(p).ok, p).toBe(false);
    }
  });

  it('rejects Windows protected roots', () => {
    expect(checkProtectedPath('C:\\Windows\\System32\\cmd.exe').ok).toBe(false);
    expect(checkProtectedPath('C:\\Program Files\\App\\x.exe').ok).toBe(false);
    expect(checkProtectedPath('C:\\Program Files (x86)\\App\\x.exe').ok).toBe(false);
    expect(checkProtectedPath('C:\\Users\\bob\\AppData\\Local\\Temp\\x.tmp').ok).toBe(true);
  });

  it('rejects shallow paths (depth < 2 from filesystem root)', () => {
    expect(checkProtectedPath('/').ok).toBe(false);
    expect(checkProtectedPath('/Users').ok).toBe(false);
    expect(checkProtectedPath('C:\\').ok).toBe(false);
    expect(checkProtectedPath('C:\\stray.txt').ok).toBe(false);
  });

  it("allows the user's own ~/Library but not system /Library", () => {
    const home = os.homedir();
    expect(checkProtectedPath(path.join(home, 'Library/Caches/x')).ok).toBe(true);
    expect(checkProtectedPath('/Library/Caches/x').ok).toBe(false);
  });

  it('/Applications is protected except for the uninstall category', () => {
    expect(checkProtectedPath('/Applications/Foo.app').ok).toBe(false);
    expect(checkProtectedPath('/Applications/Foo.app', { category: 'uninstall' }).ok).toBe(true);
  });

  it('rejects the sweepdeck DB itself and the app dirs', () => {
    expect(checkProtectedPath('/tmp/deep/graph.db', { dbPath: '/tmp/deep/graph.db' }).ok).toBe(false);
    expect(checkProtectedPath('/tmp/deep/graph.db-wal', { dbPath: '/tmp/deep/graph.db' }).ok).toBe(false);
    expect(checkProtectedPath('/tmp/deep/other.txt', { dbPath: '/tmp/deep/graph.db' }).ok).toBe(true);
    const home = os.homedir();
    expect(checkProtectedPath(path.join(home, '.sweepdeck/quarantine/x')).ok).toBe(false);
  });
});

describe('verify()', () => {
  it('rejects protected-path candidates with verifier provenance', async () => {
    const [v] = await verify([cand('/System/Library/Caches/apple.thing')], { root: '/sandbox' });
    expect(v.status).toBe('rejected');
    expect(v.verifierProvenance.some((p) => p.rule === 'verify.protected-path')).toBe(true);
    expect(v.verifierProvenance[0].scanner).toBe('verifier@1');
  });

  it('rejects junk under Documents/Desktop/Pictures', async () => {
    const [docs] = await verify([cand('/Users/bob/Documents/report.log')], { root: '/sandbox' });
    expect(docs.status).toBe('rejected');
    expect(docs.verifierProvenance.some((p) => p.rule === 'verify.junk.user-content-dir')).toBe(true);

    // but a LARGE-category candidate in Documents is allowed (user chose to scan it)
    const [large] = await verify([cand('/Users/bob/Documents/huge.mov', { category: 'large' })], { root: '/sandbox' });
    expect(large.status).toBe('proposed');
  });

  it('downgrades trash → advise when scanner confidence < 0.5', async () => {
    const low = cand('/Users/bob/Downloads/maybe.dat', {
      provenance: prov('junk-scanner@1', 'weak-rule', {}, 0.3),
    });
    const [v] = await verify([low], { root: '/sandbox' });
    expect(v.status).toBe('proposed');
    expect(v.action).toBe('advise');
    expect(v.verifierProvenance.some((p) => p.rule === 'verify.low-confidence')).toBe(true);
  });

  it('downgrades recently-modified files in real (non-sandbox) mode', async () => {
    const fresh = cand('/Users/bob/Downloads/fresh.dat', {
      provenance: prov('junk-scanner@1', 'r', { mtimeMs: Date.now() - 1000 }, 0.9),
    });
    const [real] = await verify([fresh], { openFileCheck: async () => new Set() });
    expect(real.action).toBe('advise');
    expect(real.verifierProvenance.some((p) => p.rule === 'verify.recent-mtime')).toBe(true);
    // sandbox mode keeps fixtures deterministic — no mtime downgrade
    const [sandbox] = await verify([fresh], { root: '/sandbox' });
    expect(sandbox.action).toBe('trash');
  });

  it('downgrades files held open (injected open-file check)', async () => {
    const target = '/Users/bob/Library/Caches/app/held.db';
    const [v] = await verify([cand(target, { provenance: prov('s', 'r', { mtimeMs: 0 }, 0.9) })], {
      openFileCheck: async () => new Set([target]),
    });
    expect(v.action).toBe('advise');
    expect(v.verifierProvenance.some((p) => p.rule === 'verify.open-file')).toBe(true);
  });

  it('passes clean candidates through with a verify.pass record', async () => {
    const [v] = await verify([cand('/Users/bob/Downloads/x/cache.bin')], { root: '/sandbox' });
    expect(v.status).toBe('proposed');
    expect(v.action).toBe('trash');
    expect(v.verifierProvenance.map((p) => p.rule)).toEqual(['verify.pass']);
  });
});

describe('isUnderUserContentDir', () => {
  it('matches any ancestor named Documents/Desktop/Pictures, not the file itself', () => {
    expect(isUnderUserContentDir('/u/Documents/x/y.log')).toBe(true);
    expect(isUnderUserContentDir('/u/desktop/y.tmp')).toBe(true);
    expect(isUnderUserContentDir('C:\\Users\\b\\Pictures\\a.tmp')).toBe(true);
    expect(isUnderUserContentDir('/u/Downloads/Documents.log')).toBe(false);
  });
});
