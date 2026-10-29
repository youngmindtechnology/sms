import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from '../lib/api'
import type { Me } from './types'

type Status = 'loading' | 'signedOut' | 'signedIn' | 'error'

interface AuthValue {
  status: Status
  me: Me | null
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  switchSchool: (schoolId: string) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  reload: () => Promise<void>
  can: (permission: string) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

/**
 * Auth state comes from the server (/api/auth/me), never from the browser's storage.
 * Reloading the page asks the server "who am I?" again. The UI uses `can()` only to
 * hide things; the server enforces every permission itself.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMe] = useState<Me | null>(null)

  const clear = useCallback(() => {
    setCsrfToken(null)
    setMe(null)
    setStatus('signedOut')
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api<Me>('/api/auth/me', { skipUnauthorizedHandler: true })
      setCsrfToken(data.csrfToken)
      setMe(data)
      setStatus('signedIn')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clear()
      else setStatus('error')
    }
  }, [clear])

  useEffect(() => {
    setUnauthorizedHandler(clear)
    void load()
    return () => setUnauthorizedHandler(null)
  }, [load, clear])

  const login = useCallback(
    async (email: string, password: string) => {
      await api('/api/auth/login', { method: 'POST', body: { email, password }, skipUnauthorizedHandler: true })
      await load()
    },
    [load],
  )

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', skipUnauthorizedHandler: true })
    } catch {
      /* even if the call fails, drop local state; the server session expires on its own */
    }
    clear()
  }, [clear])

  const switchSchool = useCallback(
    async (schoolId: string) => {
      await api('/api/auth/switch-school', { method: 'POST', body: { schoolId } })
      await load()
    },
    [load],
  )

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword }, skipUnauthorizedHandler: true })
      await load()
    },
    [load],
  )

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      login,
      logout,
      switchSchool,
      changePassword,
      reload: load,
      can: (permission) => me?.school?.permissions.includes(permission) ?? false,
    }),
    [status, me, login, logout, switchSchool, changePassword, load],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
