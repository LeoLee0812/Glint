// 校准小游戏的历史成绩：每玩完一局记一条（存本机 localStorage），结果页的排行榜、开始页的「最高分」都从这里读
// 17 个点和 9 个点的局分开排（点多总分自然高，混在一起不公平）

export interface GameRun {
  /** 这局结束的时间（毫秒时间戳），也当这条记录的 id */
  at: number
  score: number
  /** 平均反应（秒）：目标冒出来到按对 */
  avg: number
  /** 最快的一次（秒） */
  fastest: number
  /** 最高连击 */
  combo: number
  perfect: number
  /** 这局一共按对了几个目标 */
  n: number
  /** 设置里的校准点数（9 / 17），按它分榜；老记录没有这一项的按 17 算 */
  size?: number
  /** 这局校准出来的准度（很准 / 够用 / 有点偏 / 偏得多） */
  rate: string
}

const KEY = 'lookask.calibGame.runs'
/** 最多留这么多局：每个点数的前 20 名一直留着，其余只留最新的 */
const MAX = 100

function read(): GameRun[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((r) => r && typeof r.score === 'number' && typeof r.at === 'number') : []
  } catch {
    return []
  }
}

const sizeOf = (r: GameRun): number => r.size ?? 17

/** 按分数从高到低，同分的反应快的在前 */
export function ranked(runs: GameRun[] = read()): GameRun[] {
  return [...runs].sort((a, b) => b.score - a.score || a.avg - b.avg || a.at - b.at)
}

/** 这个点数下的最高分 */
export function bestScore(size: number): number | null {
  const top = ranked(read().filter((r) => sizeOf(r) === size))[0]
  return top ? top.score : null
}

/** 记下这一局：返回同点数的排行、这局排第几（从 1 开始）、是不是破了纪录、同点数一共玩了几局 */
export function saveRun(run: GameRun): { board: GameRun[]; rank: number; record: boolean; total: number } {
  const size = sizeOf(run)
  const before = read()
  const prevBest = bestScore(size)
  let all = [...before, run]
  if (all.length > MAX) {
    const top = new Set([9, 17].flatMap((k) => ranked(all.filter((r) => sizeOf(r) === k)).slice(0, 20).map((r) => r.at)))
    const recent = new Set(
      all
        .filter((r) => !top.has(r.at))
        .sort((a, b) => b.at - a.at)
        .slice(0, Math.max(0, MAX - top.size))
        .map((r) => r.at)
    )
    all = all.filter((r) => top.has(r.at) || recent.has(r.at))
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 存不下就只在这次显示 */
  }
  const board = ranked(all.filter((r) => sizeOf(r) === size))
  return {
    board,
    rank: board.findIndex((r) => r.at === run.at) + 1,
    record: prevBest != null && run.score > prevBest,
    total: board.length
  }
}

/** 「今天 14:02」「昨天 20:15」「9月28日」 */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (t: number) => new Date(t).toDateString()
  if (day(at) === day(now)) return `今天 ${hm}`
  if (day(at) === day(now - 86400000)) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
