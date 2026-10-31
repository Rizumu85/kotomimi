/** A local term pair used by recognition and translation hints. */
export interface GlossaryEntry {
  id: string;
  /** An optional stable identifier from an external source such as VRCX. */
  externalId?: string;
  /** The canonical term as it should appear in the source transcript. */
  source: string;
  /** The preferred rendering in the translated text. Use the source for names that should stay unchanged. */
  target: string;
  /** Recognition variants that should be folded into `source`. */
  aliases: readonly string[];
  enabled: boolean;
}

export interface GlossarySnapshot {
  readonly entries: readonly GlossaryEntry[];
}

export interface GlossaryEntryInput {
  source: string;
  target?: string;
  aliases?: readonly string[];
  enabled?: boolean;
  externalId?: string;
}

export interface GlossaryImportResult {
  added: number;
  updated: number;
  skipped: number;
}

