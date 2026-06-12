import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { zh } from "./zh";
import { en } from "./en";

// `zh` is the source of truth (declared `as const` so TS sees its keys at the
// literal level). Catalog widens every leaf back to `string` so other locales
// can supply their own translations while still having to mirror the *shape*
// — missing keys or wrong nesting still fail to compile.
type DeepStrings<T> = T extends string
  ? string
  : { [K in keyof T]: DeepStrings<T[K]> };

export type Catalog = DeepStrings<typeof zh>;

// Recursive dotted-path key extractor over the catalog literal type. Limited
// to ~5 levels deep, which comfortably covers the current structure.
type Join<A extends string, B extends string> = A extends "" ? B : `${A}.${B}`;
type Paths<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: Paths<T[K], Join<Prefix, K>>;
    }[keyof T & string];

export type TKey = Paths<Catalog>;

export type Lang = "zh" | "en";
export type LanguagePref = "auto" | Lang;

const CATALOGS: Record<Lang, Catalog> = { zh, en };

export function detectSystemLang(): Lang {
  const nav = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLang(pref: LanguagePref | string | undefined): Lang {
  if (pref === "zh" || pref === "en") return pref;
  return detectSystemLang();
}

function lookup(cat: Catalog, key: string): string {
  const parts = key.split(".");
  let cur: any = cat;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return key;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : key;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}

export function translate(
  lang: Lang,
  key: TKey,
  vars?: Record<string, string | number>,
): string {
  return interpolate(lookup(CATALOGS[lang], key), vars);
}

/** Pick singular vs plural form. English-style rule (n === 1 → one). */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

interface I18nValue {
  lang: Lang;
  pref: LanguagePref;
  setPref: (next: LanguagePref) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

interface ProviderProps {
  pref: LanguagePref;
  onPrefChange?: (next: LanguagePref) => void;
  children: ReactNode;
}

export function I18nProvider({ pref, onPrefChange, children }: ProviderProps) {
  const [internal, setInternal] = useState<LanguagePref>(pref);

  useEffect(() => {
    setInternal(pref);
  }, [pref]);

  const lang = useMemo(() => resolveLang(internal), [internal]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    }
  }, [lang]);

  const setPref = useCallback(
    (next: LanguagePref) => {
      setInternal(next);
      onPrefChange?.(next);
    },
    [onPrefChange],
  );

  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>) =>
      translate(lang, key, vars),
    [lang],
  );

  const value: I18nValue = useMemo(
    () => ({ lang, pref: internal, setPref, t }),
    [lang, internal, setPref, t],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n must be used inside <I18nProvider>");
  return v;
}

export function useT(): I18nValue["t"] {
  return useI18n().t;
}
