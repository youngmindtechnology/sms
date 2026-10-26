import { ConfigError, loadConfig } from "../config.js";

/** Validate the environment the same way the server does; print problems (never values) and stop. */
export function loadConfigFromEnvOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
