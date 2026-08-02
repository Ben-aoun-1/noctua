import { describe, it, expect, vi } from "vitest"
import { assertSafeUrl, isPrivateIp } from "../../src/safety/urlGuard.js"

// Only the two fake hosts below are stubbed; every other lookup hits the real resolver,
// so the public-site test still exercises real DNS.
const STUBBED_DNS: Record<string, { address: string; family: number }[]> = {
  "ssrf-metadata.example": [{ address: "169.254.169.254", family: 4 }],
  "ssrf-empty.example": [],
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

  it.each(["http://metadata.google.internal/", "http://printer.local/"])(
    "rejects internal host suffix in %s", async (url) =>
      await expect(assertSafeUrl(url)).rejects.toThrow(/^blocked: host /))
  it("rejects an unparseable url", async () =>
    await expect(assertSafeUrl("not a url")).rejects.toThrow(/^blocked: invalid URL$/))
})

describe("urlGuard DNS resolution (stubbed resolver)", () => {
  it("rejects a public hostname that resolves to a private ip", async () =>
    await expect(assertSafeUrl("http://ssrf-metadata.example/")).rejects.toThrow(/resolves to private ip/))
  it("rejects a hostname with no dns answers", async () =>
    await expect(assertSafeUrl("http://ssrf-empty.example/")).rejects.toThrow(/^blocked: cannot resolve /))
})
