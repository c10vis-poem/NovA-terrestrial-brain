// Local drop-in replacement for @supabase/supabase-js's createClient(), backed
// directly by a local Postgres instance (no PostgREST/Supabase platform).
// Implements only the query-builder surface this codebase actually calls:
// from/select/eq/neq/gt/gte/lt/lte/like/ilike/is/in/contains/order/limit/
// single/insert/update/upsert/delete/rpc. All values are passed as bound
// parameters ($1, $2, ...) — never string-interpolated. Table/column names
// come from this repo's own source (not external input) and are still
// identifier-quoted defensively.
import postgres from "npm:postgres@3";

type Row = Record<string, unknown>;
type FilterOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like" | "ilike" | "is" | "in" | "contains";

interface Filter {
  col: string;
  op: FilterOp;
  val: unknown;
}

interface Result<T> {
  data: T | null;
  error: { message: string } | null;
  count?: number | null;
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

// Columns known to hold pgvector values; array-of-number params targeting
// these columns are cast to ::vector instead of the jsonb/array default.
const VECTOR_COLUMNS = new Set(["embedding", "query_embedding"]);

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

function valueCast(col: string, val: unknown): string {
  if (isNumberArray(val) && VECTOR_COLUMNS.has(col)) return "::vector";
  if (val !== null && typeof val === "object" && !Array.isArray(val)) return "::jsonb";
  return "";
}

function toParam(col: string, val: unknown): unknown {
  if (isNumberArray(val) && VECTOR_COLUMNS.has(col)) return `[${val.join(",")}]`;
  if (val !== null && typeof val === "object" && !Array.isArray(val)) return JSON.stringify(val);
  return val;
}

export function createLocalClient(connectionString: string) {
  const sql = postgres(connectionString, { max: 5, prepare: false });

  class QueryBuilder<T = Row> implements PromiseLike<Result<T[]>> {
    private table: string;
    private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    private selectCols = "*";
    private wantCount = false;
    private headOnly = false;
    private filters: Filter[] = [];
    private orderCol?: { col: string; ascending: boolean };
    private limitN?: number;
    private singleMode = false;
    private payload?: Row | Row[];
    private conflictCols?: string;

    constructor(table: string) {
      this.table = table;
    }

    select(cols = "*", opts?: { count?: "exact"; head?: boolean }) {
      this.selectCols = cols;
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.headOnly = true;
      return this;
    }
    eq(col: string, val: unknown) { this.filters.push({ col, op: "eq", val }); return this; }
    neq(col: string, val: unknown) { this.filters.push({ col, op: "neq", val }); return this; }
    gt(col: string, val: unknown) { this.filters.push({ col, op: "gt", val }); return this; }
    gte(col: string, val: unknown) { this.filters.push({ col, op: "gte", val }); return this; }
    lt(col: string, val: unknown) { this.filters.push({ col, op: "lt", val }); return this; }
    lte(col: string, val: unknown) { this.filters.push({ col, op: "lte", val }); return this; }
    like(col: string, val: unknown) { this.filters.push({ col, op: "like", val }); return this; }
    ilike(col: string, val: unknown) { this.filters.push({ col, op: "ilike", val }); return this; }
    is(col: string, val: unknown) { this.filters.push({ col, op: "is", val }); return this; }
    in(col: string, vals: unknown[]) { this.filters.push({ col, op: "in", val: vals }); return this; }
    contains(col: string, val: unknown) { this.filters.push({ col, op: "contains", val }); return this; }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = { col, ascending: opts?.ascending ?? true };
      return this;
    }
    limit(n: number) { this.limitN = n; return this; }
    single() { this.singleMode = true; return this; }
    maybeSingle() { this.singleMode = true; return this; }

    insert(payload: Row | Row[]) { this.mode = "insert"; this.payload = payload; return this; }
    update(payload: Row) { this.mode = "update"; this.payload = payload; return this; }
    upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
      this.mode = "upsert";
      this.payload = payload;
      this.conflictCols = opts?.onConflict;
      return this;
    }
    delete() { this.mode = "delete"; return this; }

    private buildWhere(params: unknown[]): string {
      if (this.filters.length === 0) return "";
      const clauses = this.filters.map((f) => {
        const col = quoteIdent(f.col);
        switch (f.op) {
          case "eq":
            params.push(toParam(f.col, f.val));
            return `${col} = $${params.length}${valueCast(f.col, f.val)}`;
          case "neq":
            params.push(toParam(f.col, f.val));
            return `${col} <> $${params.length}${valueCast(f.col, f.val)}`;
          case "gt":
            params.push(f.val);
            return `${col} > $${params.length}`;
          case "gte":
            params.push(f.val);
            return `${col} >= $${params.length}`;
          case "lt":
            params.push(f.val);
            return `${col} < $${params.length}`;
          case "lte":
            params.push(f.val);
            return `${col} <= $${params.length}`;
          case "like":
            params.push(f.val);
            return `${col} LIKE $${params.length}`;
          case "ilike":
            params.push(f.val);
            return `${col} ILIKE $${params.length}`;
          case "is":
            if (f.val === null) return `${col} IS NULL`;
            if (f.val === true) return `${col} IS TRUE`;
            if (f.val === false) return `${col} IS FALSE`;
            params.push(f.val);
            return `${col} IS $${params.length}`;
          case "in": {
            const vals = f.val as unknown[];
            if (vals.length === 0) return "FALSE";
            const placeholders = vals.map((v) => { params.push(v); return `$${params.length}`; });
            return `${col} IN (${placeholders.join(",")})`;
          }
          case "contains":
            params.push(JSON.stringify(f.val));
            return `${col} @> $${params.length}::jsonb`;
        }
      });
      return " WHERE " + clauses.join(" AND ");
    }

