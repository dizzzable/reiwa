import { create } from 'zustand'

interface AuthState {
  /** Whether the user must change their password before accessing protected routes */
  requiresPasswordChange: boolean
  setRequiresPasswordChange: (value: boolean) => void
  clearRequiresPasswordChange: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  requiresPasswordChange: false,
  setRequiresPasswordChange: (value) => set({ requiresPasswordChange: value }),
  clearRequiresPasswordChange: () => set({ requiresPasswordChange: false }),
}))
