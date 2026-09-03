import { describe, expect, it, vi } from "vitest";
import {
  combineStoredCursorModel,
  parseCursorModel,
  toSdkCursorModel,
  resolveListedRouterModelId,
  splitStoredCursorModel,
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

  it("normalizes catalog default to auto-smart in parse/settings", () => {
    expect(parseCursorModel("default:intelligence")).toEqual({
      id: "auto-smart",
      params: [{ id: "optimize_for", value: "intelligence" }],
    });
    expect(combineStoredCursorModel("default", "cost")).toBe("auto-smart:cost");
    expect(splitStoredCursorModel("default:cost")).toEqual({
      modelId: "auto-smart",
      routerMode: "cost",
    });
  });

  it("rewrites stored default onto listed auto-smart", () => {
    expect(
      resolveListedRouterModelId("default", [
        "auto",
        "auto-smart",
        "composer-2.5",
      ]),
    ).toBe("auto-smart");
  });
});

describe("listCursorModelsForApiKey", () => {
  it("exposes catalog default as auto-smart for the dropdown", async () => {
    listMock.mockResolvedValueOnce([
      { id: "default", displayName: "Auto" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]);
    const { listCursorModelsForApiKey } = await import("../modelList.js");
    const result = await listCursorModelsForApiKey("k", "auto-smart:cost");
    expect(result.models.map((m) => m.id)).toEqual([
      "auto",
      "auto-smart",
      "composer-2.5",
    ]);
    expect(result.models.find((m) => m.id === "auto-smart")?.displayName).toBe(
      "Auto (Router)",
    );
    expect(result.models.some((m) => m.id === "default")).toBe(false);
  });
});
