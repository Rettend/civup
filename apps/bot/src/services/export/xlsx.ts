export type XlsxCellValue = string | number | boolean | XlsxDateValue | null | undefined

export interface XlsxDateValue {
  type: 'date'
  value: number
}

export interface XlsxWorksheet {
  name: string
  columns: string[]
  rows: XlsxCellValue[][]
}

interface ZipFile {
  name: string
  data: Uint8Array
}

interface ZipEntry extends ZipFile {
  crc: number
  offset: number
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const textEncoder = new TextEncoder()
const DOS_DATE_1980_01_01 = 33

export function createXlsxWorkbook(worksheets: XlsxWorksheet[]): Uint8Array {
  if (worksheets.length === 0) throw new Error('XLSX workbook needs at least one worksheet.')

  const safeWorksheets = worksheets.map((worksheet, index) => ({
    ...worksheet,
    name: sanitizeSheetName(worksheet.name, index),
  }))

  return createZip([
    { name: '[Content_Types].xml', data: encodeXml(contentTypesXml(safeWorksheets.length)) },
    { name: '_rels/.rels', data: encodeXml(rootRelationshipsXml()) },
    { name: 'xl/workbook.xml', data: encodeXml(workbookXml(safeWorksheets)) },
    { name: 'xl/styles.xml', data: encodeXml(stylesXml()) },
    { name: 'xl/_rels/workbook.xml.rels', data: encodeXml(workbookRelationshipsXml(safeWorksheets.length)) },
    ...safeWorksheets.map((worksheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: encodeXml(worksheetXml(worksheet)),
    })),
  ])
}

function contentTypesXml(sheetCount: number): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_value, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('')

  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheetOverrides}</Types>`
}

function rootRelationshipsXml(): string {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
}

function workbookXml(worksheets: XlsxWorksheet[]): string {
  const sheets = worksheets.map((worksheet, index) => (
    `<sheet name="${escapeXmlAttribute(worksheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('')

  return `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`
}

function workbookRelationshipsXml(sheetCount: number): string {
  const worksheetRelationships = Array.from({ length: sheetCount }, (_value, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('')
  const relationships = `${worksheetRelationships}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`

  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
}

function stylesXml(): string {
  return `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
}

function worksheetXml(worksheet: XlsxWorksheet): string {
  const rows = [worksheet.columns, ...worksheet.rows]
  const sheetRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1
    const cells = row.map((cell, columnIndex) => cellXml(cell, rowNumber, columnIndex)).join('')
    return `<row r="${rowNumber}">${cells}</row>`
  }).join('')
  const lastColumn = columnName(Math.max(worksheet.columns.length, ...worksheet.rows.map(row => row.length)) - 1)
  const dimension = rows.length > 0 && lastColumn ? `<dimension ref="A1:${lastColumn}${rows.length}"/>` : ''

  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetData>${sheetRows}</sheetData></worksheet>`
}

function cellXml(value: XlsxCellValue, rowNumber: number, columnIndex: number): string {
  const reference = `${columnName(columnIndex)}${rowNumber}`
  if (value === null || value === undefined) return `<c r="${reference}"/>`
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`
  if (typeof value === 'object' && value.type === 'date') return `<c r="${reference}" s="1"><v>${value.value}</v></c>`

  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(String(value))}</t></is></c>`
}

export function xlsxDateFromUnixMs(timestampMs: number): XlsxDateValue {
  return {
    type: 'date',
    value: Math.round(((timestampMs / 86_400_000) + 25_569) * 86_400) / 86_400,
  }
}

function columnName(index: number): string {
  if (index < 0) return ''
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function sanitizeSheetName(name: string, index: number): string {
  const safeName = name.replace(/[\\/?:*\[\]]/g, ' ').trim()
  return (safeName.length > 0 ? safeName : `Sheet ${index + 1}`).slice(0, 31)
}

function encodeXml(xml: string): Uint8Array {
  return textEncoder.encode(xml)
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function createZip(files: ZipFile[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  const entries: ZipEntry[] = []
  let offset = 0

  for (const file of files) {
    const filename = textEncoder.encode(file.name)
    const crc = crc32(file.data)
    const localHeader = createLocalFileHeader(filename, file.data.length, crc)
    entries.push({ ...file, crc, offset })
    localParts.push(localHeader, filename, file.data)
    offset += localHeader.length + filename.length + file.data.length
  }

  const centralDirectoryOffset = offset
  for (const entry of entries) {
    const filename = textEncoder.encode(entry.name)
    const centralHeader = createCentralDirectoryHeader(filename, entry.data.length, entry.crc, entry.offset)
    centralParts.push(centralHeader, filename)
    offset += centralHeader.length + filename.length
  }

  const centralDirectorySize = offset - centralDirectoryOffset
  return concatBytes([
    ...localParts,
    ...centralParts,
    createEndOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset),
  ])
}

function createLocalFileHeader(filename: Uint8Array, size: number, crc: number): Uint8Array {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034B50, true)
  view.setUint16(4, 20, true)
  view.setUint16(8, 0, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, DOS_DATE_1980_01_01, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, size, true)
  view.setUint32(22, size, true)
  view.setUint16(26, filename.length, true)
  return bytes
}

function createCentralDirectoryHeader(filename: Uint8Array, size: number, crc: number, localHeaderOffset: number): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x02014B50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, 0, true)
  view.setUint16(14, DOS_DATE_1980_01_01, true)
  view.setUint32(16, crc, true)
  view.setUint32(20, size, true)
  view.setUint32(24, size, true)
  view.setUint16(28, filename.length, true)
  view.setUint32(42, localHeaderOffset, true)
  return bytes
}

function createEndOfCentralDirectory(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number): Uint8Array {
  const bytes = new Uint8Array(22)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x06054B50, true)
  view.setUint16(8, entryCount, true)
  view.setUint16(10, entryCount, true)
  view.setUint32(12, centralDirectorySize, true)
  view.setUint32(16, centralDirectoryOffset, true)
  return bytes
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const CRC32_TABLE = createCrc32Table()

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
