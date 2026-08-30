/** Ambient stubs so typecheck passes before `npm install mysql2 pg`. */
declare module "mysql2/promise" {
  export function createConnection(config: Record<string, unknown>): Promise<{
    query: (opts: { sql: string; timeout?: number }) => Promise<
      [unknown, Array<{ name?: string }> | undefined]
    >;
    end: () => Promise<void>;
  }>;
}

declare module "pg" {
  export class Client {
    constructor(config: Record<string, unknown>);
    connect(): Promise<void>;
    query(sql: string): Promise<{
      rows: Record<string, unknown>[];
      fields?: Array<{ name: string }>;
    }>;
    end(): Promise<void>;
  }
  const _default: { Client: typeof Client };
  export default _default;
}
