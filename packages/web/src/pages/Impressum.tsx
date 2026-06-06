import { ssr } from "../../config";

/**
 * /impressum — § 5 DDG legal page for the hosted geomark.dev.
 *
 * Email is rendered as HTML character entities (`&#109;&#97;…`) so
 * basic regex scrapers won't match a typical email pattern. Browsers
 * decode entities at parse time, so users see and click a normal
 * `mailto:` link. Doesn't stop sophisticated parsers but cuts most
 * drive-by bots.
 */

// ─── shared section label (same pattern as the other pages) ──────────────

const SectionLabel = (p: { label: string; coord: string; icon: string }) => (
  <div class="section-divider">
    <div class="flex items-baseline gap-3">
      <i class={`ti ${p.icon} text-[var(--color-marker)] text-base translate-y-[2px]`} aria-hidden="true" />
      <span class="mono-cap">{p.label}</span>
    </div>
    <span class="coord hidden md:inline">{p.coord}</span>
  </div>
);

// ─── email obfuscation ───────────────────────────────────────────────────

const encodeEntities = (s: string): string =>
  s
    .split("")
    .map((c) => `&#${c.charCodeAt(0)};`)
    .join("");

const EMAIL_PLAIN = "mail@valentin-kolb.com";
const EMAIL_ENC = encodeEntities(EMAIL_PLAIN);
const MAILTO_ENC = encodeEntities(`mailto:${EMAIL_PLAIN}`);

// ─── page ────────────────────────────────────────────────────────────────

