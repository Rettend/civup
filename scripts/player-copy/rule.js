const jargon =
  /\b(?:season-isolated|seed-aware|frozen RP opening|historical assignment|validated season assignment|hidden-rating substitute|session-owned roster|guild context|rank gating|SessionDO binding|report projections|rating scope|failed safely)\b/i
const messageProperties = new Set(['error', 'message', 'content', 'description', 'title', 'label', 'blockedReason'])

export const playerCopyMessage =
  'Explain the player\'s actual problem instead of using "{{phrase}}". Keep technical details in logs. See AGENTS.md.'

// The standalone checker supplies parent links without changing the parser's AST.
// Neither this visitor nor the checker reads inline suppression comments.
export function createPlayerCopyVisitors(report, parentOf = node => node.parent) {
  function isMessage(node) {
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (parent.type === 'TaggedTemplateExpression') return false
      if (parent.type === 'Property') return messageProperties.has(parent.key.name ?? parent.key.value)
      if (
        parent.type === 'ReturnStatement' ||
        parent.type === 'JSXAttribute' ||
        parent.type === 'JSXElement' ||
        parent.type === 'JSXFragment'
      )
        return true
      if (parent.type === 'NewExpression') return parent.callee.name === 'SeasonSelectionError'
      if (parent.type === 'CallExpression') {
        const name = parent.callee.name ?? parent.callee.property?.name
        return /^(?:set.*Error|set.*Notice|res|reply|privateLaunchError)$/.test(name ?? '')
      }
      if (/^(?:.*Statement|.*Declaration|.*FunctionExpression)$/.test(parent.type)) return false
    }
    return false
  }

  function check(node, text) {
    const match = jargon.exec(text)
    if (match && isMessage(node)) report({ node, messageId: 'jargon', data: { phrase: match[0] } })
  }

  return {
    Literal(node) {
      if (typeof node.value === 'string') check(node, node.value)
    },
    TemplateLiteral(node) {
      check(node, node.quasis.map(part => part.value.cooked ?? part.value.raw).join(' '))
    },
    JSXText(node) {
      check(node, node.value)
    },
  }
}

export const playerCopyRule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { jargon: playerCopyMessage },
  },
  create(context) {
    return createPlayerCopyVisitors(report => context.report(report))
  },
}
