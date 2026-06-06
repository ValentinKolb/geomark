import { createSignal, Index, onCleanup, onMount } from "solid-js";

/**
 * Live world map — fetches `/v1/random` every 2s and tweens each
 * dot's position from its old sample to its new sample.
 *
 * Why position-tween instead of opacity cross-fade: with two
 * cross-fading layers, alpha-compositing math means each pixel of a
 * single-layer dot drops to 50% brightness at the midpoint of the
 * fade. The total ink integral stays constant, but the human eye
 * picks up the per-pixel dimming as a sinusoidal brightness pulse.
 *
 * With one layer of 2000 always-fully-opaque dots that smoothly
 * migrate to new positions, the average brightness stays flat and the
 * visual reads as a coordinate swarm rearranging itself.
 *
 * The animation is pure CSS — `circle.live-dot` transitions cx, cy,
 * fill, r, and opacity. Solid's `<Index>` keys by position (not
 * reference), so the same DOM element persists across refreshes even
 * when the array contains fresh objects; updating its attributes
 * triggers the browser-native transition (GPU-accelerated).
 */

type Dot = { lng: number; lat: number; tier: 0 | 1 | 2 };

type RandomPlace = {
  gid: string;
  latitude: number;
  longitude: number;
  population: number | null;
};

const tier = (pop: number | null): 0 | 1 | 2 => {
  if (pop == null) return 0;
  if (pop >= 2_000_000) return 2;
  if (pop >= 500_000) return 1;
  return 0;
};

const LIMIT = 2000;
const INTERVAL_MS = 5000;

export default function LiveWorldMap() {
  const [dots, setDots] = createSignal<Dot[]>([]);
  let inFlight = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const fetchPlaces = async (): Promise<RandomPlace[] | null> => {
    try {
      const r = await fetch(`/v1/random?limit=${LIMIT}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { places: RandomPlace[] };
      return body.places ?? [];
    } catch {
      return null;
    }
  };

  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const newPlaces = await fetchPlaces();
      if (!newPlaces) return;
      setDots(
        newPlaces.map((p) => ({
          lng: p.longitude,
          lat: p.latitude,
          tier: tier(p.population),
        })),
      );
    } finally {
      inFlight = false;
    }
  };

  onMount(() => {
    refresh();
    intervalId = setInterval(refresh, INTERVAL_MS);
  });

  onCleanup(() => {
    if (intervalId !== null) clearInterval(intervalId);
  });

  return (
    <svg
      viewBox="-180 -90 360 180"
      class="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
      aria-label="live world map sampling places from the dataset"
    >
      {/* graticule */}
      <line x1="-180" y1="0" x2="180" y2="0"
        stroke="var(--color-line)" stroke-width="0.25" />
      <line x1="0" y1="-90" x2="0" y2="90"
        stroke="var(--color-line)" stroke-width="0.25" />
      {[-60, -30, 30, 60].map((y) => (
        <line x1="-180" y1={y} x2="180" y2={y}
          stroke="var(--color-line)" stroke-width="0.12" />
      ))}
      {[-120, -60, 60, 120].map((x) => (
        <line x1={x} y1="-90" x2={x} y2="90"
          stroke="var(--color-line)" stroke-width="0.12" />
      ))}

      {/* dots — one element per index, attributes update on refresh,
          CSS transitions handle the smooth migration */}
      <Index each={dots()}>
        {(d) => (
          <circle
            class="live-dot"
            cx={d().lng}
            cy={-d().lat}
            r={d().tier === 2 ? 0.55 : d().tier === 1 ? 0.35 : 0.2}
            fill={d().tier > 0 ? "var(--color-marker)" : "var(--color-bone)"}
            opacity={d().tier === 2 ? 0.95 : d().tier === 1 ? 0.75 : 0.55}
          />
        )}
      </Index>
    </svg>
  );
}
