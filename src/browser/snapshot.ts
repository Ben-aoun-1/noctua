import type { Page } from "playwright"
import sharp from "sharp"

/** One interactive element the model can act on, addressed by its `ref` number. */
export interface ElementRef {
  ref: number
  role: string
  name: string
}

export interface Snapshot {
  url: string
  title: string
  elements: ElementRef[]
  /** True when the page had more actionable elements than `MAX_ELEMENTS`, so the listing is partial. */
  truncated: boolean
  screenshotJpeg: Buffer
}

/** Keeps the prompt bounded on link-farm pages; refs beyond this are simply not offered. */
const MAX_ELEMENTS = 120
/** Long button labels and paragraphs-as-links get truncated rather than blowing up the prompt. */
const MAX_NAME = 80
const SCREENSHOT_WIDTH = 1024
const JPEG_QUALITY = 70

/**
 * Reads the page the way the model sees it: a numbered list of interactive elements plus a
 * screenshot. Every captured element is tagged with `data-noctua-ref="<n>"` in the live DOM,
 * so tools act on a ref with the selector `[data-noctua-ref="<n>"]`.
 *
 * Refs are 1-based and only valid until the next `capture` of the same page — each capture
 * clears the previous tags first, so a stale ref resolves to nothing instead of the wrong node.
 * Only the main frame is walked; elements inside iframes are not addressable. Elements a click
 * could not land on — zero-area, invisible, `disabled`, `aria-hidden="true"` — get no ref at all,
 * so the model never spends a step on an action that would time out.
 */
export async function capture(page: Page): Promise<Snapshot> {
  const { elements, truncated } = await page.evaluate(collectElements, {
    maxElements: MAX_ELEMENTS,
    maxName: MAX_NAME,
  })

  const raw = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY })
  const screenshotJpeg = await sharp(raw)
    .resize({ width: SCREENSHOT_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()

  return { url: page.url(), title: await page.title(), elements, truncated, screenshotJpeg }
}

/** The model-facing rendering of a snapshot; the screenshot travels alongside it as an image. */
export function snapshotText(s: Snapshot): string {
  const lines = [`URL: ${s.url}`, `TITLE: ${s.title}`, ""]
  // JSON.stringify quotes and escapes, so a name containing a quote cannot break a line.
  for (const e of s.elements) lines.push(`[${e.ref}] ${e.role} ${JSON.stringify(e.name)}`)
  // Otherwise "it is not listed" reads as "it is not on the page", and the model gives up on a
  // control that is really there — just past the cap.
  if (s.truncated) lines.push(`(listing truncated at ${MAX_ELEMENTS} elements)`)
  return lines.join("\n")
}

/**
 * Runs inside the page. Must be fully self-contained — it is serialised to the browser, so it
 * cannot reference anything from this module's scope beyond its single argument.
 */
function collectElements({
  maxElements,
  maxName,
}: {
  maxElements: number
  maxName: number
}): { elements: ElementRef[]; truncated: boolean } {
  const SELECTOR =
    "a[href], button, input, select, textarea, [role=button], [role=link], [onclick]"
  const TEXTBOX_TYPES = new Set(["text", "search", "email", "url", "number", "tel", "password"])
  const BUTTON_TYPES = new Set(["submit", "button", "reset", "image"])

  // A ref only means anything for the capture that issued it; drop the previous round's tags
  // so a model replaying an old ref gets "not found" rather than a silently different element.
  for (const stale of Array.from(document.querySelectorAll("[data-noctua-ref]"))) {
    stale.removeAttribute("data-noctua-ref")
  }

  const clean = (value: string | null): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxName)

  const roleOf = (el: HTMLElement): string => {
    const explicit = (el.getAttribute("role") ?? "").trim().toLowerCase()
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === "a") return "link"
    if (tag === "button") return "button"
    if (tag === "select") return "combobox"
    if (tag === "textarea") return "textbox"
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase()
      if (TEXTBOX_TYPES.has(type)) return "textbox"
      if (BUTTON_TYPES.has(type)) return "button"
      if (type === "checkbox" || type === "radio") return type
      return "input"
    }
    return tag
  }

  const nameOf = (el: HTMLElement): string => {
    // A native dropdown renders its options outside the page, so neither the screenshot nor a
    // click can reveal them. Naming the choices here is what makes `select_option` usable at all.
    if (el.tagName.toLowerCase() === "select") {
      const label =
        clean(el.getAttribute("aria-label")) || clean(el.getAttribute("name")) || "select"
      // `option.label` is the label attribute when there is one and the option's text otherwise —
      // exactly what Playwright's label matcher compares against, so what the model is shown here
      // is what `select_option` can actually select.
      const options = Array.from((el as HTMLSelectElement).options)
        .map((option) => clean(option.label))
        .filter((text) => text !== "")
      if (options.length === 0) return label

      const prefix = `${label} — options: `
      const whole = `${prefix}${options.join("|")}`
      if (whole.length <= maxName) return whole
      // A country picker's options cannot all fit. Cutting mid-word would invent a choice the
      // model then tries to select, so show whole labels only and count the rest.
      let best = ""
      for (let shown = 1; shown <= options.length; shown++) {
        const candidate = `${prefix}${options.slice(0, shown).join("|")}|…(+${options.length - shown} more)`
        if (candidate.length > maxName) break
        best = candidate
      }
      if (best !== "") return best
      // Not even one label fits beside the marker: say only how many there are.
      const none = `${prefix}…(+${options.length} more)`
      return none.length <= maxName ? none : label
    }
    const isPassword =
      el.tagName.toLowerCase() === "input" &&
      (el.getAttribute("type") ?? "").toLowerCase() === "password"
    // Never surface a typed password to the model, even as an element name.
    const value = isPassword ? "" : ((el as HTMLInputElement).value ?? el.getAttribute("value"))
    return (
      clean(el.innerText) ||
      clean(el.getAttribute("aria-label")) ||
      clean(el.getAttribute("placeholder")) ||
      clean(value) ||
      clean(el.getAttribute("name")) ||
      ""
    )
  }

  const out: ElementRef[] = []
  let truncated = false
  for (const node of Array.from(document.querySelectorAll(SELECTOR))) {
    // Skips SVG anchors and other non-HTML elements, which have no innerText to name them.
    if (!(node instanceof HTMLElement)) continue
    // Cheap "a click could plausibly land here" filter — not full Playwright actionability
    // (no occlusion, pointer-events or ancestor aria-hidden walk). It exists so the model is
    // never offered a ref that `page.click` would then time out on.
    if (node.getClientRects().length === 0) continue
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue // zero-area: nothing to click
    if (getComputedStyle(node).visibility === "hidden") continue
    if ((node as HTMLButtonElement).disabled === true) continue
    if (node.getAttribute("aria-hidden") === "true") continue

    // The cap is checked after the filters, so "truncated" means a real, actionable element was
    // left out — not merely that the page has many hidden nodes.
    if (out.length >= maxElements) {
      truncated = true
      break
    }
    const ref = out.length + 1
    node.setAttribute("data-noctua-ref", String(ref))
    out.push({ ref, role: roleOf(node), name: nameOf(node) })
  }
  return { elements: out, truncated }
}
