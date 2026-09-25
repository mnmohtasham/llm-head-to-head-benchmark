/** Ports for the browser tests, away from the ones npm run demo uses. */
export const E2E_APP_PORT = 3100;
export const E2E_MOCK_PORTS = [18891, 18892] as const;
export const E2E_AGENT_PORTS = [18895, 18896] as const;
export const E2E_CLOUD_PORTS = [18911, 18912, 18913] as const;
export const E2E_SHARE_PORT = 18914;
/** Nothing may listen here: the machines spec adds a machine at this port to see the error. */
export const E2E_UNUSED_PORT = 18899;
