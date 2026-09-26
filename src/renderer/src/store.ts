import { useSyncExternalStore } from 'react'

// 极简状态容器：高频数据（视线、手柄）放在 React 外面，组件按需订阅

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  patch(p: Partial<T>): void
  subscribe(fn: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? (next as (p: T) => T)(state) : next
      subs.forEach((f) => f())
    },
    patch(p) {
      state = { ...state, ...p }
      subs.forEach((f) => f())
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** 简单的事件总线 */
export class Emitter<E extends Record<string, unknown>> {
  private map = new Map<keyof E, Set<(p: any) => void>>()
  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    if (!this.map.has(k)) this.map.set(k, new Set())
    this.map.get(k)!.add(fn)
    return () => this.map.get(k)!.delete(fn)
  }
  emit<K extends keyof E>(k: K, p: E[K]): void {
    this.map.get(k)?.forEach((f) => f(p))
  }
}

let idSeq = 0
export function uid(prefix = 'id'): string {
  idSeq++
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`
}
