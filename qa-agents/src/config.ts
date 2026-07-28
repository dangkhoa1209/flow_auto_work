import { getConfig as getFlowConfig } from "../../src/config.js";

/** QA service listens on QA_PORT; shares Flow DB/secrets/GitLab config. */
export function getQaConfig() {
  const flow = getFlowConfig();
  return {
    ...flow,
    PORT: flow.QA_PORT,
  };
}
