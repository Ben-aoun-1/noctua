import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./]
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase()
    return low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("::ffff:127.")
  }
  return PRIVATE_V4.some((re) => re.test(ip))
}

export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`blocked: invalid URL`) }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked: protocol ${u.protocol}`)
  const host = u.hostname
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`blocked: host ${host}`)
  if (isIP(host)) { if (isPrivateIp(host)) throw new Error(`blocked: private ip ${host}`); return }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new Error(`blocked: cannot resolve ${host}`) })
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`blocked: ${host} resolves to private ip`)
}
