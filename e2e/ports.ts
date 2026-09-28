/** Ports for the browser tests and their stand-in servers. */
export const E2E_APP_PORT = 3100;
export const E2E_MOCK_PORTS = [18891, 18892] as const;
export const E2E_CLOUD_PORTS = [18911, 18912, 18913] as const;
export const E2E_SHARE_PORT = 18914;
export const E2E_LMSTUDIO_PORT = 18915;
/** Nothing may listen here: the machines spec adds a machine at this port to see the error. */
export const E2E_UNUSED_PORT = 18899;
/** A second copy of the app with a password, for the sign-in test. */
export const E2E_AUTH_APP_PORT = 3101;
export const E2E_PASSWORD = 'e2e-test-password';
