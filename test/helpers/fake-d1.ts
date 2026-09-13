/**
 * A tiny D1 stand-in for service-layer tests: each prepared SQL string is matched
 * (by substring) against a table of canned responses. Anything unmatched throws,
 * so a test cannot silently pass on a query it never modelled.
 */
export interface FakeRoute {
  match: string | RegExp;
  rows?: unknown[];
  first?: unknown;
  /** Throw instead of answering — models a missing table. */
  error?: string;
}

export interface FakeD1 extends D1Database {
  /** Every SQL string prepared, in order. */
  log: string[];
}

export function fakeD1(routes: FakeRoute[]): FakeD1 {
  const log: string[] = [];
  const find = (sql: string) =>
    routes.find((r) => (typeof r.match === 'string' ? sql.includes(r.match) : r.match.test(sql)));
  const stmt = (sql: string): D1PreparedStatement => {
    const self: D1PreparedStatement = {
      bind: () => self,
      all: async () => {
        const r = find(sql);
        if (!r) throw new Error(`unmodelled query: ${sql}`);
        if (r.error) throw new Error(r.error);
        return { results: (r.rows ?? []) as never, success: true, meta: {} as never };
      },
      first: async () => {
        const r = find(sql);
        if (!r) throw new Error(`unmodelled query: ${sql}`);
        if (r.error) throw new Error(r.error);
        return (r.first ?? (r.rows ?? [])[0] ?? null) as never;
      },
      run: async () => ({ success: true, meta: { changes: 1 } as never, results: [] as never }),
      raw: async () => [] as never,
    } as unknown as D1PreparedStatement;
    return self;
  };
  return {
    log,
    prepare: (sql: string) => {
      log.push(sql);
      return stmt(sql);
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as FakeD1;
}
