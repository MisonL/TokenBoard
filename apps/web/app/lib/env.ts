import { z } from 'zod'

export const workerEnvSchema = z.object({
  DB: z.custom<D1Database>(),
  WEBHOOK_ENCRYPTION_KEY: z.string().optional()
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>
