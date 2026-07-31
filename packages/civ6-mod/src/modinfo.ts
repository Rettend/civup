import { xmlEscape } from './escape.ts'

const REFERENCES = [
  ['E3F53C61-371C-440B-96CE-077D318B36C0', 'DLC: Australia Civilization Pack'],
  ['02A8BDDE-67EA-4D38-9540-26E685E3156E', 'DLC: Aztec Civilization Pack'],
  ['1F367231-A040-4793-BDBB-088816853683', 'DLC: Khmer and Indonesia Civilization Pack'],
  ['643EA320-8E1A-4CF1-A01C-00D88DDD131A', 'DLC: Nubia Civilization Pack'],
  ['E2749E9A-8056-45CD-901B-C368C8E83DEB', 'DLC: Persia and Macedon Civilization Pack'],
  ['3809975F-263F-40A2-A747-8BFB171D821A', 'DLC: Poland Civilization Pack'],
  ['2F6E858A-28EF-46B3-BEAC-B985E52E9BC1', 'DLC: Vikings Content'],
  ['8424840C-92EF-4426-A9B4-B4E0CB818049', 'LOC_BABYLON_MOD_TITLE'],
  ['A1100FC4-70F2-4129-AC27-2A65A685ED08', 'LOC_BYZANTIUM_GAUL_MOD_TITLE'],
  ['CE5876CD-6900-46D1-9C9C-8DBA1F28872E', 'LOC_CATHERINE_DE_MEDICI_MOD_TITLE'],
  ['1B394FE9-23DC-4868-8F0A-5220CB8FB427', 'LOC_ETHIOPIA_MOD_TITLE'],
  ['1B28771A-C749-434B-9053-D1380C553DE9', 'LOC_EXPANSION1_MOD_TITLE'],
  ['9DE86512-DE1A-400D-8C0A-AB46EBBF76B9', 'LOC_GRANCOLOMBIA_MAYA_MOD_TITLE'],
  ['A3F42CD4-6C3E-4F5A-BC81-BE29E0C0B87C', 'LOC_KUBLAIKHAN_VIETNAM_MOD_TITLE'],
  ['FFDF4E79-DEE2-47BB-919B-F5739106627A', 'LOC_PORTUGAL_MOD_TITLE'],
  ['113D9459-0A3B-4FCB-A49C-483F40303575', 'LOC_TEDDY_ROOSEVELT_MOD_TITLE'],
  ['9ED63236-617C-45A6-BB70-8CB6B0BE8ED2', 'LOC_JULIUS_CAESAR_MOD_TITLE'],
  ['7A66DB58-B354-4061-8C80-95B638DD6F6C', 'LOC_GREAT_NEGOTIATORS_MOD_TITLE'],
  ['F48213B4-56F5-45DD-92F7-AC78E49BDA49', 'LOC_GREAT_WARLORDS_MOD_TITLE'],
  ['7D27831B-BAA6-4A8B-A39C-94243BAD3F47', 'LOC_RULERS_OF_CHINA_MOD_TITLE'],
  ['82AE6F24-930F-4640-833C-FCDFD4845757', 'LOC_RULERS_OF_THE_SAHARA_MOD_TITLE'],
  ['249D9276-0832-48E4-B370-14531FA4E33C', 'LOC_GREAT_BUILDERS_MOD_TITLE'],
  ['258EF3CA-890B-4863-8A52-982822EFF7BD', 'LOC_RULERS_OF_ENGLAND_MOD_TITLE'],
] as const

interface ModInfoInput {
  modId: string
  title: string
  description: string
  paths: readonly string[]
}

export function generateModInfo(input: ModInfoInput): string {
  const files = input.paths.map(path => `    <File>${xmlEscape(path)}</File>`).join('\n')
  const references = REFERENCES.map(([id, title]) => `    <Mod id="${id}" title="${xmlEscape(title)}" />`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<Mod id="${xmlEscape(input.modId)}" version="1">
  <Properties>
    <Name>${xmlEscape(input.title)}</Name>
    <Description>${xmlEscape(input.description)}</Description>
    <Teaser>${xmlEscape(input.description)}</Teaser>
    <CompatibleVersions>2.0</CompatibleVersions>
  </Properties>
  <Dependencies>
    <Mod id="4873eb62-8ccc-4574-b784-dda455e74e68" title="Expansion: Gathering Storm" />
  </Dependencies>
  <References>
${references}
  </References>
  <FrontEndActions>
    <UpdateDatabase id="CivBlitz_Frontend"><File>Frontend.sql</File></UpdateDatabase>
    <UpdateColors id="CivBlitz_Colors"><File>Colors.sql</File></UpdateColors>
    <UpdateText id="CivBlitz_Text"><File>Locale.sql</File></UpdateText>
    <UpdateIcons id="CivBlitz_Icons"><File>Icons.sql</File></UpdateIcons>
  </FrontEndActions>
  <InGameActions>
    <UpdateDatabase id="CivBlitz_Gameplay">
      <Properties><LoadOrder>11699</LoadOrder></Properties>
      <File>Gameplay.sql</File>
    </UpdateDatabase>
    <UpdateDatabase id="CivBlitz_Compatibility">
      <Properties><LoadOrder>11700</LoadOrder></Properties>
      <File>Compatibility.sql</File>
    </UpdateDatabase>
    <ReplaceUIScript id="CivBlitz_LeaderScene">
      <Properties><LuaContext>LeaderScene</LuaContext><LuaReplace>lua/LeaderScene_layeredBg.lua</LuaReplace></Properties>
    </ReplaceUIScript>
    <ImportFiles id="CivBlitz_UI"><File>lua/LeaderScene_layeredBg.lua</File></ImportFiles>
    <UpdateColors id="CivBlitz_Colors"><File>Colors.sql</File></UpdateColors>
    <UpdateText id="CivBlitz_Text"><File>Locale.sql</File></UpdateText>
    <UpdateIcons id="CivBlitz_Icons"><File>Icons.sql</File></UpdateIcons>
    <UpdateArt id="CivBlitz_Art">
      <Properties><LoadOrder>9000</LoadOrder></Properties>
      <File>Art.dep</File>
    </UpdateArt>
  </InGameActions>
  <Files>
${files}
  </Files>
</Mod>
`
}
