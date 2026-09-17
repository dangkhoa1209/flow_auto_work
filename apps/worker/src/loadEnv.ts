import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// apps/worker/src → repo root
const repoRoot = join(here, "../../..");
loadDotenv({ path: join(repoRoot, ".env") });
