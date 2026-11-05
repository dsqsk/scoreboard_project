import { z } from 'zod'
export const entityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
export const commandIdSchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/)
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
