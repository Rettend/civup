export interface PublicRuleSection {
  heading: string
  body: string
}

export interface PublicCreator {
  name: string
  description: string
  url?: string
}

// Replace these local constants when approved public copy is available.
export const PUBLIC_RULE_SECTIONS: readonly PublicRuleSection[] = []
export const PUBLIC_RULES_EMPTY_MESSAGE = 'The full rules are being prepared. Until then, use the rules published in your supported server.'

// Add only verified creator profiles and URLs. Empty entries intentionally render a useful placeholder.
export const PUBLIC_CREATORS: readonly PublicCreator[] = []
export const PUBLIC_CREATORS_EMPTY_MESSAGE = 'Creator profiles and verified links will appear here once they are available.'
