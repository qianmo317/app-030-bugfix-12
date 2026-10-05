/**
 * 批量导入：表头识别、列名匹配（中文短名字 / 英文写法都认）、列冲突仲裁、
 * 两步式 dry_run 预览（新增 / 更新 / 无效 / 错误行）。
 * 严格校验：数值范围、性别值（男/女/M/F）、重复行（同名 + 同班级 + 同身高体重，只提示不删除）。
 *
 * 唯一性约定：createImportPlan 是「表头在哪一行、哪一列映射到哪个字段、哪些列对不上」
 * 的唯一判定入口；预览（buildDryRun）与正式导入（applyImport）共用同一份 plan，
 * 不允许两处各算一遍。
 */
import type { Gender, Person, Project, SizeRule } from './types'
import { analyzeDraft, makePersonId, duplicateKeyOf, type PersonDraft } from './analyze'
import { parseLengthCm, parseWeightKg } from './precision'
import { isBlankRow } from './csv'

export type ImportFieldKey =
  | 'name'
  | 'gender'
  | 'orgUnit'
  | 'batch'
  | 'heightCm'
  | 'weightKg'
  | 'chestCm'
  | 'waistCm'
  | 'specialFlag'
  | 'note'

export type ImportField = {
  key: ImportFieldKey
  label: string
  required: boolean
  /** 归一化后精确相等即可命中的写法（中文短名字、英文写法都列在这里） */
  aliases: string[]
  /** 中文包含词：归一化后的表头包含该词即命中 */
  tokens: string[]
  /** 英文词干：归一化后的英文表头包含该词干即命中 */
  stems: string[]
}

export const IMPORT_FIELDS: ImportField[] = [
  {
    key: 'name',
    label: '姓名',
    required: true,
    aliases: ['姓名', '名字', '学生姓名', '员工姓名', '姓名name', 'name', 'studentname', 'employeename', 'student', 'employee', 'xm'],
    tokens: ['姓名', '名字'],
    stems: ['name', 'student', 'employee']
  },
  {
    key: 'gender',
    label: '性别',
    required: true,
    aliases: ['性别', '性别sex', 'sex', 'gender', 'xb'],
    tokens: ['性别'],
    stems: ['sex', 'gender']
  },
  {
    key: 'orgUnit',
    label: '班级/车间',
    required: false,
    aliases: ['班级', '车间', '部门', '单位', '班组', '科室', '班级车间', 'org', 'orgunit', 'organization', 'department', 'dept', 'team', 'group', 'class', 'workshop', 'bj'],
    tokens: ['班级', '车间', '部门', '单位', '班组', '科室'],
    stems: ['org', 'department', 'dept', 'team', 'group', 'class', 'workshop']
  },
  {
    key: 'batch',
    label: '批次',
    required: false,
    aliases: ['批次', '季节', 'batch', 'season', 'pc'],
    tokens: ['批次', '季节'],
    stems: ['batch', 'season']
  },
  {
    key: 'heightCm',
    label: '身高(cm)',
    required: true,
    aliases: ['身高', '身高厘米', '身高cm', '身高(cm)', '身高（cm）', '厘米', 'height', 'heightcm', 'heightincm', 'h', 'sg'],
    tokens: ['身高'],
    stems: ['height']
  },
  {
    key: 'weightKg',
    label: '体重(kg)',
    required: false,
    aliases: ['体重', '体重公斤', '体重kg', '体重(kg)', '体重（kg）', '公斤', 'weight', 'weightkg', 'weightinkg', 'w', 'wt', 'tz'],
    tokens: ['体重'],
    stems: ['weight']
  },
  {
    key: 'chestCm',
    label: '胸围(cm)',
    required: true,
    aliases: ['胸围', '胸围厘米', '胸围cm', '胸围(cm)', '胸围（cm）', 'chest', 'chestcm', 'chestincm', 'bust', 'bustcm', 'xw'],
    tokens: ['胸围'],
    stems: ['chest', 'bust']
  },
  {
    key: 'waistCm',
    label: '腰围(cm)',
    required: true,
    aliases: ['腰围', '腰围厘米', '腰围cm', '腰围(cm)', '腰围（cm）', 'waist', 'waistcm', 'waistincm', 'yw'],
    tokens: ['腰围'],
    stems: ['waist']
  },
  {
    key: 'specialFlag',
    label: '特殊体型',
    required: false,
    aliases: ['特殊体型', '特殊体形', '特体', '定制', '特殊', 'special', 'specialflag', 'ts'],
    tokens: ['特殊体型', '特殊体形', '特体', '定制', '特殊'],
    stems: ['special']
  },
  {
    key: 'note',
    label: '备注',
    required: false,
    aliases: ['备注', '说明', '注释', 'note', 'remark', 'remarks', 'comment', 'comments', 'bz'],
    tokens: ['备注', '说明', '注释'],
    stems: ['note', 'remark', 'comment']
  }
]

