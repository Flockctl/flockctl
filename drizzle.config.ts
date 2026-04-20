import { defineConfig } from "drizzle-kit";
import { join } from "path";
import { getFlockctlHome } from "./src/config.js";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: join(getFlockctlHome(), "flockctl.db"),
  },
});
