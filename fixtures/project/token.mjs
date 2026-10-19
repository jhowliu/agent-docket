export function expired(expiry, now) {
  return expiry < now;
}
