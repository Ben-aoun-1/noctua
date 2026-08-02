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
})
