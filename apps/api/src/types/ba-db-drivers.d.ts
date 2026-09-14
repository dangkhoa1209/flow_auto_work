/** Ambient stubs so typecheck passes before `npm install mysql2 pg`. */
declare module "mysql2/promise" {
  export function createConnection(config: Record<string, unknown>): Promise<{
    query: (
      opts: { sql: string; timeout?: number } | string,
      values?: unknown[],
    ) => Promise<[unknown, Array<{ name?: string }> | undefined]>;
    execute: (
      sql: string,
      values?: unknown[],
    ) => Promise<[unknown, Array<{ name?: string }> | undefined]>;
    end: () => Promise<void>;
  }>;
}

declare module "pg" {
  export class Client {
    constructor(config: Record<string, unknown>);
    connect(): Promise<void>;
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{
      rows: Record<string, unknown>[];
      rowCount?: number | null;
      fields?: Array<{ name: string }>;
    }>;
    end(): Promise<void>;
  }
  const _default: { Client: typeof Client };
  export default _default;
}
