/**
 * Fork: "which device?" answered by looking. The app searches the local
 * network for what it can use another device's models through and lists
 * what it finds — a Kotomimi sharing its models, by its computer's name, a
 * phone lending its recognition engine, or a model server — each a row to
 * click. The address field stays below for
 * whatever the search cannot reach; nobody has to know an address to start.
 *
 * Drawn by the setup wizard's Kotomimi step and, in the settings, in the
 * provider's "another device" block, above its address field.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Loader, Monitor, RefreshCw, Search, Server, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { canFindServers, findServers, plainAddress, type FoundServer } from '../../lib/lan/discover';
import './ServerFinder.scss';

interface ServerFinderProps {
  /** The address now in the field: the row it names is marked as the one in use. */
  value: string;
  onPick(server: FoundServer): void;
  disabled?: boolean;
  /** Search as soon as it is shown; without it the search waits for its button. */
  auto?: boolean;
  /** What stands above the search in place of its own title: the settings say what the search is for. */
  hint?: string;
  /**
   * Present: phones that lend their recognition engine are listed too, and this is the address recognition is asked
   * at now (blank where it is asked of none) — the phone it names is marked as the one in use. A phone is no device
   * for the other stages, so only who can set recognition to it lists it.
   */
  phone?: string;
  /** For tests: the search itself. */
  find?(): Promise<FoundServer[]>;
}

export function ServerFinder({ value, onPick, disabled = false, auto = false, hint, phone, find = findServers }: ServerFinderProps) {
  const { t } = useTranslation();
  const [searching, setSearching] = useState(false);
  /** null: not searched yet. */
  const [servers, setServers] = useState<FoundServer[] | null>(null);
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const search = useCallback(async () => {
    const mine = ++latest.current;
    setSearching(true);
    const found = await find();
    if (!alive.current || mine !== latest.current) return;
    setServers(phone === undefined ? found.filter((server) => server.kind !== 'phone') : found);
    setSearching(false);
  }, [find, phone === undefined]);

  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    void search();
  }, [auto, search]);

  if (find === findServers && !canFindServers()) return null;

  const current = plainAddress(value);
  // By the name its owner knows it by; else what it is; else where it is.
  const title = (server: FoundServer) => server.name || (server.self ? (server.product ? t('fork.find.productHere', { product: server.product }) : t('fork.find.thisComputer')) : server.product || server.address.replace(/:\d+$/, ''));

  return (
    <div className="kt-find">
      <div className="kt-find__head">
        <span className="kt-find__title">{hint ?? t('fork.find.title')}</span>
        {servers !== null && (
          <button type="button" className="kt-find__again" onClick={() => { void search(); }} disabled={disabled || searching}>
            <RefreshCw size={12} className={searching ? 'kt-find__spin' : undefined} />
            <span>{t('fork.find.again')}</span>
          </button>
        )}
      </div>

      {servers === null && !searching && (
        <button type="button" className="kt-find__search" onClick={() => { void search(); }} disabled={disabled}>
          <Search size={14} />
          <span>{t('fork.find.search')}</span>
        </button>
      )}

      {searching && servers === null && (
        <div className="kt-find__state" role="status"><Loader size={14} className="kt-find__spin" /><span>{t('fork.find.searching')}</span></div>
      )}

      {servers !== null && servers.length === 0 && !searching && <p className="kt-find__none">{t('fork.find.none')}</p>}

      {servers !== null && servers.length > 0 && (
        <ul className="kt-find__list">
          {servers.map((server) => {
            const chosen = plainAddress(server.address) === (server.kind === 'phone' ? plainAddress(phone ?? '') : current);
            return (
              <li key={server.address}>
                <button type="button" className={`kt-find__row${chosen ? ' is-chosen' : ''}`} aria-pressed={chosen} aria-label={t('fork.find.use', { name: title(server) })} onClick={() => onPick(server)} disabled={disabled}>
                  <span className="kt-find__icon">{server.kind === 'kotomimi' ? <Monitor size={16} /> : server.kind === 'phone' ? <Smartphone size={16} /> : <Server size={16} />}</span>
                  <span className="kt-find__text">
                    <span className="kt-find__name">
                      {title(server)}
                      <em className="kt-find__kind">{server.kind === 'kotomimi' ? t('fork.find.kindKotomimi') : server.kind === 'phone' ? t('fork.find.kindPhone') : t('fork.find.kindServer')}</em>
                    </span>
                    <span className="kt-find__detail">
                      {server.address}
                      {' · '}
                      {server.needsKey ? <><KeyRound size={11} />{t('fork.find.needsKey')}</> : server.kind === 'phone' ? server.model : t('fork.find.models', { count: server.models })}
                    </span>
                  </span>
                  {chosen && <Check size={15} className="kt-find__check" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
