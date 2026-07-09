const START_ACTOR = marker([0x58, 0xBA, 0x7F, 0x4C])
const ZLIB_HEADER = marker([0x78, 0x9C])
const END_UNCOMPRESSED = marker([0x00, 0x00, 0x01, 0x00])
const COMPRESSED_DATA_END = marker([0x00, 0x00, 0xFF, 0xFF])

const GAME_DATA = {
  GAME_TURN: marker([0x9D, 0x2C, 0xE6, 0xBD]),
  GAME_SPEED: marker([0x99, 0xB0, 0xD9, 0x05]),
  GAME_RANDOM_SEED: marker([0x8C, 0x54, 0xEE, 0x04]),
  MAP_RANDOM_SEED: marker([0x7C, 0xC7, 0xC5, 0x96]),
  MOD_BLOCK_1: marker([0x5C, 0xAE, 0x27, 0x84]),
  MOD_BLOCK_2: marker([0xC8, 0xD1, 0x8C, 0x1B]),
  MOD_BLOCK_3: marker([0x44, 0x7F, 0xD4, 0xFE]),
  MOD_BLOCK_4: marker([0xBB, 0x5E, 0x30, 0x88]),
  MOD_ID: marker([0x54, 0x5F, 0xC4, 0x04]),
  MOD_TITLE: marker([0x72, 0xE1, 0x34, 0x30]),
  MAP_FILE: marker([0x5A, 0x87, 0xD8, 0x63]),
  MAP_SIZE: marker([0x40, 0x5C, 0x83, 0x0B]),
} as const

const PACKET_DATA = {
  PLAYER_ID: 0x1A96522F,
  TEAM: 0x0D8AB454,
} as const

const SLOT_HEADERS = [
  marker([0xC8, 0x9B, 0x5F, 0x65]),
  marker([0x5E, 0xAB, 0x58, 0x12]),
  marker([0xE4, 0xFA, 0x51, 0x8B]),
  marker([0x72, 0xCA, 0x56, 0xFC]),
  marker([0xD1, 0x5F, 0x32, 0x62]),
  marker([0x47, 0x6F, 0x35, 0x15]),
  marker([0xFD, 0x3E, 0x3C, 0x8C]),
  marker([0x6B, 0x0E, 0x3B, 0xFB]),
  marker([0xFA, 0x13, 0x84, 0x6B]),
  marker([0x6C, 0x23, 0x83, 0x1C]),
  marker([0xF4, 0x14, 0x18, 0xAA]),
  marker([0x62, 0x24, 0x1F, 0xDD]),
] as const

const ACTOR_DATA = {
  ACTOR_NAME: marker([0x2F, 0x5C, 0x5E, 0x9D]),
  LEADER_NAME: marker([0x5F, 0x5E, 0xCD, 0xE8]),
  ACTOR_TYPE: marker([0xBE, 0xAB, 0x55, 0xCA]),
  PLAYER_NAME: marker([0xFD, 0x6B, 0xB9, 0xDA]),
  PLAYER_PASSWORD: marker([0x6C, 0xD1, 0x7C, 0x6E]),
  PLAYER_ALIVE: marker([0xA6, 0xDF, 0xA7, 0x62]),
  IS_CURRENT_TURN: marker([0xCB, 0x21, 0xB0, 0x7A]),
  ACTOR_AI_HUMAN: marker([0x95, 0xB9, 0x42, 0xCE]),
  ACTOR_DESCRIPTION: marker([0x65, 0x19, 0x9B, 0xFF]),
} as const

const DATA_TYPES = {
  BOOLEAN: 1,
  INTEGER: 2,
  STRING: 5,
  UTF_STRING: 6,
  ARRAY_START: 0x0A,
} as const

type MarkerMap = Record<string, Uint8Array>
type ActorRecord = Record<string, ParsedEntry | undefined>
type ParsedGameData = Record<string, ParsedEntry | undefined>

interface ParserState {
  pos: number
}

interface ParsedEntry {
  marker: Uint8Array
  type: number
  data: unknown
}

interface ParsedSave {
  ACTORS: ActorRecord[]
  CIVS: ActorRecord[]
  game: ParsedGameData
}

