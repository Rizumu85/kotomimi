import { describe, expect, it } from 'vitest';
import { kotomimiRefusal } from './kotomimiRefusal';

describe("a sharing Kotomimi's refusal, as the app words it (fork)", () => {
  it('names the language it has no recognizer for, and says apart that it has none that detects one', () => {
    expect(kotomimiRefusal({ code: 'model_not_found', message: 'This Kotomimi shares no speech recognition model for "ko".' })).toEqual({ code: 'server_no_asr', params: { source: 'ko' } });
    expect(kotomimiRefusal({ code: 'model_not_found', message: 'This Kotomimi shares no speech recognition model for "auto".' })).toEqual({ code: 'server_no_detect' });
  });

  it('says a recognizer in use with another model is busy, not missing', () => {
    expect(kotomimiRefusal({ code: 'recognizer_busy', message: `This Kotomimi's speech recognition is in use with another model, which does not hear "auto".` })).toEqual({ code: 'server_asr_busy' });
  });

  it('leaves every other error to its own words', () => {
    expect(kotomimiRefusal({ code: 'model_not_found', message: 'The model gpt-x does not exist.' })).toBeNull();
    expect(kotomimiRefusal({ code: 'invalid_api_key', message: 'Incorrect API key.' })).toBeNull();
    expect(kotomimiRefusal({})).toBeNull();
  });
});
