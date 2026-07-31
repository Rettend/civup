import type { CivBlitzModInput } from '@civup/civ6-mod'
import { generateCivBlitzModArchive, isCivBlitzModError } from '@civup/civ6-mod'

export function generateCivBlitzModResponse(input: unknown): Response {
  try {
    const generated = generateCivBlitzModArchive(input as CivBlitzModInput)
    return new Response(generated.data, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${generated.archiveFilename}"`,
        'Content-Length': String(generated.data.byteLength),
        'Content-Type': 'application/zip',
        ETag: `"${generated.modId}"`,
      },
    })
  }
  catch (error) {
    if (isCivBlitzModError(error)) return Response.json({ error: error.safeMessage, code: error.code }, { status: error.status })
    console.error('[maintenance-do] Failed to generate CivBlitz mod:', error)
    return Response.json({ error: 'Failed to generate the match mod.' }, { status: 500 })
  }
}
