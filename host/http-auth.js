/** Connection source and identity admission for owner-only search HTTP routes. */
export function requestRejection(req, getConnection, peer) {
  try {
    const connection = getConnection()
    const admit = connection?.admit
    if (admit !== undefined && typeof admit !== 'function') return 403
    if (typeof admit === 'function') {
      // This Peer comes only from the WebServer handler's third argument.
      // The carrier has already checked source policy and credentials.
      return peer?.principal?.kind === 'owner' && peer?.signal?.aborted === false ? undefined : 403
    }
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return rejection === undefined ? undefined : [401, 403, 503].includes(rejection) ? rejection : 403
    }
    return 403
  } catch { return 403 }
}
