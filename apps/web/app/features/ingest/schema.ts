import { z } from 'zod'
import { usageSnapshotSchema, usageSourceSchema } from '@tokenboard/usage-core'

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
        usageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        model: z.string().min(1)
      })
    )
    .min(1)
    .max(maxSnapshotCheckBatchSize)
})

export type IngestRequest = z.infer<typeof ingestRequestSchema>
export type SnapshotCheckRequest = z.infer<typeof snapshotCheckRequestSchema>