export interface Civ6SavePlayerMetadata {
  slot: number
  team: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
  isHuman: boolean | null
  alive: boolean | null
}

export interface Civ6SaveModMetadata {
  id: string | null
  title: string | null
}

export interface Civ6SaveMetadata {
  gameTurn: number | null
  playerCount: number | null
  gameMode: string | null
  leaders: string[]
  civs: string[]
  players: Civ6SavePlayerMetadata[]
  mapSize: string | null
  mapFile: string | null
  gameSpeed: string | null
  gameRandomSeed: number | null
  mapRandomSeed: number | null
  mods: Civ6SaveModMetadata[]
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
}

export function parseCiv6SaveMetadata(bytes: Uint8Array): Civ6SaveMetadata {
  if (decodeAscii(bytes.subarray(0, 4)) !== 'CIV6') throw new Error('Not a Civilization 6 save file')

  const parsed: ParsedSave = { ACTORS: [], CIVS: [], game: {} }
  const state: ParserState = { pos: 0 }
  let curActor: ActorRecord | null = null

  while (state.pos < bytes.length - 4 && !markerEquals(bytes.subarray(state.pos, state.pos + 4), GAME_DATA.GAME_SPEED)) {
    state.pos += 1
  }
  if (state.pos >= bytes.length - 4) throw new Error('Could not find Civ 6 game metadata block')

  while (state.pos < bytes.length - 4) {
    if (markerEquals(bytes.subarray(state.pos, state.pos + 4), END_UNCOMPRESSED)) break

    const info = parseEntry(bytes, state)
    let actorStarted = false
    for (const slotHeader of SLOT_HEADERS) {
      if (markerEquals(info.marker, slotHeader)) {
        curActor = { SLOT_HEADER: info }
        parsed.ACTORS.push(curActor)
        actorStarted = true
        break
      }
    }
    if (actorStarted) continue

    if (!curActor && markerEquals(info.marker, START_ACTOR)) {
      curActor = { START_ACTOR: info }
      parsed.ACTORS.push(curActor)
      continue
    }

    if (markerEquals(info.marker, ACTOR_DATA.ACTOR_DESCRIPTION)) {
      curActor = null
      continue
    }

    const gameKey = findMarkerKey(info.marker, GAME_DATA)
    if (gameKey) addParsedGameEntry(parsed.game, gameKey, info)

    if (curActor) {
      const actorKey = findMarkerKey(info.marker, ACTOR_DATA)
      if (actorKey) curActor[actorKey] = info
    }
  }

  addFallbackGameInt(parsed.game, 'GAME_RANDOM_SEED', GAME_DATA.GAME_RANDOM_SEED, findPacketInt32(bytes, GAME_DATA.GAME_RANDOM_SEED))
  addFallbackGameInt(parsed.game, 'MAP_RANDOM_SEED', GAME_DATA.MAP_RANDOM_SEED, findPacketInt32(bytes, GAME_DATA.MAP_RANDOM_SEED))

  parsed.CIVS = collectCivilizationActors(parsed.ACTORS)
  return buildMetadata(parsed, bytes)
}

function buildMetadata(parsed: ParsedSave, bytes: Uint8Array): Civ6SaveMetadata {
  const packetPlayers = collectPacketPlayerMetadata(bytes)
  const players = parsed.CIVS.map(actor => buildPlayerMetadata(actor, packetPlayers))
  const leaders = uniqueStrings(players.map(player => player.leader))
  const civs = uniqueStrings(players.map(player => player.civilization))
  const mods = collectMods(parsed.game)
  const bbg = resolveBbgMetadata(mods)

  return {
    gameTurn: numberData(parsed.game.GAME_TURN),
    playerCount: players.length,
    gameMode: deriveTeamerGameMode(players.length),
    leaders,
    civs,
    players,
    mapSize: stringData(parsed.game.MAP_SIZE),
    mapFile: stringData(parsed.game.MAP_FILE),
    gameSpeed: stringData(parsed.game.GAME_SPEED),
    gameRandomSeed: int32Data(parsed.game.GAME_RANDOM_SEED),
    mapRandomSeed: int32Data(parsed.game.MAP_RANDOM_SEED),
    mods,
    bbgDetected: bbg.detected,
    bbgTitle: bbg.title,
    bbgVersion: bbg.version,
  }
}

