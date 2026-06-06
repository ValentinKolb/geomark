import { clipboard } from "@valentinkolb/stdlib/solid";

/**
 * Copy-to-clipboard button. Uses stdlib's `clipboard.create` which
 * exposes a `wasCopied` accessor that auto-resets after 2000ms — gives
 * us a tiny "copied" feedback without manual timer juggling.
 */

export default function CopyButton(p: { text: string; label?: string }) {
  const { copy, wasCopied } = clipboard.create(2000);

  return (
    <button
      type="button"
      class="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-widest text-[var(--color-bone-dim)] hover:text-[var(--color-bone)] transition-colors px-2 py-1 -mr-2"
      onClick={() => copy(p.text)}
      aria-label={wasCopied() ? "Copied" : "Copy to clipboard"}
    >
      <i
        class={`ti ${wasCopied() ? "ti-check text-[var(--color-tide)]" : "ti-copy"}`}
        aria-hidden="true"
      />
      <span class={wasCopied() ? "text-[var(--color-tide)]" : ""}>
        {wasCopied() ? "copied" : (p.label ?? "copy")}
      </span>
    </button>
  );
}
