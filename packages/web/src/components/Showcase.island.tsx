import { createSignal, For, Show } from "solid-js";
import { hotkeys, mutation, timed } from "@valentinkolb/stdlib/solid";
import { timing } from "@valentinkolb/stdlib";

/**
 * Live API showcase — the /v1/search endpoint.
 *
 * Search is the main feature: fuzzy (trigram), unaccent, BM25-ranked,
 * multilingual via aliases. The other endpoints (reverse, code, postal)
 * are documented in /docs — bundling them all into one input was a
 * mode-switching UX nightmare.
 *
 * Async lifecycle delegated to @valentinkolb/stdlib/solid:
 *   • mutation.create  — loading/error/abort/retry + AbortSignal
 *   • timed.debounce   — auto-cleanup on unmount
 */

// ─── types ────────────────────────────────────────────────────────────────

type Feature = {
  gid: string;
  layer: string;
  name: string;
  label?: string | null;
  latitude: number;
  longitude: number;
  country_code: string | null;
  score: number;
  matched_alias?: { lang: string | null; value: string; kind: string } | null;
};

type SearchResp = {
  features: Feature[];
  ms: number;
  path: string;
};

// ─── helpers ──────────────────────────────────────────────────────────────

const layerIcon = (layer: string): string => {
  if (layer === "address")  return "ti-map-pin";
  if (layer === "locality") return "ti-building";
  if (layer === "country")  return "ti-flag";
  return "ti-tag";
};

const EXAMPLES: { text: string; hint: string }[] = [
  { text: "berlin",   hint: "exact match"          },
  { text: "münchen",  hint: "multilingual · alias" },
  { text: "munic",    hint: "trigram · typo"       },
  { text: "lubeck",   hint: "unaccent · fuzzy"     },
  { text: "broadway", hint: "cross-country"        },
];

// ─── component ────────────────────────────────────────────────────────────

