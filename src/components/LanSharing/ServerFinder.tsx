/**
 * Fork: "which device?" answered by looking. The app searches the local
 * network for what it can use another device's models through and lists
 * what it finds — a Kotomimi sharing its models, by its computer's name, a
 * phone lending its engines, or a model server — each a row to
 * click. The address field stays below for
 * whatever the search cannot reach; nobody has to know an address to start.
 *
 * Drawn by the setup wizard's Kotomimi step and, in the settings, in the
 * provider's "another device" block, above its address field.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, GraduationCap, KeyRound, Languages, Loader, Mic, Monitor, RefreshCw, Search, Server, Smartphone, Tablet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../Tooltip/Tooltip';
import { canFindServers, findServers, plainAddress, type FoundServer } from '../../lib/lan/discover';
import './ServerFinder.scss';

/** A stage a device runs now: drawn by the icon its card carries. */
export type FinderStage = 'asr' | 'translate' | 'coach';
const STAGE_ICON: Record<FinderStage, typeof Mic> = { asr: Mic, translate: Languages, coach: GraduationCap };
const STAGE_NAME: Record<FinderStage, string> = { asr: 'fork.find.lendsAsr', translate: 'fork.find.lendsTranslate', coach: 'fork.find.lendsCoach' };

interface ServerFinderProps {
  /** The address now in the field: the row it names is marked as the one in use (where `uses` is not given). */
  value?: string;
  onPick(server: FoundServer): void;
  disabled?: boolean;
  /** Search as soon as it is shown; without it the search waits for its button. */
  auto?: boolean;
  /** The card's own heading, in place of the search's title: searching again is then an icon beside it. */
  heading?: ReactNode;
  /**
   * Phones that lend their engines are listed too. A phone is no device with a whole pipeline, so only who can give a
   * stage to it lists it.
   */
  phones?: boolean;
  /** The stages each device runs now: a device with any is in use, and shows them in place of a check. */
  uses?(server: FoundServer): readonly FinderStage[];
  /** What a search found, phones among them or not as above: for whoever offers the devices elsewhere too. */
  onFound?(servers: FoundServer[]): void;
  /** For tests: the search itself. */
  find?(): Promise<FoundServer[]>;
}

/** An address without its port: the devices are told apart by what they are, and the port says nothing to a person. */
const hostOf = (address: string) => address.replace(/:\d+$/, '');

export function ServerFinder({ value = '', onPick, disabled = false, auto = false, heading, phones = false, uses, onFound, find = findServers }: ServerFinderProps) {
  const { t } = useTranslation();
  const [searching, setSearching] = useState(false);
  /** null: not searched yet. */
  const [servers, setServers] = useState<FoundServer[] | null>(null);
  const latest = useRef(0);
  const told = useRef(onFound);
  told.current = onFound;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const search = useCallback(async () => {
    const mine = ++latest.current;
    setSearching(true);
    const found = await find();
    if (!alive.current || mine !== latest.current) return;
    const shown = phones ? found : found.filter((server) => server.kind !== 'phone');
    setServers(shown);
    told.current?.(shown);
    setSearching(false);
  }, [find, phones]);

  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    void search();
  }, [auto, search]);

  if (find === findServers && !canFindServers()) return heading ? <>{heading}</> : null;

  const current = plainAddress(value);
  // What device it is (a Kotomimi runs on each of them), or a model server: the stages it can run are chosen in their cards.
  const kind = (server: FoundServer) => (server.kind === 'kotomimi'
    ? t('fork.find.kindComputer')
    : server.kind === 'phone' ? t(server.tablet ? 'fork.find.kindTablet' : 'fork.find.kindPhone') : t('fork.find.kindServer'));
  // A phone counts what it lends: its recognizer and its text models.
  const count = (server: FoundServer) => (server.kind === 'phone' ? (server.model ? 1 : 0) + (server.text?.length ?? 0) : server.models);
  // By the name its owner knows it by; else what it is; else where it is.
  const title = (server: FoundServer) => server.name || (server.self ? (server.product ? t('fork.find.productHere', { product: server.product }) : t('fork.find.thisComputer')) : server.product || hostOf(server.address));
  const searchAgain = () => { void search(); };
  const again = servers === null ? null : heading ? (
    <Tooltip content={t('fork.find.again')} position="top" icon="none">
      <button type="button" className="kt-find__again kt-find__again--icon" aria-label={t('fork.find.again')} onClick={searchAgain} disabled={disabled || searching}>
        <RefreshCw size={14} className={searching ? 'kt-find__spin' : undefined} />
      </button>
    </Tooltip>
  ) : (
    <button type="button" className="kt-find__again" onClick={searchAgain} disabled={disabled || searching}>
      <RefreshCw size={12} className={searching ? 'kt-find__spin' : undefined} />
      <span>{t('fork.find.again')}</span>
    </button>
  );

  return (
    <div className="kt-find">
      <div className={`kt-find__head${heading ? ' kt-find__head--card' : ''}`}>
        {heading ?? <span className="kt-find__title">{t('fork.find.title')}</span>}
        {again}
      </div>

      {servers === null && !searching && (
        <button type="button" className="kt-find__search" onClick={searchAgain} disabled={disabled}>
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
            const stages = uses ? uses(server) : [];
            const chosen = uses ? stages.length > 0 : server.kind !== 'phone' && plainAddress(server.address) === current;
            const Icon = server.kind === 'kotomimi' ? Monitor : server.kind === 'phone' ? (server.tablet ? Tablet : Smartphone) : Server;
            return (
              <li key={server.address}>
                <button type="button" className={`kt-find__row${chosen ? ' is-chosen' : ''}`} aria-pressed={chosen} aria-label={t('fork.find.use', { name: title(server) })} onClick={() => onPick(server)} disabled={disabled}>
                  <span className="kt-find__icon"><Icon size={16} /></span>
                  <span className="kt-find__text">
                    <span className="kt-find__name">{title(server)}</span>
                    <span className="kt-find__detail">
                      <span>{kind(server)}</span>
                      <span>{hostOf(server.address)}</span>
                      {server.needsKey
                        ? <span className="kt-find__key"><KeyRound size={11} />{t('fork.find.needsKey')}</span>
                        : <span>{t('fork.find.models', { count: count(server) })}</span>}
                    </span>
                  </span>
                  {stages.length > 0 && (
                    <Tooltip content={stages.map((stage) => t(STAGE_NAME[stage])).join(t('fork.find.lendsJoin'))} position="top" icon="none">
                      <span className="kt-find__uses">
                        {stages.map((stage) => {
                          const StageIcon = STAGE_ICON[stage];
                          return <StageIcon key={stage} size={14} aria-hidden />;
                        })}
                      </span>
                    </Tooltip>
                  )}
                  {!uses && chosen && <Check size={15} className="kt-find__check" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