function collectCivilizationActors(actors: ActorRecord[]): ActorRecord[] {
  const civs: ActorRecord[] = []
  for (const slotHeader of SLOT_HEADERS) {
    const actor = actors.find(candidate => (
      candidate.SLOT_HEADER
      && markerEquals(candidate.SLOT_HEADER.marker, slotHeader)
      && numberData(candidate.ACTOR_AI_HUMAN) !== 2
      && stringData(candidate.ACTOR_TYPE) === 'CIVILIZATION_LEVEL_FULL_CIV'
      && candidate.ACTOR_NAME
    ))
    if (actor) civs.push(actor)
  }
  return civs
}

function buildPlayerMetadata(actor: ActorRecord, packetPlayers: Map<number, Civ6SavePacketPlayerMetadata>): Civ6SavePlayerMetadata {
  const aiHuman = numberData(actor.ACTOR_AI_HUMAN)
  const slot = resolveSlotIndex(actor.SLOT_HEADER?.marker)
  return {
    slot,
    team: packetPlayers.get(slot)?.team ?? null,
    playerName: stringData(actor.PLAYER_NAME),
    leader: stringData(actor.LEADER_NAME),
    civilization: stringData(actor.ACTOR_NAME),
    isHuman: aiHuman === 3 ? true : aiHuman === 1 ? false : null,
    alive: booleanData(actor.PLAYER_ALIVE),
  }
}

interface Civ6SavePacketPlayerMetadata {
  playerId: number
  team: number | null
}

interface PacketNode {
  marker: number
  intValue: number | null
  children: PacketNode[]
}

function collectPacketPlayerMetadata(bytes: Uint8Array): Map<number, Civ6SavePacketPlayerMetadata> {
  try {
    const players = new Map<number, Civ6SavePacketPlayerMetadata>()
    for (const node of parsePlayerInfoPacketArray(bytes)) {
      const playerId = childInt(node, PACKET_DATA.PLAYER_ID)
      if (playerId == null || playerId < 0 || playerId > 63) continue
      players.set(playerId, {
        playerId,
        team: childInt(node, PACKET_DATA.TEAM),
      })
    }
    return players
  }
  catch {
    return new Map()
  }
}

function parsePlayerInfoPacketArray(bytes: Uint8Array): PacketNode[] {
  const state: ParserState = { pos: 4 }
  state.pos += 4
  skipPacketArray(bytes, state)
  state.pos += 4
  state.pos += 4
  skipPacketArray(bytes, state)
  state.pos += 4
  return readPacketArray(bytes, state)
}

function skipPacketArray(bytes: Uint8Array, state: ParserState) {
  readPacketArray(bytes, state)
}

function readPacketArray(bytes: Uint8Array, state: ParserState): PacketNode[] {
  const count = readUint32(bytes, state.pos)
  state.pos += 4
  const nodes: PacketNode[] = []
  for (let index = 0; index < count; index += 1) nodes.push(readPacketEntry(bytes, state, null))
  return nodes
}

function readPacketEntry(bytes: Uint8Array, state: ParserState, arrayIndex: number | null): PacketNode {
  const markerValue = arrayIndex == null ? readUint32(bytes, state.pos) : arrayIndex
  if (arrayIndex == null) state.pos += 4
  const type = readUint32(bytes, state.pos)
  state.pos += 4
  const length = readUint24(bytes, state.pos)
  state.pos += 3
  state.pos += 1
  state.pos += 4

  if (type === DATA_TYPES.BOOLEAN || type === DATA_TYPES.INTEGER || type === 3) {
    const intValue = readUint32(bytes, state.pos)
    state.pos += 4
    return { marker: markerValue, intValue, children: [] }
  }
  if (type === DATA_TYPES.ARRAY_START || type === 0x0B) {
    const count = readUint32(bytes, state.pos)
    state.pos += 4
    const children: PacketNode[] = []
    for (let index = 0; index < count; index += 1) children.push(readPacketEntry(bytes, state, type === 0x0B ? index : null))
    return { marker: markerValue, intValue: null, children }
  }

  if (type === 4 || type === DATA_TYPES.STRING) state.pos += length || 4
  else if (type === DATA_TYPES.UTF_STRING) state.pos += length * 2
  else if (type === 0x14) state.pos += 8
  else if (type === 0x15 || type === 0x0D) state.pos += 8
  else if (type === 0x18) skipPacketCompressed(state, length)
  else throw new Error(`Unsupported packet type ${type}`)
  return { marker: markerValue, intValue: null, children: [] }
}

