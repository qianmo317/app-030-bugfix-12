/** 无依赖 CSV 读写、文本指纹与本地下载工具 */

const DELIMITER_CANDIDATES: string[] = [',', '\t', ';', '，']

/** 空白行判定：所有单元格去空白后均为空（用于丢弃文件末尾与标题下的空行） */
export function isBlankRow(cells: string[]): boolean {
  return cells.every((cell) => cell.trim() === '')
}

/**
 * 状态机解析（sep 必须为单字符）：
 * 引号包裹的单元格内允许出现分隔符与换行；`""` 为转义引号；兼容 CRLF / LF / CR 行尾。
 */
function parseWithDelimiter(source: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }
  while (index < source.length) {
    const char = source[index]
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
        } else {
          inQuotes = false
          index += 1
        }
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === sep) {
      pushField()
      index += 1
      continue
    }
    if (char === '\r') {
      pushRow()
      index += source[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (char === '\n') {
      pushRow()
      index += 1
      continue
    }
    field += char
    index += 1
  }
  pushRow()
  return rows
}

/** 打分：列数 >1 且各行宽度越一致，说明分隔符选得越对（引号内换行/分隔符不会干扰） */
function scoreRows(rows: string[][]): number {
  let width = 0
  for (const row of rows) width = Math.max(width, row.length)
  if (width < 2) return 0
  let consistent = 0
  for (const row of rows) if (row.length === width) consistent += 1
  return consistent * 1000 + width
}

function parseAndClean(source: string, sep: string): string[][] {
  return parseWithDelimiter(source, sep).filter((row) => !isBlankRow(row))
}

/** 引号感知的分隔符嗅探：对候选分隔符各试解析一遍，取列数最稳定的一种（同一份文件结果确定） */
export function detectDelimiter(text: string): string {
  const source = text.replace(/^\uFEFF/, '')
  let best = DELIMITER_CANDIDATES[0]
  let bestScore = -1
  for (const candidate of DELIMITER_CANDIDATES) {
    const score = scoreRows(parseAndClean(source, candidate))
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** 解析 CSV/TSV 文本为二维数组，支持引号包裹、转义引号、引号内换行、CRLF 与 BOM；丢弃空白行 */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  if (delimiter) return parseAndClean(source, delimiter)
  let bestRows: string[][] = []
  let bestScore = -1
  for (const candidate of DELIMITER_CANDIDATES) {
    const rows = parseAndClean(source, candidate)
    const score = scoreRows(rows)
    if (score > bestScore) {
      bestScore = score
      bestRows = rows
    }
  }
  return bestRows
}

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 生成带 BOM 的 CSV，Excel 双击即正确识别中文 */
export function toCsvText(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`
}

/** FNV-1a 文本指纹，用于同一文件重复导入的幂等判定 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadText(text: string, fileName: string, mime = 'text/csv;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type: mime }), fileName)
}

export function todayStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}`
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}