export default function Showcase() {
  const [q, setQ] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  // ⌘ K (or Ctrl+K on non-Mac) focuses the search input from anywhere
  // on the page. `inInput` is unset so the hotkey will NOT fire while
  // the user is already typing in another field — they're presumably
  // doing something deliberate. Auto-cleanup on unmount.
  hotkeys.create({
    "mod+k": {
      label: "Focus search",
      run: () => {
        inputRef?.focus();
        inputRef?.select();
      },
    },
  });

  // The fetch fires immediately; `timing.withMinLoadTime` holds the
  // promise (and therefore the mutation's `loading` state) for at least
  // 300ms so the loader bar gets time to actually appear. Without this
  // floor a typical 5–15ms response would make the bar flicker — present
  // long enough to flash, too short to read.
  const search = mutation.create<SearchResp, string>({
    mutation: (text, { abortSignal }) =>
      timing.withMinLoadTime(async () => {
        const path = `/v1/search?q=${encodeURIComponent(text)}&limit=6`;
        const start = performance.now();
        const r = await fetch(path, { signal: abortSignal });
        const ms = Math.round(performance.now() - start);
        if (!r.ok) throw new Error("upstream");
        const body = (await r.json()) as { features: Feature[] };
        return { features: body.features, ms, path };
      }, 300),
  });

  // Tiny debounce — only coalesces sub-50ms keystroke bursts (paste,
  // composition events). Slower input goes straight through; the 300ms
  // loading-state floor (above) handles the visual flicker so we don't
  // throttle the search itself.
  const debounced = timed.debounce((text: string) => {
    search.abort();
    const t = text.trim();
    if (!t) return;
    search.mutate(t);
  }, 50);

  const onInput = (text: string) => {
    setQ(text);
    debounced.debouncedFn(text);
  };

  const fillExample = (text: string) => {
    setQ(text);
    debounced.trigger(text);
  };

  // Hide stale data when input is empty.
  const resp = () => (q().trim() ? search.data() : null);

  return (
    <div class="panel">
      {/* header */}
      <div class="flex items-baseline justify-between mb-5 gap-3 flex-wrap">
        <span class="mono-cap flex items-center gap-2">
          <i class="ti ti-bolt" aria-hidden="true" /> Try the search API
        </span>
        <span class="coord flex items-center gap-2">
          <span class="beacon-dot" /> live
        </span>
      </div>

      {/* input */}
      <div class="relative">
        <i
          class="ti ti-search absolute left-4 md:left-5 top-1/2 -translate-y-1/2 text-xl text-[var(--color-marker)] pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          class="input-field pl-12 md:pl-14 pr-20 md:pr-28"
          placeholder="search a city, address, or postal code…"
          value={q()}
          onInput={(e) => onInput(e.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
        />
        <span class="absolute right-3 md:right-5 top-1/2 -translate-y-1/2 hidden sm:inline-flex kbd">
          <i class="ti ti-command" aria-hidden="true" /> K
        </span>
      </div>

      {/* examples */}
      <div class="flex flex-wrap gap-2 mt-4 items-center">
        <span class="coord text-[var(--color-bone-fade)] mr-1">try:</span>
        <For each={EXAMPLES}>
          {(ex) => (
            <button
              type="button"
              class={`chip ${q() === ex.text ? "chip-active" : ""}`}
              onClick={() => fillExample(ex.text)}
              title={ex.hint}
            >
              {ex.text}
            </button>
          )}
        </For>
      </div>

      {/* loader strip */}
      <div class="h-px bg-[var(--color-line)] mt-6 relative overflow-hidden">
        <Show when={search.loading()}>
          <div class="absolute inset-0 loader-bar" />
        </Show>
      </div>

      {/* error */}
      <Show when={search.error() && !search.loading() && q().trim()}>
        <div class="py-4 flex items-center gap-3 text-[var(--color-bone-dim)] text-sm">
          <i class="ti ti-cloud-off text-[var(--color-marker)] text-base" aria-hidden="true" />
          <span>Couldn't reach the geocoder — please try again in a moment.</span>
          <button type="button" class="btn-link ml-auto" onClick={() => search.retry()}>
            <i class="ti ti-refresh" aria-hidden="true" /> retry
          </button>
        </div>
      </Show>

      {/* response */}
      <Show when={resp() && !search.loading() && !search.error()}>
        <div class="flex items-baseline justify-between py-3 gap-3 flex-wrap">
          <code class="coord coord-tide truncate">
            <span class="text-[var(--color-bone-fade)]">GET</span>{" "}
            {resp()!.path.replace(/^\/api/, "")}
          </code>
          <span class="coord shrink-0">{resp()!.ms}ms</span>
        </div>

        <Show
          when={resp()!.features.length > 0}
          fallback={
            <div class="result-row coord text-[var(--color-bone-dim)]">
              <i class="ti ti-help-circle" aria-hidden="true" /> no matches
            </div>
          }
        >
          <ul class="divide-y divide-[var(--color-line)] border border-[var(--color-line)]">
            <For each={resp()!.features}>{(f) => <FeatureRow f={f} />}</For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

// ─── result row ───────────────────────────────────────────────────────────

const FeatureRow = (p: { f: Feature }) => (
  <li class="result-row">
    <i
      class={`ti ${layerIcon(p.f.layer)} text-lg text-[var(--color-bone-dim)] shrink-0`}
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1">
      <div class="text-base text-[var(--color-bone)] truncate">
        {p.f.label || p.f.name}
      </div>
      <div class="coord truncate">
        {p.f.layer}
        {p.f.country_code ? ` · ${p.f.country_code}` : ""}
        <Show when={p.f.matched_alias}>
          {" · "}
          <span class="coord-marker">
            matched: {p.f.matched_alias!.value}
            {p.f.matched_alias!.lang ? ` (${p.f.matched_alias!.lang})` : ""}
          </span>
        </Show>
      </div>
    </div>
    <span class="coord coord-tide hidden sm:inline shrink-0">
      {p.f.latitude.toFixed(4)}° · {p.f.longitude.toFixed(4)}°
    </span>
  </li>
);
