import { createSignal, onMount } from "solid-js";

/**
 * Language toggle for the docs page. Flips a `lang-curl` / `lang-ts`
 * class on the nearest `[data-lang-root]` ancestor; CSS rules in
 * styles.css hide the inactive snippet block, so SSR renders both
 * versions and the toggle just switches visibility — no big island
 * payload, no flash on language change.
 *
 * Choice persists across pages via plain localStorage (deferred to
 * onMount so the SSR pass doesn't try to access browser globals).
 */

type Lang = "curl" | "ts";
const STORAGE_KEY = "geomark-docs-lang";

const apply = (next: Lang) => {
  const root = document.querySelector("[data-lang-root]");
  if (!root) return;
  root.classList.remove("lang-curl", "lang-ts");
  root.classList.add(`lang-${next}`);
};

export default function LangToggle() {
  const [lang, setLang] = createSignal<Lang>("curl");

  onMount(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "curl" || saved === "ts") {
        setLang(saved);
        apply(saved);
      }
    } catch {
      // localStorage may be blocked (private mode, etc.) — silently ignore
    }
  });

  const select = (next: Lang) => {
    setLang(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  return (
    <div class="inline-flex items-center gap-2 border border-[var(--color-line)] p-1 bg-[var(--color-ink-rise)]/40">
      <button
        type="button"
        class={`chip border-transparent ${lang() === "curl" ? "chip-active" : ""}`}
        onClick={() => select("curl")}
      >
        <i class="ti ti-terminal-2" aria-hidden="true" /> curl
      </button>
      <button
        type="button"
        class={`chip border-transparent ${lang() === "ts" ? "chip-active" : ""}`}
        onClick={() => select("ts")}
      >
        <i class="ti ti-brand-typescript" aria-hidden="true" /> typescript
      </button>
    </div>
  );
}
