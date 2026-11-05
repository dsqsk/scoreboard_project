import { foundationRequestSchema } from '@scoreboard/shared'
import { defineHandler } from '../infrastructure/handler'
import type { Caller } from '../domain/models'
import { createFoundation } from './foundation'

export function createApi(deps: Parameters<typeof createFoundation>[0], getCaller: () => Caller) {
  const foundation = createFoundation(deps)
  return defineHandler(foundationRequestSchema, (request) =>
    foundation.dispatch(request, getCaller()),
  )
}
