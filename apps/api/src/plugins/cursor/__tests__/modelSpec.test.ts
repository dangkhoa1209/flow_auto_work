import { describe, expect, it, vi } from "vitest";
import {
  parseCursorModel,
  toSdkCursorModel,
  resolveListedRouterModelId,
} from "@flow/shared";
import { toAgentModel } from "../modelSpec.js";

const listMock = vi.fn();

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => listMock(...args),
    },
  },
}));

describe("toAgentModel / toSdkCursorModel", () => {
  it("maps auto-smart:cost onto catalog id default", () => {
    expect(toAgentModel("auto-smart:cost")).toEqual({
      id: "default",
      params: [{ id: "optimize_for", value: "cost" }],
    });
    expect(toSdkCursorModel("default:balanced")).toEqual({
      id: "default",
      params: [{ id: "optimize_for", value: "balanced" }],
    });
  });

  it("maps legacy auto onto default without router params", () => {
    expect(toAgentModel("auto")).toEqual({ id: "default" });
    expect(toAgentModel("")).toEqual({ id: "default" });
  });

  it("leaves pinned models unchanged", () => {
    expect(toAgentModel("composer-2.5")).toEqual({ id: "composer-2.5" });
  });

  it("keeps stored auto-smart in parse, remaps only at SDK boundary", () => {
    expect(parseCursorModel("auto-smart:intelligence")).toEqual({
      id: "auto-smart",
      params: [{ id: "optimize_for", value: "intelligence" }],
    });
  });

  it("rewrites stored auto-smart to listed default", () => {
    expect(
      resolveListedRouterModelId("auto-smart", ["auto", "default", "composer-2.5"]),
    ).toBe("default");
  });
});

describe("listCursorModelsForApiKey", () => {
  it("does not inject auto-smart when catalog has default", async () => {
    listMock.mockResolvedValueOnce([
      { id: "default", displayName: "Auto" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]);
    const { listCursorModelsForApiKey } = await import("../modelList.js");
    const result = await listCursorModelsForApiKey("k", "auto-smart:cost");
    expect(result.models.map((m) => m.id)).toEqual([
      "auto",
      "default",
      "composer-2.5",
    ]);
    expect(result.models.find((m) => m.id === "default")?.displayName).toBe(
      "Auto (Router)",
    );
    expect(result.models.some((m) => m.id === "auto-smart")).toBe(false);
  });
});
