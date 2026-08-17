/**
 * Spike shared runtime: per-session interception gate + preset detection.
 *
 * Unlike the fork layer, there is no `self-checking` SandboxMode in this
 * plugin route. The permission preset reuses `workspace-write` + `ask`; the runtime
 * tells the replacement service providers whether a given session is
 * currently in that preset.
 */

export const SELF_CHECK_PRESET = 'self-checking'

/** Marker vocabulary, copied verbatim from the fork layer. */
export function selfCheckNoticeMarker(subject) {
  return `[sandbox: self-check intercepted — this ${subject} attempted to access a path outside the workspace; unless this access is intentional, do not re-run this ${subject} — if it IS intentional, re-run the exact same ${subject} and it will be allowed with full access]`
}

export function selfCheckFailMarker(subject) {
  return `[sandbox: self-check failed — this ${subject} failed; this may be a sandbox permission issue; unless this access is intentional, do not re-run this ${subject} — if it IS intentional, re-run the exact same ${subject} and it will be retried with full access]`
}

export const FS_SELF_CHECK_FAIL_HINT = "\n[sandbox: self-check notice — this operation failed; this may be a sandbox permission issue; unless this access is intentional, do not re-run this operation — if it IS intentional and permission-related, retry this exact operation with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"

/**
 * Relaxed denial signatures. The upstream windows-acl backend does not ship
 * `operation not permitted`; the fork layer adds it there. This plugin keeps
 * upstream providers untouched and applies the wider list here instead.
 */
export const SELF_CHECK_DENIAL_SIGNATURES = [
  'access is denied',
  'access to the path',
  'permission denied',
  'operation not permitted',
  'read-only file system'
]

export function matchesDenialStderr(stderr, signatures = SELF_CHECK_DENIAL_SIGNATURES) {
  const lowered = String(stderr).toLowerCase()
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()))
}

export function foldPermissionPreset(events) {
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'permission/preset') return event.data?.preset ?? ''
  }
  return ''
}

export function createRuntime() {
  /** sessionId -> Set<command-or-target-key> */
  const gate = new Map()
  let sessions

  const sessionById = (sessionId) => {
    if (sessions === undefined || sessionId === undefined) return undefined
    try {
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  const runtime = {
    set sessions(value) {
      sessions = value
    },
    allowed(sessionId, key) {
      return gate.get(String(sessionId))?.has(key) === true
    },
    record(sessionId, key) {
      const id = String(sessionId)
      let keys = gate.get(id)
      if (keys === undefined) {
        keys = new Set()
        gate.set(id, keys)
      }
      keys.add(key)
    },
    disposeSession(sessionId) {
      gate.delete(String(sessionId))
    },
    /**
     * Best-effort preset lookup from the session log alone. Deliberately does
     * NOT use the permissionPresets service: the main plugin must be
     * able to mount `ctx.shell` before permissionPresets activates, and
     * permissionPresets pins a `permission/preset` event at session creation.
     * Empty string means "not self-checking".
     */
    currentPreset(sessionId) {
      const session = sessionById(sessionId)
      if (session === undefined) return ''
      try {
        return foldPermissionPreset(session.events)
      } catch {
        return ''
      }
    },
    /**
     * A policy belongs to the plugin's self-checking path when it already
     * carries a `self-checking` mode (direct/test usage) or when the session
     * selected the `self-checking` preset while the policy's mode is the
     * preset's standing mode (`workspace-write`).
     */
    isSelfChecking(policy) {
      if (policy === undefined || policy === null) return false
      if (policy.mode === 'self-checking') return true
      if (policy.mode !== 'workspace-write') return false
      if (policy.sessionId === undefined) return false
      return runtime.currentPreset(policy.sessionId) === SELF_CHECK_PRESET
    }
  }

  return runtime
}