/**
 * 字段仲裁顺序：一个列名同时像多个字段时，按此顺序归给最靠前且尚未被占用的字段。
 * 必填字段在前，保证「必填列在文件里却报没对上」不会被弱字段抢占。
 */
const FIELD_RANK: ImportFieldKey[] = [
  'name',
  'gender',
  'heightCm',
  'chestCm',
  'waistCm',
  'weightKg',
  'orgUnit',
  'batch',
  'specialFlag',
  'note'
]

const FIELD_BY_KEY = new Map(IMPORT_FIELDS.map((field) => [field.key, field]))

export type ColumnMapping = Record<ImportFieldKey, number | null>

export const EMPTY_MAPPING: ColumnMapping = {
  name: null,
  gender: null,
  orgUnit: null,
  batch: null,
  heightCm: null,
  weightKg: null,
  chestCm: null,
  waistCm: null,
  specialFlag: null,
  note: null
}

/** 归一化：去空白/括号/冒号/连字符等，转小写；中文单位词统一成英文单位。
 * 「身高(cm)」「身高 cm」「身高厘米」「Height（厘米）」都按同一形态比较；
 * 同时避免「身高厘米」里的单字「米」误命中单位类词 */
function normalizeHeader(text: string): string {
  return text
    .trim()
    .replace(/厘米|公分/g, 'cm')
    .replace(/公斤|千克/g, 'kg')
    .replace(/[\s（）()：:_\-/[\]【】、.。,，单位#]/g, '')
    .toLowerCase()
}

/** 判断某列表头能否匹配某字段：精确别名 → 中文包含词 → 英文词干 */
function headerMatchesField(headerCell: string, field: ImportField): boolean {
  const cell = headerCell.trim()
  if (cell === '') return false
  const normalized = normalizeHeader(cell)
  // 注意：归一化结果为空串的写法必须跳过——字符串 includes('') 恒为 true，会让该字段匹配一切
  if (field.aliases.some((alias) => {
    const normalizedAlias = normalizeHeader(alias)
    return normalizedAlias !== '' && normalized === normalizedAlias
  }))
    return true
  // 中文短词（≤2 字）要求出现在开头，避免「2026年度量体表」「季节批次说明」之类文本在里侧偶然命中；
  // 长词（如「特殊体型」）包含命中即可
  if (
    field.tokens.some((token) => {
      const normalizedToken = normalizeHeader(token)
      if (normalizedToken === '') return false
      if (normalizedToken.length <= 2) return normalized.startsWith(normalizedToken)
      return normalized.includes(normalizedToken)
    })
  )
    return true
  if (field.stems.some((stem) => stem !== '' && stemRegex(stem).test(normalized))) return true
  return false
}

/** 英文词干按词边界匹配：前面必须是字符串头或非字母（season 不命中 seasoning 式的中间包含）；
 * 后面允许直接接 cm/kg 等单位后缀（heightcm、weightkg 仍命中），否则需到字符串尾或非字母边界 */
function stemRegex(stem: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}(cm|kg|incm|inkg|[^a-z]|$)`)
}

export type ColumnStatusKind = 'mapped' | 'duplicate-column' | 'duplicate-field' | 'unmatched' | 'empty'

export type ColumnStatus = {
  index: number
  header: string
  kind: ColumnStatusKind
  /** kind=mapped 时，该列归属的字段 */
  fieldKey: ImportFieldKey | null
  /** kind=duplicate-* 时，已被采用的那一列下标 */
  takenBy: number | null
  message: string
}

export type ResolveResult = {
  mapping: ColumnMapping
  statuses: ColumnStatus[]
  /** 命中的不同字段数（表头行打分用） */
  matchedFieldCount: number
  warnings: string[]
}

/**
 * 列映射唯一仲裁实现。规则（定下来后预览与正式导入共同遵守）：
 * 1. 从左到右逐列判定，一列匹配多个字段时按 FIELD_RANK 归给最靠先、尚未占用的字段；
 * 2. 同一字段被两列匹配（如「身高」与「height」）：最左列生效，右侧列记 duplicate-field，不算映射成功；
 * 3. 同一列名出现两次：最左列生效，右侧列记 duplicate-column，不算映射成功；
 * 4. 其余未识别列记 unmatched（可由用户手工下拉改判），空列名记 empty。
 */
export function resolveColumns(header: string[]): ResolveResult {
  const mapping: ColumnMapping = { ...EMPTY_MAPPING }
  const statuses: ColumnStatus[] = []
  const warnings: string[] = []
  const seenHeader = new Map<string, number>()

  header.forEach((rawCell, index) => {
    const cell = (rawCell ?? '').trim()
    const label = cell || '(空列名)'
    if (cell === '') {
      statuses.push({ index, header: cell, kind: 'empty', fieldKey: null, takenBy: null, message: '' })
      return
    }

    const normalized = normalizeHeader(cell)
    const sameNameAt = seenHeader.get(normalized)

    const matchedKey = FIELD_RANK.find((key) => {
      const field = FIELD_BY_KEY.get(key)!
      return mapping[key] === null && headerMatchesField(cell, field)
    })

    if (matchedKey === undefined || mapping[matchedKey] !== null) {
      // 没有任何空闲字段可接收：先看是不是同名重复列，再看是不是被别的列抢走了字段
      let kind: ColumnStatusKind = 'unmatched'
      let takenBy: number | null = null
      let message = `第 ${index + 1} 列「${label}」未匹配到任何字段`
      if (sameNameAt !== undefined) {
        kind = 'duplicate-column'
        takenBy = sameNameAt
        message = `第 ${index + 1} 列「${label}」与第 ${sameNameAt + 1} 列同名列名重复，已采用第 ${sameNameAt + 1} 列，本列不导入`
      } else {
        const claimedByKey = FIELD_RANK.find((key) => {
          const field = FIELD_BY_KEY.get(key)!
          const at = mapping[key]
          return at !== null && headerMatchesField(cell, field)
        })
        if (claimedByKey) {
          kind = 'duplicate-field'
          takenBy = mapping[claimedByKey]
          message = `第 ${index + 1} 列「${label}」与第 ${(takenBy ?? 0) + 1} 列「${
            header[takenBy ?? 0]
          }」同时匹配字段「${FIELD_BY_KEY.get(claimedByKey)!.label}」，已采用第 ${(takenBy ?? 0) + 1} 列，本列不导入`
        }
      }
      statuses.push({ index, header: cell, kind, fieldKey: null, takenBy, message })
      if (kind !== 'unmatched') warnings.push(message)
      if (!seenHeader.has(normalized)) seenHeader.set(normalized, index)
      return
    }

    mapping[matchedKey] = index
    seenHeader.set(normalized, index)
    statuses.push({
      index,
      header: cell,
      kind: 'mapped',
      fieldKey: matchedKey,
      takenBy: null,
      message: `→ ${FIELD_BY_KEY.get(matchedKey)!.label}`
    })
  })

  return {
    mapping,
    statuses,
    matchedFieldCount: IMPORT_FIELDS.filter((field) => mapping[field.key] !== null).length,
    warnings
  }
}

/** 表头行扫描窗口：标题/空行之后的表头最多向前找这么多行 */
export const HEADER_SCAN_LIMIT = 10

/**
 * 表头行识别：前 HEADER_SCAN_LIMIT 行内，命中字段数最多的一行作为表头；
 * 至少命中 2 个字段且其中有 1 个必填字段才算数，避免把标题或第一行数据误当表头。
 * 平分时取最靠上的一行。
 */
export function detectHeaderRow(rows: string[][]): number {
  let bestIndex = -1
  let bestScore = 0
  const limit = Math.min(rows.length, HEADER_SCAN_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    if (isBlankRow(rows[index] ?? [])) continue
    const resolved = resolveColumns(rows[index] ?? [])
    const requiredHit = IMPORT_FIELDS.some((field) => field.required && resolved.mapping[field.key] !== null)
    const score = resolved.matchedFieldCount
    if (requiredHit && score >= 2 && score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestIndex
}

export type DataRow = { cells: string[]; lineNo: number }

/** 取表头之后的物理行：整行空白（含文件末尾空行）一律跳过；行号按文件物理行（从 1 起）标注 */
export function extractDataRows(rows: string[][], headerIndex: number): DataRow[] {
  const result: DataRow[] = []
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const cells = rows[index] ?? []
    if (isBlankRow(cells)) continue
    result.push({ cells, lineNo: index + 1 })
  }
  return result
}

export type ImportPlan = {
  headerIndex: number
  header: string[]
  mapping: ColumnMapping
  statuses: ColumnStatus[]
  warnings: string[]
  dataRows: DataRow[]
}

/**
 * 导入判定唯一入口：输出表头位置、列映射、列状态、提示信息与清洗后的数据行。
 * 预览与正式导入都只接受这一份结果，不再各自重新判定。
 */
export function createImportPlan(rows: string[][]): ImportPlan | null {
  const headerIndex = detectHeaderRow(rows)
  if (headerIndex < 0) return null
  const header = rows[headerIndex] ?? []
  const resolved = resolveColumns(header)
  return {
    headerIndex,
    header,
    mapping: resolved.mapping,
    statuses: resolved.statuses,
    warnings: resolved.warnings,
    dataRows: extractDataRows(rows, headerIndex)
  }
}

/** 未映射的必填字段标签（预览生成前必须为空） */
export function missingRequiredFields(mapping: ColumnMapping): string[] {
  return IMPORT_FIELDS.filter((field) => field.required && mapping[field.key] === null).map((field) => field.label)
}

export function mappedCount(mapping: ColumnMapping): number {
  return IMPORT_FIELDS.filter((field) => mapping[field.key] !== null).length
}

/** 手工改判后重新生成列状态（映射以入参为准，重复占用的字段给出提示） */
export function statusesForMapping(header: string[], mapping: ColumnMapping): ColumnStatus[] {
  const fieldByColumn = new Map<number, ImportFieldKey[]>()
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field.key]
    if (column === null) continue
    const list = fieldByColumn.get(column) ?? []
    list.push(field.key)
    fieldByColumn.set(column, list)
  }
  return header.map((rawCell, index) => {
    const cell = (rawCell ?? '').trim()
    const fieldKey = IMPORT_FIELDS.find((field) => mapping[field.key] === index)?.key ?? null
    if (fieldKey) {
      return {
        index,
        header: cell,
        kind: 'mapped' as const,
        fieldKey,
        takenBy: null,
        message: `→ ${FIELD_BY_KEY.get(fieldKey)!.label}`
      }
    }
    if (cell === '') return { index, header: cell, kind: 'empty' as const, fieldKey: null, takenBy: null, message: '' }
    return { index, header: cell, kind: 'unmatched' as const, fieldKey: null, takenBy: null, message: `第 ${index + 1} 列「${cell}」未参与导入` }
  })
}

export type DryRunKind = 'new' | 'update' | 'invalid' | 'error'

export type DryRunRow = {
  lineNo: number
  kind: DryRunKind
  reason: string
  draft: PersonDraft | null
  duplicateOf: string | null
  raw: string[]
}

export type DryRunCounts = {
  new: number
  update: number
  invalid: number
  error: number
  duplicate: number
  total: number
}

export type DryRun = {
  fileName: string
  fingerprint: string
  header: string[]
  mapping: ColumnMapping
  rows: DryRunRow[]
  counts: DryRunCounts
  durationMs: number
}

export function parseGenderValue(raw: string): Gender | null {
  const text = raw.trim()
  if (text === '') return null
  if (/^(男|男性|男生|m|male|1|boy)$/i.test(text)) return 'male'
  if (/^(女|女性|女生|f|female|0|2|girl)$/i.test(text)) return 'female'
  return null
}

function resolveSflag(raw: string, rule: SizeRule): { code: string | null; warning: string } {
  const text = raw.trim()
  if (text === '' || /^(无|否|no|none|-)$/i.test(text)) return { code: null, warning: '' }
  const byCode = rule.specialFlags.find((flag) => flag.code.toLowerCase() === text.toLowerCase())
  if (byCode) return { code: byCode.code, warning: '' }
  const byLabel = rule.specialFlags.find((flag) => flag.label === text || text.includes(flag.label))
  if (byLabel) return { code: byLabel.code, warning: '' }
  return { code: null, warning: `特殊体型标记「${text}」不在 ${rule.version} 规则中，已按普通行处理` }
}

function cellAt(cells: string[], index: number | null): string {
  if (index === null) return ''
  return (cells[index] ?? '').trim()
}

export function buildDraftFromRow(
  cells: string[],
  mapping: ColumnMapping,
  rule: SizeRule,
  defaultBatch: string,
  lineNo: number
): { draft: PersonDraft | null; error: string; warning: string } {
  const name = cellAt(cells, mapping.name)
  if (name === '') return { draft: null, error: '缺少姓名', warning: '' }

  const genderRaw = cellAt(cells, mapping.gender)
  const gender = parseGenderValue(genderRaw)
  if (!gender) {
    return { draft: null, error: `性别「${genderRaw || '空'}」无法识别（应为 男/女/M/F）`, warning: '' }
  }

  const heightRaw = cellAt(cells, mapping.heightCm)
  const heightCm = parseLengthCm(heightRaw)
  if (heightRaw !== '' && heightCm === null) return { draft: null, error: `身高「${heightRaw}」不是有效数字`, warning: '' }

  const chestRaw = cellAt(cells, mapping.chestCm)
  const chestCm = parseLengthCm(chestRaw)
  if (chestRaw !== '' && chestCm === null) return { draft: null, error: `胸围「${chestRaw}」不是有效数字`, warning: '' }

  const waistRaw = cellAt(cells, mapping.waistCm)
  const waistCm = parseLengthCm(waistRaw)
  if (waistRaw !== '' && waistCm === null) return { draft: null, error: `腰围「${waistRaw}」不是有效数字`, warning: '' }

  const weightRaw = cellAt(cells, mapping.weightKg)
  const weightKg = parseWeightKg(weightRaw)
  if (weightRaw !== '' && weightKg === null) return { draft: null, error: `体重「${weightRaw}」不是有效数字`, warning: '' }

  const flag = resolveSflag(cellAt(cells, mapping.specialFlag), rule)
  const noteParts = [cellAt(cells, mapping.note)]
  if (flag.warning) noteParts.push(flag.warning)

  return {
    draft: {
      name,
      gender,
      orgUnit: cellAt(cells, mapping.orgUnit),
      batch: cellAt(cells, mapping.batch) || defaultBatch,
      heightCm,
      weightKg,
      chestCm,
      waistCm,
      specialFlag: flag.code,
      note: noteParts.filter((part) => part !== '').join('；'),
      sourceRow: lineNo,
      source: 'import'
    },
    error: '',
    warning: flag.warning
  }
}

export function buildDryRun(
  plan: ImportPlan,
  project: Project,
  rule: SizeRule,
  fileName: string,
  fingerprint: string,
  /** 手工调整过的映射；不传则用 plan 自动判定的映射。无论哪种都与正式导入共用同一份行集合与判定 */
  mappingOverride?: ColumnMapping
): DryRun {
  const started = performance.now()
  const mapping = mappingOverride ?? plan.mapping
  const dataRows = plan.dataRows
  const existingByKey = new Map<string, Person>()
  const duplicateKeys = new Map<string, string>()
  for (const person of project.persons) {
    const key = `${person.name.trim()}|${person.orgUnit.trim()}|${person.gender}`
    if (!existingByKey.has(key)) existingByKey.set(key, person)
    const dupKey = duplicateKeyOf(person)
    if (!duplicateKeys.has(dupKey)) duplicateKeys.set(dupKey, `既有行「${person.name}」`)
  }

  const rows: DryRunRow[] = []
  const counts: DryRunCounts = { new: 0, update: 0, invalid: 0, error: 0, duplicate: 0, total: dataRows.length }
  const batchDefault = project.batches[0] ?? '未分批'
  const fileDuplicateKeys = new Map<string, number>()

  for (const row of dataRows) {
    const parsed = buildDraftFromRow(row.cells, mapping, rule, batchDefault, row.lineNo)
    if (!parsed.draft) {
      counts.error += 1
      rows.push({ lineNo: row.lineNo, kind: 'error', reason: parsed.error, draft: null, duplicateOf: null, raw: row.cells })
      continue
    }
    const draft = parsed.draft
    const outcome = analyzeDraft(draft, rule)
    const key = `${draft.name.trim()}|${draft.orgUnit.trim()}|${draft.gender}`
    const existing = existingByKey.get(key)

    const dupKey = [draft.name.trim(), draft.orgUnit.trim(), draft.heightCm ?? '', draft.weightKg ?? ''].join('|')
    let duplicateOf: string | null = duplicateKeys.get(dupKey) ?? null
    const earlierLine = fileDuplicateKeys.get(dupKey)
    if (!duplicateOf && earlierLine !== undefined) duplicateOf = `本文件第 ${earlierLine} 行`
    if (!fileDuplicateKeys.has(dupKey)) fileDuplicateKeys.set(dupKey, row.lineNo)
    if (duplicateOf) counts.duplicate += 1

    if (outcome.status === 'invalid') {
      counts.invalid += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'invalid',
        reason: outcome.statusReason,
        draft,
        duplicateOf,
        raw: row.cells
      })
      continue
    }

    if (existing) {
      counts.update += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'update',
        reason: `按「姓名 + 班级」匹配到既有记录（第 ${existing.sourceRow ?? '—'} 行），将更新其量体数据`,
        draft,
        duplicateOf,
        raw: row.cells
      })
    } else {
      counts.new += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'new',
        reason: parsed.warning || '新增量体记录',
        draft,
        duplicateOf,
        raw: row.cells
      })
    }
  }

  return {
    fileName,
    fingerprint,
    header: plan.header,
    mapping,
    rows,
    counts,
    durationMs: Math.round((performance.now() - started) * 100) / 100
  }
}

export function createPersonFromDraft(draft: PersonDraft, rule: SizeRule, duplicateOf: string | null): Person {
  const outcome = analyzeDraft(draft, rule)
  return {
    id: makePersonId(),
    name: draft.name.trim(),
    gender: draft.gender ?? 'male',
    orgUnit: draft.orgUnit.trim(),
    batch: draft.batch,
    heightCm: draft.heightCm ?? 0,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm ?? 0,
    waistCm: draft.waistCm ?? 0,
    specialFlag: draft.specialFlag,
    note: draft.note,
    status: outcome.status,
    statusReason: outcome.statusReason,
    anomaly: outcome.anomaly,
    needsConfirm: outcome.needsConfirm || Boolean(duplicateOf),
    possibleDuplicateOf: duplicateOf,
    sourceRow: draft.sourceRow,
    source: draft.source,
    result: null,
    createdAt: Date.now()
  }
}

export type ApplyResult = { added: number; updated: number; invalid: number; skipped: number }

/** 正式导入：直接消费 dry_run（与预览同一套判定，不再重新解析）；同一文件指纹幂等由调用方先校验 */
export function applyImport(project: Project, dryRun: DryRun, rule: SizeRule): ApplyResult {
  const existingByKey = new Map<string, Person>()
  for (const person of project.persons) {
    const key = `${person.name.trim()}|${person.orgUnit.trim()}|${person.gender}`
    if (!existingByKey.has(key)) existingByKey.set(key, person)
  }
  const result: ApplyResult = { added: 0, updated: 0, invalid: 0, skipped: 0 }
  for (const row of dryRun.rows) {
    if (row.kind === 'error' || !row.draft) {
      result.skipped += 1
      continue
    }
    const draft = row.draft
    const key = `${draft.name.trim()}|${draft.orgUnit.trim()}|${draft.gender}`
    const created = createPersonFromDraft(draft, rule, row.duplicateOf)
    if (row.kind === 'update') {
      const existing = existingByKey.get(key)
      if (existing) {
        existing.heightCm = created.heightCm
        existing.weightKg = created.weightKg
        existing.chestCm = created.chestCm
        existing.waistCm = created.waistCm
        existing.specialFlag = created.specialFlag
        existing.note = created.note
        existing.status = created.status
        existing.statusReason = created.statusReason
        existing.anomaly = created.anomaly
        existing.needsConfirm = created.needsConfirm
        existing.possibleDuplicateOf = created.possibleDuplicateOf
        existing.sourceRow = created.sourceRow
        existing.result = null
        result.updated += 1
        continue
      }
    }
    project.persons.push(created)
    existingByKey.set(key, created)
    if (row.kind === 'invalid') result.invalid += 1
    else result.added += 1
  }
  project.imports.push({
    fingerprint: dryRun.fingerprint,
    fileName: dryRun.fileName,
    at: Date.now(),
    rows: dryRun.counts.total,
    added: result.added,
    updated: result.updated,
    invalid: result.invalid,
    skipped: result.skipped
  })
  return result
}

export const IMPORT_TEMPLATE_HEADER = [
  '姓名',
  '性别',
  '班级',
  '批次',
  '身高(cm)',
  '体重(kg)',
  '胸围(cm)',
  '腰围(cm)',
  '特殊体型',
  '备注'
]

export const IMPORT_TEMPLATE_SAMPLE: string[][] = [
  ['示例·张三', '男', '高一(3)班', '春装', '170', '65', '88', '72', '', '第一排'],
  ['示例·李四', '女', '高一(3)班', '春装', '160', '52', '84', '68', '', '——']
]
