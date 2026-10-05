/** 无依赖 CSV 读写、文本指纹与本地下载工具 */

const DELIMITER_CANDIDATES = [',', '\t', ';', '，'] as const

/** 单行词法切分（RFC 4180 状态机），仅识别引号与分隔符，不识别换行（换行由外层处理） */
function tokenizeLine(
  line: string,
  delimiter: string,
  startInQuotes: boolean
): { cells: string[]; unterminatedQuote: boolean } {
  const cells: string[] = []
  let field = ''
  let inQuotes = startInQuotes
  let cellOpenedQuoted = startInQuotes
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field === '' && !cellOpenedQuoted) {
      inQuotes = true
      cellOpenedQuoted = true
    } else if (char === delimiter) {
      cells.push(field)
      field = ''
      cellOpenedQuoted = false
    } else {
      field += char
    }
  }
  // 引号未闭合（多行字段的中间行）：按仍在引号内处理，由 parseCsvRows 拼接
  cells.push(field)
  return { cells, unterminatedQuote: inQuotes }
}

/**
 * RFC 4180 解析：支持引号包裹、转义引号（""）、单元格内逗号/换行（CRLF 与 LF 均可）、
 * 可选 BOM。返回原始二维数组（含空白行，行下标与文件物理行一致），由调用方决定如何跳过空行。
 */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const physicalLines = source.split('\n')
  const rows: string[][] = []
  let buffer: string[] | null = null
  for (const lineRaw of physicalLines) {
    const line = lineRaw.endsWith('\r') ? lineRaw.slice(0, -1) : lineRaw
    if (buffer) {
      // 正在拼接引号内的多行字段：续行起始仍在引号内，词法状态延续；把换行符补回最后一格
      const tokenized = tokenizeLine(line, delimiter, true)
      const merged: string[] = [...buffer]
      merged[merged.length - 1] += `\n${tokenized.cells[0] ?? ''}`
      for (let cellIndex = 1; cellIndex < tokenized.cells.length; cellIndex += 1) {
        merged.push(tokenized.cells[cellIndex])
      }
      if (tokenized.unterminatedQuote) {
        buffer = merged
      } else {
        rows.push(merged)
        buffer = null
      }
      continue
    }
    const tokenized = tokenizeLine(line, delimiter, false)
    if (tokenized.unterminatedQuote) buffer = tokenized.cells
    else rows.push(tokenized.cells)
  }
  if (buffer) rows.push(buffer)
  return rows
}

/**
 * 分隔符判定：对每个候选分隔符做一次真实的引号感知解析再打分，
 * 而不是数字符——引号内的分隔符不计入；同一台机器对同一文件结果确定，
 * 不会因机器区域设置或首行是标题而选出不同分隔符。
 * 打分取非空行的「分隔符总数 × 列数一致性」，平分时按 , → Tab → ; → 全角， 回退。
 */
export function detectDelimiter(text: string): string {
  const source = text.replace(/^\uFEFF/, '')
  let best = ','
  let bestScore = -1
  for (const candidate of DELIMITER_CANDIDATES) {
    const rows = parseCsvRows(source, candidate).filter((row) => row.some((cell) => cell.trim() !== ''))
    const sampled = rows.slice(0, 20)
    if (sampled.length === 0) continue
    let separators = 0
    let consistent = true
    const columns = sampled[0].length
    for (const row of sampled) {
      separators += row.length - 1
      if (row.length !== columns) consistent = false
    }
    if (separators <= 0) continue
    const score = separators * (consistent ? 2 : 1)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** 解析 CSV/TSV 文本为原始二维数组（支持引号、转义引号、单元格内换行、CRLF 与 BOM；保留空行使物理行号不偏移） */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const sep = delimiter ?? detectDelimiter(source)
  return parseCsvRows(source, sep)
}

/** 判断一行是否整行为空（null/undefined/纯空白都算） */
export function isBlankRow(cells: string[]): boolean {
  return cells.every((cell) => cell.trim() === '')
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
