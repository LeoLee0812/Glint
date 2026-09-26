import type { LookAskApi } from './index'

declare global {
  interface Window {
    lookask: LookAskApi
  }
}

export {}
