/**
 * The stand-in machines and cloud providers the browser tests race. Their keys only unlock the
 * stand-in servers in test-servers/; nothing here reaches the app outside the tests.
 */
export const TEST_MACHINES = [
  {
    name: 'Mock Mac Studio',
    profile: 'mac-mlx',
    apiKey: 'sk-unsloth-test-mac-00000000000000000001',
    notes: 'Stand-in Unsloth: Apple M3 Ultra, 512 GB',
    color: '#e8a33d',
  },
  {
    name: 'Mock Linux RTX',
    profile: 'linux-cuda',
    apiKey: 'sk-unsloth-test-linux-000000000000000002',
    notes: 'Stand-in Unsloth: NVIDIA RTX 5090, 32 GB',
    color: '#c6dbe0',
  },
] as const;

export const TEST_CLOUDS = [
  { provider: 'openai', apiKey: 'sk-proj-test-openai-0000000000000000000001' },
  { provider: 'anthropic', apiKey: 'sk-ant-api03-test-anthropic-000000000000001' },
  { provider: 'gemini', apiKey: 'AIzaSyTestGemini0000000000000000000000001' },
] as const;
