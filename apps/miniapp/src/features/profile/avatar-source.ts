// One local SVG template for all generated avatars; only a validated RGB color varies.
export function personAvatarSource(
  avatar: { template: string; color: string } | null | undefined,
): string {
  const color =
    avatar?.template === 'person-v1' && /^#[0-9a-f]{6}$/i.test(avatar.color)
      ? avatar.color
      : '#71BDA7'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#192B2C"/><g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="48" cy="26" r="12"/><path d="M48 39v25M28 53l20-10 20 10M48 64L34 83M48 64l14 19"/></g></svg>`
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  for (let i = 0; i < svg.length; i += 3) {
    const a = svg.charCodeAt(i),
      b = svg.charCodeAt(i + 1),
      c = svg.charCodeAt(i + 2)
    const bits = (a << 16) | ((b || 0) << 8) | (c || 0)
    encoded +=
      alphabet[(bits >>> 18) & 63]! +
      alphabet[(bits >>> 12) & 63]! +
      (i + 1 < svg.length ? alphabet[(bits >>> 6) & 63] : '=') +
      (i + 2 < svg.length ? alphabet[bits & 63] : '=')
  }
  return `data:image/svg+xml;base64,${encoded}`
}
