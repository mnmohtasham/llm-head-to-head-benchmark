/**
 * Ports for the browser tests and their stand-in servers. The app's two ports can be moved with
 * E2E_APP_PORT and E2E_AUTH_APP_PORT when something else on the computer uses them.
 */
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
export const E2E_APP_PORT = port('E2E_APP_PORT', 3100);
export const E2E_MOCK_PORTS = [18891, 18892] as const;
export const E2E_CLOUD_PORTS = [18911, 18912, 18913] as const;
export const E2E_LMSTUDIO_PORT = 18915;
export const E2E_OLLAMA_PORT = 18916;
/** An OpenAI-compatible server that answers as llama.cpp's llama-server. */
export const E2E_COMPAT_PORT = 18917;
/** Nothing may listen here: the machines spec adds a machine at this port to see the error. */
export const E2E_UNUSED_PORT = 18899;
/** A second copy of the app with a password, for the sign-in test. */
export const E2E_AUTH_APP_PORT = port('E2E_AUTH_APP_PORT', 3101);
export const E2E_PASSWORD = 'e2e-test-password';