function skipPacketCompressed(state: ParserState, packetLength: number) {
  state.pos += 12
  let remaining = packetLength - 12
  while (remaining > 0) {
    const chunkLength = Math.min(remaining, 65536)
    state.pos += chunkLength
    remaining -= chunkLength
    if (remaining === 0) break
    state.pos += 4
    remaining -= 4
  }
}

function childInt(node: PacketNode, markerValue: number): number | null {
  return node.children.find(child => child.marker === markerValue)?.intValue ?? null
}

function collectMods(game: ParsedGameData): Civ6SaveModMetadata[] {
  const mods: Civ6SaveModMetadata[] = []
  const seen = new Set<string>()
  for (const [key, entry] of Object.entries(game)) {
    if (!key.startsWith('MOD_BLOCK_') || !Array.isArray(entry?.data)) continue
    for (const item of entry.data) {
      if (!item || typeof item !== 'object') continue
      const mod = item as Record<string, ParsedEntry | undefined>
      const id = stringData(mod.MOD_ID)
      const title = normalizeModTitle(stringData(mod.MOD_TITLE))
      const dedupeKey = `${id ?? ''}\n${title ?? ''}`
      if ((id || title) && !seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        mods.push({ id, title })
      }
    }
  }
  return mods
}

function resolveBbgMetadata(mods: Civ6SaveModMetadata[]): { detected: boolean, title: string | null, version: string | null } {
  const baseBbg = mods.find(candidate => {
    const haystack = `${candidate.id ?? ''} ${candidate.title ?? ''}`.toLowerCase()
    return (haystack.includes('better balanced game') || /\bbbg\b/.test(haystack))
      && !haystack.includes('expanded')
  }) ?? null
  const mod = baseBbg ?? mods.find(candidate => {
    const haystack = `${candidate.id ?? ''} ${candidate.title ?? ''}`.toLowerCase()
    return haystack.includes('better balanced game') || /\bbbg\b/.test(haystack)
  }) ?? null

  const title = mod?.title ?? null
  return {
    detected: mod != null,
    title,
    version: title?.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0] ?? null,
  }
}

function normalizeModTitle(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const [key, localizedValues] = Object.entries(parsed as Record<string, unknown>)[0] ?? []
      if (!key) return value
      if (Array.isArray(localizedValues)) {
        const localized = localizedValues.find(item => hasLocaleText(item, 'en_US'))
          ?? localizedValues.find(hasAnyText)
        if (localized && typeof localized === 'object' && 'text' in localized && typeof localized.text === 'string') {
          return localized.text
        }
      }
      return key
    }
  }
  catch {}
  return value
}

function hasLocaleText(value: unknown, locale: string): boolean {
  return Boolean(value && typeof value === 'object'
    && 'locale' in value && value.locale === locale
    && 'text' in value && typeof value.text === 'string')
}

function hasAnyText(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'text' in value && typeof value.text === 'string')
}

function deriveTeamerGameMode(playerCount: number | null): string | null {
  if (playerCount == null || playerCount < 2 || playerCount > 12 || playerCount % 2 !== 0) return null
  return `${playerCount / 2}v${playerCount / 2}`
}

