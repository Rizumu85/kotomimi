/**
 * Fork: in the title bar, while this computer is lending its models to other
 * devices — while sharing is on, which lends a LocalAI's models too. A LocalAI
 * alone lends nothing: the one the app starts listens on this computer only
 * (`electron/local-server.js`), and its own card says whether it is up. On the
 * computer that does the work the main screen is otherwise idle, and its own
 * session controls say nothing of the devices it is serving: this says it,
 * and in its tooltip, whose settings decide what those devices get.
 */
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLanStore } from '../../stores/lanStore';
import './ServingBadge.scss';

export function ServingBadge() {
  const { t } = useTranslation();
  const sharing = useLanStore((s) => s.status.state === 'on');
  const clients = useLanStore((s) => s.clients);
  if (!sharing) return null;
  const busy = clients > 0;
  return (
    <span className={`kt-serving${busy ? ' is-busy' : ''}`} title={t('fork.lan.servingTip')} role="status">
      <Share2 size={12} />
      <span className="kt-serving__label">{busy ? t('fork.lan.servingClients', { count: clients }) : t('fork.lan.serving')}</span>
    </span>
  );
}
