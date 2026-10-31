/** A term the user keeps: how it is written, how it comes out wrong, and how it is translated. */
export interface GlossaryEntry {
  id: string;
  /** How it should appear in the source transcript. */
  source: string;
  /** How it is translated. The source for a name that stays as it is. */
  target: string;
  /** What recognition writes instead: folded into `source`. */
  aliases: readonly string[];
}

export interface GlossarySnapshot {
  readonly entries: readonly GlossaryEntry[];
}

export interface GlossaryEntryInput {
  source: string;
  target?: string;
  aliases?: readonly string[];
}
