import { describe, it, expect } from "vitest"
import { assertSafeUrl, isPrivateIp } from "../../src/safety/urlGuard.js"

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
  it.each(["100.64.1.2", "100.127.255.254", "240.0.0.1", "255.255.255.255"])(
    "flags cgnat/reserved %s as private", (ip) => expect(isPrivateIp(ip)).toBe(true))
  it("leaves neighbouring public ranges alone", () => {
    expect(isPrivateIp("100.63.0.1")).toBe(false)
    expect(isPrivateIp("101.0.0.1")).toBe(false)
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false)
  })
  it.each(["http://[::1]/", "http://[fd00::1]/", "http://[::ffff:169.254.169.254]/"])(
    "rejects ipv6 literal %s as a private ip", async (url) =>
      await expect(assertSafeUrl(url)).rejects.toThrow(/^blocked: private ip/))
  it("does not treat a public ipv6 literal as private", async () => {
    let err: unknown
    await assertSafeUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/").catch((e: unknown) => { err = e })
    if (err) expect((err as Error).message).not.toMatch(/private/)
  })
})
