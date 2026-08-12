import { describe, expect, it } from "vitest";
import { assertReadonlySql, parseMongoQuery } from "../query.js";

describe("assertReadonlySql", () => {
  it("allows select / with / show / describe / explain", () => {
    expect(assertReadonlySql("SELECT 1")).toBe("SELECT 1");
    expect(assertReadonlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toContain(
      "WITH",
    );
    expect(assertReadonlySql("SHOW TABLES")).toMatch(/^SHOW/i);
    expect(assertReadonlySql("DESCRIBE users")).toMatch(/^DESCRIBE/i);
    expect(assertReadonlySql("EXPLAIN SELECT 1")).toMatch(/^EXPLAIN/i);
  });

  it("strips trailing semicolon once", () => {
    expect(assertReadonlySql("SELECT 1;")).toBe("SELECT 1");
  });

  it("rejects mutations and multi-statements", () => {
    expect(() => assertReadonlySql("DELETE FROM users")).toThrow(/read-only/i);
    expect(() => assertReadonlySql("UPDATE users SET a=1")).toThrow(/read-only/i);
    expect(() => assertReadonlySql("DROP TABLE users")).toThrow(/read-only/i);
    expect(() => assertReadonlySql("SELECT 1; SELECT 2")).toThrow(/Multiple/i);
    expect(() => assertReadonlySql("INSERT INTO t VALUES (1)")).toThrow(
      /read-only/i,
    );
  });
});

describe("parseMongoQuery", () => {
  it("parses listCollections / find / count / aggregate", () => {
    expect(parseMongoQuery('{"op":"listCollections"}')).toEqual({
      op: "listCollections",
    });
    expect(
      parseMongoQuery(
        '{"op":"find","collection":"users","filter":{"a":1},"limit":10}',
      ),
    ).toMatchObject({ op: "find", collection: "users", limit: 10 });
    expect(
      parseMongoQuery('{"op":"count","collection":"users"}'),
    ).toMatchObject({ op: "count", collection: "users" });
    expect(
      parseMongoQuery(
        '{"op":"aggregate","collection":"users","pipeline":[{"$match":{}}]}',
      ),
    ).toMatchObject({ op: "aggregate", collection: "users" });
  });

  it("rejects write stages, other-db fields, and bad ops", () => {
    expect(() =>
      parseMongoQuery(
        '{"op":"aggregate","collection":"u","pipeline":[{"$out":"x"}]}',
      ),
    ).toThrow(/read-only/i);
    expect(() =>
      parseMongoQuery(
        '{"op":"aggregate","collection":"u","pipeline":[{"$merge":{}}]}',
      ),
    ).toThrow(/read-only/i);
    expect(() =>
      parseMongoQuery(
        '{"op":"find","database":"YKKSUB","collection":"users"}',
      ),
    ).toThrow(/database/i);
    expect(() =>
      parseMongoQuery('{"op":"insert","collection":"users"}'),
    ).toThrow(/op must be/i);
  });
});

describe("assertReadonlySql database lock", () => {
  it("rejects USE", () => {
    expect(() => assertReadonlySql("USE otherdb")).toThrow(/USE|admin-configured/i);
  });
});
