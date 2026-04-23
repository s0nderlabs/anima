export type EditAction = 'add' | 'replace' | 'remove'

export interface EditOp {
  action: EditAction
  /** Required for replace/remove. Substring to match in the existing body. */
  oldText?: string
  /** Required for add/replace. Text to insert. */
  newText?: string
}

export class EditError extends Error {
  constructor(
    message: string,
    readonly op: EditOp,
  ) {
    super(message)
    this.name = 'EditError'
  }
}

/**
 * Apply a single edit op to `body`. Substring-based matching (hermes pattern),
 * no IDs or line numbers. Returns the new body.
 */
export function applyEdit(body: string, op: EditOp): string {
  switch (op.action) {
    case 'add': {
      if (op.newText === undefined) throw new EditError('add requires newText', op)
      return body.length === 0 ? op.newText : `${body.trimEnd()}\n\n${op.newText}\n`
    }
    case 'replace': {
      if (op.oldText === undefined || op.newText === undefined) {
        throw new EditError('replace requires oldText AND newText', op)
      }
      const idx = locateUnique(body, op.oldText, op)
      return body.slice(0, idx) + op.newText + body.slice(idx + op.oldText.length)
    }
    case 'remove': {
      if (op.oldText === undefined) throw new EditError('remove requires oldText', op)
      const idx = locateUnique(body, op.oldText, op)
      return body.slice(0, idx) + body.slice(idx + op.oldText.length)
    }
  }
}

function locateUnique(body: string, needle: string, op: EditOp): number {
  const idx = body.indexOf(needle)
  if (idx < 0) throw new EditError('oldText not found in body', op)
  if (body.indexOf(needle, idx + 1) >= 0) {
    throw new EditError('oldText is not unique in body', op)
  }
  return idx
}
