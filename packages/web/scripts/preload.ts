/**
 * Bun preload — registers the SSR plugin globally so dev (`bun --watch`)
 * picks up .island.tsx / .client.tsx files transparently.
 *
 * `bun-plugin-tailwind` is *not* registered here: it uses `onBeforeParse`,
 * which is only available inside `Bun.build({plugins:[…]})`. The CSS
 * compile happens in src/server.tsx (dev) and scripts/build.ts (prod).
 */
import { plugin } from "../config";

Bun.plugin(plugin());
