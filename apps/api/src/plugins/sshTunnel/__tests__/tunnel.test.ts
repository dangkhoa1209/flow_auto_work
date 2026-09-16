import { describe, expect, it } from "vitest";
import { isSshLocalForwardCmdline } from "../tunnel.js";

describe("isSshLocalForwardCmdline", () => {
  it("matches ssh / sshpass -L <port>:", () => {
    expect(
      isSshLocalForwardCmdline(
        "ssh -L 27019:127.0.0.1:27017 user@host -N",
        27019,
      ),
    ).toBe(true);
    expect(
      isSshLocalForwardCmdline(
        "sshpass -e ssh -L27019:localhost:27017 user@host -N",
        27019,
      ),
    ).toBe(true);
    expect(
      isSshLocalForwardCmdline(
        ["sshpass", "-e", "ssh", "-L", "27019:db:27017", "u@h", "-N"].join(
          "\0",
        ),
        27019,
      ),
    ).toBe(true);
  });

  it("rejects other ports or non-ssh processes", () => {
    expect(
      isSshLocalForwardCmdline(
        "ssh -L 27018:127.0.0.1:27017 user@host -N",
        27019,
      ),
    ).toBe(false);
    expect(
      isSshLocalForwardCmdline("mongod --port 27019", 27019),
    ).toBe(false);
    expect(isSshLocalForwardCmdline("", 27019)).toBe(false);
    expect(isSshLocalForwardCmdline("ssh -L 27019:h:1", 0)).toBe(false);
  });
});
