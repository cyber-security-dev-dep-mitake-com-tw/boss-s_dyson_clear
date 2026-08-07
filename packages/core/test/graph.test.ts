import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphStore } from '../src/graph/store.js';
import { prov } from '../src/graph/provenance.js';

describe('GraphStore', () => {
  let db: GraphStore;
  beforeEach(() => {
    db = new GraphStore(':memory:');
  });
  afterEach(() => db.close());

  it('upserts nodes idempotently by (type,key) and patches props', () => {
    const a = db.upsertNode('File', '/x/a.txt', { sizeBytes: 10 });
    const b = db.upsertNode('File', '/x/a.txt', { mtimeMs: 5 });
    expect(a).toBe(b);
    expect(db.countNodes('File')).toBe(1);
    const node = db.getNode(a)!;
    expect(node.props.sizeBytes).toBe(10); // json_patch merged, not replaced
    expect(node.props.mtimeMs).toBe(5);
  });

  it('rejects unknown node types via CHECK constraint', () => {
    expect(() => db.upsertNode('Bogus' as never, 'k')).toThrow();
  });

  it('upserts edges uniquely by (src,dst,type)', () => {
    const f = db.upsertNode('File', '/f');
    const app = db.upsertNode('Application', 'com.x');
    const e1 = db.upsertEdge(f, app, 'OWNED_BY');
    const e2 = db.upsertEdge(f, app, 'OWNED_BY', { via: 'name' });
    expect(e1).toBe(e2);
  });

  it('stores and lists provenance', () => {
    const f = db.upsertNode('File', '/f');
    db.addProvenance('node', f, prov('junk-scanner@1', 'mac.user-cache', { glob: '*' }, 0.8));
    const list = db.listProvenance('node', f);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe('mac.user-cache');
    expect(list[0].evidence).toEqual({ glob: '*' });
  });

  it('verdict round-trip carries scanner provenance and status updates', () => {
    const id = db.addVerdict(
      {
        runId: 'r1',
        category: 'junk',
        action: 'trash',
        subjectKey: '/tmp/x/cache.bin',
        subjectType: 'File',
        label: 'cache.bin',
        sizeBytes: 42,
        smartSelected: true,
        detail: { kind: 'caches' },
      },
      prov('junk-scanner@1', 'sandbox.junk.caches', {}, 0.9),
    );
    const v = db.getVerdict(id)!;
    expect(v.status).toBe('proposed');
    expect(v.provenance.scanner).toBe('junk-scanner@1');
    expect(v.smartSelected).toBe(true);
    db.updateVerdictStatus(id, 'approved');
    expect(db.getVerdict(id)!.status).toBe('approved');
  });

  it('plans resolve by planId or runId and include verdicts', () => {
    db.addVerdict(
      {
        runId: 'r2', category: 'large', action: 'trash', subjectKey: '/tmp/a/big',
        subjectType: 'File', label: 'big', sizeBytes: 1000, smartSelected: false, detail: {},
      },
      prov('large-scanner@1', 'large.threshold', {}, 0.9),
    );
    db.createPlan('p2', 'r2', 1000);
    expect(db.getPlan('p2')!.verdicts).toHaveLength(1);
    expect(db.getPlan('r2')!.planId).toBe('p2');
    expect(db.getPlan('nope')).toBeNull();
  });

  it('receipts CRUD', () => {
    const id = db.addReceipt({
      verdictId: null, action: 'trash', path: '/tmp/a', trashRef: '/q/a',
      bytesFreed: 5, executedAt: 123, ok: true, error: null,
    });
    const r = db.getReceipt(id)!;
    expect(r.ok).toBe(true);
    expect(db.listReceipts()).toHaveLength(1);
  });

  describe('canned insight queries', () => {
    it('app-cache-aggregation sums owned cache bytes per app', () => {
      const app = db.upsertNode('Application', 'com.chrome', { name: 'Chrome' });
      const c1 = db.upsertNode('CacheLocation', '/c1', { sizeBytes: 100 });
      const c2 = db.upsertNode('CacheLocation', '/c2', { sizeBytes: 50 });
      db.upsertEdge(c1, app, 'OWNED_BY');
      db.upsertEdge(c2, app, 'OWNED_BY');
      const res = db.query('app-cache-aggregation');
      expect(res.queryId).toBe('app-cache-aggregation');
      expect(res.rows[0]).toMatchObject({ appName: 'Chrome', locations: 2, totalBytes: 150 });
    });

    it('duplicate-groups aggregates DUPLICATE_OF edges by canonical', () => {
      const canon = db.upsertNode('File', '/docs/orig.jpg', { sizeBytes: 10 });
      const d1 = db.upsertNode('File', '/dl/copy1.jpg', { sizeBytes: 10 });
      const d2 = db.upsertNode('File', '/dl/copy2.jpg', { sizeBytes: 10 });
      db.upsertEdge(d1, canon, 'DUPLICATE_OF');
      db.upsertEdge(d2, canon, 'DUPLICATE_OF');
      const res = db.query('duplicate-groups');
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ canonicalPath: '/docs/orig.jpg', copies: 2, wastedBytes: 20 });
      expect(res.rows[0].duplicatePaths).toEqual(expect.arrayContaining(['/dl/copy1.jpg', '/dl/copy2.jpg']));
    });

    it('orphaned-files lists paths owned by uninstalled apps', () => {
      const gone = db.upsertNode('Application', 'com.gone', { name: 'Gone', installed: 0 });
      const here = db.upsertNode('Application', 'com.here', { name: 'Here', installed: 1 });
      const o = db.upsertNode('Directory', '/lib/gone-support', { sizeBytes: 7 });
      const k = db.upsertNode('Directory', '/lib/here-support', { sizeBytes: 7 });
      db.upsertEdge(o, gone, 'OWNED_BY');
      db.upsertEdge(k, here, 'OWNED_BY');
      const res = db.query('orphaned-files');
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ path: '/lib/gone-support', appKey: 'com.gone' });
    });

    it('top-space-owners ranks apps by owned bytes', () => {
      const big = db.upsertNode('Application', 'com.big', { name: 'Big', sizeBytes: 5 });
      const small = db.upsertNode('Application', 'com.small', { name: 'Small', sizeBytes: 1 });
      const owned = db.upsertNode('Directory', '/big-data', { sizeBytes: 1000 });
      db.upsertEdge(owned, big, 'OWNED_BY');
      const res = db.query('top-space-owners');
      expect(res.rows[0]).toMatchObject({ appKey: 'com.big', totalBytes: 1005 });
      expect(res.rows[1]).toMatchObject({ appKey: 'com.small' });
    });
  });
});
