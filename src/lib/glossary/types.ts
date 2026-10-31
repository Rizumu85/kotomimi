/** A term the user keeps: how it is written, and what recognition writes instead. */
export interface GlossaryEntry {
  id: string;
  /** How it should appear in the transcript. */
  source: string;
  /** What recognition writes instead: folded into `source`. */
  aliases: readonly string[];
}

export interface GlossarySnapshot {
  readonly entries: readonly GlossaryEntry[];
}

export interface GlossaryEntryInput {
  source: string;
  aliases?: readonly string[];
}