    private buildSelectCols(): string {
      if (this.selectCols.trim() === "*") return "*";
      return this.selectCols
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => quoteIdent(c))
        .join(", ");
    }

    private async execute(): Promise<Result<T[]>> {
      try {
        const params: unknown[] = [];
        const table = quoteIdent(this.table);
        let text: string;

        if (this.mode === "select") {
          if (this.wantCount && this.headOnly) {
            text = `SELECT COUNT(*)::int AS count FROM ${table}${this.buildWhere(params)}`;
            const rows = await sql.unsafe(text, params as never[]);
            return { data: null, error: null, count: (rows[0] as Row)?.count as number ?? 0 };
          }
          text = `SELECT ${this.buildSelectCols()} FROM ${table}${this.buildWhere(params)}`;
          if (this.orderCol) {
            text += ` ORDER BY ${quoteIdent(this.orderCol.col)} ${this.orderCol.ascending ? "ASC" : "DESC"}`;
          }
          if (this.limitN != null) text += ` LIMIT ${Number(this.limitN)}`;
          const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
          if (this.singleMode) {
            const row = (rows as unknown as Row[])[0] ?? null;
            return { data: row as unknown as T, error: null } as unknown as Result<T[]>;
          }
          return { data: rows, error: null };
        }

        if (this.mode === "insert") {
          const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
          if (rowsIn.length === 0) return { data: [] as unknown as T[], error: null };
          const cols = Object.keys(rowsIn[0]);
          const valueRows = rowsIn.map((r) => {
            const placeholders = cols.map((c) => {
              params.push(toParam(c, r[c]));
              return `$${params.length}${valueCast(c, r[c])}`;
            });
            return `(${placeholders.join(", ")})`;
          });
          text = `INSERT INTO ${table} (${cols.map(quoteIdent).join(", ")}) VALUES ${valueRows.join(", ")} RETURNING *`;
          const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
          if (this.singleMode) {
            const row = (rows as unknown as Row[])[0] ?? null;
            return { data: row as unknown as T, error: null } as unknown as Result<T[]>;
          }
          return { data: rows, error: null };
        }

        if (this.mode === "update") {
          const payload = this.payload as Row;
          const cols = Object.keys(payload);
          const setClauses = cols.map((c) => {
            params.push(toParam(c, payload[c]));
            return `${quoteIdent(c)} = $${params.length}${valueCast(c, payload[c])}`;
          });
          text = `UPDATE ${table} SET ${setClauses.join(", ")}${this.buildWhere(params)} RETURNING *`;
          const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
          if (this.singleMode) {
            const row = (rows as unknown as Row[])[0] ?? null;
            return { data: row as unknown as T, error: null } as unknown as Result<T[]>;
          }
          return { data: rows, error: null };
        }

        if (this.mode === "upsert") {
          const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
          if (rowsIn.length === 0) return { data: [] as unknown as T[], error: null };
          const cols = Object.keys(rowsIn[0]);
          const valueRows = rowsIn.map((r) => {
            const placeholders = cols.map((c) => {
              params.push(toParam(c, r[c]));
              return `$${params.length}${valueCast(c, r[c])}`;
            });
            return `(${placeholders.join(", ")})`;
          });
          const conflictTarget = this.conflictCols
            ? this.conflictCols.split(",").map((s) => quoteIdent(s.trim())).join(", ")
            : quoteIdent("id");
          const updateSet = cols
            .filter((c) => c !== "id")
            .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
            .join(", ");
          text = `INSERT INTO ${table} (${cols.map(quoteIdent).join(", ")}) VALUES ${valueRows.join(", ")} ` +
            `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet} RETURNING *`;
          const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
          return { data: rows, error: null };
        }

        // delete
        text = `DELETE FROM ${table}${this.buildWhere(params)} RETURNING *`;
        const rows = (await sql.unsafe(text, params as never[])) as unknown as T[];
        return { data: rows, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    }

    then<TResult1 = Result<T[]>, TResult2 = never>(
      onfulfilled?: ((value: Result<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return {
    from(table: string) {
      return new QueryBuilder(table);
    },
    rpc(fnName: string, args?: Record<string, unknown>) {
      const params: unknown[] = [];
      const namedArgs = args ?? {};
      const argExprs = Object.keys(namedArgs).map((k) => {
        params.push(toParam(k, namedArgs[k]));
        return `${quoteIdent(k)} := $${params.length}${valueCast(k, namedArgs[k])}`;
      });
      const text = `SELECT * FROM ${quoteIdent(fnName)}(${argExprs.join(", ")})`;
      const exec = async (): Promise<Result<Row[]>> => {
        try {
          const rows = (await sql.unsafe(text, params as never[])) as unknown as Row[];
          return { data: rows, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      };
      return {
        then<TResult1 = Result<Row[]>, TResult2 = never>(
          onfulfilled?: ((value: Result<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return exec().then(onfulfilled, onrejected);
        },
      };
    },
  };
}
