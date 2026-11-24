/** Connection source and identity admission for owner-only search HTTP routes. */
export function requestRejection(req, getConnection) {
  try {
    const connection = getConnection()
    const admit = connection?.admit
    if (admit !== undefined && typeof admit !== 'function') return 403
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      if (admission === null || typeof admission !== 'object') return 403
      if ('rejection' in admission) {
        const status = admission.rejection
        return [401, 403, 503].includes(status) ? status : 403
      }
      const peer = admission.peer
      return peer?.principal?.kind === 'owner' && peer?.signal?.aborted === false ? undefined : 403
    }
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return rejection === undefined ? undefined : [401, 403, 503].includes(rejection) ? rejection : 403
    }
    return 403
  } catch { return 403 }
}
