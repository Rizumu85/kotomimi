import { describe, expect, it } from 'vitest';
import { API_SERVICES, preferredModel, quickOf, serviceOf, servicesFor } from './apiServices';

const service = (id: string) => API_SERVICES.find((s) => s.id === id)!;

describe('the services an API model usually is', () => {
  it('offers a stage only the services that can serve it', () => {
    expect(servicesFor('asr').map((s) => s.id)).toEqual(['openai', 'groq', 'siliconflow']);
    expect(servicesFor('text').map((s) => s.id)).toEqual(['openai', 'gemini', 'ark', 'deepseek', 'groq', 'siliconflow', 'openrouter', 'ollama']);
  });

  it('reads the service back from the address, however it was typed', () => {
    expect(serviceOf('https://api.openai.com/v1', 'text')?.id).toBe('openai');
    expect(serviceOf(' https://API.openai.com/v1/ ', 'asr')?.id).toBe('openai');
    expect(serviceOf('http://localhost:11434/v1', 'text')?.id).toBe('ollama');
    // An address none of them has is the user's own; so is a service's address in a stage it cannot serve.
    expect(serviceOf('http://192.168.1.20:8080/v1', 'text')).toBeUndefined();
    expect(serviceOf('https://generativelanguage.googleapis.com/v1beta/openai', 'asr')).toBeUndefined();
    expect(serviceOf('', 'text')).toBeUndefined();
  });

  it('has an address with a scheme and no trailing slash, and each id once', () => {
    for (const s of API_SERVICES) expect(s.baseUrl).toMatch(/^https?:\/\/[^\s]+[^/]$/);
    expect(new Set(API_SERVICES.map((s) => s.id)).size).toBe(API_SERVICES.length);
  });
});

describe('a service whose models think before they answer', () => {
  it('is asked not to, by its address, however that was typed; any other service is asked as it was', () => {
    expect(quickOf('https://api.deepseek.com/v1')).toEqual({ thinking: { type: 'disabled' } });
    expect(quickOf(' HTTPS://API.DeepSeek.com/v1/ ')).toEqual({ thinking: { type: 'disabled' } });
    expect(quickOf('https://api.openai.com/v1')).toBeUndefined();
    expect(quickOf('http://localhost:1234/v1')).toBeUndefined();
  });
});

describe('the model a service is asked for when none is named', () => {
  it('is the newest of the kind meant, taken from what the service lists', () => {
    expect(preferredModel(service('openai'), 'text', ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.5', 'gpt-5.4-nano'])).toBe('gpt-5.4-mini');
    // 3.10 is newer than 3.8: the numbers are compared, not the text.
    expect(preferredModel(service('gemini'), 'text', ['models/gemini-3.8-flash', 'models/gemini-3.10-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-3.1-pro-preview'])).toBe('models/gemini-3.10-flash');
    expect(preferredModel(service('openrouter'), 'text', ['openai/gpt-5.4-mini', 'google/gemini-3.8-flash', 'google/gemini-3.7-flash'])).toBe('google/gemini-3.8-flash');
  });

  it('falls to the next kind when the first is not listed, and to nothing when none is', () => {
    expect(preferredModel(service('openai'), 'text', ['gpt-5.4-nano', 'gpt-5.5'])).toBe('gpt-5.4-nano');
    expect(preferredModel(service('openai'), 'text', ['gpt-5.5', 'o9'])).toBeUndefined();
    expect(preferredModel(service('ark'), 'text', ['doubao-seed-2-flash'])).toBeUndefined();
    expect(preferredModel(service('openai'), 'text', [])).toBeUndefined();
  });

  it('is a transcriber for the speech recognition, never a chat model', () => {
    expect(preferredModel(service('openai'), 'asr', ['gpt-5.4-mini', 'whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'tts-1'])).toBe('gpt-4o-mini-transcribe');
    expect(preferredModel(service('groq'), 'asr', ['llama-3.3-70b-versatile', 'whisper-large-v3', 'whisper-large-v3-turbo'])).toBe('whisper-large-v3-turbo');
    expect(preferredModel(service('siliconflow'), 'asr', ['Qwen/Qwen3-8B', 'FunAudioLLM/SenseVoiceSmall'])).toBe('FunAudioLLM/SenseVoiceSmall');
    expect(preferredModel(service('openai'), 'asr', ['gpt-5.4-mini'])).toBeUndefined();
  });

  it('is whatever is installed, for an Ollama', () => {
    expect(preferredModel(service('ollama'), 'text', ['qwen3:4b'])).toBe('qwen3:4b');
  });
});
