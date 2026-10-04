/**
 * Fork: a readiness check that could not find out — a server that did not
 * answer, or answered with an error — said in words a surface can put into
 * the user's language. Thrown like any other failure, so the store keeps the
 * models it found last (`providerStore.refreshReadiness`); it carries the code
 * and params a refusal would (`noticeText`), so the person reads a sentence
 * of the catalog's rather than the check's diagnostic English, which stays
 * the message.
 */
export class CheckError extends Error {
  constructor(message: string, readonly code: string, readonly params?: Record<string, string | number>) {
    super(message);
    this.name = 'CheckError';
  }
}

/**
 * The code and params of a thrown `CheckError`; null for anything else. Read
 * by its shape, not `instanceof`: a store and a check loaded apart (a test's
 * fresh module graph) hold the same class twice.
 */
export function checkErrorWords(error: unknown): { code: string; params?: Record<string, string | number> } | null {
  if (!(error instanceof Error) || error.name !== 'CheckError') return null;
  const { code, params } = error as Partial<CheckError>;
  return typeof code === 'string' ? { code, ...(params ? { params } : {}) } : null;
}
