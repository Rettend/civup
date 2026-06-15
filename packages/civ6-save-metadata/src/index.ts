<<<<<<< New base: chore: update leader desc
export {
  type Civ6SaveMetadata,
  type Civ6SaveModMetadata,
  type Civ6SavePlayerMetadata,
  parseCiv6SaveMetadata,
} from './save-metadata.ts'

export {
  type AutosaveZipIndex,
  type AutosaveZipIndexOptions,
  type AutosaveZipEntry,
  type InflateRaw,
  type ZipByteReader,
  type ZipEntry,
  type ZipEntryReadLimits,
  type ZipParseLimits,
  DEFAULT_ZIP_ENTRY_RANGE_CHUNK_BYTES,
  MAX_AUTOSAVE_ZIP_CENTRAL_DIRECTORY_BYTES,
  MAX_AUTOSAVE_ZIP_ENTRY_COUNT,
  MAX_CIV6_SAVE_COMPRESSED_BYTES,
  MAX_CIV6_SAVE_UNCOMPRESSED_BYTES,
  MAX_ZIP_ENTRY_RANGE_CHUNK_BYTES,
  createAutosaveZipIndex,
  listAutosaveZipEntries,
  parseAutosaveZipIndex,
  parseAutosaveZipIndexFromReader,
  parseZipEntries,
  parseZipEntriesFromReader,
  pickLatestAutosaveZipEntry,
  readZipEntryData,
  readZipEntryDataFromReader,
} from './zip-index.ts'
|||||||
=======
export {
  type Civ6SaveMetadata,
  type Civ6SaveModMetadata,
  type Civ6SavePlayerMetadata,
  parseCiv6SaveMetadata,
} from './save-metadata.ts'

export {
  type AutosaveZipIndex,
  type AutosaveZipIndexOptions,
  type AutosaveZipEntry,
  type InflateRaw,
  type ZipEntry,
  listAutosaveZipEntries,
  parseAutosaveZipIndex,
  parseZipEntries,
  pickLatestAutosaveZipEntry,
  readZipEntryData,
} from './zip-index.ts'
>>>>>>> Current commit: feat: catalog