export default ssr(async (c) => {
  const page = c.get("page");
  page.title = "Geomark — Impressum";
  page.description =
    "Anbieterkennzeichnung nach § 5 DDG für geomark.dev.";

  return () => (
    <div class="min-h-screen bg-[var(--color-ink)] text-[var(--color-bone)] relative overflow-hidden">

      {/* ─── top strip ──────────────────────────────────────────────────── */}
      <div class="fixed top-0 left-0 right-0 z-50 backdrop-blur-sm bg-[var(--color-ink)]/80 border-b border-[var(--color-line)]">
        <div class="max-w-[1280px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3 text-[11px]">
          <a href="/" class="flex items-center gap-3 font-mono shrink-0 hover:opacity-80 transition-opacity">
            <span class="beacon-dot" />
            <span class="text-[var(--color-bone)]">geomark</span>
            <span class="text-[var(--color-bone-fade)] hidden sm:inline">/</span>
            <span class="text-[var(--color-bone-dim)] hidden sm:inline">v0.1</span>
          </a>
          <nav class="flex items-center gap-3 md:gap-5 font-mono text-[10.5px] uppercase tracking-widest">
            <a href="/data" class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)]">data</a>
            <a href="/docs" class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)]">docs</a>
            <a
              href="https://github.com/valentinkolb/geomark"
              class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)] flex items-center gap-1"
            >
              <i class="ti ti-brand-github" aria-hidden="true" /> github
            </a>
          </nav>
        </div>
      </div>

      {/* graticule background */}
      <div class="fixed inset-0 bg-graticule pointer-events-none opacity-60" />

      <div class="relative z-10 max-w-3xl mx-auto px-4 md:px-6 pt-20 md:pt-24 pb-24">

        {/* ─── PAGE HEADER ──────────────────────────────────────────────── */}
        <header class="mb-16 md:mb-20 pt-6 md:pt-10">
          <div class="mono-cap mb-4 flex items-center gap-2">
            <i class="ti ti-file-description" aria-hidden="true" /> legal
          </div>
          <h1 class="display text-[clamp(2.25rem,6vw,4.5rem)] mb-5 md:mb-6">
            Impressum.
          </h1>
          <p class="text-sm md:text-base text-[var(--color-bone-dim)] leading-relaxed">
            Anbieterkennzeichnung nach § 5 DDG (vormals § 5 TMG) für die
            unter <code class="code-inline">geomark.dev</code> betriebene
            Website.
          </p>
        </header>

        {/* ─── ANBIETER ──────────────────────────────────────────────────── */}
        <section class="mb-12 md:mb-16">
          <SectionLabel label="Anbieter" coord="§ 5 DDG" icon="ti-user" />
          <address class="not-italic text-base md:text-lg text-[var(--color-bone)] leading-relaxed">
            Valentin Kolb<br />
            Maienweg 22<br />
            89081 Ulm<br />
            Deutschland
          </address>
        </section>

        {/* ─── KONTAKT ──────────────────────────────────────────────────── */}
        <section class="mb-12 md:mb-16">
          <SectionLabel label="Kontakt" coord="email only" icon="ti-mail" />
          <p class="text-base md:text-lg text-[var(--color-bone-dim)] leading-relaxed">
            E-Mail:{" "}
            <a
              href={MAILTO_ENC}
              class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
              innerHTML={EMAIL_ENC}
            />
          </p>
        </section>

        {/* ─── V.i.S.d.P. ───────────────────────────────────────────────── */}
        <section class="mb-12 md:mb-16">
          <SectionLabel
            label="Inhaltliche Verantwortung"
            coord="§ 18 Abs. 2 MStV"
            icon="ti-id-badge"
          />
          <p class="text-base text-[var(--color-bone-dim)] leading-relaxed">
            Verantwortlich für den Inhalt: Valentin Kolb (Anschrift wie
            oben).
          </p>
        </section>

        {/* ─── HAFTUNG ──────────────────────────────────────────────────── */}
        <section class="mb-12 md:mb-16">
          <SectionLabel label="Haftungsausschluss" coord="content + links + ©" icon="ti-shield" />

          <div class="space-y-6 text-sm md:text-base text-[var(--color-bone-dim)] leading-relaxed">
            <div>
              <h3 class="text-[var(--color-bone)] font-medium mb-2">
                Haftung für Inhalte
              </h3>
              <p>
                Die Inhalte dieser Website wurden mit größter Sorgfalt
                erstellt. Für die Richtigkeit, Vollständigkeit und
                Aktualität der Inhalte kann jedoch keine Gewähr übernommen
                werden. Als Diensteanbieter bin ich gemäß § 7 Abs. 1 DDG
                für eigene Inhalte auf diesen Seiten nach den allgemeinen
                Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG bin ich als
                Diensteanbieter jedoch nicht verpflichtet, übermittelte
                oder gespeicherte fremde Informationen zu überwachen oder
                nach Umständen zu forschen, die auf eine rechtswidrige
                Tätigkeit hinweisen.
              </p>
            </div>

            <div>
              <h3 class="text-[var(--color-bone)] font-medium mb-2">
                Haftung für Links
              </h3>
              <p>
                Diese Website enthält Links zu externen Websites Dritter,
                auf deren Inhalte ich keinen Einfluss habe. Deshalb kann
                ich für diese fremden Inhalte auch keine Gewähr übernehmen.
                Für die Inhalte der verlinkten Seiten ist stets der
                jeweilige Anbieter oder Betreiber der Seiten
                verantwortlich. Bei Bekanntwerden von Rechtsverletzungen
                werden derartige Links umgehend entfernt.
              </p>
            </div>

            <div>
              <h3 class="text-[var(--color-bone)] font-medium mb-2">
                Urheberrecht
              </h3>
              <p>
                Der Quellcode dieser Website und der zugehörigen
                Geomark-API steht unter der MIT-Lizenz (siehe{" "}
                <a
                  href="https://github.com/valentinkolb/geomark/blob/main/LICENSE"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  LICENSE
                </a>
                ). Die ausgelieferten Geodaten stammen von{" "}
                <a
                  href="https://www.geonames.org/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  GeoNames
                </a>{" "}
                (CC&nbsp;BY&nbsp;4.0) und{" "}
                <a
                  href="https://openaddresses.io/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  OpenAddresses
                </a>{" "}
                (lizenziert je nach Quelle: CC0, CC BY, ODbL, Public
                Domain). Bei Weiterverwendung der Daten bitte die
                Quellenangaben aus{" "}
                <a href="/api/v1/attribution" class="coord-tide hover:underline">
                  /api/v1/attribution
                </a>{" "}
                beibehalten.
              </p>
            </div>
          </div>
        </section>

        {/* ─── DATENSCHUTZ ─────────────────────────────────────────────── */}
        <section class="mb-12 md:mb-16">
          <SectionLabel label="Datenschutz" coord="no tracking · no cookies" icon="ti-lock" />

          <div class="space-y-4 text-sm md:text-base text-[var(--color-bone-dim)] leading-relaxed">
            <p>
              Diese Website setzt keine Cookies, lädt keine
              Drittanbieter-Tracker und nutzt keine Analyse-Werkzeuge wie
              Google Analytics, Plausible o. ä. Es werden keine
              personenbezogenen Daten erhoben oder verarbeitet, die über
              das technisch Notwendige hinausgehen.
            </p>
            <p>
              <strong class="text-[var(--color-bone)] font-medium">Lokaler Speicher.</strong>{" "}
              Auf der Seite <code class="code-inline">/docs</code> wird die
              gewählte Sprache (curl / typescript) im{" "}
              <code class="code-inline">localStorage</code> des Browsers
              gespeichert — ausschließlich auf deinem Gerät, kein Versand
              an den Server.
            </p>
            <p>
              <strong class="text-[var(--color-bone)] font-medium">API-Aufrufe.</strong>{" "}
              Die interaktive Suche und die Welt-Karte rufen die
              öffentliche Geomark-API unter{" "}
              <code class="code-inline">/api/v1/*</code> auf. Diese Anfragen
              werden zur Auslieferung der Antwort verarbeitet; die IP-Adresse
              wird kurzzeitig im Speicher des Rate-Limiters vorgehalten und
              nicht persistent geloggt oder weitergegeben.
            </p>
            <p>
              <strong class="text-[var(--color-bone)] font-medium">Server-Logs.</strong>{" "}
              Der Webserver kann technische Zugriffsdaten (Zeitstempel,
              IP-Adresse, User-Agent, angefragte URL, Statuscode)
              vorübergehend zur Fehlerbehebung und Abwehr von Missbrauch
              verarbeiten. Eine darüber hinausgehende Auswertung oder
              Weitergabe findet nicht statt.
            </p>
            <p>
              Rechtsgrundlage für die o. g. Verarbeitungen ist Art. 6 Abs.
              1 lit. f DSGVO (berechtigtes Interesse am Betrieb einer
              technisch funktionierenden Website).
            </p>
          </div>
        </section>

        {/* ─── footer ──────────────────────────────────────────────────── */}
        <footer class="border-t border-[var(--color-line)] pt-8 md:pt-10 mt-16 md:mt-20">
          <div class="grid md:grid-cols-12 gap-6 text-sm">
            <div class="md:col-span-6">
              <div class="display text-2xl md:text-3xl mb-2">geomark.dev</div>
              <div class="text-[var(--color-bone-dim)] max-w-md leading-relaxed">
                Open-source geocoding. Data: GeoNames (CC&nbsp;BY&nbsp;4.0)
                and OpenAddresses contributors. Code: MIT.
              </div>
            </div>
            <nav class="md:col-span-3 space-y-2 coord">
              {[
                { href: "/",          label: "home",      icon: "ti-home"             },
                { href: "/data",      label: "data",      icon: "ti-database"         },
                { href: "/docs",      label: "docs",      icon: "ti-book"             },
                { href: "/impressum", label: "impressum", icon: "ti-file-description" },
              ].map((l) => (
                <div>
                  <a
                    href={l.href}
                    class={`hover:text-[var(--color-marker)] flex items-center gap-2 ${l.href === "/impressum" ? "text-[var(--color-marker)]" : ""}`}
                  >
                    <i class={`ti ${l.icon}`} aria-hidden="true" />
                    {l.label}
                  </a>
                </div>
              ))}
            </nav>
            <div class="md:col-span-3 coord space-y-2 md:text-right">
              <div class="text-[var(--color-bone-fade)]">made in Ulm</div>
              <div class="coord-tide">48.4011° N · 9.9876° E</div>
              <div class="text-[var(--color-bone-fade)] flex items-center md:justify-end gap-2">
                <i class="ti ti-current-location" aria-hidden="true" /> you are here
              </div>
            </div>
          </div>
        </footer>

      </div>
    </div>
  );
});
