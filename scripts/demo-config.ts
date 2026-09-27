/** The two fake machines the demo and the browser tests use. The keys only unlock the mocks. */
export const DEMO_APP_PORT = 3000;
export const DEMO_MOCK_PORTS = [18881, 18882] as const;

export const DEMO_MACHINES = [
  {
    name: 'Mock Mac Studio',
    profile: 'mac-mlx',
    apiKey: 'sk-unsloth-demo-mac-00000000000000000001',
    notes: 'Fake Unsloth: Apple M3 Ultra, 512 GB',
    color: '#e8a33d',
  },
  {
    name: 'Mock Linux RTX',
    profile: 'linux-cuda',
    apiKey: 'sk-unsloth-demo-linux-000000000000000002',
    notes: 'Fake Unsloth: NVIDIA RTX 5090, 32 GB',
    color: '#c6dbe0',
  },
] as const;

/** A fake LM Studio, raced on the Text tab like the fake Unsloth machines. */
export const DEMO_LMSTUDIO_PORT = 18889;
export const DEMO_LMSTUDIO = {
  name: 'Mock LM Studio',
  notes: 'Fake LM Studio 0.4 with Qwen3.8 27B loaded',
  color: '#e3d160',
} as const;

/** A fake results service, where the Results tab's Send button goes in the demo. */
export const DEMO_SHARE_PORT = 18888;

/** Fake cloud providers, raced on the Text tab as references. Their keys only unlock the mocks. */
export const DEMO_CLOUD_PORTS = [18885, 18886, 18887] as const;

export const DEMO_CLOUDS = [
  {
    provider: 'openai',
    name: 'Mock ChatGPT',
    model: 'gpt-6-luna',
    apiKey: 'sk-proj-demo-openai-0000000000000000000001',
    color: '#86c98f',
  },
  {
    provider: 'anthropic',
    name: 'Mock Claude',
    model: 'claude-sonnet-5',
    apiKey: 'sk-ant-api03-demo-anthropic-000000000000001',
    color: '#b49cf0',
  },
  {
    provider: 'gemini',
    name: 'Mock Gemini',
    model: 'gemini-3.8-flash',
    apiKey: 'AIzaSyDemoGemini000000000000000000000001',
    color: '#ef8fb0',
  },
] as const;