function parseEntry(bytes: Uint8Array, state: ParserState): ParsedEntry {
  while (state.pos < bytes.length - 8) {
    const start = state.pos
    const markerBytes = bytes.subarray(state.pos, state.pos + 4)
    const type = readUint32(bytes, state.pos + 4)
    const entry: ParsedEntry = { marker: markerBytes, type, data: null }
    state.pos += 8

    if (readUint32(markerBytes, 0) < 256 || type === 0) {
      entry.data = 'SKIP'
      return entry
    }
    if (type === 0x18 || markerEquals(bytes.subarray(start + 4, start + 6), ZLIB_HEADER)) {
      entry.data = 'UNKNOWN COMPRESSED DATA'
      const end = indexOfMarker(bytes, COMPRESSED_DATA_END, state.pos)
      state.pos = end >= 0 ? end + COMPRESSED_DATA_END.length : bytes.length
      return entry
    }

    switch (type) {
      case DATA_TYPES.BOOLEAN:
        entry.data = readBoolean(bytes, state)
        return entry
      case DATA_TYPES.INTEGER:
        entry.data = readInt(bytes, state)
        return entry
      case DATA_TYPES.ARRAY_START:
        entry.data = readArray0A(bytes, state)
        return entry
      case 3:
        entry.data = 'UNKNOWN'
        state.pos += 12
        return entry
      case 0x15:
        entry.data = 'UNKNOWN'
        state.pos += markerEquals(bytes.subarray(state.pos, state.pos + 4), marker([0x00, 0x00, 0x00, 0x80])) ? 20 : 12
        return entry
      case 4:
      case DATA_TYPES.STRING:
        entry.data = readString(bytes, state)
        return entry
      case DATA_TYPES.UTF_STRING:
        entry.data = readUtfString(bytes, state)
        return entry
      case 0x14:
      case 0x0D:
        entry.data = 'UNKNOWN'
        state.pos += 16
        return entry
      case 0x0B:
        entry.data = readArray0B(bytes, state)
        return entry
      default:
        state.pos = start + 1
        break
    }
  }

  throw new Error('Could not parse save entry')
}

function readArray0A(bytes: Uint8Array, state: ParserState): unknown[] | number {
  const result: unknown[] = []
  state.pos += 8
  const arrayLen = readUint32(bytes, state.pos)
  state.pos += 4

  for (let index = 0; index < arrayLen; index += 1) {
    const itemIndex = readUint32(bytes, state.pos)
    if (itemIndex > arrayLen) return arrayLen
    const info = parseEntry(bytes, state)
    result.push(info.data)
  }

  return result
}

function readArray0B(bytes: Uint8Array, state: ParserState): unknown[] | string {
  const result: Record<string, ParsedEntry>[] = []
  state.pos += 8
  const arrayLen = readUint32(bytes, state.pos)
  state.pos += 4

  for (let index = 0; index < arrayLen; index += 1) {
    if (bytes[state.pos] !== 0x0A) return 'Error reading array'

    state.pos += 16
    const curData: Record<string, ParsedEntry> = {}
    result.push(curData)

    let safety = 0
    while (state.pos < bytes.length - 8 && safety < 200) {
      safety += 1
      const info = parseEntry(bytes, state)
      const gameKey = findMarkerKey(info.marker, GAME_DATA)
      if (gameKey) curData[gameKey] = info
      if (info.data === '1') break
    }
  }

  return result
}

function readString(bytes: Uint8Array, state: ParserState): string {
  const strLen = readUint24(bytes, state.pos)
  state.pos += 2

  const discriminator = bytes[state.pos + 1]
  if (discriminator === 0 || discriminator === 0x20) {
    state.pos += 10
    return 'UNKNOWN STRING'
  }

  if (discriminator === 0x21) {
    state.pos += 6
    const nullTerminator = indexOfByte(bytes, 0, state.pos)
    if (nullTerminator < 0) return 'ERROR READING STRING'
    const result = decodeUtf8(bytes.subarray(state.pos, nullTerminator))
    state.pos += strLen
    return result
  }

  return 'ERROR READING STRING'
}

