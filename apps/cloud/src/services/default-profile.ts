import { randomInt } from 'node:crypto'
import { createDefaultProfile as generate, isDefaultAvatar } from '@scoreboard/shared'

export const validDefaultAvatar = isDefaultAvatar
export const createDefaultProfile = () => generate(() => randomInt(0, 0x1000000) / 0x1000000)
