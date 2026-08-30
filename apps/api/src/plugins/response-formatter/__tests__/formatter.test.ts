import { describe, expect, it } from "vitest";
import { FORMATTER_METHODS } from "../methods.js";
import {
  formatterMethodForStatus,
  generateFormatters,
} from "../index.js";
import type { Response } from "express";

describe("response-formatter", () => {
  it("maps status codes to method names", () => {
    expect(formatterMethodForStatus(404)).toBe("notFound");
    expect(formatterMethodForStatus(401)).toBe("unauthorized");
    expect(formatterMethodForStatus(500)).toBe("serverError");
  });

  it("ok() wraps success envelope with data + error alias fields on errors", () => {
    let statusCode = 0;
    let payload: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        payload = body;
        return this;
      },
      end() {
        return this;
      },
    } as unknown as Response;

    const formatter = generateFormatters(res);
    expect(FORMATTER_METHODS.some((m) => m.name === "ok")).toBe(true);

    formatter.ok({ projects: [] }, { limit: 10 });
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      data: { projects: [] },
      meta: { limit: 10 },
      name: "ok",
    });

    formatter.notFound("missing");
    expect(statusCode).toBe(404);
    expect(payload).toMatchObject({
      success: false,
      error: "missing",
      message: "missing",
      name: "notFound",
    });
  });
});
