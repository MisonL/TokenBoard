import { z } from 'zod'
import { isValidIsoDate, usageModelSchema, usageSnapshotSchema, usageSourceSchema } from '@tokenboard/usage-core'

export const maxIngestSnapshotBatchSize = 500
export const maxSnapshotCheckBatchSize = maxIngestSnapshotBatchSize

export const ingestRequestSchema = z.object({
  snapshots: z.array(usageSnapshotSchema).min(0).max(maxIngestSnapshotBatchSize)
})

export const snapshotCheckRequestSchema = z.object({
  keys: z
    .array(
      z.object({
        source: usageSourceSchema,
        usageDate: z.string().refine(isValidIsoDate, 'Invalid ISO date'),
        model: usageModelSchema
      })
    )
    .min(1)
    .max(maxSnapshotCheckBatchSize)
})

export type IngestRequest = z.infer<typeof ingestRequestSchema>
export type SnapshotCheckRequest = z.infer<typeof snapshotCheckRequestSchema>
