import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../../utils/AppError.js";
import { parseBuildScripts, resolveWorkingDir, slugScriptId } from "../catalog.js";

describe("parseBuildScripts", () => {
  it("returns empty for blank input", () => {
    expect(parseBuildScripts("")).toEqual([]);
    expect(parseBuildScripts("   ")).toEqual([]);
  });

  it("parses a valid whitelist entry", () => {
    const scripts = parseBuildScripts(
      JSON.stringify([
        {
          id: "ykkuat",
          label: "YKK UAT",
          command: "bash /opt/build/YKKUAT.sh",
          workingDir: "/opt/build",
          timeoutSec: 900,
        },
      ]),
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0].id).toBe("ykkuat");
    expect(scripts[0].command).toBe("bash /opt/build/YKKUAT.sh");
    expect(scripts[0].workingDir).toBe("/opt/build");
  });

  it("resolves relative workingDir against cwd", () => {
    const scripts = parseBuildScripts(
      JSON.stringify([
        {
          id: "rel",
          label: "Rel",
          command: "echo hi",
          workingDir: "tmp/build",
        },
      ]),
    );
    expect(scripts[0].workingDir).toBe(path.resolve("tmp/build"));
  });

  it("joins multiline commands with &&", () => {
    const scripts = parseBuildScripts(
      JSON.stringify([
        {
          id: "multi",
          label: "Multi",
          command: "echo hi\necho there",
          workingDir: "/tmp",
        },
      ]),
    );
    expect(scripts[0].command).toBe("echo hi && echo there");
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseBuildScripts(
        JSON.stringify([
          {
            id: "a",
            label: "A",
            command: "echo 1",
            workingDir: "/tmp",
          },
          {
            id: "a",
            label: "A2",
            command: "echo 2",
            workingDir: "/tmp",
          },
        ]),
      ),
    ).toThrow(/Duplicate/);
  });

  it("rejects invalid script id", () => {
    expect(() =>
      parseBuildScripts(
        JSON.stringify([
          {
            id: "../etc/passwd",
            label: "Nope",
            command: "echo hi",
            workingDir: "/tmp",
          },
        ]),
      ),
    ).toThrow(AppError);
  });
});

describe("resolveWorkingDir", () => {
  it("keeps absolute paths", () => {
    expect(resolveWorkingDir("/opt/build")).toBe("/opt/build");
  });
});

describe("slugScriptId", () => {
  it("slugs a label", () => {
    expect(slugScriptId("YKK UAT")).toBe("ykk-uat");
  });
});
