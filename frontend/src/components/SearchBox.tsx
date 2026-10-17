import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Building2, Clock, Hash, Home, Loader2, Map as MapIcon, MapPin, Navigation, Search, X } from 'lucide-react';
import { API_BASE, QUICK_PLACES } from '../config';
import { searchLocations } from '../api/locations';
import { normalize, placeSubtitle, placeTitle, searchPlaces, type SearchOutcome } from '../lib/search';
import { choosePlace, clearSearch, goToPoint, locateMe, recentPlaceIds } from '../state/actions';
import { useStore } from '../state/store';
import type { PlaceResult } from '../types';
import { formatPopulation } from '../lib/format';

function useNarrow() {
  const query = '(max-width: 699px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

type Option = { kind: 'place'; place: PlaceResult; recent?: boolean } | { kind: 'coords'; lngLat: [number, number] } | { kind: 'locate' };

function TypeIcon({ type }: { type: PlaceResult['type'] }) {
  if (type === 'county') return <MapIcon size={16} />;
  if (type === 'zip') return <Hash size={16} />;
  if (type === 'cdp') return <Home size={16} />;
  return <Building2 size={16} />;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = normalize(query);
  const i = q ? normalize(text).indexOf(q) : -1;
  if (i < 0 || normalize(text).length !== text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SearchBox() {
  const places = useStore((s) => s.places);
  const highlight = useStore((s) => s.highlight);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const narrow = useNarrow();
  const [remoteSearch, setRemoteSearch] = useState<{ query: string; results: PlaceResult[]; loading: boolean; error: string | null }>({ query: '', results: [], loading: false, error: null });

  // Reflect selections made elsewhere (URL restore, chat) in the field.
  useEffect(() => {
    if (highlight) setQuery(placeTitle(highlight.place));
  }, [highlight]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 120);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  const localOutcome: SearchOutcome | null = useMemo(() => {
    if (!places.data || !debounced.trim()) return null;
    if (highlight && debounced === placeTitle(highlight.place)) return null;
    return searchPlaces(places.data, debounced);
  }, [places.data, debounced, highlight]);

  useEffect(() => {
    if (!API_BASE) return;
    if (!debounced.trim() || debounced.trim().length < 2 ||
      (highlight && debounced === placeTitle(highlight.place)) || localOutcome?.coordinates) {
      setRemoteSearch({ query: '', results: [], loading: false, error: null });
      return;
    }
    const ctrl = new AbortController();
    setRemoteSearch({ query: debounced, results: [], loading: true, error: null });
    void searchLocations(debounced, ctrl.signal).then(results => {
      if (!ctrl.signal.aborted) setRemoteSearch({ query: debounced, results, loading: false, error: null });
    }).catch((error: Error) => {
      if (!ctrl.signal.aborted) setRemoteSearch({ query: debounced, results: [], loading: false, error: error.message });
    });
    return () => ctrl.abort();
  }, [debounced, highlight, localOutcome?.coordinates]);

  const outcome: SearchOutcome | null = useMemo(() => API_BASE && !localOutcome?.coordinates && debounced.trim()
    ? { results: remoteSearch.query === debounced ? remoteSearch.results : [], coordinates: null, fuzzy: false,
        notice: remoteSearch.loading || remoteSearch.error ? null : localOutcome?.notice ??
          (remoteSearch.query === debounced && !remoteSearch.results.length ? { kind: 'none', message: `No California location matches “${debounced}”.` } : null) }
    : localOutcome, [localOutcome, debounced, remoteSearch]);

  const options: Option[] = useMemo(() => {
    if (!query.trim() || (highlight && query === placeTitle(highlight.place))) {
      const byId = new Map((places.data ?? []).map((p) => [p.id, p]));
      const recent = recentPlaceIds().map((id) => byId.get(id)).filter(Boolean) as PlaceResult[];
      const quick = QUICK_PLACES.map((id) => byId.get(id)).filter((p): p is PlaceResult => !!p && !recent.some((r) => r.id === p.id));
      return [{ kind: 'locate' } as Option, ...recent.map((place) => ({ kind: 'place' as const, place, recent: true })), ...quick.map((place) => ({ kind: 'place' as const, place }))];
    }
    if (outcome?.coordinates) return [{ kind: 'coords', lngLat: outcome.coordinates }];
    return (query === debounced ? outcome?.results ?? [] : []).map((place) => ({ kind: 'place' as const, place }));
  }, [query, outcome, places.data, highlight]);

  useEffect(() => setActive(0), [options]);

  const choose = (o: Option | undefined) => {
    if (!o) return;
    setOpen(false);
    input.current?.blur();
    if (o.kind === 'place') {
      setQuery(placeTitle(o.place));
      void choosePlace(o.place);
    } else if (o.kind === 'coords') {
      void goToPoint(o.lngLat);
    } else void locateMe();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(options[active] ?? options[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open) setOpen(false);
      else input.current?.blur();
    }
  };

  const clear = () => {
    setQuery('');
    setDebounced('');
    clearSearch();
    input.current?.focus();
    setOpen(true);
  };

  const showEmptyState = !!query.trim() && !!outcome && !options.length;
  const loading = open && (places.state === 'loading' || (!!API_BASE && (remoteSearch.loading || query !== debounced)));
  const searchError = API_BASE ? remoteSearch.error : places.error;

  return (
    <div className="search" ref={root}>
      <Search className="search__icon" size={17} aria-hidden />
      <input
        id="place-search"
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={narrow ? 'Search places…' : 'Search a city, county, town, or ZIP code in California…'}
        value={query}
        maxLength={120}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          e.target.select();
        }}
        onKeyDown={onKeyDown}
      />
      {(query || highlight) && (
        <button type="button" className="search__clear" aria-label="Clear search" onClick={clear}>
          <X size={15} />
        </button>
      )}
      {open && (loading || searchError || options.length > 0 || showEmptyState || outcome?.notice) && (
        <div className="search__menu" role="presentation">
          {loading && (
            <div className="search__status">
              <Loader2 className="spin" size={15} /> Loading California places…
            </div>
          )}
          {searchError && <div className="search__status is-error" role="alert">Place search is unavailable. {searchError}</div>}
          {outcome?.notice && <div className={`search__notice search__notice--${outcome.notice.kind}`}>{outcome.notice.message}</div>}
          {outcome?.fuzzy && <div className="search__status">Showing close matches</div>}
          <ul id={listId} role="listbox" aria-label="Search suggestions">
            {options.map((o, i) => (
              <li
                key={o.kind === 'place' ? o.place.id : o.kind}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'is-active' : ''}
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                {o.kind === 'place' && (
                  <>
                    <span className="search__type">{o.recent ? <Clock size={16} /> : <TypeIcon type={o.place.type} />}</span>
                    <span className="search__text">
                      <span className="search__name">
                        <Highlight text={placeTitle(o.place)} query={o.recent ? '' : query} />
                      </span>
                      <span className="search__sub">
                        {placeSubtitle(o.place)}
                        {formatPopulation(o.place.population) ? ` · ${formatPopulation(o.place.population)}` : ''}
                      </span>
                    </span>
                  </>
                )}
                {o.kind === 'coords' && (
                  <>
                    <span className="search__type">
                      <MapPin size={16} />
                    </span>
                    <span className="search__text">
                      <span className="search__name">
                        Go to {o.lngLat[1].toFixed(4)}, {o.lngLat[0].toFixed(4)}
                      </span>
                      <span className="search__sub">Coordinates (latitude, longitude)</span>
                    </span>
                  </>
                )}
                {o.kind === 'locate' && (
                  <>
                    <span className="search__type search__type--accent">
                      <Navigation size={15} />
                    </span>
                    <span className="search__text">
                      <span className="search__name">Use my location</span>
                      <span className="search__sub">Show the forecast where you are (California only)</span>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {!query.trim() && <div className="search__hint">Cities, towns, counties and ZIP codes · ZIP areas are approximate</div>}
        </div>
      )}
    </div>
  );
}
