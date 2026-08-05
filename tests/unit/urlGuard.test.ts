import { describe, it, expect, vi } from "vitest"
import { allowPublicRequest, assertSafeUrl, isPrivateIp } from "../../src/safety/urlGuard.js"

// Only the two fake hosts below are stubbed; every other lookup hits the real resolver,
// so the public-site test still exercises real DNS.
const STUBBED_DNS: Record<string, { address: string; family: number }[]> = {
  "ssrf-metadata.example": [{ address: "169.254.169.254", family: 4 }],
  "ssrf-empty.example": [],
  // Names that merely *contain* an internal-sounding word, so the suffix rules can be shown not to
  // over-match without the answer depending on what the real resolver says about a made-up domain.
  "internal.example": [{ address: "93.184.216.34", family: 4 }],
  "mylocalhost.example": [{ address: "93.184.216.34", family: 4 }],
}
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>()
  return {
    ...actual,
    lookup: vi.fn((host: string, options: Parameters<typeof actual.lookup>[1]) =>
      host in STUBBED_DNS ? Promise.resolve(STUBBED_DNS[host]) : actual.lookup(host, options)),
  }
})

describe("urlGuard", () => {
  it.each(["10.0.0.1", "192.168.1.5", "127.0.0.1", "169.254.169.254", "172.16.0.9", "::1", "fd00::1"])(
    "flags %s as private", (ip) => expect(isPrivateIp(ip)).toBe(true))
  it("allows public ips", () => expect(isPrivateIp("93.184.216.34")).toBe(false))
  it("rejects non-http protocols", async () =>
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(/^blocked:/))
  it("rejects localhost literal", async () =>
    await expect(assertSafeUrl("http://127.0.0.1:8080/")).rejects.toThrow(/^blocked:/))
  it("allows a public site", async () =>
    await expect(assertSafeUrl("https://example.com/")).resolves.toBeUndefined())

  // "::ffff:a9fe:a9fe" is how the WHATWG URL parser normalizes "::ffff:169.254.169.254".
  it.each(["::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::"])(
    "flags ipv4-mapped/unspecified %s as private", (ip) => expect(isPrivateIp(ip)).toBe(true))
  it.each(["100.64.1.2", "100.127.255.254", "240.0.0.1", "255.255.255.255", "224.0.0.1"])(
    "flags cgnat/reserved %s as private", (ip) => expect(isPrivateIp(ip)).toBe(true))
  it("flags a NAT64-encoded metadata address as private", () =>
    expect(isPrivateIp("64:ff9b::a9fe:a9fe")).toBe(true))
  it("leaves neighbouring public ranges alone", () => {
    expect(isPrivateIp("100.63.0.1")).toBe(false)
    expect(isPrivateIp("101.0.0.1")).toBe(false)
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false)
  })
  it.each(["http://[::1]/", "http://[fd00::1]/", "http://[::ffff:169.254.169.254]/"])(
    "rejects ipv6 literal %s as a private ip", async (url) =>
      await expect(assertSafeUrl(url)).rejects.toThrow(/^blocked: private ip/))
  it("allows a public ipv6 literal", async () =>
    await expect(assertSafeUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/")).resolves.toBeUndefined())

  it.each([
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://localhost/",
    "http://anything.localhost/",
  ])("rejects internal host suffix in %s", async (url) =>
    await expect(assertSafeUrl(url)).rejects.toThrow(/^blocked: host /))
  // The same names both gates refuse, so neither can quietly drift away from the other.
  it.each(["http://mylocalhost.example/", "http://internal.example/"])(
    "does not mistake %s for an internal name", async (url) =>
      await expect(assertSafeUrl(url)).resolves.toBeUndefined())
  it("rejects an unparseable url", async () =>
    await expect(assertSafeUrl("not a url")).rejects.toThrow(/^blocked: invalid URL$/))
})

/**
 * The subresource question, which is a smaller one on purpose: it is asked of every image, frame
 * and fetch a page makes, so it cannot spend a DNS lookup on each. What it stops is the direct
 * hit — an embedded `http://169.254.169.254/…` whose pixels would otherwise be photographed into
 * the model's context, the event log and the exports.
 */
describe("urlGuard — what a page may pull in", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/admin",
    "https://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
  ])("refuses %s", (url) => expect(allowPublicRequest(url)).toBe(false))

  it.each([
    "https://example.com/logo.png",
    "https://find-and-update.company-information.service.gov.uk/company/09446231",
    "http://[2606:2800:220:1:248:1893:25c8:1946]/",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "about:blank",
  ])("allows %s", (url) => expect(allowPublicRequest(url)).toBe(true))

  /**
   * A name can say "inside this deployment" without an IP literal anywhere in it, and this check
   * reads nothing but the literal address — so the names have to be refused by name. These are the
   * canonical ones: `metadata.google.internal` is where GCP serves the same credentials that
   * 169.254.169.254 does, and `localhost` is this app's own API inside its own container.
   */
  it.each([
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://localhost:8080/api/runs",
    "https://LOCALHOST/",
    "http://printer.local/",
    "http://wiki.internal/",
    // `.localhost` is reserved to loopback, and chromium resolves every name under it there —
    // so this is `localhost:8080` again, spelled so that a check on the word alone misses it.
    "http://anything.localhost:8080/",
  ])("refuses %s by name", (url) => expect(allowPublicRequest(url)).toBe(false))

  // Named rules are suffixes, not substrings: a real site must not be caught by one.
  it.each(["https://mylocalhost.com/", "https://internal.example.com/", "https://local.dev/"])(
    "leaves %s alone", (url) => expect(allowPublicRequest(url)).toBe(true))

  // The honest limit of a check that must not resolve DNS. The address the *tab* is on is where
  // that policy is applied, by `assertSafeUrl`, which does resolve.
  it("does not chase a hostname that resolves somewhere private", () => {
    expect(allowPublicRequest("http://ssrf-metadata.example/")).toBe(true)
  })

  it("refuses a request whose url is not one", () => {
    expect(allowPublicRequest("not a url")).toBe(false)
  })
})

describe("urlGuard DNS resolution (stubbed resolver)", () => {
  it("rejects a public hostname that resolves to a private ip", async () =>
    await expect(assertSafeUrl("http://ssrf-metadata.example/")).rejects.toThrow(/resolves to private ip/))
  it("rejects a hostname with no dns answers", async () =>
    await expect(assertSafeUrl("http://ssrf-empty.example/")).rejects.toThrow(/^blocked: cannot resolve /))
})