function readUtfString(bytes: Uint8Array, state: ParserState): string {
  const strLen = readUint16(bytes, state.pos) * 2
  state.pos += 2
  if (!markerEquals(bytes.subarray(state.pos, state.pos + 6), marker([0x00, 0x21, 0x02, 0x00, 0x00, 0x00]))) {
    return 'ERROR READING UTF STRING'
  }

  state.pos += 6
  const result = decodeUtf16Le(bytes.subarray(state.pos, state.pos + strLen - 2))
  state.pos += strLen
  return result
}

function readBoolean(bytes: Uint8Array, state: ParserState): boolean {
  state.pos += 8
  const result = Boolean(bytes[state.pos])
  state.pos += 4
  return result
}

function readInt(bytes: Uint8Array, state: ParserState): number {
  state.pos += 8
  const result = readUint32(bytes, state.pos)
  state.pos += 4
  return result
}

function addParsedGameEntry(game: ParsedGameData, key: string, entry: ParsedEntry) {
  if (!game[key]) {
    game[key] = entry
    return
  }

  let suffix = 2
  let candidate = `${key}_${suffix}`
  while (game[candidate]) {
    suffix += 1
    candidate = `${key}_${suffix}`
  }
  game[candidate] = entry
}

function addFallbackGameInt(game: ParsedGameData, key: string, markerBytes: Uint8Array, value: number | null) {
  if (value == null || numberData(game[key]) != null) return
  game[key] = { marker: markerBytes, type: DATA_TYPES.INTEGER, data: value }
}

function findPacketInt32(bytes: Uint8Array, markerBytes: Uint8Array): number | null {
  for (let offset = 0; offset <= bytes.length - 20; offset += 1) {
    if (!markerEquals(bytes.subarray(offset, offset + 4), markerBytes)) continue
    const type = readUint32(bytes, offset + 4)
    if (type !== DATA_TYPES.INTEGER && type !== 3) continue
    return readUint32(bytes, offset + 16) | 0
  }
  return null
}

function findMarkerKey(markerBytes: Uint8Array, markers: MarkerMap): string | null {
  for (const [key, value] of Object.entries(markers)) {
    if (markerEquals(markerBytes, value)) return key
  }
  return null
}

function resolveSlotIndex(markerBytes: Uint8Array | undefined): number {
  if (!markerBytes) return -1
  const index = SLOT_HEADERS.findIndex(candidate => markerEquals(candidate, markerBytes))
  return index >= 0 ? index : -1
}

function numberData(entry: ParsedEntry | undefined): number | null {
  return typeof entry?.data === 'number' && Number.isFinite(entry.data) ? entry.data : null
}

function int32Data(entry: ParsedEntry | undefined): number | null {
  const value = numberData(entry)
  return value == null ? null : value | 0
}

function stringData(entry: ParsedEntry | undefined): string | null {
  return typeof entry?.data === 'string' && entry.data.length > 0 && !entry.data.startsWith('ERROR ') && !entry.data.startsWith('UNKNOWN')
    ? entry.data
    : null
}

function booleanData(entry: ParsedEntry | undefined): boolean | null {
  return typeof entry?.data === 'boolean' ? entry.data : null
}

function uniqueStrings(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.length > 0))]
}

function marker(values: readonly number[]): Uint8Array {
  return new Uint8Array(values)
}

function markerEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function indexOfMarker(bytes: Uint8Array, markerBytes: Uint8Array, from: number): number {
  for (let offset = from; offset <= bytes.length - markerBytes.length; offset += 1) {
    if (markerEquals(bytes.subarray(offset, offset + markerBytes.length), markerBytes)) return offset
  }
  return -1
}

function indexOfByte(bytes: Uint8Array, value: number, from: number): number {
  for (let offset = from; offset < bytes.length; offset += 1) {
    if (bytes[offset] === value) return offset
  }
  return -1
}

function readUint16(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  if (first == null || second == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return first | (second << 8)
}

function readUint24(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  if (first == null || second == null || third == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return first | (second << 8) | (third << 16)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  const fourth = bytes[offset + 3]
  if (first == null || second == null || third == null || fourth == null) throw new Error(`Unexpected end of buffer at offset ${offset}`)
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0
}

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes)
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function decodeUtf16Le(bytes: Uint8Array): string {
  return new TextDecoder('utf-16le').decode(bytes)
}
