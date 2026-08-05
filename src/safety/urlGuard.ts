import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

/**
 * Ranges an agent must never reach. BlockList compares parsed bytes, so every textual
 * spelling of an address (compressed, hex, IPv4-mapped) is matched by the same rule.
 */
const PRIVATE = new BlockList()
PRIVATE.addSubnet("0.0.0.0", 8)        // "this network"
PRIVATE.addSubnet("10.0.0.0", 8)       // RFC1918
PRIVATE.addSubnet("100.64.0.0", 10)    // CGNAT
PRIVATE.addSubnet("127.0.0.0", 8)      // loopback
PRIVATE.addSubnet("169.254.0.0", 16)   // link-local, incl. cloud metadata 169.254.169.254
PRIVATE.addSubnet("172.16.0.0", 12)    // RFC1918
PRIVATE.addSubnet("192.168.0.0", 16)   // RFC1918
PRIVATE.addSubnet("224.0.0.0", 4)      // multicast
PRIVATE.addSubnet("240.0.0.0", 4)      // reserved, incl. 255.255.255.255 broadcast
PRIVATE.addSubnet("::", 96, "ipv6")    // unspecified, loopback, IPv4-compatible ::a.b.c.d
PRIVATE.addSubnet("64:ff9b::", 96, "ipv6") // NAT64, can encode any IPv4 incl. metadata
PRIVATE.addSubnet("fc00::", 7, "ipv6") // unique local
PRIVATE.addSubnet("fe80::", 10, "ipv6") // link-local
// IPv4-mapped ::ffff:a.b.c.d is matched against the IPv4 rules above by BlockList itself.

/** Strips the square brackets the WHATWG URL parser keeps around IPv6 hosts. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

export function isPrivateIp(ip: string): boolean {
  const addr = unbracket(ip)
  const family = isIP(addr)
  if (family === 0) return false
  return PRIVATE.check(addr, family === 6 ? "ipv6" : "ipv4")
}

/**
 * Whether one request the page makes may go out, judged on the literal address alone.
 *
 * This is a deliberately smaller question than {@link assertSafeUrl} answers. It is asked of every
 * subresource — images, frames, stylesheets, fetches, dozens per page — so it cannot resolve DNS:
 * that would be a lookup on the critical path of every request, to re-apply a policy the tab's own
 * address is already held to. What it stops is the case the navigation guard structurally cannot
 * see, because the tab never moves: a page that embeds `http://169.254.169.254/latest/meta-data/`
 * and has the browser photograph cloud credentials into the model's context, the event log and the
 * exports on its behalf.
 */
export function allowPublicRequest(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  // Not an IP literal (a hostname, or no host at all as in `data:`) is not this check's business.
  return !isPrivateIp(u.hostname)
}

export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`blocked: invalid URL`) }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked: protocol ${u.protocol}`)
  const host = unbracket(u.hostname)
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`blocked: host ${host}`)
  if (isIP(host)) { if (isPrivateIp(host)) throw new Error(`blocked: private ip ${host}`); return }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new Error(`blocked: cannot resolve ${host}`) })
  if (addrs.length === 0) throw new Error(`blocked: cannot resolve ${host}`)
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`blocked: ${host} resolves to private ip`)
}
