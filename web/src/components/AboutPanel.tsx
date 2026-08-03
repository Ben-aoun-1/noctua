import { useEffect, useRef } from "react"

/**
 * What Noctua is, for whoever opened the link.
 *
 * The cockpit explains itself to anyone who already knows what a browser agent is. This panel is
 * for everyone else: the person handed a URL and asked whether the thing is any good. So it is
 * prose rather than a feature list, it names no class and no API, and it puts the receipt — the one
 * idea the whole project turns on — in the middle where it cannot be skimmed past.
 *
 * A slide-over rather than a page: the run stays on screen behind it, which is the point. Reading
 * "every number carries a receipt" with the table of numbers still visible is a different sentence
 * from reading it on a marketing page.
 */

/** Everything Tab would stop on inside the panel, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Section {
  head: string
  body: string
}

const SECTIONS: Section[] = [
  {
    head: "WHAT THIS IS",
    body:
      "Noctua is an agent that does a chore in a real browser. You describe the work the way you " +
      "would describe it to a new colleague — verify these three vendors, compile the filing " +
      "deadlines for a company opening in Ireland — and it opens a tab, reads pages, clicks " +
      "through them, and comes back with a table you can check.",
  },
  {
    head: "THE LOOP",
    body:
      "It works in one loop, repeated: observe, think, act. Each step starts with a fresh " +
      "screenshot of the page and a list of what is on it. It reads that, decides on a single next " +
      "move — open this link, type in that box, record what it just confirmed — and takes it. Then " +
      "it looks again. Nothing is scripted underneath: the route through a site is chosen as it goes, " +
      "which is why it can handle a site nobody prepared it for.",
  },
  {
    head: "RECEIPTS",
    body:
      "Every number in the findings table carries a receipt. The small chip at the end of a row is " +
      "the step the fact was read on; click it and you get the address it was read from, and the " +
      "page exactly as it looked at that moment. Where a finding recorded no source, the receipt " +
      "says so rather than covering for it. Either way you are told what the receipt can and " +
      "cannot show, which is the difference between an answer you have to trust and one you can " +
      "check.",
  },
  {
    head: "STEERING IT",
    body:
      "You are not a spectator. Autopilot lets it work; approve-each-step makes it ask before every " +
      "single action. You can pause it, stop it, or whisper a note mid-flight — the note is binding " +
      "from the next step on, so “use the official registry, not the directory” lands at " +
      "once. It can also stop and ask you something, when the choice is genuinely yours: two " +
      "companies share a name, and only you know which one is your vendor.",
  },
  {
    head: "THE GUARDRAILS",
    body:
      "It is instructed never to type a password, an API key or a card number, and to hand a login " +
      "or payment wall back to you instead. Filling in a field and pressing Enter to submit it " +
      "stops for your approval even in autopilot, and approve-each-step gates every action there " +
      "is. Every run carries a hard ceiling on steps, on cost and on minutes, and stops when one " +
      "is reached. Addresses on private networks are refused before a tab is opened.",
  },
  {
    head: "WHEN IT GETS STUCK",
    body:
      "A failed step is not repeated. It tries a genuinely different way — another element, another " +
      "route, another source — and if that fails too it asks you rather than thrashing. At the end " +
      "it says which of success, partial or failure it actually achieved, in its own words. Whatever " +
      "it had already confirmed is kept, so a run that ends early still hands over the part it got.",
  },
  {
    head: "THE LOG",
    body:
      "Everything on this screen is replayed from one durable log of what happened: thoughts, " +
      "actions, frames and findings, in the order they occurred. Nothing lives only in the page. " +
      "That is why a finished run can be dragged back and forth like a tape, opened again next week " +
      "from the same link, and exported as Markdown, CSV or JSON with the receipts still attached.",
  },
  {
    head: "THE NAME",
    body:
      "Underneath, it is Claude driving Playwright — a real Chromium browser, nothing simulated. " +
      "Noctua is the owl of Minerva, which flies at dusk: understanding arriving once the day's " +
      "work is done.",
  },
]

export default function AboutPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  // The panel takes focus on open so that Escape, the scroll keys and the close button are all one
  // keystroke away; the trigger takes it back on close, which is the caller's half of the bargain.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  /**
   * Escape, and the loop that keeps Tab inside the panel.
   *
   * On the window rather than on the panel, because focus can legitimately be inside it, on the
   * backdrop's dead space, or nowhere at all after a click on the body — and both of these have to
   * work in all three cases. The trap is what earns `aria-modal`: a screen reader is being told the
   * rest of the page is inert, and Tab must not then walk straight out into it. It is also what
   * keeps the cockpit's own keyboard shortcuts out of reach while this is open.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const panel = panelRef.current
      if (panel === null) return

      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab") return

      const stops = panel.querySelectorAll<HTMLElement>(FOCUSABLE)
      const active = document.activeElement
      const outside = !(active instanceof Node) || !panel.contains(active)
      // The prose carries no links, so this can legitimately be the close button alone — and a
      // panel with nothing tabbable in it at all still must not hand Tab to the page behind.
      if (stops.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = stops[0]
      const last = stops[stops.length - 1]
      if (event.shiftKey ? outside || active === first || active === panel : outside || active === last) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      {/* Ink at a fifth, so the run behind stays legible: this panel is read against the cockpit,
          not instead of it. Keyboard users close with Escape or the button, so the backdrop is a
          mouse affordance only and is hidden from the accessibility tree rather than announced. */}
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-ink/20"
        onClick={onClose}
        data-testid="about-backdrop"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        tabIndex={-1}
        className="slide-over hairline fixed top-0 right-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l bg-sand outline-none"
        data-testid="about-panel"
      >
        <header className="hairline flex shrink-0 items-center justify-between gap-4 border-b px-6 py-4">
          <h2 id="about-title" className="serif text-[22px] leading-tight">
            About Noctua
          </h2>
          <button
            className="chip hover:bg-cream"
            onClick={onClose}
            aria-label="Close the About panel"
            data-testid="about-close"
          >
            <span aria-hidden>CLOSE ✕</span>
          </button>
        </header>

        <div className="min-h-0 grow overflow-y-auto px-6 py-5">
          {SECTIONS.map((section) => (
            <section key={section.head} className="mt-6 first:mt-0">
              <p className="microlabel">{section.head}</p>
              <p className="serif mt-2 text-[17px] leading-[1.45] text-ink/85">{section.body}</p>
            </section>
          ))}
          <p className="microlabel hairline mt-8 border-t pt-4">
            NOCTUA — THE OWL OF MINERVA · BUILT WITH CLAUDE
          </p>
        </div>
      </div>
    </>
  )
}
