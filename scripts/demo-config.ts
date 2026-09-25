/** The two fake machines the demo and the browser tests use. The keys only unlock the mocks. */
export const DEMO_APP_PORT = 3000;
export const DEMO_MOCK_PORTS = [18881, 18882] as const;
/** A fake agent beside each mock, for the Command tab. */
export const DEMO_AGENT_PORTS = [18883, 18884] as const;

export const DEMO_MACHINES = [
  {
    name: 'Mock Mac Studio',
    profile: 'mac-mlx',
    apiKey: 'sk-unsloth-demo-mac-00000000000000000001',
    agentToken: 'demo-agent-token-mac-000000000000000001',
    /** How fast its fake encode runs, in frames per second. */
    fakeFps: 240,
    notes: 'Fake Unsloth: Apple M3 Ultra, 512 GB',
    color: '#e8a33d',
  },
  {
    name: 'Mock Linux RTX',
    profile: 'linux-cuda',
    apiKey: 'sk-unsloth-demo-linux-000000000000000002',
    agentToken: 'demo-agent-token-linux-00000000000000002',
    fakeFps: 400,
    notes: 'Fake Unsloth: NVIDIA RTX 5090, 32 GB',
    color: '#c6dbe0',
  },
] as const;
