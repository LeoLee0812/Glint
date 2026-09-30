import { createStore, uid } from '../store'
import { la, toast } from '../appState'
import { WELCOME_MD } from './welcome'

// 左侧标签页：每个标签是一份「文档」——Markdown、PDF 或终端

export type DocKind = 'md' | 'pdf' | 'terminal'

export interface Doc {
  id: string
  kind: DocKind
  title: string
  text?: string
  data?: Uint8Array
  path?: string
}

const initial: Doc[] = [
  { id: 'welcome', kind: 'md', title: '使用说明', text: WELCOME_MD },
  { id: 'term1', kind: 'terminal', title: '终端' }
]

export const docsStore = createStore<{ docs: Doc[]; active: string }>({ docs: initial, active: 'welcome' })

export function openDoc(doc: Omit<Doc, 'id'> & { id?: string }): string {
  const id = doc.id || uid('doc')
  docsStore.set((s) => {
    const exists = s.docs.find((d) => d.id === id || (doc.path && d.path === doc.path))
    if (exists) return { ...s, active: exists.id }
    return { docs: [...s.docs, { ...doc, id }], active: id }
  })
  return id
}

export function closeDoc(id: string): void {
  docsStore.set((s) => {
    const docs = s.docs.filter((d) => d.id !== id)
    const active = s.active === id ? docs[Math.max(0, s.docs.findIndex((d) => d.id === id) - 1)]?.id ?? '' : s.active
    return { docs, active }
  })
}

export function activate(id: string): void {
  docsStore.patch({ active: id })
}

export function cycleDoc(delta: number): void {
  const { docs, active } = docsStore.get()
  if (!docs.length) return
  const i = docs.findIndex((d) => d.id === active)
  const next = docs[(i + delta + docs.length) % docs.length]
  docsStore.patch({ active: next.id })
}

export function activeDoc(): Doc | undefined {
  const { docs, active } = docsStore.get()
  return docs.find((d) => d.id === active)
}

/** 从拖进来的文件 / 打开对话框读到的内容建标签 */
export async function openFile(f: File): Promise<void> {
  const name = f.name
  const lower = name.toLowerCase()
  let path = ''
  try {
    path = la.file.pathOf(f)
  } catch {
    /* 从别处拖来的内存文件没有路径 */
  }
  if (lower.endsWith('.pdf')) {
    const data = new Uint8Array(await f.arrayBuffer())
    openDoc({ kind: 'pdf', title: name.replace(/\.pdf$/i, ''), data, path })
  } else if (/\.(md|markdown|txt)$/.test(lower)) {
    openDoc({ kind: 'md', title: name.replace(/\.(md|markdown|txt)$/i, ''), text: await f.text(), path })
  } else {
    toast(`打不开 ${name}，只支持 .md / .pdf / .txt`, 'warn')
  }
}

export async function openViaDialog(): Promise<void> {
  const r = await la.file.open()
  if (!r) return
  if (r.kind === 'pdf') openDoc({ kind: 'pdf', title: r.name.replace(/\.pdf$/i, ''), data: r.data, path: r.path })
  else openDoc({ kind: 'md', title: r.name.replace(/\.(md|markdown|txt)$/i, ''), text: r.text, path: r.path })
}

export function newTerminal(): void {
  const n = docsStore.get().docs.filter((d) => d.kind === 'terminal').length + 1
  openDoc({ kind: 'terminal', title: `终端 ${n}` })
}
