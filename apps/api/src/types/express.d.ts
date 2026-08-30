import type { ResponseFormatter } from "../plugins/response-formatter/index.js";

declare global {
  namespace Express {
    interface Response {
      formatter: ResponseFormatter;
    }
  }
}

export {};
