import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';

export interface TypedTextProps {
  /** Called with the trimmed, non-empty text. */
  onSend(text: string): void;
}

/** Today's 300ms re-submit latch (`isAdvancedSending`, `MainPanel.tsx:3511-3530`). */
const SEND_COOLDOWN_MS = 300;

/**
 * Typed text — speaker channel only. Visibility ("running && legs.speaker &&
 * provider.textInput(settings)", ruling 16) is the composition's (Task 12); this
 * component only owns its own box and the 300ms re-submit latch, calling
 * `onSend` with the trimmed text (`MainPanel.tsx:4646-4670`, `:3511-3530`).
 */
const TypedText: React.FC<TypedTextProps> = ({ onSend }) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  // Fork: Ctrl+K (Cmd+K) puts the cursor here from anywhere in the window — a word looked up mid-conversation is one keystroke away.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    onSend(trimmed);
    setText('');

    // Brief delay before allowing next submission
    setTimeout(() => setIsSending(false), SEND_COOLDOWN_MS);
  }, [text, isSending, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return (
    <div className="text-input-section">
      <div className="text-input-container">
        <input
          ref={input}
          type="text"
          className="text-input"
          title="Ctrl+K"
          placeholder={t('mainPanel.typeMessage', 'Text to translate...')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={1000}
        />
        <button
          className={`send-btn ${!text.trim() ? 'disabled' : ''}`}
          onClick={submit}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!text.trim() || isSending}
          title={t('mainPanel.send', 'Send')}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

export default TypedText;
