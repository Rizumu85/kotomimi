export type NoiseSuppressionMode = 'off' | 'standard' | 'enhanced';

/** Runtime processing, separate from the user's persisted preference. */
export interface NoiseSuppressionState {
  requested: NoiseSuppressionMode;
  effective: NoiseSuppressionMode;
  /** Why a lower level is in use; technical detail for diagnostics. */
  reason?: string;
}
