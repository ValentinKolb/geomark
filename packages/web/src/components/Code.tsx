import { tokenize, TOKEN_COLOR, type Lang } from "./highlight";

/**
 * Server-rendered code block. Tokenizes once at SSR, emits each token
 * as either a raw string (default kind) or a colored <span>. No
 * runtime dependency on the client — Solid SSR walks the JSX tree and
 * inlines everything into the HTML.
 */

export const Code = (p: { lang: Lang; code: string }) => {
  const tokens = tokenize(p.lang, p.code);
  return (
    <>
      {tokens.map((t) => {
        const cls = TOKEN_COLOR[t.kind];
        return cls ? <span class={cls}>{t.text}</span> : t.text;
      })}
    </>
  );
};
